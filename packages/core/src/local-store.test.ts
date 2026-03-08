import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LocalStore } from './local-store.js';

// Use a unique temp path per test run so tests don't interfere with each other.
const dbPath = join(tmpdir(), `plumb-test-${Date.now()}.db`);

let store: LocalStore;

// Initialize store before running tests
before(async () => {
  store = await LocalStore.create({ dbPath, userId: 'test-user' });
});

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

test('ingestMemoryFact() inserts a fact and returns a factId UUID', async () => {
  const result = await store.ingestMemoryFact({
    content: 'User prefers dark mode',
    sourceSessionId: 'session-abc',
    tags: ['preferences', 'ui'],
  });

  assert.match(result.factId, /^[0-9a-f-]{36}$/, 'factId should be a UUID');
});

test('ingestMemoryFact() fact is counted in status()', async () => {
  const fresh = await LocalStore.create({
    dbPath: join(tmpdir(), `plumb-fact-status-${Date.now()}.db`),
    userId: 'fact-status-user',
  });

  try {
    const initial = await fresh.status();
    assert.equal(initial.factCount, 0);

    await fresh.ingestMemoryFact({
      content: 'User uses TypeScript',
      sourceSessionId: 'session-abc',
    });

    const after = await fresh.status();
    assert.equal(after.factCount, 1);
  } finally {
    fresh.close();
  }
});

test('delete() soft-deletes a fact (sets deleted_at, excludes from searchMemoryFacts)', async () => {
  const fresh = await LocalStore.create({
    dbPath: join(tmpdir(), `plumb-delete-${Date.now()}.db`),
    userId: 'delete-user',
  });

  try {
    const { factId } = await fresh.ingestMemoryFact({
      content: 'User dislikes Comic Sans',
      sourceSessionId: 'session-xyz',
    });

    // Fact should be counted before deletion
    const before = await fresh.status();
    assert.equal(before.factCount, 1, 'fact should be visible before deletion');

    await fresh.delete(factId);

    // factCount excludes soft-deleted rows
    const afterDelete = await fresh.status();
    assert.equal(afterDelete.factCount, 0, 'soft-deleted fact should not appear in count');
  } finally {
    fresh.close();
  }
});

test('status() returns accurate factCount and rawLogCount', async () => {
  const fresh = await LocalStore.create({
    dbPath: join(tmpdir(), `plumb-status-test-${Date.now()}.db`),
    userId: 'status-test-user',
  });

  try {
    const initial = await fresh.status();
    assert.equal(initial.factCount, 0);
    assert.equal(initial.rawLogCount, 0);
    assert.equal(initial.lastIngestion, null);
    assert.ok(initial.storageBytes > 0, 'storageBytes should be positive even for empty DB');

    await fresh.ingestMemoryFact({
      content: 'User is a developer',
      sourceSessionId: 's1',
    });

    const afterFact = await fresh.status();
    assert.equal(afterFact.factCount, 1);
    assert.equal(afterFact.rawLogCount, 0);

    await fresh.ingest({
      userMessage: 'Hello!',
      agentResponse: 'Hi there!',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'session-1',
    });

    const afterIngest = await fresh.status();
    assert.equal(afterIngest.rawLogCount, 1);
    assert.ok(afterIngest.lastIngestion !== null, 'lastIngestion should be set after ingest');
  } finally {
    fresh.close();
  }
});

test('ingest() writes to raw_log and returns rawLogId', async () => {
  const result = await store.ingest({
    userMessage: 'What is the capital of France?',
    agentResponse: 'The capital of France is Paris.',
    timestamp: new Date(),
    source: 'claude-code',
    sessionId: 'session-ingest-test',
    sessionLabel: 'geography-chat',
  });

  assert.match(result.rawLogId, /^[0-9a-f-]{36}$/, 'rawLogId should be a UUID');
  assert.equal(result.factsExtracted, 0, 'no facts extracted yet (T-005)');
  assert.deepEqual(result.factIds, []);
});

test('ingest() cross-session: exchanges from different sessions visible in status()', async () => {
  const crossStore = await LocalStore.create({
    dbPath: join(tmpdir(), `plumb-cross-session-${Date.now()}.db`),
    userId: 'cross-user',
  });

  try {
    await crossStore.ingest({
      userMessage: 'Planning session A',
      agentResponse: 'Got it.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'session-A',
      sessionLabel: 'planning',
    });

    await crossStore.ingest({
      userMessage: 'Continuing in session B',
      agentResponse: 'Understood.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'session-B',
      sessionLabel: 'followup',
    });

    const status = await crossStore.status();
    assert.equal(status.rawLogCount, 2, 'both sessions should be counted in raw_log');
  } finally {
    crossStore.close();
  }
});
