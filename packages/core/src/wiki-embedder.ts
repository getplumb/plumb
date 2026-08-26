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
import { serializeWikiEmbeddingBlob } from './vector-search.js';
import { backfillContextualEmbeddings, DEFAULT_CONTEXTUAL_MODEL } from './wiki-contextual-embeddings.js';
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
  /** Explicitly refresh contextual sidecar embeddings for changed/new chunks. Default false. */
  contextualRefresh?: boolean;
  /** Contextual model to refresh. Only Xenova/bge-small-en-v1.5 is supported in E017. */
  contextualModel?: string;
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
  /** Inclusive start offset in the markdown body after frontmatter parsing. */
  charStart: number;
  /** Exclusive end offset in the markdown body after frontmatter parsing. */
  charEnd: number;
}

type SpanChunk = WikiChunk;

/** Tiny chunks below this size are merged into a neighbor when possible. */
const MIN_INFORMATION_CHARS = 80;

function trimSpan(text: string, start = 0): { content: string; charStart: number; charEnd: number } | null {
  const leading = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = text.match(/\s*$/)?.[0].length ?? 0;
  const charStart = start + leading;
  const charEnd = start + text.length - trailing;
  if (charEnd <= charStart) return null;
  return { content: text.slice(leading, text.length - trailing), charStart, charEnd };
}

function informationScore(text: string): number {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[\W_]+/g, '')
    .length;
}

function isTinyLowInformation(chunk: SpanChunk): boolean {
  if (chunk.content.length >= MIN_INFORMATION_CHARS) return false;
  const words = chunk.content.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length <= 4 || informationScore(chunk.content) < 40;
}

function mergeChunks(a: SpanChunk, b: SpanChunk): SpanChunk {
  const content = `${a.content}\n\n${b.content}`.trim();
  return {
    content,
    section: a.section || b.section,
    charStart: Math.min(a.charStart, b.charStart),
    charEnd: Math.max(a.charEnd, b.charEnd),
  };
}

/**
 * Split text paragraphs into chunks up to targetChars each.
 * Never splits mid-paragraph. Returns plain strings.
 */
function splitOversizedSpan(text: string, start: number, maxChars: number, section: string): SpanChunk[] {
  const chunks: SpanChunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
    if (cursor >= text.length) break;

    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      const trimmed = trimSpan(text.slice(cursor), start + cursor);
      if (trimmed) chunks.push({ ...trimmed, section });
      break;
    }

    const windowText = text.slice(cursor, cursor + maxChars + 1);
    const boundaryPatterns = [/\n{2,}/g, /(?<=[.!?])\s+/g, /\n/g, /\s+/g];
    let cut = -1;
    for (const pattern of boundaryPatterns) {
      for (const match of windowText.matchAll(pattern)) {
        const end = (match.index ?? 0) + match[0].length;
        if (end > 0 && end <= maxChars) cut = Math.max(cut, end);
      }
      if (cut >= Math.floor(maxChars * 0.5)) break;
    }
    if (cut <= 0) cut = maxChars;

    const trimmed = trimSpan(text.slice(cursor, cursor + cut), start + cursor);
    if (trimmed) chunks.push({ ...trimmed, section });
    cursor += cut;
  }

  return chunks;
}

