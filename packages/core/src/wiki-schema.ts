/**
 * SQLite schema for Plumb wiki.db.
 *
 * Tables:
 *   - wiki_pages:     Page metadata (type, title, frontmatter fields, status)
 *   - wiki_chunks:    Text chunks for embedding/search (keyed by page_id + chunk_index)
 *   - wiki_links:     Wikilink graph — inbound/outbound links between pages
 *   - wiki_changelog: Append-only audit trail of page-level actions
 *
 * Foreign keys are enabled by the caller (PRAGMA foreign_keys = ON).
 * All tables use CREATE IF NOT EXISTS for safe idempotent initialization.
 */

import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, type WasmDb } from './wasm-db.js';

// ---------------------------------------------------------------------------
// Table DDL
// ---------------------------------------------------------------------------

/**
 * wiki_pages — one row per wiki markdown file.
 *
 * id:           Canonical slug, e.g. "people/dylan-sellberg"
 * path:         Relative filesystem path, e.g. "people/dylan-sellberg.md"
 * type:         Page type from §2 of SCHEMA.md
 * title:        H1 title of the page
 * created:      YYYY-MM-DD (from frontmatter; never changes)
 * updated:      YYYY-MM-DD (from frontmatter; updated on each write)
 * confidence:   high | medium | low
 * tags:         JSON array of lowercase-hyphenated strings
 * source_refs:  JSON array of source reference strings
 * status:       active | archived
 * word_count:   Approximate word count for chunking decisions
 * content_hash: SHA-256 of raw file content for incremental re-embed detection
 */
export const CREATE_WIKI_PAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS wiki_pages (
    id           TEXT    PRIMARY KEY,
    path         TEXT    NOT NULL UNIQUE,
    type         TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    created      TEXT    NOT NULL,
    updated      TEXT    NOT NULL,
    confidence   TEXT    NOT NULL DEFAULT 'medium',
    tags         TEXT,
    source_refs  TEXT,
    status       TEXT    NOT NULL DEFAULT 'active',
    word_count   INTEGER,
    content_hash TEXT
  )
`;

export const CREATE_WIKI_PAGES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_type   ON wiki_pages (type)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_status ON wiki_pages (status)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated ON wiki_pages (updated)`,
];

/**
 * wiki_chunks — text chunks derived from a wiki page for embedding/search.
 *
 * page_id:      FK → wiki_pages.id
 * chunk_index:  Zero-based position within the page (for reconstruction order)
 * content:      The chunk text
 * section:      H2 heading that contains this chunk (empty string for pre-H2 content)
 * embed_status: pending | done | failed
 * embed_model:  Model name when embed_status = 'done'
 * vec_rowid:    Row in the shared vec_raw_log table (null until embedded)
 * embedding:    JSON-serialized Float32Array embedding vector
 */
export const CREATE_WIKI_CHUNKS_TABLE = `
  CREATE TABLE IF NOT EXISTS wiki_chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id      TEXT    NOT NULL REFERENCES wiki_pages(id),
    chunk_index  INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    section      TEXT    NOT NULL DEFAULT '',
    embed_status TEXT    NOT NULL DEFAULT 'pending',
    embed_error  TEXT,
    embed_model  TEXT,
    vec_rowid    INTEGER,
    embedding    TEXT,
    UNIQUE (page_id, chunk_index)
  )
`;

