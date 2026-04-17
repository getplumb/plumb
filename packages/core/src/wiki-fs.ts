/**
 * wiki-fs.ts — File system interface for the Plumb wiki layer.
 *
 * Provides:
 *   - parseFrontmatter() / serializeFrontmatter()  YAML frontmatter parsing
 *   - readWikiPage() / writeWikiPage()             file I/O with frontmatter
 *   - hashContent()                                SHA-256 for change detection
 *   - isModifiedExternally()                       detect Obsidian edits
 *   - listWikiPages()                              enumerate .md files under wikiRoot
 *
 * Archive policy: writes NEVER delete files. To remove a page, call archivePage(),
 * which moves the file to archive/ and sets status: archived in frontmatter.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiFrontmatter {
  type: string;
  created: string;        // YYYY-MM-DD
  updated: string;        // YYYY-MM-DD
  source_refs: string[];
  tags: string[];
  confidence: 'high' | 'medium' | 'low';
  status?: 'active' | 'archived';
  /** Additional fields passed through without modification */
  [key: string]: unknown;
}

export interface WikiPage {
  /** Relative path from wikiRoot, e.g. "people/dylan-sellberg.md" */
  path: string;
  frontmatter: WikiFrontmatter;
  /** H1 title extracted from body, e.g. "Dylan Sellberg". undefined if not found. */
  title: string | undefined;
  /** Markdown body text (everything after the closing frontmatter ---) */
  body: string;
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser
//
// Handles the subset of YAML produced by SCHEMA.md §3:
//   - key: scalar_value
//   - key: [a, b, c]          (inline array)
//   - key: []                 (empty inline array)
//   - key:\n  - item          (block array)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML content between the frontmatter delimiters.
 * Does not handle nested objects, multi-line strings, or anchors.
 */
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Skip blank lines and comment lines
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '') {
      // Could be start of block array: next lines begin with optional whitespace + "- "
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s+-\s+/, '').trim());
        i++;
      }
      result[key] = items;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array: [a, b, c] or []
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim());
      i++;
    } else {
      result[key] = rest;
      i++;
    }
  }

  return result;
}

/**
 * Serialize a WikiFrontmatter object back to a YAML string (no delimiters).
 * Arrays are always written in block style; scalars on a single line.
 */
export function serializeFrontmatter(fm: WikiFrontmatter): string {
  // Canonical field order per SCHEMA.md §3
  const fieldOrder: Array<keyof WikiFrontmatter> = [
    'type', 'created', 'updated', 'source_refs', 'tags', 'confidence', 'status',
  ];
  const lines: string[] = [];

  const seen = new Set<string>();

  for (const key of fieldOrder) {
    if (!(key in fm)) continue;
    seen.add(key as string);
    const value = fm[key];
    lines.push(...formatYamlField(key as string, value));
  }

  // Append any extra fields not in canonical order
  for (const [key, value] of Object.entries(fm)) {
    if (seen.has(key)) continue;
    lines.push(...formatYamlField(key, value));
  }

  return lines.join('\n');
}

function formatYamlField(key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map(item => `  - ${item}`)];
  }
  return [`${key}: ${value}`];
}

// ---------------------------------------------------------------------------
// Frontmatter parsing: split raw markdown into frontmatter + body
// ---------------------------------------------------------------------------

const FM_DELIMITER = '---';

/**
 * Strip leading/closing code fences (```yaml, ```markdown, ```, etc.) if an
 * LLM wrapped the frontmatter in a fenced code block. Defensive only —
 * the SCHEMA forbids this, but we still accept it so a single rogue LLM
 * output doesn't silently break indexing. See T-220.
 */
function stripFrontmatterFence(raw: string): string {
  const lines = raw.split('\n');
  const first = (lines[0] ?? '').trim();
  // Match ```yaml, ```markdown, ```md, ```, or any ```<lang>
  if (/^```[\w-]*$/.test(first)) {
    // Find the matching closing fence that sits BEFORE the H1.
    // If we see an H1 without a closing fence in between, the fence is
    // malformed — bail and let parse fail naturally.
    for (let i = 1; i < lines.length; i++) {
      const trimmed = (lines[i] ?? '').trim();
      if (trimmed === '```') {
        // Drop opening fence, inner frontmatter stays, drop closing fence line.
        const inner = lines.slice(1, i);
        const rest = lines.slice(i + 1);
        return [...inner, ...rest].join('\n');
      }
      if (trimmed.startsWith('# ')) {
        // Reached H1 without closing fence — abandon the strip.
        break;
      }
    }
  }
  return raw;
}

