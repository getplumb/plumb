/**
 * tombstone.ts — Anti-regression tombstone table in wiki.db.
 *
 * Problem: the writer could re-add content that Clay manually deleted.
 * Solution: when git diff shows a sentence was manually removed from a wiki
 * page, record its SHA-256 hash in wiki_tombstones with a 30-day TTL.
 * Before emitting any patch, the writer checks tombstones and skips adding
 * text that matches an active tombstone.
 *
 * Schema:
 *   wiki_tombstones (hash TEXT PK, source TEXT, created_at TEXT, expires_at TEXT)
 *
 * The tombstone hash is sha256(normalizeSentence(sentence)).
 * Normalization: trim, collapse whitespace, lowercase.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { WasmDb } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOMBSTONE_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TOMBSTONES_TABLE = `
  CREATE TABLE IF NOT EXISTS wiki_tombstones (
    hash        TEXT    PRIMARY KEY,
    source      TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL
  )
`;

const CREATE_TOMBSTONES_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_wiki_tombstones_expires ON wiki_tombstones (expires_at)
`;

/**
 * Ensure the wiki_tombstones table exists in wiki.db.
 * Safe to call on every worker startup — uses CREATE IF NOT EXISTS.
 */
export function ensureTombstoneTable(db: WasmDb): void {
  db.exec(CREATE_TOMBSTONES_TABLE);
  db.exec(CREATE_TOMBSTONES_INDEX);
}

// ---------------------------------------------------------------------------
// Normalization and hashing
// ---------------------------------------------------------------------------

/** Normalize a sentence for tombstone comparison. */
export function normalizeSentence(sentence: string): string {
  return sentence.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SHA-256 hash of the normalized sentence. */
export function hashSentence(sentence: string): string {
  return createHash('sha256').update(normalizeSentence(sentence)).digest('hex');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Add a tombstone for a manually-deleted sentence.
 * If a tombstone for this hash already exists, refreshes the TTL.
 */
export function addTombstone(db: WasmDb, sentence: string, source = 'git-diff'): void {
  const hash = hashSentence(sentence);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const stmt = db.prepare(`
    INSERT INTO wiki_tombstones (hash, source, created_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      source     = excluded.source,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  stmt.bind([hash, source, now.toISOString(), expiresAt.toISOString()]);
  stmt.step();
  stmt.finalize();
}

/**
 * Return true if any sentence in `text` matches an active (non-expired) tombstone.
 * Splits text into sentences on ". " or "\n" boundaries.
 */
export function isTombstoned(db: WasmDb, text: string): boolean {
  const now = new Date().toISOString();

  // Split text into candidate sentences for checking
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (sentence.length < 10) continue; // Too short to be meaningful
    const hash = hashSentence(sentence);
    const h = hash.replace(/'/g, "''");
    const n = now.replace(/'/g, "''");
    const rows = db.exec({
      sql: `SELECT hash FROM wiki_tombstones WHERE hash = '${h}' AND expires_at > '${n}'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ hash: string }>;
    if (rows.length > 0) return true;
  }
  return false;
}

/**
 * Return hashes of all tombstoned sentences that appear in `text`.
 * Used to filter individual sentences from patch content.
 */
export function getTombstonedSentences(db: WasmDb, text: string): Set<string> {
  const now = new Date().toISOString();
  const result = new Set<string>();

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (sentence.length < 10) continue;
    const hash = hashSentence(sentence);
    const h = hash.replace(/'/g, "''");
    const n = now.replace(/'/g, "''");
    const rows = db.exec({
      sql: `SELECT hash FROM wiki_tombstones WHERE hash = '${h}' AND expires_at > '${n}'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ hash: string }>;
    if (rows.length > 0) result.add(hash);
  }
  return result;
}

/** Remove all expired tombstones. Call periodically to keep the table clean. */
export function pruneExpiredTombstones(db: WasmDb): number {
  const now = new Date().toISOString();
  db.exec(`DELETE FROM wiki_tombstones WHERE expires_at <= '${now.replace(/'/g, "''")}'`);
  // Return approximate count (the wasm db doesn't expose changes() easily)
  return 0;
}

// ---------------------------------------------------------------------------
// Git diff tombstone collection
// ---------------------------------------------------------------------------

/**
 * Scan git diff for manually-deleted lines in the wiki directory and create
 * tombstones for each removed sentence-like line.
 *
 * Only looks at lines that start with `-` (deletions) and skips frontmatter
 * (lines between `---` markers) and heading lines (start with `#`).
 *
 * @param wikiRoot  Absolute path to the wiki git repository
 * @param db        Open wiki.db handle with tombstone table applied
 * @returns         Number of tombstones created
 */
export function scanGitDiffForDeletions(wikiRoot: string, db: WasmDb): number {
  // Verify this is a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: wikiRoot, stdio: 'pipe' });
  } catch {
    return 0; // Not a git repo — skip
  }

  let diffOutput: string;
  try {
    // Diff staged + unstaged changes vs HEAD
    diffOutput = execSync('git diff HEAD -- "*.md"', {
      cwd: wikiRoot,
      stdio: 'pipe',
    }).toString('utf8');
  } catch {
    return 0;
  }

  if (!diffOutput.trim()) return 0;

  let count = 0;
  let inFrontmatter = false;
  let frontmatterCount = 0;

  for (const line of diffOutput.split('\n')) {
    // Track frontmatter boundaries (--- markers)
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      if (line === '---' || (line.startsWith('---') && !line.startsWith('--- a/'))) {
        frontmatterCount++;
        if (frontmatterCount % 2 === 1) inFrontmatter = true;
        else inFrontmatter = false;
      }
      continue;
    }

    // Only process deletion lines
    if (!line.startsWith('-')) continue;
    const content = line.slice(1).trim();

    // Skip frontmatter, headings, wikilinks-only lines, empty lines
    if (inFrontmatter) continue;
    if (content.startsWith('#')) continue;
    if (content.startsWith('---')) continue;
    if (content.length < 20) continue;
    if (/^\[\[.*\]\]$/.test(content)) continue; // Pure wikilink line

    addTombstone(db, content, 'git-diff');
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split text into sentence-like fragments for tombstone matching. */
function splitSentences(text: string): string[] {
  // Split on ". " or "\n" — crude but effective for wiki prose
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Further split long lines on sentence boundaries
    for (const sentence of trimmed.split(/\.\s+/)) {
      const s = sentence.trim();
      if (s) parts.push(s);
    }
  }
  return parts;
}
