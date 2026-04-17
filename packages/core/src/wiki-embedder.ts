/**
 * wiki-embedder.ts — Embed wiki pages into wiki.db for vector search.
 *
 * For each wiki page under wikiRoot:
 *   1. Read raw file content and compute SHA-256 hash.
 *   2. Skip the page if wiki_pages.content_hash already matches (incremental).
 *   3. Parse frontmatter, extract title, compute word_count.
 *   4. Chunk the page body into ~200-token paragraph-aware segments.
 *   5. Embed each chunk using the existing embed() function (bge-small-en-v1.5).
 *   6. Upsert wiki_pages row with content_hash.
 *   7. Replace wiki_chunks rows for the page with new embedded chunks.
 *
 * The content_hash check implements the mtime/hash approach from spec §7.1:
 * Obsidian edits change the file content → hash mismatch → re-embed triggered.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { listWikiPages, parseFrontmatter, extractTitle, hashContent } from './wiki-fs.js';
import { WikiStore } from './wiki-schema.js';
import { embed } from './embedder.js';
import { serializeEmbedding } from './vector-search.js';
import type { WasmDb } from './wasm-db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target chunk size in characters (~200 tokens × 4 chars/token). */
const TARGET_CHUNK_CHARS = 800;

/**
 * Sub-chunk threshold in characters (~300 tokens × 4 chars/token).
 * H2 sections larger than this are split into paragraph-aware sub-chunks.
 */
const H2_SUBCHUNK_CHARS = 1200;

/** Embedding model name — must match the model used in embedder.ts. */
const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiEmbedderOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  dbPath?: string;
  /** Print progress to stdout. Defaults to false. */
  verbose?: boolean;
}