/**
 * Parse raw markdown content into frontmatter fields and body text.
 * Throws if the content does not begin with a valid frontmatter block.
 * Defensively strips an accidental ```yaml / ``` fence wrapper around
 * the frontmatter (see T-220); SCHEMA forbids fences, this is a safety net.
 */
export function parseFrontmatter(raw: string): { frontmatter: WikiFrontmatter; body: string } {
  raw = stripFrontmatterFence(raw);
  const lines = raw.split('\n');

  if ((lines[0] ?? '').trim() !== FM_DELIMITER) {
    throw new Error('Missing YAML frontmatter: file must start with ---');
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === FM_DELIMITER) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    throw new Error('Unclosed YAML frontmatter: no closing --- found');
  }

  const yamlContent = lines.slice(1, closeIdx).join('\n');
  const body = lines.slice(closeIdx + 1).join('\n');
  const parsed = parseSimpleYaml(yamlContent);

  const frontmatter: WikiFrontmatter = {
    type: String(parsed.type ?? ''),
    created: String(parsed.created ?? ''),
    updated: String(parsed.updated ?? ''),
    source_refs: Array.isArray(parsed.source_refs) ? (parsed.source_refs as string[]) : [],
    tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]) : [],
    confidence: (parsed.confidence as WikiFrontmatter['confidence']) ?? 'medium',
  };

  const statusVal = parsed.status as 'active' | 'archived' | undefined;
  if (statusVal !== undefined) {
    frontmatter.status = statusVal;
  }

  // Pass through any extra fields
  for (const [k, v] of Object.entries(parsed)) {
    if (!(k in frontmatter)) {
      frontmatter[k] = v;
    }
  }

  return { frontmatter, body };
}

/**
 * Format a complete wiki page file: YAML frontmatter block + markdown body.
 */
export function formatPage(frontmatter: WikiFrontmatter, body: string): string {
  const yaml = serializeFrontmatter(frontmatter);
  // Ensure body starts with a newline separator after the closing ---
  const normalizedBody = body.startsWith('\n') ? body : '\n' + body;
  return `${FM_DELIMITER}\n${yaml}\n${FM_DELIMITER}${normalizedBody}`;
}

// ---------------------------------------------------------------------------
// H1 title extraction
// ---------------------------------------------------------------------------

/**
 * Extract the H1 title from a markdown body.
 * Returns the text after the leading `# `, or undefined if not found.
 */
