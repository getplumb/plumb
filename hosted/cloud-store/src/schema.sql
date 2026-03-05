-- Postgres schema for Plumb CloudStore (Supabase backend)
--
-- Functionally identical to LocalStore SQLite schema, but using Postgres types and pgvector.
--
-- Design principles:
--   - Soft deletes only: deleted_at timestamp, never hard delete
--   - Cross-session by design: session info stored as metadata, not as a boundary
--   - Indexes on high-cardinality query axes: user_id, session_id, timestamp, deleted_at
--   - pgvector for embeddings: vector(384) matches BAAI/bge-small-en-v1.5 output dimension

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Facts table (Layer 2 structured fact graph) ─────────────────────────────

CREATE TABLE IF NOT EXISTS facts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL,
  subject             TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object              TEXT NOT NULL,
  confidence          REAL NOT NULL,
  decay_rate          TEXT NOT NULL,
  timestamp           TIMESTAMPTZ NOT NULL,
  source_session_id   TEXT NOT NULL,
  source_session_label TEXT,
  context             TEXT,
  deleted_at          TIMESTAMPTZ,
  embedding           vector(384) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_user_id ON facts (user_id);
CREATE INDEX IF NOT EXISTS idx_facts_session_id ON facts (source_session_id);
CREATE INDEX IF NOT EXISTS idx_facts_timestamp ON facts (timestamp);
CREATE INDEX IF NOT EXISTS idx_facts_deleted_at ON facts (deleted_at);

-- pgvector index for KNN search (HNSW for better performance, IVFFLAT is alternative)
CREATE INDEX IF NOT EXISTS idx_facts_embedding ON facts USING ivfflat (embedding vector_cosine_ops);

-- ─── Raw log table (Layer 1 lossless conversation chunks) ────────────────────

CREATE TABLE IF NOT EXISTS raw_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  session_label TEXT,
  user_message  TEXT NOT NULL,
  agent_response TEXT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,
  source        TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  content_hash  TEXT,
  embedding     vector(384) NOT NULL,
  UNIQUE(user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_raw_log_user_id ON raw_log (user_id);
CREATE INDEX IF NOT EXISTS idx_raw_log_session_id ON raw_log (session_id);
CREATE INDEX IF NOT EXISTS idx_raw_log_timestamp ON raw_log (timestamp);

-- pgvector index for KNN search
CREATE INDEX IF NOT EXISTS idx_raw_log_embedding ON raw_log USING ivfflat (embedding vector_cosine_ops);

-- ─── Nudge log table (one-time upgrade prompts) ──────────────────────────────

CREATE TABLE IF NOT EXISTS nudge_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type  TEXT NOT NULL,
  fired_at      TIMESTAMPTZ NOT NULL
);

-- ─── API keys table (authentication for non-browser clients) ─────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hashed_key    TEXT NOT NULL UNIQUE,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hashed_key ON api_keys (hashed_key) WHERE revoked_at IS NULL;
