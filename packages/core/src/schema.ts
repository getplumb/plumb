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
    deleted_at          TEXT
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
    vec_rowid     INTEGER
  )
`;

export const CREATE_RAW_LOG_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_raw_log_user_id ON raw_log (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_session_id ON raw_log (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_raw_log_timestamp ON raw_log (timestamp)`,
];

/**
 * sqlite-vec virtual table for KNN vector search over raw_log chunks.
 * Rowid mirrors the raw_log SQLite rowid for O(1) joins without a separate mapping table.
 * FLOAT[384] matches BAAI/bge-small-en-v1.5 output dimension.
 */
export const CREATE_VEC_RAW_LOG = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_raw_log USING vec0(
    embedding FLOAT[384]
  )
`;

/**
 * sqlite-vec virtual table for KNN vector search over facts.
 * FLOAT[384] matches BAAI/bge-small-en-v1.5 output dimension.
 */
export const CREATE_VEC_FACTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
    embedding FLOAT[384]
  )
`;

export function applySchema(db: import('better-sqlite3').Database): void {
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
  const columns = db.pragma('table_info(facts)') as Array<{ name: string }>;
  const hasVecRowid = columns.some((c) => c.name === 'vec_rowid');
  if (!hasVecRowid) {
    db.exec('ALTER TABLE facts ADD COLUMN vec_rowid INTEGER');
  }
}
