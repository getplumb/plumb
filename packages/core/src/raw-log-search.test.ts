/**
 * Tests for Layer 1 hybrid search (raw-log-search.ts).
 *
 * Ingests 3 exchanges with distinct topics, then verifies that searchRawLog()
 * returns ranked results with the expected structure.
 *
 * Note: The first test run downloads the BAAI/bge-small-en-v1.5 embedding model
 * (~100 MB) and the ms-marco cross-encoder (~50 MB) — subsequent runs use the
 * local ~/.cache/huggingface/ cache.  Tests are marked with a generous timeout.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LocalStore } from './local-store.js';

const dbPath = join(tmpdir(), `plumb-search-test-${Date.now()}.db`);
const store = new LocalStore({ dbPath, userId: 'search-test-user' });

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EXCHANGES = [
  {
    userMessage: 'How do I configure TypeScript strict mode?',
    agentResponse:
      'Enable strict mode in tsconfig.json by setting "strict": true. ' +
      'This enables noImplicitAny, strictNullChecks, and several other checks ' +
      'that catch common bugs at compile time.',
    sessionId: 'session-ts',
    sessionLabel: 'typescript-help',
    source: 'openclaw' as const,
    timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
  },
  {
    userMessage: 'What is the best recipe for chocolate cake?',
    agentResponse:
      'For a classic chocolate cake, cream 200g butter with 200g sugar, ' +
      'beat in 4 eggs, fold in 175g self-raising flour and 50g cocoa powder. ' +
      'Bake at 180°C for 30 minutes. Frost with ganache when cool.',
    sessionId: 'session-recipe',
    sessionLabel: 'cooking-chat',
    source: 'openclaw' as const,
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
  },
  {
    userMessage: 'Explain SQLite WAL mode and when to use it.',
    agentResponse:
      'WAL (Write-Ahead Log) mode improves SQLite concurrency by allowing ' +
      'readers to proceed while a writer is active. Enable it with PRAGMA ' +
      'journal_mode = WAL. It is recommended for applications with multiple ' +
      'readers and infrequent writers, like desktop apps and local servers.',
    sessionId: 'session-sqlite',
    sessionLabel: 'database-chat',
    source: 'claude-code' as const,
    timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
  },
];

// ─── Ingest (shared setup) ───────────────────────────────────────────────────

test('ingest 3 exchanges with distinct topics', { timeout: 120_000 }, async () => {
  for (const exchange of EXCHANGES) {
    const result = await store.ingest(exchange);
    assert.match(result.rawLogId, /^[0-9a-f-]{36}$/, 'rawLogId should be a UUID');
  }

  const status = await store.status();
  assert.equal(status.rawLogCount, 3, 'all 3 exchanges should be in raw_log');
});

// ─── Search ──────────────────────────────────────────────────────────────────

test('searchRawLog returns results with required fields', { timeout: 120_000 }, async () => {
  const results = await store.searchRawLog('TypeScript configuration', 3);

  assert.ok(results.length > 0, 'should return at least one result');

  for (const r of results) {
    assert.ok(typeof r.chunk_text === 'string', 'chunk_text must be a string');
    assert.ok(typeof r.session_id === 'string', 'session_id must be a string');
    assert.ok(typeof r.timestamp === 'string', 'timestamp must be a string');
    assert.ok(typeof r.final_score === 'number', 'final_score must be a number');
    // session_label may be null
    assert.ok(
      r.session_label === null || typeof r.session_label === 'string',
      'session_label must be string or null',
    );
  }
});

test('searchRawLog ranks TypeScript exchange first for TS query', { timeout: 120_000 }, async () => {
  const results = await store.searchRawLog('TypeScript strict mode tsconfig', 3);

  assert.ok(results.length > 0, 'should return results');
  const top = results[0];
  assert.ok(top !== undefined, 'should have a top result');
  // The TypeScript exchange should rank first (or at least in top 2).
  const tsResult = results.find((r) => r.session_id === 'session-ts');
  assert.ok(tsResult !== undefined, 'TypeScript exchange should appear in results');

  // Top result should be the TS exchange (semantic match is strong).
  assert.equal(top.session_id, 'session-ts', 'TypeScript exchange should rank #1');
});

test('searchRawLog returns SQLite exchange in top results for database query', { timeout: 120_000 }, async () => {
  const results = await store.searchRawLog('SQLite WAL journal mode database', 3);

  assert.ok(results.length > 0, 'should return results');
  // SQLite exchange should appear in top-3 results — exact rank depends on model scores.
  const sqliteResult = results.find((r) => r.session_id === 'session-sqlite');
  assert.ok(sqliteResult !== undefined, 'SQLite exchange should appear in top-3 results');
  // The recipe exchange (no SQLite content) should NOT rank above SQLite.
  const recipeRank = results.findIndex((r) => r.session_id === 'session-recipe');
  const sqliteRank = results.findIndex((r) => r.session_id === 'session-sqlite');
  assert.ok(
    recipeRank === -1 || sqliteRank < recipeRank,
    'SQLite exchange should outrank the recipe exchange for a database query',
  );
});

test('searchRawLog is cross-session (no session filter applied)', { timeout: 120_000 }, async () => {
  // A broad query — all 3 sessions should be retrievable.
  const results = await store.searchRawLog('what did we discuss', 3);
  // We just check structure — cross-session means limit=3 can return up to all 3.
  assert.ok(results.length <= 3);
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(['session-ts', 'session-recipe', 'session-sqlite'].includes(r.session_id));
  }
});

test('searchRawLog returns empty array when no rows exist', { timeout: 30_000 }, async () => {
  const emptyStore = new LocalStore({
    dbPath: join(tmpdir(), `plumb-empty-${Date.now()}.db`),
    userId: 'empty-user',
  });
  try {
    const results = await emptyStore.searchRawLog('anything', 5);
    assert.deepEqual(results, []);
  } finally {
    emptyStore.close();
  }
});
