/**
 * Tests for read-path.ts (buildMemoryContext) and context-builder.ts (formatContextBlock).
 *
 * Strategy:
 *   - Unit tests use a mock ReadPathStore to avoid ML model downloads and keep
 *     tests fast and deterministic.
 *   - One integration smoke test uses a real LocalStore with facts inserted via
 *     store.ingestMemoryFact() to verify the end-to-end cross-session provenance path.
 *
 * Cross-session test (acceptance criteria): facts ingested in session A must
 * be returned when querying in session B context — no session filter applied.
 */

import { test, describe, afterAll as after, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

import { buildMemoryContext, type ReadPathStore, type MemoryContext } from './read-path.js';
import { formatContextBlock, formatAge } from './context-builder.js';
import { LocalStore } from './local-store.js';
import type { MemoryFactSearchResult } from './local-store.js';

// ─── Mock store factory ───────────────────────────────────────────────────────

function makeStore(
  memoryFactResults: MemoryFactSearchResult[] = [],
): ReadPathStore & { searchMemoryFactsCallCount: number } {
  let searchMemoryFactsCallCount = 0;
  return {
    get searchMemoryFactsCallCount() { return searchMemoryFactsCallCount; },
    async searchMemoryFacts(_query, _limit) {
      searchMemoryFactsCallCount++;
      // Sort by score descending (as real implementation does)
      return [...memoryFactResults].sort((a, b) => b.final_score - a.final_score);
    },
  };
}

/** Build a MemoryFactSearchResult for testing. */
function makeMemoryFact(opts: {
  content: string;
  sourceSessionId?: string;
  sourceSessionLabel?: string | null;
  ageInDays?: number;
  score?: number;
  tags?: string[] | null;
  now?: Date;
}): MemoryFactSearchResult {
  const now = opts.now ?? new Date('2026-01-01T00:00:00.000Z');
  const ageInDays = opts.ageInDays ?? 0;
  const created_at = new Date(now.getTime() - ageInDays * 24 * 60 * 60 * 1_000).toISOString();
  return {
    content: opts.content,
    source_session_id: opts.sourceSessionId ?? 'session-default',
    source_session_label: opts.sourceSessionLabel ?? null,
    created_at,
    tags: opts.tags ?? null,
    final_score: opts.score ?? 0.5,
  };
}

// ─── formatAge unit tests ─────────────────────────────────────────────────────

describe('formatAge', () => {
  test('< 1 day → today', () => {
    assert.equal(formatAge(0), 'today');
    assert.equal(formatAge(0.5), 'today');
    assert.equal(formatAge(0.99), 'today');
  });

  test('1-2 days → yesterday', () => {
    assert.equal(formatAge(1), 'yesterday');
    assert.equal(formatAge(1.5), 'yesterday');
    assert.equal(formatAge(1.99), 'yesterday');
  });

  test('2-7 days → N days ago', () => {
    assert.equal(formatAge(2), '2 days ago');
    assert.equal(formatAge(6.9), '6 days ago');
  });

  test('7-14 days → 1 week ago', () => {
    assert.equal(formatAge(7), '1 week ago');
    assert.equal(formatAge(13.9), '1 week ago');
  });

  test('14-30 days → N weeks ago', () => {
    assert.equal(formatAge(14), '2 weeks ago');
    assert.equal(formatAge(21), '3 weeks ago');
  });

  test('30-60 days → 1 month ago', () => {
    assert.equal(formatAge(30), '1 month ago');
    assert.equal(formatAge(59), '1 month ago');
  });

  test('60-365 days → N months ago', () => {
    assert.equal(formatAge(60), '2 months ago');
    assert.equal(formatAge(90), '3 months ago');
  });

  test('365-730 days → 1 year ago', () => {
    assert.equal(formatAge(365), '1 year ago');
    assert.equal(formatAge(729), '1 year ago');
  });

  test('≥ 730 days → N years ago', () => {
    assert.equal(formatAge(730), '2 years ago');
    assert.equal(formatAge(1095), '3 years ago');
  });
});

// ─── buildMemoryContext unit tests ────────────────────────────────────────────

describe('buildMemoryContext', () => {
  test('empty store → empty MemoryContext', async () => {
    const store = makeStore();
    const ctx = await buildMemoryContext('test query', store);
    assert.deepStrictEqual(ctx.relatedMemories, []);
  });

  test('facts sorted by score descending in relatedMemories', async () => {
    const facts = [
      makeMemoryFact({ content: 'low', score: 0.4 }),
      makeMemoryFact({ content: 'high', score: 0.8 }),
      makeMemoryFact({ content: 'mid', score: 0.6 }),
    ];
    const store = makeStore(facts);
    const ctx = await buildMemoryContext('query', store);
    assert.equal(ctx.relatedMemories.length, 3);
    assert.equal(ctx.relatedMemories[0]!.content, 'high');
    assert.equal(ctx.relatedMemories[1]!.content, 'mid');
    assert.equal(ctx.relatedMemories[2]!.content, 'low');
  });

  test('respects maxMemoryFacts limit', async () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      makeMemoryFact({ content: `fact-${i}`, score: 0.5 + i / 100 })
    );
    const store = makeStore(facts);
    const ctx = await buildMemoryContext('query', store, { maxMemoryFacts: 3 });
    assert.equal(ctx.relatedMemories.length, 3);
  });
});

