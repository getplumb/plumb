/**
 * @plumb/cloud-store — Hosted storage driver for Plumb using Supabase (Postgres + pgvector).
 *
 * Drop-in replacement for LocalStore (@plumb/core) — implements the same MemoryStore interface
 * but uses Postgres + pgvector instead of SQLite + sqlite-vec.
 *
 * License: BSL 1.1 (Business Source License)
 */

export { CloudStore, type CloudStoreOptions, type RawLogSearchResult } from './cloud-store.js';
