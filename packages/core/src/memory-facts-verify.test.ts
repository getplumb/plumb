import { test, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './local-store.js';

// T-118: Verify memory_facts table and ingest path

const dbPath = join(tmpdir(), `plumb-memory-facts-test-${Date.now()}.db`);
let store: LocalStore;

test('T-118: memory_facts table is created and ingestMemoryFact works', { timeout: 30_000 }, async () => {
  // Create store - should create memory_facts table via applySchema()
  store = await LocalStore.create({ dbPath, userId: 'test-user' });

  // Verify table exists
  const tables = store.db.exec({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_facts'`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;

  assert.equal(tables.length, 1, 'memory_facts table should exist');
  assert.equal(tables[0]?.name, 'memory_facts', 'table name should be memory_facts');

  // Ingest a memory fact
  const result = await store.ingestMemoryFact({
    content: 'User prefers TypeScript over JavaScript',
    sourceSessionId: 'test-session-123',
    tags: ['preference', 'language'],
  });

  assert.match(result.factId, /^[0-9a-f-]{36}$/, 'factId should be a UUID');

  // Verify fact was inserted
  const stmt = store.db.prepare(`
    SELECT id, user_id, content, source_session_id, tags, embed_status
    FROM memory_facts
    WHERE id = ?
  `);
  stmt.bind([result.factId]);
  stmt.step();
  const row = stmt.get({}) as any;
  stmt.finalize();

  assert.equal(row.user_id, 'test-user', 'user_id should match');
  assert.equal(row.content, 'User prefers TypeScript over JavaScript', 'content should match');
  assert.equal(row.source_session_id, 'test-session-123', 'source_session_id should match');
  assert.equal(row.tags, JSON.stringify(['preference', 'language']), 'tags should be JSON array');
  assert.equal(row.embed_status, 'pending', 'embed_status should be pending');
});

test('T-118: applySchema is idempotent', { timeout: 30_000 }, async () => {
  // Import directly to test idempotency
  const { applySchema } = await import('./schema.js');

  // Apply schema again - should not throw
  applySchema(store.db);

  // Verify table still exists and has correct structure
  const columns = store.db.exec({
    sql: 'PRAGMA table_info(memory_facts)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;

  const columnNames = columns.map(c => c.name);
  assert.ok(columnNames.includes('id'), 'should have id column');
  assert.ok(columnNames.includes('user_id'), 'should have user_id column');
  assert.ok(columnNames.includes('content'), 'should have content column');
  assert.ok(columnNames.includes('source_session_id'), 'should have source_session_id column');
  assert.ok(columnNames.includes('tags'), 'should have tags column');
  assert.ok(columnNames.includes('created_at'), 'should have created_at column');
  assert.ok(columnNames.includes('embed_status'), 'should have embed_status column');
  assert.ok(columnNames.includes('embed_error'), 'should have embed_error column');
  assert.ok(columnNames.includes('embed_model'), 'should have embed_model column');
  assert.ok(columnNames.includes('vec_rowid'), 'should have vec_rowid column');
});

after(() => {
  if (store) {
    store.close();
  }
});