// ─── formatContextBlock unit tests ────────────────────────────────────────────

describe('formatContextBlock', () => {
  test('includes [PLUMB MEMORY] header', () => {
    const ctx: MemoryContext = { relatedMemories: [] };
    const block = formatContextBlock(ctx);
    assert.ok(block.includes('[PLUMB MEMORY]'), 'block header missing');
  });

  test('includes tool hints section', () => {
    const ctx: MemoryContext = { relatedMemories: [] };
    const block = formatContextBlock(ctx);
    assert.ok(block.includes('plumb_search'), 'plumb_search hint missing');
    assert.ok(block.includes('plumb_remember'), 'plumb_remember hint missing');
  });

  test('formats memory facts with tier labels', () => {
    const facts = [
      makeMemoryFact({ content: 'Test fact content', score: 0.065, ageInDays: 0 }),
    ];
    const ctx: MemoryContext = { relatedMemories: facts.map(f => ({
      content: f.content,
      sourceSessionId: f.source_session_id,
      sourceSessionLabel: f.source_session_label,
      timestamp: new Date(f.created_at),
      tags: f.tags,
      score: f.final_score,
    })) };
    const block = formatContextBlock(ctx);
    assert.ok(block.includes('[HIGH]'), 'tier label missing');
    assert.ok(block.includes('Test fact content'), 'fact content missing');
  });
});

// ─── Cross-session integration test ───────────────────────────────────────────

// This test downloads an ML model (~100MB) and runs WASM inference.
// It can crash vitest worker forks on Windows due to memory/WASM constraints.
describe.skipIf(process.platform === 'win32')('Cross-session integration', () => {
  let testDbPath: string;
  let store: LocalStore;

  before(async () => {
    testDbPath = join(tmpdir(), `plumb-test-${Date.now()}.db`);
    store = await LocalStore.create({ dbPath: testDbPath, userId: 'test-user' });
  });

  after(() => {
    store.close();
    try {
      rmSync(testDbPath, { force: true });
    } catch {}
  });

  test('facts from session A returned in session B context', async () => {
    // Insert fact in session A
    await store.ingestMemoryFact({
      content: 'User prefers dark mode',
      sourceSessionId: 'session-a',
      tags: ['preferences'],
    });

    // Start backlog processor to embed the fact
    store.startBacklogProcessor();

    // Wait for embedding to complete (poll until facts are embedded)
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const ctx = await buildMemoryContext('dark mode', store, { maxMemoryFacts: 10 });
      if (ctx.relatedMemories.length > 0) {
        // Found the fact!
        await store.stopBacklogProcessor();
        assert.ok(
          ctx.relatedMemories.some((m) => m.content.includes('dark mode')),
          'fact from session A not found in session B'
        );
        return;
      }
    }

    await store.stopBacklogProcessor();
    assert.fail('Facts were not embedded within timeout');
  });

  test('buildMemoryContext + formatContextBlock: full pipeline smoke test', async () => {
    const ctx = await buildMemoryContext('dark mode', store);
    const block = formatContextBlock(ctx);
    assert.ok(block.includes('[PLUMB MEMORY]'), 'block header present');
    assert.ok(block.includes('plumb_search'), 'tool hint present');
  });
});