export const CREATE_WIKI_CHUNKS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_wiki_chunks_page_id      ON wiki_chunks (page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_chunks_embed_status ON wiki_chunks (embed_status)`,
];

/**
 * wiki_fts — FTS5 virtual table over wiki_chunks for BM25 keyword search.
 *
 * Uses content= mode pointing at wiki_chunks so SQLite manages the FTS index
 * without duplicating chunk_text in a separate storage table.
 * content_rowid='id' maps the FTS rowid to wiki_chunks.id.
 *
 * Triggers (wiki_chunks_ai/bd/bu/au) keep the FTS index in sync with
 * INSERT/DELETE/UPDATE operations on wiki_chunks.
 *
 * BM25 search: SELECT rowid, rank FROM wiki_fts WHERE wiki_fts MATCH ?
 * The rank column returns a negative float; ORDER BY rank ASC = best first.
 */
export const CREATE_WIKI_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts
  USING fts5(
    content,
    section,
    content='wiki_chunks',
    content_rowid='id'
  )
`;

export const CREATE_WIKI_FTS_TRIGGERS = [
  // After INSERT: add new chunk to FTS index
  `CREATE TRIGGER IF NOT EXISTS wiki_chunks_ai
   AFTER INSERT ON wiki_chunks BEGIN
     INSERT INTO wiki_fts(rowid, content, section)
     VALUES (new.id, new.content, new.section);
   END`,

  // Before DELETE: remove chunk from FTS index
  `CREATE TRIGGER IF NOT EXISTS wiki_chunks_bd
   BEFORE DELETE ON wiki_chunks BEGIN
     INSERT INTO wiki_fts(wiki_fts, rowid, content, section)
     VALUES ('delete', old.id, old.content, old.section);
   END`,

  // Before UPDATE: remove old entry from FTS index
  `CREATE TRIGGER IF NOT EXISTS wiki_chunks_bu
   BEFORE UPDATE ON wiki_chunks BEGIN
     INSERT INTO wiki_fts(wiki_fts, rowid, content, section)
     VALUES ('delete', old.id, old.content, old.section);
   END`,

  // After UPDATE: add new entry to FTS index
  `CREATE TRIGGER IF NOT EXISTS wiki_chunks_au
   AFTER UPDATE ON wiki_chunks BEGIN
     INSERT INTO wiki_fts(rowid, content, section)
     VALUES (new.id, new.content, new.section);
   END`,
];

/**
 * wiki_links — wikilink graph between pages.
 *
 * source_page_id: FK → wiki_pages.id (the page containing the [[wikilink]])
 * target_title:   Display name inside brackets, e.g. "Dylan Sellberg"
 * target_page_id: FK → wiki_pages.id if resolved; NULL if the target page does not yet exist
 * resolved:       1 if target_page_id is populated, 0 if still dangling
 */
export const CREATE_WIKI_LINKS_TABLE = `
  CREATE TABLE IF NOT EXISTS wiki_links (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_page_id TEXT    NOT NULL REFERENCES wiki_pages(id),
    target_title   TEXT    NOT NULL,
    target_page_id TEXT    REFERENCES wiki_pages(id),
    resolved       INTEGER NOT NULL DEFAULT 0
  )
`;

export const CREATE_WIKI_LINKS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_wiki_links_source ON wiki_links (source_page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_links_target ON wiki_links (target_page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_links_resolved ON wiki_links (resolved)`,
];

/**
 * wiki_changelog — append-only audit trail.
 *
 * page_id:    FK → wiki_pages.id; NULL for system-level events not tied to a page
 * action:     created | updated | archived | chunk_added | link_resolved | link_removed
 * detail:     JSON or free text with action-specific context
 * source_ref: The source that triggered the change (e.g. "plumb:abc123", "chat:2026-04-15")
 * created_at: ISO 8601 timestamp
 */
export const CREATE_WIKI_CHANGELOG_TABLE = `
  CREATE TABLE IF NOT EXISTS wiki_changelog (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id    TEXT    REFERENCES wiki_pages(id),
    action     TEXT    NOT NULL,
    detail     TEXT,
    source_ref TEXT,
    created_at TEXT    NOT NULL
  )
`;

export const CREATE_WIKI_CHANGELOG_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_wiki_changelog_page_id    ON wiki_changelog (page_id)`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_changelog_created_at ON wiki_changelog (created_at)`,
];

// ---------------------------------------------------------------------------
// Schema application
// ---------------------------------------------------------------------------

/**
 * Apply the wiki schema to an open database connection.
 * Idempotent: uses CREATE IF NOT EXISTS throughout.
 * Also runs ALTER TABLE migrations for columns added after initial schema creation.
 * Caller must have already run: PRAGMA foreign_keys = ON
 */
export function applyWikiSchema(db: WasmDb): void {
  db.exec(CREATE_WIKI_PAGES_TABLE);
  for (const idx of CREATE_WIKI_PAGES_INDEXES) db.exec(idx);

  db.exec(CREATE_WIKI_CHUNKS_TABLE);
  for (const idx of CREATE_WIKI_CHUNKS_INDEXES) db.exec(idx);

  db.exec(CREATE_WIKI_LINKS_TABLE);
  for (const idx of CREATE_WIKI_LINKS_INDEXES) db.exec(idx);

  db.exec(CREATE_WIKI_CHANGELOG_TABLE);
  for (const idx of CREATE_WIKI_CHANGELOG_INDEXES) db.exec(idx);

  // FTS5 virtual table and sync triggers
  db.exec(CREATE_WIKI_FTS_TABLE);
  for (const trigger of CREATE_WIKI_FTS_TRIGGERS) db.exec(trigger);

  // Migrations: add new columns to existing tables if they don't exist yet.
  // This handles wiki.db files created before these columns were added.
  const pagesColumns = db.exec({
    sql: 'PRAGMA table_info(wiki_pages)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const pagesColNames = new Set(pagesColumns.map((c) => c.name));
  if (!pagesColNames.has('content_hash')) {
    db.exec(`ALTER TABLE wiki_pages ADD COLUMN content_hash TEXT`);
  }

  const chunksColumns = db.exec({
    sql: 'PRAGMA table_info(wiki_chunks)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const chunksColNames = new Set(chunksColumns.map((c) => c.name));
  if (!chunksColNames.has('embedding')) {
    db.exec(`ALTER TABLE wiki_chunks ADD COLUMN embedding TEXT`);
  }
  if (!chunksColNames.has('section')) {
    db.exec(`ALTER TABLE wiki_chunks ADD COLUMN section TEXT NOT NULL DEFAULT ''`);
  }

  // Rebuild FTS index from existing wiki_chunks rows if the table was just
  // created (or was empty). This handles databases that had rows before the
  // FTS table was added — we insert all existing done chunks into the index.
  const ftsCount = db.selectValue(`SELECT count(*) FROM wiki_fts`) as number ?? 0;
  const chunkCount = db.selectValue(
    `SELECT count(*) FROM wiki_chunks WHERE embed_status = 'done'`,
  ) as number ?? 0;
  if (ftsCount === 0 && chunkCount > 0) {
    db.exec(`
      INSERT INTO wiki_fts(rowid, content, section)
      SELECT id, content, COALESCE(section, '') FROM wiki_chunks WHERE embed_status = 'done'
    `);
  }
}

// ---------------------------------------------------------------------------
// WikiStore — thin wrapper for wiki.db lifecycle
// ---------------------------------------------------------------------------

export interface WikiStoreOptions {
  /** Absolute path to the wiki SQLite database. Defaults to ~/.plumb/wiki.db */
  dbPath?: string;
}

/**
 * WikiStore manages the wiki.db SQLite database.
 *
 * Responsibilities:
 *   - Open (or create) wiki.db at the configured path
 *   - Apply the schema idempotently on first open
 *   - Provide a raw db handle for higher-level modules (indexer, search, etc.)
 *
 * Out of scope (handled by future tasks):
 *   - Populating the database from markdown files
 *   - Embedding pipeline
 *   - Search queries
 */
export class WikiStore {
  readonly #db: WasmDb;

  private constructor(db: WasmDb) {
    this.#db = db;
  }

  /** Raw database handle for use by higher-level modules. */
  get db(): WasmDb {
    return this.#db;
  }

  /**
   * Open (or create) wiki.db and apply the schema.
   * Creates the parent directory if it doesn't exist.
   */
  static async create(options: WikiStoreOptions = {}): Promise<WikiStore> {
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');

    mkdirSync(dirname(dbPath), { recursive: true });

    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    applyWikiSchema(db);

    return new WikiStore(db);
  }

  /** Close the database connection. */
  close(): void {
    this.#db.close();
  }
}