function splitParagraphsWithSpans(text: string, targetChars: number, section: string, start = 0): SpanChunk[] {
  const paragraphs: SpanChunk[] = [];
  const paragraphPattern = /\S[\s\S]*?(?=\n{2,}|$)/g;
  for (const match of text.matchAll(paragraphPattern)) {
    const raw = match[0]!;
    const trimmed = trimSpan(raw, start + (match.index ?? 0));
    if (!trimmed) continue;
    if (trimmed.content.length > targetChars) {
      paragraphs.push(...splitOversizedSpan(trimmed.content, trimmed.charStart, targetChars, section));
    } else {
      paragraphs.push({ ...trimmed, section });
    }
  }

  const chunks: SpanChunk[] = [];
  let current: SpanChunk | null = null;
  for (const para of paragraphs) {
    if (!current) {
      current = para;
    } else {
      const merged = mergeChunks(current, para);
      if (merged.content.length <= targetChars) current = merged;
      else {
        chunks.push(current);
        current = para;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Split text paragraphs into chunks up to targetChars each.
 * Paragraphs larger than targetChars are split deterministically at sentence,
 * line, word, then hard character boundaries. Returns plain strings.
 */
function splitParagraphs(text: string, targetChars: number): string[] {
  return splitParagraphsWithSpans(text, targetChars, '', 0).map((chunk) => chunk.content);
}

function mergeTinyChunks(chunks: SpanChunk[], maxChars: number): SpanChunk[] {
  const result: SpanChunk[] = [];

  for (const chunk of chunks) {
    if (!isTinyLowInformation(chunk)) {
      result.push(chunk);
      continue;
    }

    const previous = result[result.length - 1];
    const nextMergeWouldFit = previous ? mergeChunks(previous, chunk).content.length <= maxChars : false;
    if (previous && nextMergeWouldFit) {
      result[result.length - 1] = mergeChunks(previous, chunk);
    } else {
      result.push(chunk);
    }
  }

  for (let i = 0; i < result.length - 1; i++) {
    const current = result[i]!;
    if (!isTinyLowInformation(current)) continue;
    const next = result[i + 1]!;
    const merged = mergeChunks(current, next);
    if (merged.content.length <= maxChars) {
      result.splice(i, 2, merged);
      i--;
    }
  }

  return result;
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
 *      paragraph, sentence, line, word, then hard character boundaries.
 *   5. Tiny low-information chunks are merged into neighbors when possible.
 *
 * @param text        The page body (everything after the frontmatter ---).
 * @param targetChars Sub-chunk character budget within an H2 section (default: 1200 ≈ 300 tokens).
 * @returns Array of WikiChunk objects (content + section name).
 */
export function chunkByH2(text: string, targetChars = H2_SUBCHUNK_CHARS): WikiChunk[] {
  if (targetChars < 1) throw new Error('targetChars must be positive');

  const headings = [...text.matchAll(/^## .+$/gm)].map((match) => ({
    index: match.index ?? 0,
    line: match[0]!,
    heading: match[0]!.slice(3).trim(),
  }));

  const sections: Array<{ heading: string; body: string; start: number }> = [];
  if (headings.length === 0) {
    sections.push({ heading: '', body: text, start: 0 });
  } else {
    if (headings[0]!.index > 0) sections.push({ heading: '', body: text.slice(0, headings[0]!.index), start: 0 });
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]!;
      const end = headings[i + 1]?.index ?? text.length;
      sections.push({ heading: h.heading, body: text.slice(h.index, end), start: h.index });
    }
  }

  const result: WikiChunk[] = [];

  for (const section of sections) {
    const bodyTrimmed = trimSpan(section.body, section.start);
    if (!bodyTrimmed) continue;
    if (bodyTrimmed.content.length <= targetChars) result.push({ ...bodyTrimmed, section: section.heading });
    else result.push(...splitParagraphsWithSpans(bodyTrimmed.content, targetChars, section.heading, bodyTrimmed.charStart));
  }

  return mergeTinyChunks(result, targetChars);
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
 * "people/jordan-lee.md" → "people/jordan-lee"
 */
function pageIdFromPath(relPath: string): string {
  return relPath.replace(/\.md$/, '');
}

/**
 * Convert a slug path to a display title (fallback when H1 is absent).
 * "people/jordan-lee" → "Jordan Lee"
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
 * Upsert a wiki_pages row without replacing/deleting the row.
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
    INSERT INTO wiki_pages
      (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      type = excluded.type,
      title = excluded.title,
      created = excluded.created,
      updated = excluded.updated,
      confidence = excluded.confidence,
      tags = excluded.tags,
      source_refs = excluded.source_refs,
      status = excluded.status,
      word_count = excluded.word_count,
      content_hash = excluded.content_hash
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
  // Raw float32 BLOB, not JSON text (2026-08-13). See
  // serializeWikiEmbeddingBlob for why, and why the memory system's
  // serializeEmbedding was deliberately left alone.
  embeddingBlob: Uint8Array,
): void {
  const stmt = db.prepare(`
    INSERT INTO wiki_chunks (page_id, chunk_index, content, section, embed_status, embed_model, embedding)
    VALUES (?, ?, ?, ?, 'done', ?, ?)
  `);
  stmt.bind([pageId, chunkIndex, content, section, EMBED_MODEL, embeddingBlob]);
  stmt.step();
  stmt.finalize();
}


function existingContextualModelsForPage(db: WasmDb, pageId: string): string[] {
  const stmt = db.prepare('SELECT DISTINCT model FROM wiki_chunk_context_embeddings WHERE page_id = ?');
  stmt.bind([pageId]);
  const models: string[] = [];
  while (stmt.step()) {
    const row = stmt.get({}) as { model?: string };
    if (row.model) models.push(row.model);
  }
  stmt.finalize();
  return models;
}

function beginImmediate(db: WasmDb): void {
  db.exec('BEGIN IMMEDIATE');
}

function commit(db: WasmDb): void {
  db.exec('COMMIT');
}

function rollback(db: WasmDb): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Ignore rollback errors; preserve original failure.
  }
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
  const contextualModel = options.contextualModel ?? DEFAULT_CONTEXTUAL_MODEL;

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
        const embeddedChunks: Array<{ content: string; section: string; embeddingBlob: Uint8Array }> = [];
        let chunkFailed = false;

        for (const wikiChunk of chunks) {
          try {
            const vec = await embed(wikiChunk.content);
            embeddedChunks.push({
              content: wikiChunk.content,
              section: wikiChunk.section,
              embeddingBlob: serializeWikiEmbeddingBlob(vec),
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

        // --- Write to DB atomically: upsert page, replace chunks, cascade old sidecars ---
        const provisionedContextualModels = existingContextualModelsForPage(db, pageId);
        beginImmediate(db);
        try {
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
            insertChunk(db, pageId, i, chunk.content, chunk.section, chunk.embeddingBlob);
          }
          commit(db);
        } catch (err) {
          rollback(db);
          throw err;
        }

        const shouldRefreshContextual = options.contextualRefresh || provisionedContextualModels.includes(contextualModel);
        if (shouldRefreshContextual) {
          await backfillContextualEmbeddings({
            db,
            model: contextualModel,
            pageIds: [pageId],
            verbose,
          });
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