export function extractTitle(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse a wiki page from disk.
 *
 * @param wikiRoot  Absolute path to the wiki root directory (e.g. ~/.plumb/wiki)
 * @param relPath   Relative path of the file (e.g. "people/dylan-sellberg.md")
 */
export async function readWikiPage(wikiRoot: string, relPath: string): Promise<WikiPage> {
  const absPath = join(wikiRoot, relPath);
  const raw = await readFile(absPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const title = extractTitle(body);
  return { path: relPath, frontmatter, title, body };
}

/**
 * Write a wiki page to disk with correct formatting.
 * Creates parent directories as needed.
 * Never deletes existing files — only overwrites with new content.
 *
 * @param wikiRoot    Absolute path to the wiki root directory
 * @param relPath     Relative path (e.g. "people/dylan-sellberg.md")
 * @param frontmatter Page frontmatter fields
 * @param body        Markdown body (should start with H1 title)
 */
export async function writeWikiPage(
  wikiRoot: string,
  relPath: string,
  frontmatter: WikiFrontmatter,
  body: string,
): Promise<void> {
  const absPath = join(wikiRoot, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  const content = formatPage(frontmatter, body);
  await writeFile(absPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/** Files to skip when enumerating wiki pages (non-page metadata files). */
const SKIP_FILENAMES = new Set([
  'SCHEMA.md',
  'index.md',
  'log.md',
  'REVIEW.md',
  '_index.md',
]);

/** Filename prefixes to skip (meta reports, audits, evals). */
const SKIP_PREFIXES = ['AUDIT_', 'EVAL_', 'REPORT_'];

/**
 * Recursively list all wiki page .md files under wikiRoot.
 * Skips metadata files (SCHEMA.md, index.md, log.md, REVIEW.md, _index.md).
 * Excludes files in the archive/ subdirectory.
 *
 * Returns paths relative to wikiRoot, e.g. ["people/dylan-sellberg.md"].
 */
export async function listWikiPages(
  wikiRoot: string,
  { includeArchive = false }: { includeArchive?: boolean } = {},
): Promise<string[]> {
  const results: string[] = [];
  await walk(wikiRoot, wikiRoot, results, includeArchive);
  return results.sort();
}

async function walk(
  wikiRoot: string,
  dir: string,
  results: string[],
  includeArchive: boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const absEntry = join(dir, entry);
    const relEntry = relative(wikiRoot, absEntry);

    // Skip archive/ unless explicitly requested
    if (!includeArchive && relEntry === 'archive') continue;

    let isDir = false;
    try {
      const s = await stat(absEntry);
      isDir = s.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      await walk(wikiRoot, absEntry, results, includeArchive);
    } else if (
      extname(entry) === '.md' &&
      !SKIP_FILENAMES.has(entry) &&
      !SKIP_PREFIXES.some((prefix) => entry.startsWith(prefix))
    ) {
      results.push(relEntry);
    }
  }
}

// ---------------------------------------------------------------------------
// Hashing — SHA-256 of file content for external-edit detection
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a string (UTF-8 encoded).
 * Returns the hex digest (64 characters).
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read a file from disk and return its content hash.
 * Useful for computing the "current" hash to store in wiki_pages.
 */
export async function hashWikiPage(wikiRoot: string, relPath: string): Promise<string> {
  const absPath = join(wikiRoot, relPath);
  const content = await readFile(absPath, 'utf8');
  return hashContent(content);
}

/**
 * Detect whether a wiki page was modified outside the system (e.g. by Obsidian).
 *
 * Compares the SHA-256 hash of the file's current content against an expected
 * hash that was stored when the system last wrote the file.  A mismatch means
 * the file has been edited externally.
 *
 * @param wikiRoot     Absolute path to the wiki root directory
 * @param relPath      Relative path of the file
 * @param expectedHash Hex SHA-256 digest stored at last write time
 * @returns true if the file differs from expectedHash (externally modified)
 */
export async function isModifiedExternally(
  wikiRoot: string,
  relPath: string,
  expectedHash: string,
): Promise<boolean> {
  const currentHash = await hashWikiPage(wikiRoot, relPath);
  return currentHash !== expectedHash;
}

// ---------------------------------------------------------------------------
// Archive (soft-delete) — never rm
// ---------------------------------------------------------------------------

/**
 * Soft-delete a wiki page by moving it to archive/ and setting status: archived.
 *
 * Per SCHEMA.md §6: never use `rm`. Pages are moved to archive/ so that
 * rogue AI hallucination cannot destroy data permanently.
 *
 * @param wikiRoot  Absolute path to the wiki root directory
 * @param relPath   Relative path of the page to archive
 * @returns The new relative path inside archive/
 */
export async function archivePage(wikiRoot: string, relPath: string): Promise<string> {
  const absPath = join(wikiRoot, relPath);
  const raw = await readFile(absPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  // Set status to archived in frontmatter
  const archivedFm: WikiFrontmatter = { ...frontmatter, status: 'archived' };

  // Destination: archive/<original-relative-path>
  const archiveRelPath = join('archive', relPath);
  const archiveAbsPath = join(wikiRoot, archiveRelPath);
  mkdirSync(dirname(archiveAbsPath), { recursive: true });

  // Write updated content (with status: archived) to archive location
  const archivedContent = formatPage(archivedFm, body);
  await writeFile(archiveAbsPath, archivedContent, 'utf8');

  // Remove the original file now that the archive copy is safely written.
  // This is a programmatic move (write + unlink), not `rm` — the data is
  // preserved in archive/ per SCHEMA.md §6.
  await unlink(absPath);

  return archiveRelPath;
}
