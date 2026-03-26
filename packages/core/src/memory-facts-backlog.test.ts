import { test, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from './local-store.js';

// T-118: Verify backlog processor handles memory_facts

const dbPath = join(tmpdir(), `plumb-memory-facts-backlog-test-${Date.now()}.db`);
let store: LocalStore;

test('T-118: backlog processor embeds memory_facts rows', { timeout: 60_000 }, async () => {
  // Create store with fast backlog processing
  store = await LocalStore.create({
    dbPath,
    userId: 'test-user',
    backlog: { embedIdleMs: 100 },
  });

  // Ingest a memory fact
  const result = await store.ingestMemoryFact({
    content: 'User prefers React over Vue for frontend development',
    sourceSessionId: 'test-session-456',
    tags: ['preference', 'framework'],
  });

  // Start backlog processor
  store.startBacklogProcessor();

  // Wait for embedding to complete (poll until embed_status is 'done')
  let embedStatus = 'pending';
  let attempts = 0;
  const maxAttempts = 300; // 30 seconds max (Windows CI can be slow on first ONNX load)

  while (embedStatus === 'pending' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));

    const stmt = store.db.prepare(`
      SELECT embed_status, embed_model, vec_rowid
      FROM memory_facts
      WHERE id = ?
    `);
    stmt.bind([result.factId]);
    stmt.step();
    const row = stmt.get({}) as any;
    stmt.finalize();

    embedStatus = row.embed_status;
    attempts++;

    if (embedStatus === 'done') {
      // Verify embedding was created
      assert.equal(row.embed_model, 'Xenova/bge-small-en-v1.5', 'embed_model should be set');
      assert.ok(row.vec_rowid > 0, 'vec_rowid should be set');

      // Verify vec_raw_log entry exists
      const vecStmt = store.db.prepare(`SELECT embedding FROM vec_raw_log WHERE rowid = ?`);
      vecStmt.bind([row.vec_rowid]);
      vecStmt.step();
      const vecRow = vecStmt.get({}) as any;
      vecStmt.finalize();

      assert.ok(vecRow.embedding, 'embedding should exist in vec_raw_log');
      assert.ok(typeof vecRow.embedding === 'string', 'embedding should be JSON string');
    }
  }

  assert.equal(embedStatus, 'done', 'embedding should complete within 30 seconds');

  // Stop backlog processor
  await store.stopBacklogProcessor();
});

after(async () => {
  if (store) {
    await store.close();
  }
});
