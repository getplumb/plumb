/**
 * SQLite schema for Plumb LocalStore.
 *
 * Single table per user (scoped by user_id column):
 *   - raw_log: Lossless conversation chunks with vector embeddings
 *
 * Design principles:
 *   - Cross-session by design: session info stored as metadata, not as a boundary
 *   - Indexes on high-cardinality query axes: user_id, session_id, timestamp
 */

export const CREATE_RAW_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS raw_log (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    session_label TEXT,
    user_message  TEXT NOT NULL,
    agent_response TEXT NOT NULL,
    timestamp     TEXT NOT NULL,
    source        TEXT NOT NULL,
    chunk_text    TEXT NOT NULL,
    chunk_index   INTEGER NOT NULL,
    vec_rowid     INTEGER,
    content_hash  TEXT,
    embed_status  TEXT NOT NULL DEFAULT 'pending',
    embed_error   TEXT,
    embed_model   TEXT,
    parent_id     TEXT REFERENCES raw_log(id),
    UNIQUE(user_id, content_hash)
  )
`;

export const CREATE_RAW_LOG_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_raw_log_user_id ON raw_log (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_session_id ON raw_log (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_timestamp ON raw_log (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_parent_id ON raw_log (parent_id)`,
];

/**
 * Embeddings table for vector search over raw_log chunks.
 * Stores embeddings as JSON arrays (WASM-compatible, no native extension needed).
 */
export const CREATE_VEC_RAW_LOG = `
  CREATE TABLE IF NOT EXISTS vec_raw_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    embedding TEXT NOT NULL
  )
`;

/**
 * Memory facts table for curated, high-signal facts written by Terra.
 * Each fact is a short, dense piece of information stored as a single chunk.
 */
export const CREATE_MEMORY_FACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_facts (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    content       TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    tags          TEXT,
    created_at    TEXT NOT NULL,
    embed_status  TEXT NOT NULL DEFAULT 'pending',
    embed_error   TEXT,
    embed_model   TEXT,
    vec_rowid     INTEGER
  )
`;

export const CREATE_MEMORY_FACTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memory_facts_user_id ON memory_facts (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_facts_embed_status ON memory_facts (embed_status)`,
];

/**
 * Nudge log table for tracking one-time upgrade prompts.
 * Each trigger type fires exactly once per install.
 */
export const CREATE_NUDGE_LOG_TABLE = `
  CREATE TABLE IF NOT EXISTS nudge_log (
    id            TEXT PRIMARY KEY,
    trigger_type  TEXT NOT NULL,
    fired_at      TEXT NOT NULL
  )
`;

export function applySchema(db: import('./wasm-db.js').WasmDb): void {
  db.exec(CREATE_RAW_LOG_TABLE);
  for (const idx of CREATE_RAW_LOG_INDEXES) {
    db.exec(idx);
  }
  db.exec(CREATE_VEC_RAW_LOG);

  // Conditional migration: add content_hash column to raw_log if it doesn't exist yet.
  const rawLogColumns = db.exec({
    sql: 'PRAGMA table_info(raw_log)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const hasContentHash = rawLogColumns.some((c) => c.name === 'content_hash');
  if (!hasContentHash) {
    db.exec('ALTER TABLE raw_log ADD COLUMN content_hash TEXT');
    // Create unique constraint on (user_id, content_hash).
    // SQLite UNIQUE constraints ignore NULL values, so existing rows with NULL won't conflict.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_log_content_hash ON raw_log(user_id, content_hash)');
  }

  // Conditional migration: create nudge_log table if it doesn't exist yet.
  const tables = db.exec({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='nudge_log'`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  if (tables.length === 0) {
    db.exec(CREATE_NUDGE_LOG_TABLE);
  }

  // T-079: Conditional migration for processing state machine columns (embed only).
  const rawLogColumns2 = db.exec({
    sql: 'PRAGMA table_info(raw_log)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;

  // Add embed columns to raw_log if they don't exist.
  const hasEmbedStatus = rawLogColumns2.some((c) => c.name === 'embed_status');
  if (!hasEmbedStatus) {
    // Add embed columns with defaults.
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_status TEXT NOT NULL DEFAULT \'pending\'');
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_error TEXT');
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_model TEXT');

    // Backfill embed_status for existing rows based on vec_rowid.
    // Rows with vec_rowid already set -> embed_status='done', embed_model='Xenova/bge-small-en-v1.5'
    db.exec(`
      UPDATE raw_log
      SET embed_status = 'done', embed_model = 'Xenova/bge-small-en-v1.5'
      WHERE vec_rowid IS NOT NULL
    `);
    // Rows with vec_rowid=NULL remain embed_status='pending' (from DEFAULT).
  }

  // T-108: Add parent_id column to raw_log if it doesn't exist (for parent-child chunking).
  const rawLogColumns3 = db.exec({
    sql: 'PRAGMA table_info(raw_log)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const hasParentId = rawLogColumns3.some((c) => c.name === 'parent_id');
  if (!hasParentId) {
    db.exec('ALTER TABLE raw_log ADD COLUMN parent_id TEXT REFERENCES raw_log(id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_raw_log_parent_id ON raw_log (parent_id)');
    // Existing rows have parent_id=NULL (they are parent-only rows, treated as searchable fallback).
  }

  // T-118: Create memory_facts table if it doesn't exist (for curated facts from Terra).
  const memoryFactsTables = db.exec({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_facts'`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  if (memoryFactsTables.length === 0) {
    db.exec(CREATE_MEMORY_FACTS_TABLE);
    for (const idx of CREATE_MEMORY_FACTS_INDEXES) {
      db.exec(idx);
    }
  }
}
