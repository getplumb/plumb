/**
 * SQLite schema for Plumb LocalStore.
 *
 * Tables:
 *   - memory_facts: Curated facts written by the agent via plumb_remember
 *   - nudge_log: One-time upgrade prompt tracking
 *
 * Design principles:
 *   - Cross-session by design: session info stored as metadata, not as a boundary
 *   - Indexes on high-cardinality query axes: user_id, embed_status
 */

/**
 * Memory facts table for curated, high-signal facts written by Terra.
 * Each fact is a short, dense piece of information stored as a single chunk.
 *
 * subject/predicate/object store the structured fact components.
 * confidence (0–1) and decay_rate ('slow'|'medium'|'fast') drive scoring.
 * source_session_label is optional human-readable session name for provenance.
 */
export const CREATE_MEMORY_FACTS_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_facts (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL,
    content              TEXT NOT NULL,
    subject              TEXT,
    predicate            TEXT,
    object               TEXT,
    confidence           REAL NOT NULL DEFAULT 0.9,
    decay_rate           TEXT NOT NULL DEFAULT 'slow',
    source_session_id    TEXT NOT NULL,
    source_session_label TEXT,
    tags                 TEXT,
    created_at           TEXT NOT NULL,
    deleted_at           TEXT,
    embed_status         TEXT NOT NULL DEFAULT 'pending',
    embed_error          TEXT,
    embed_model          TEXT,
    vec_rowid            INTEGER
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
  // Conditional migration: create nudge_log table if it doesn't exist yet.
  const tables = db.exec({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='nudge_log'`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  if (tables.length === 0) {
    db.exec(CREATE_NUDGE_LOG_TABLE);
  }

  // T-118: Create memory_facts table if it doesn't exist (for curated facts from agent).
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
  } else {
    // Conditional migration: add structured fact columns to existing memory_facts table.
    const memFactColumns = db.exec({
      sql: 'PRAGMA table_info(memory_facts)',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ name: string }>;
    const memFactColNames = new Set(memFactColumns.map((c) => c.name));

    if (!memFactColNames.has('subject')) db.exec(`ALTER TABLE memory_facts ADD COLUMN subject TEXT`);
    if (!memFactColNames.has('predicate')) db.exec(`ALTER TABLE memory_facts ADD COLUMN predicate TEXT`);
    if (!memFactColNames.has('object')) db.exec(`ALTER TABLE memory_facts ADD COLUMN "object" TEXT`);
    if (!memFactColNames.has('confidence')) db.exec(`ALTER TABLE memory_facts ADD COLUMN confidence REAL NOT NULL DEFAULT 0.9`);
    if (!memFactColNames.has('decay_rate')) db.exec(`ALTER TABLE memory_facts ADD COLUMN decay_rate TEXT NOT NULL DEFAULT 'slow'`);
    if (!memFactColNames.has('source_session_label')) db.exec(`ALTER TABLE memory_facts ADD COLUMN source_session_label TEXT`);
    if (!memFactColNames.has('deleted_at')) db.exec(`ALTER TABLE memory_facts ADD COLUMN deleted_at TEXT`);
  }

  // T-128: Share vec_raw_log for memory_facts embeddings (table may exist from old raw_log usage)
  // Create only if it doesn't exist - this allows existing DBs to continue working
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_raw_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      embedding TEXT NOT NULL
    )
  `);
}
