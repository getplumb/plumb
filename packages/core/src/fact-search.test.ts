/**
 * Tests for Layer 2 hybrid search (fact-search.ts).
 *
 * Stores 3 facts with distinct topics via store.store(), then verifies that
 * search() returns ranked results with the expected structure.
 *
 * Note: The first test run downloads the BAAI/bge-small-en-v1.5 embedding model
 * (~100 MB) and the ms-marco cross-encoder (~50 MB) — subsequent runs use the
 * local ~/.cache/huggingface/ cache.
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LocalStore } from './local-store.js';
import { DecayRate } from './types.js';

const dbPath = join(tmpdir(), `plumb-fact-search-test-${Date.now()}.db`);
let store: LocalStore;

before(async () => {
  store = await LocalStore.create({ dbPath, userId: 'fact-search-test-user' });
});

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FACTS = [
  {
    subject: 'Clay',
    predicate: 'is actively searching for',
    object: 'software engineering jobs',
    context: 'Clay is looking at Samsara, applied to multiple companies, tracking applications and interviews',
    confidence: 0.95,
    decayRate: DecayRate.slow,
    timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
    sourceSessionId: 'session-job-search',
    sourceSessionLabel: 'job-search-chat',
  },
  {
    subject: 'Clay',
    predicate: 'prefers',
    object: 'TypeScript over JavaScript',
    context: 'Clay mentioned preferring strict typing and has all projects configured with strict mode',
    confidence: 0.9,
    decayRate: DecayRate.slow,
    timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
    sourceSessionId: 'session-ts-prefs',
    sourceSessionLabel: 'typescript-chat',
  },
  {
    subject: 'chocolate cake recipe',
    predicate: 'requires',
    object: '200g butter and 50g cocoa powder',
    context: 'Classic recipe baked at 180 degrees for 30 minutes with ganache frosting',
    confidence: 0.85,
    decayRate: DecayRate.fast,
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    sourceSessionId: 'session-cooking',
    sourceSessionLabel: 'cooking-chat',
  },
];

// ─── Store facts (shared setup) ──────────────────────────────────────────────

test('store 3 facts with distinct topics', { timeout: 120_000 }, async () => {
  for (const fact of FACTS) {
    const id = await store.store(fact);
    assert.match(id, /^[0-9a-f-]{36}$/, 'id should be a UUID');
  }

  const status = await store.status();
  assert.equal(status.factCount, 3, 'all 3 facts should be stored');
});

// ─── Search ──────────────────────────────────────────────────────────────────

test('search returns results with required SearchResult fields', { timeout: 120_000 }, async () => {
  const results = await store.search('job search applications', 3);

  assert.ok(results.length > 0, 'should return at least one result');

  for (const r of results) {
    assert.ok(typeof r.fact.id === 'string', 'fact.id must be a string');
    assert.ok(typeof r.fact.subject === 'string', 'fact.subject must be a string');
    assert.ok(typeof r.fact.predicate === 'string', 'fact.predicate must be a string');
    assert.ok(typeof r.fact.object === 'string', 'fact.object must be a string');
    assert.ok(typeof r.score === 'number', 'score must be a number');
    assert.ok(typeof r.ageInDays === 'number', 'ageInDays must be a number');
    assert.ok(r.fact.timestamp instanceof Date, 'timestamp must be a Date');
  }
});

test('search ranks job-search fact first for job query', { timeout: 120_000 }, async () => {
  const results = await store.search('job search applications Samsara', 3);

  assert.ok(results.length > 0, 'should return results');
  const top = results[0];
  assert.ok(top !== undefined, 'should have a top result');

  // The job-search fact should rank first.
  assert.equal(top.fact.subject, 'Clay', 'top result subject should be Clay');
  assert.ok(
    top.fact.object.includes('job') || top.fact.object.includes('engineering'),
    'top result should be about job search',
  );
});

test('search returns cooking fact in results for recipe query', { timeout: 120_000 }, async () => {
  const results = await store.search('chocolate cake recipe baking', 3);

  assert.ok(results.length > 0, 'should return results');
  const cookingResult = results.find((r) => r.fact.sourceSessionId === 'session-cooking');
  assert.ok(cookingResult !== undefined, 'cooking fact should appear in results');
});

test('search returns empty array when no facts exist', { timeout: 30_000 }, async () => {
  const emptyStore = await LocalStore.create({
    dbPath: join(tmpdir(), `plumb-fact-empty-${Date.now()}.db`),
    userId: 'empty-user',
  });
  try {
    const results = await emptyStore.search('anything', 5);
    assert.deepEqual(results, []);
  } finally {
    emptyStore.close();
  }
});

test('benchmark smoke: job search query returns at least 1 result with correct subject', { timeout: 120_000 }, async () => {
  const results = await store.search('job search applications', 5);
  assert.ok(results.length >= 1, 'should return at least 1 result');

  const jobResult = results.find(
    (r) => r.fact.subject === 'Clay' && r.fact.object.includes('job'),
  );
  assert.ok(jobResult !== undefined, 'should find Clay job search fact');
});