export interface WikiEmbedStats {
  /** Total wiki pages found. */
  total: number;
  /** Pages skipped because content_hash matched. */
  skipped: number;
  /** Pages successfully embedded. */
  embedded: number;
  /** Pages that failed with an error. */
  errors: number;
  /** Total chunks written across all embedded pages. */
  chunks: number;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * A chunk of wiki text with its associated H2 section name.
 * section is the H2 heading text (without ##), or '' for content before the first H2.
 */
export interface WikiChunk {
  content: string;
  section: string;
}

/**
 * Split text paragraphs into chunks up to targetChars each.
 * Never splits mid-paragraph. Returns plain strings.
 */
function splitParagraphs(text: string, targetChars: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length === 0) {
      current = para;
    } else if (current.length + 2 + para.length <= targetChars) {
      current += '\n\n' + para;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * H2-aware chunking of a markdown body.
 *
 * Algorithm:
 *   1. Split the body at H2 boundaries (## Heading lines).
 *   2. Each H2 section becomes one or more chunks (the heading line is
 *      prepended to each sub-chunk so context is preserved in search snippets).
 *   3. Any content before the first H2 is treated as section '' and chunked
 *      by paragraphs as before.
 *   4. H2 sections larger than H2_SUBCHUNK_CHARS are further split by
 *      paragraph boundaries to stay within the sub-chunk budget.
 *
 * @param text        The page body (everything after the frontmatter ---).
 * @param targetChars Sub-chunk character budget within an H2 section (default: 1200 ≈ 300 tokens).
 * @returns Array of WikiChunk objects (content + section name).
 */
export function chunkByH2(text: string, targetChars = H2_SUBCHUNK_CHARS): WikiChunk[] {
  // Split body into H2-delimited sections.
  // Lines starting with exactly "## " begin a new section.
  const lines = text.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];

  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^## /.test(line)) {
      // Flush previous section
      sections.push({ heading: currentHeading, body: currentLines.join('\n') });
      currentHeading = line.slice(3).trim();
      currentLines = [line]; // Include heading line in the body for context
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  sections.push({ heading: currentHeading, body: currentLines.join('\n') });

  const result: WikiChunk[] = [];

  for (const section of sections) {
    const bodyTrimmed = section.body.trim();
    if (!bodyTrimmed) continue;

    if (bodyTrimmed.length <= targetChars) {
      result.push({ content: bodyTrimmed, section: section.heading });
    } else {
      // Sub-chunk the section by paragraphs
      const subChunks = splitParagraphs(bodyTrimmed, targetChars);
      for (const sub of subChunks) {
        result.push({ content: sub, section: section.heading });
      }
    }
  }

  return result;
}

/**
 * Chunk a markdown body into ~200-token paragraph-aware segments.
 * This is the legacy paragraph-only chunker — kept for backward compatibility
 * and tests. New code should prefer chunkByH2().
 *
 * @param text        The page body (everything after the frontmatter ---).
 * @param targetChars Approximate character budget per chunk (default: 800).
 * @returns Array of non-empty chunk strings.
 */
export function chunkText(text: string, targetChars = TARGET_CHUNK_CHARS): string[] {
  return splitParagraphs(text, targetChars);
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Derive the canonical page ID (slug) from a relative file path.
 * "people/dylan-sellberg.md" → "people/dylan-sellberg"
 */
function pageIdFromPath(relPath: string): string {
  return relPath.replace(/\.md$/, '');
}

/**
 * Convert a slug path to a display title (fallback when H1 is absent).
 * "people/dylan-sellberg" → "Dylan Sellberg"
 */
function slugToTitle(pageId: string): string {
  const stem = pageId.replace(/^.*\//, '');
  return stem
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Look up the stored content_hash for a page, or null if the page isn't in the DB.
 */
function getStoredHash(db: WasmDb, pageId: string): string | null {
  const stmt = db.prepare('SELECT content_hash FROM wiki_pages WHERE id = ?');
  stmt.bind([pageId]);
  const found = stmt.step();
  if (!found) {
    stmt.finalize();
    return null;
  }
  const row = stmt.get({}) as { content_hash?: string | null };
  stmt.finalize();
  return row.content_hash ?? null;
}

/**
 * Upsert a wiki_pages row (INSERT OR REPLACE).
 */
function upsertWikiPage(
  db: WasmDb,
  pageId: string,
  relPath: string,
  type: string,
  title: string,
  created: string,
  updated: string,
  confidence: string,
  tags: string,
  sourceRefs: string,
  status: string,
  wordCount: number,
  contentHash: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wiki_pages
      (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.bind([
    pageId,
    relPath,
    type,
    title,
    created,
    updated,
    confidence,
    tags,
    sourceRefs,
    status,
    wordCount,
    contentHash,
  ]);
  stmt.step();
  stmt.finalize();
}

/**
 * Delete all existing chunks for a page (called before inserting fresh chunks).
 */
function deleteChunksForPage(db: WasmDb, pageId: string): void {
  const stmt = db.prepare('DELETE FROM wiki_chunks WHERE page_id = ?');
  stmt.bind([pageId]);
  stmt.step();
  stmt.finalize();
}

/**
 * Insert a single wiki_chunk row with its embedding and section.
 */
function insertChunk(
  db: WasmDb,
  pageId: string,
  chunkIndex: number,
  content: string,
  section: string,
  embeddingJson: string,
): void {
  const stmt = db.prepare(`
    INSERT INTO wiki_chunks (page_id, chunk_index, content, section, embed_status, embed_model, embedding)
    VALUES (?, ?, ?, ?, 'done', ?, ?)
  `);
  stmt.bind([pageId, chunkIndex, content, section, EMBED_MODEL, embeddingJson]);
  stmt.step();
  stmt.finalize();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Embed all wiki pages into wiki.db.
 *
 * Incremental: pages whose content_hash matches the stored value are skipped.
 * Detects Obsidian manual edits via hash mismatch (spec §7.1).
 *
 * @returns Embedding statistics.
 */
export async function runWikiEmbed(options: WikiEmbedderOptions = {}): Promise<WikiEmbedStats> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const verbose = options.verbose ?? false;

  const stats: WikiEmbedStats = { total: 0, skipped: 0, embedded: 0, errors: 0, chunks: 0 };

  // Open wiki.db (creates it if missing; applies schema idempotently).
  const store = await WikiStore.create({ dbPath });
  const db = store.db;

  try {
    // Enumerate all wiki pages (excludes special files and archive/).
    let relPaths: string[];
    try {
      relPaths = await listWikiPages(wikiRoot);
    } catch {
      if (verbose) {
        console.log(`Wiki root not found at ${wikiRoot}. Nothing to embed.`);
      }
      return stats;
    }

    stats.total = relPaths.length;
    if (verbose) {
      console.log(`Found ${relPaths.length} wiki pages under ${wikiRoot}`);
    }

    for (const relPath of relPaths) {
      const pageId = pageIdFromPath(relPath);

      try {
        const absPath = join(wikiRoot, relPath);
        const raw = await readFile(absPath, 'utf8');
        const currentHash = hashContent(raw);

        // --- Incremental check ---
        const storedHash = getStoredHash(db, pageId);
        if (storedHash !== null && storedHash === currentHash) {
          stats.skipped++;
          if (verbose) console.log(`  skip  ${relPath} (hash unchanged)`);
          continue;
        }

        // --- Parse page ---
        let frontmatter: ReturnType<typeof parseFrontmatter>['frontmatter'];
        let body: string;
        let title: string;
        try {
          const parsed = parseFrontmatter(raw);
          frontmatter = parsed.frontmatter;
          body = parsed.body;
          title = extractTitle(body) ?? slugToTitle(pageId);
        } catch {
          // Gracefully handle pages without valid frontmatter.
          frontmatter = {
            type: 'unknown',
            created: '',
            updated: '',
            source_refs: [],
            tags: [],
            confidence: 'medium',
          };
          body = raw;
          title = slugToTitle(pageId);
        }

        const wordCount = body.split(/\s+/).filter((w) => w.length > 0).length;

        // --- Chunk the body (H2-aware) ---
        const chunks = chunkByH2(body);

        // --- Embed each chunk ---
        const embeddedChunks: Array<{ content: string; section: string; embeddingJson: string }> = [];
        let chunkFailed = false;

        for (const wikiChunk of chunks) {
          try {
            const vec = await embed(wikiChunk.content);
            embeddedChunks.push({
              content: wikiChunk.content,
              section: wikiChunk.section,
              embeddingJson: serializeEmbedding(vec),
            });
          } catch (err) {
            // If any chunk fails to embed, mark the whole page as failed.
            const msg = err instanceof Error ? err.message : String(err);
            if (verbose) console.error(`  error ${relPath} (chunk embed failed): ${msg}`);
            chunkFailed = true;
            break;
          }
        }

        if (chunkFailed) {
          stats.errors++;
          continue;
        }

        // --- Write to DB (atomic: upsert page, replace chunks) ---
        upsertWikiPage(
          db,
          pageId,
          relPath,
          frontmatter.type ?? 'unknown',
          title,
          frontmatter.created ?? '',
          frontmatter.updated ?? '',
          frontmatter.confidence ?? 'medium',
          JSON.stringify(frontmatter.tags ?? []),
          JSON.stringify(frontmatter.source_refs ?? []),
          frontmatter.status ?? 'active',
          wordCount,
          currentHash,
        );

        deleteChunksForPage(db, pageId);

        for (let i = 0; i < embeddedChunks.length; i++) {
          const chunk = embeddedChunks[i]!;
          insertChunk(db, pageId, i, chunk.content, chunk.section, chunk.embeddingJson);
        }

        stats.embedded++;
        stats.chunks += embeddedChunks.length;
        if (verbose) {
          console.log(`  embed ${relPath} (${embeddedChunks.length} chunks)`);
        }
      } catch (err) {
        stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        if (verbose) console.error(`  error ${relPath}: ${msg}`);
      }
    }
  } finally {
    store.close();
  }

  return stats;
}
