import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LocalStore } from './local-store.js';
import { DecayRate } from './types.js';

// Use a unique temp path per test run so tests don't interfere with each other.
const dbPath = join(tmpdir(), `plumb-test-${Date.now()}.db`);

const store = new LocalStore({ dbPath, userId: 'test-user' });

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

test('store() inserts a fact and returns a UUID', async () => {
  const id = await store.store({
    subject: 'user',
    predicate: 'prefers',
    object: 'dark mode',
    confidence: 0.95,
    decayRate: DecayRate.slow,
    timestamp: new Date(),
    sourceSessionId: 'session-abc',
    sourceSessionLabel: 'test-session',
    context: 'user mentioned this in passing',
  });

  assert.match(id, /^[0-9a-f-]{36}$/, 'id should be a UUID');
});

test('search() retrieves stored fact by keyword', async () => {
  await store.store({
    subject: 'user',
    predicate: 'uses',
    object: 'TypeScript',
    confidence: 0.9,
    decayRate: DecayRate.medium,
    timestamp: new Date(),
    sourceSessionId: 'session-abc',
  });

  const results = await store.search('TypeScript');
  assert.ok(results.length > 0, 'should return at least one result');
  const match = results.find((r) => r.fact.object === 'TypeScript');
  assert.ok(match !== undefined, 'should find the TypeScript fact');
  assert.equal(match.fact.subject, 'user');
  assert.equal(match.fact.predicate, 'uses');
  assert.ok(match.ageInDays >= 0, 'ageInDays should be non-negative');
  assert.ok(match.score >= 0, 'score should be non-negative');
});

test('delete() soft-deletes a fact (sets deleted_at, excludes from search)', async () => {
  const id = await store.store({
    subject: 'user',
    predicate: 'dislikes',
    object: 'Comic Sans',
    confidence: 0.99,
    decayRate: DecayRate.slow,
    timestamp: new Date(),
    sourceSessionId: 'session-xyz',
  });

  // Fact should be findable before deletion.
  const before = await store.search('Comic Sans');
  assert.ok(before.some((r) => r.fact.id === id), 'fact should be visible before deletion');

  await store.delete(id);

  // Fact should be excluded after soft delete.
  const after = await store.search('Comic Sans');
  assert.ok(!after.some((r) => r.fact.id === id), 'soft-deleted fact should not appear in search');
});

test('status() returns accurate factCount and rawLogCount', async () => {
  const fresh = new LocalStore({
    dbPath: join(tmpdir(), `plumb-status-test-${Date.now()}.db`),
    userId: 'status-test-user',
  });

  try {
    const initial = await fresh.status();
    assert.equal(initial.factCount, 0);
    assert.equal(initial.rawLogCount, 0);
    assert.equal(initial.lastIngestion, null);
    assert.ok(initial.storageBytes > 0, 'storageBytes should be positive even for empty DB');

    await fresh.store({
      subject: 'user',
      predicate: 'is',
      object: 'a developer',
      confidence: 0.8,
      decayRate: DecayRate.slow,
      timestamp: new Date(),
      sourceSessionId: 's1',
    });

    const afterStore = await fresh.status();
    assert.equal(afterStore.factCount, 1);
    assert.equal(afterStore.rawLogCount, 0);

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

test('ingest() cross-session: facts from different sessions visible in same status()', async () => {
  const crossStore = new LocalStore({
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
