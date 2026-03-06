/**
 * SQLite schema for Plumb LocalStore.
 *
 * Two tables per user (scoped by user_id column, NOT separate tables per user):
 *   - facts: Layer 2 structured fact graph (subject-predicate-object triples)
 *   - raw_log: Layer 1 lossless conversation chunks
 *
 * Design principles:
 *   - Soft deletes only: deleted_at timestamp, never hard delete
 *   - Cross-session by design: session info stored as metadata, not as a boundary
 *   - Indexes on high-cardinality query axes: user_id, session_id, timestamp, deleted_at
 */

export const CREATE_FACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS facts (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    subject             TEXT NOT NULL,
    predicate           TEXT NOT NULL,
    object              TEXT NOT NULL,
    confidence          REAL NOT NULL,
    decay_rate          TEXT NOT NULL,
    timestamp           TEXT NOT NULL,
    source_session_id   TEXT NOT NULL,
    source_session_label TEXT,
    context             TEXT,
    deleted_at          TEXT,
    source_chunk_id     TEXT
  )
`;

export const CREATE_FACTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_facts_user_id ON facts (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_session_id ON facts (source_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_timestamp ON facts (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_deleted_at ON facts (deleted_at)`,
];

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
    extract_status TEXT NOT NULL DEFAULT 'pending',
    extract_error TEXT,
    UNIQUE(user_id, content_hash)
  )
`;

export const CREATE_RAW_LOG_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_raw_log_user_id ON raw_log (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_session_id ON raw_log (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_timestamp ON raw_log (timestamp)`,
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
 * Embeddings table for vector search over facts.
 * Stores embeddings as JSON arrays (WASM-compatible, no native extension needed).
 */
export const CREATE_VEC_FACTS = `
  CREATE TABLE IF NOT EXISTS vec_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    embedding TEXT NOT NULL
  )
`;

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
  db.exec(CREATE_FACTS_TABLE);
  for (const idx of CREATE_FACTS_INDEXES) {
    db.exec(idx);
  }
  db.exec(CREATE_RAW_LOG_TABLE);
  for (const idx of CREATE_RAW_LOG_INDEXES) {
    db.exec(idx);
  }
  db.exec(CREATE_VEC_RAW_LOG);
  db.exec(CREATE_VEC_FACTS);

  // Conditional migration: add vec_rowid column to facts if it doesn't exist yet.
  const factsColumns = db.exec({
    sql: 'PRAGMA table_info(facts)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const hasVecRowid = factsColumns.some((c) => c.name === 'vec_rowid');
  if (!hasVecRowid) {
    db.exec('ALTER TABLE facts ADD COLUMN vec_rowid INTEGER');
  }

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

  // T-079: Conditional migration for processing state machine columns.
  // Refetch column info for raw_log and facts after prior migrations.
  const rawLogColumns2 = db.exec({
    sql: 'PRAGMA table_info(raw_log)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const factsColumns2 = db.exec({
    sql: 'PRAGMA table_info(facts)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;

  // Add new columns to raw_log if they don't exist.
  const hasEmbedStatus = rawLogColumns2.some((c) => c.name === 'embed_status');
  if (!hasEmbedStatus) {
    // Add new columns with defaults.
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_status TEXT NOT NULL DEFAULT \'pending\'');
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_error TEXT');
    db.exec('ALTER TABLE raw_log ADD COLUMN embed_model TEXT');
    db.exec('ALTER TABLE raw_log ADD COLUMN extract_status TEXT NOT NULL DEFAULT \'pending\'');
    db.exec('ALTER TABLE raw_log ADD COLUMN extract_error TEXT');

    // Backfill embed_status for existing rows based on vec_rowid.
    // Rows with vec_rowid already set -> embed_status='done', embed_model='Xenova/bge-small-en-v1.5'
    db.exec(`
      UPDATE raw_log
      SET embed_status = 'done', embed_model = 'Xenova/bge-small-en-v1.5'
      WHERE vec_rowid IS NOT NULL
    `);
    // Rows with vec_rowid=NULL remain embed_status='pending' (from DEFAULT).
    // All rows remain extract_status='pending' (from DEFAULT) — cannot infer which were extracted.
  }

  // Add source_chunk_id column to facts if it doesn't exist.
  const hasSourceChunkId = factsColumns2.some((c) => c.name === 'source_chunk_id');
  if (!hasSourceChunkId) {
    db.exec('ALTER TABLE facts ADD COLUMN source_chunk_id TEXT');
    // Existing facts have source_chunk_id=NULL (no retroactive mapping).
  }
}
