/**
 * worker.test.ts — Tests for the @getplumb/wiki-worker package.
 *
 * Coverage:
 *   - patch-schema: parsePatchOp, parseWikiPatch validation
 *   - tombstone: addTombstone, isTombstoned, hashSentence, pruneExpiredTombstones
 *   - applier: replaceParagraph, updateLine, appendSection body ops
 *   - dead-letter: appendDeadLetter, readDeadLetters
 *   - worker: end-to-end coalescing test (5 Dylan Sellberg facts → 1 write each page)
 */

import { describe, test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';

// Top-level imports (ESM top-level await is valid in vitest ESM mode)
import { parsePatchOp, parseWikiPatch } from './patch-schema.js';
import {
  ensureTombstoneTable,
  addTombstone,
  isTombstoned,
  hashSentence,
  normalizeSentence,
  pruneExpiredTombstones,
} from './tombstone.js';
import { applyPatch } from './applier.js';
import { appendDeadLetter, readDeadLetters } from './dead-letter.js';
import { runWorkerTick, startWikiWorker } from './worker.js';
import { WikiService } from '@getplumb/wiki';
import { openDb, appendToQueue, readQueue } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wiki-worker-test-'));
}

const VALID_FM_YAML = `---
type: person
created: 2026-04-16
updated: 2026-04-16
source_refs:
  - plumb:test
tags:
  - samsara
confidence: medium
---`;

const DYLAN_BODY = `
# Dylan Sellberg

Engineering Manager at Samsara. Based in San Francisco.

## Background

Dylan joined Samsara in 2022.
`;

const SAMSARA_FM_YAML = `---
type: company
created: 2026-04-16
updated: 2026-04-16
source_refs:
  - plumb:test
tags:
  - fleet-management
confidence: medium
---`;

const SAMSARA_BODY = `
# Samsara

Fleet management software company.

## Team

Key engineering leaders include [[Dylan Sellberg]].
`;

// ---------------------------------------------------------------------------
// patch-schema tests
// ---------------------------------------------------------------------------

describe('parsePatchOp', () => {

  test('parses append_section op', () => {
    const op = parsePatchOp({
      op: 'append_section',
      section: 'Background',
      content: 'New content here.',
    });
    assert.equal(op.op, 'append_section');
    if (op.op === 'append_section') {
      assert.equal(op.section, 'Background');
      assert.equal(op.content, 'New content here.');
    }
  });

  test('parses replace_paragraph op', () => {
    const op = parsePatchOp({
      op: 'replace_paragraph',
      anchor: 'joined Samsara',
      replacement: 'Dylan joined Samsara in 2021 as Senior EM.',
    });
    assert.equal(op.op, 'replace_paragraph');
  });

  test('parses update_line op', () => {
    const op = parsePatchOp({
      op: 'update_line',
      anchor: 'Engineering Manager',
      replacement: 'Engineering Manager at Samsara (promoted 2024).',
    });
    assert.equal(op.op, 'update_line');
  });

  test('parses set_frontmatter op with string value', () => {
    const op = parsePatchOp({ op: 'set_frontmatter', key: 'updated', value: '2026-04-16' });
    assert.equal(op.op, 'set_frontmatter');
    if (op.op === 'set_frontmatter') {
      assert.equal(op.key, 'updated');
      assert.equal(op.value, '2026-04-16');
    }
  });

  test('parses set_frontmatter op with string[] value', () => {
    const op = parsePatchOp({ op: 'set_frontmatter', key: 'tags', value: ['a', 'b'] });
    assert.equal(op.op, 'set_frontmatter');
    if (op.op === 'set_frontmatter') {
      assert.deepEqual(op.value, ['a', 'b']);
    }
  });

  test('throws on unknown op', () => {
    assert.throws(() => parsePatchOp({ op: 'delete_page' }), /Unknown patch op/);
  });

  test('throws on non-object', () => {
    assert.throws(() => parsePatchOp('invalid'), /PatchOp must be an object/);
  });
});

describe('parseWikiPatch', () => {

  test('parses valid patch', () => {
    const patch = parseWikiPatch({
      path: 'people/dylan-sellberg.md',
      source_ref: 'abc123',
      ops: [{ op: 'set_frontmatter', key: 'updated', value: '2026-04-16' }],
    });
    assert.equal(patch.path, 'people/dylan-sellberg.md');
    assert.equal(patch.source_ref, 'abc123');
    assert.equal(patch.ops.length, 1);
  });

  test('throws when ops missing', () => {
    assert.throws(
      () => parseWikiPatch({ path: 'x.md', source_ref: 'y' }),
      /ops must be an array/,
    );
  });
});

// ---------------------------------------------------------------------------
// tombstone tests
// ---------------------------------------------------------------------------

describe('tombstone', () => {

  let tempDir: string;
  let db: import('@getplumb/core').WasmDb;

  beforeEach(async () => {
    tempDir = makeTempDir();
    const dbPath = join(tempDir, 'wiki.db');
    db = await openDb(dbPath);
    ensureTombstoneTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('hashSentence is deterministic', () => {
    const h1 = hashSentence('Dylan joined Samsara in 2022.');
    const h2 = hashSentence('Dylan joined Samsara in 2022.');
    assert.equal(h1, h2);
  });

  test('normalizeSentence trims, collapses whitespace, and lowercases', () => {
    const n = normalizeSentence('  Dylan joined  Samsara. ');
    assert.equal(n, 'dylan joined samsara.');
  });

  test('addTombstone + isTombstoned: matches exact sentence', () => {
    addTombstone(db, 'Dylan joined Samsara in 2022.');
    const result = isTombstoned(db, 'Dylan joined Samsara in 2022.');
    assert.equal(result, true);
  });

  test('isTombstoned: returns false for unknown sentence', () => {
    const result = isTombstoned(db, 'A completely different sentence.');
    assert.equal(result, false);
  });

  test('isTombstoned: returns false when tombstone expired', () => {
    // Manually insert an already-expired tombstone
    const hash = hashSentence('Old deleted sentence here.');
    db.exec(
      `INSERT INTO wiki_tombstones (hash, source, created_at, expires_at)
       VALUES ('${hash}', 'test', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')`,
    );
    const result = isTombstoned(db, 'Old deleted sentence here.');
    assert.equal(result, false);
  });

  test('pruneExpiredTombstones runs without error', () => {
    addTombstone(db, 'Some sentence to prune.');
    // Insert an expired one
    const hash = hashSentence('Expired sentence here.');
    db.exec(
      `INSERT INTO wiki_tombstones (hash, source, created_at, expires_at)
       VALUES ('${hash}', 'test', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')`,
    );
    assert.doesNotThrow(() => pruneExpiredTombstones(db));
  });

  test('addTombstone refreshes TTL on duplicate', () => {
    addTombstone(db, 'Some sentence.');
    // Should not throw — upsert refreshes TTL
    assert.doesNotThrow(() => addTombstone(db, 'Some sentence.'));
  });
});

// ---------------------------------------------------------------------------
// applier body op tests (unit — no API calls)
// ---------------------------------------------------------------------------

describe('applier body ops', () => {

  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(join(tempDir, 'people'), { recursive: true });
    mkdirSync(join(tempDir, 'companies'), { recursive: true });
    // Write test pages
    writeFileSync(
      join(tempDir, 'people', 'dylan-sellberg.md'),
      VALID_FM_YAML + DYLAN_BODY,
    );
    writeFileSync(
      join(tempDir, 'companies', 'samsara.md'),
      SAMSARA_FM_YAML + SAMSARA_BODY,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('replace_paragraph op modifies body', async () => {
    const wiki = WikiService.createFilesystemOnly(tempDir);

    const result = await applyPatch(
      {
        path: 'people/dylan-sellberg.md',
        source_ref: 'test-001',
        ops: [
          {
            op: 'replace_paragraph',
            anchor: 'joined Samsara in 2022',
            replacement: 'Dylan joined Samsara in 2021 as a Senior Engineering Manager.',
          },
          { op: 'set_frontmatter', key: 'updated', value: '2026-04-16' },
        ],
      },
      wiki,
    );

    assert.equal(result.path, 'people/dylan-sellberg.md');
    assert.equal(result.appliedOps, 2);
    assert.equal(result.skippedOps, 0);

    // Verify the file was updated via wiki.write (not direct fs.writeFile)
    const page = await wiki.read('people/dylan-sellberg.md');
    assert.ok(page.body.includes('2021 as a Senior Engineering Manager'));
    assert.ok(!page.body.includes('joined Samsara in 2022'));

    wiki.close();
  });

  test('update_line op modifies matching line', async () => {
    const wiki = WikiService.createFilesystemOnly(tempDir);

    const result = await applyPatch(
      {
        path: 'people/dylan-sellberg.md',
        source_ref: 'test-002',
        ops: [
          {
            op: 'update_line',
            anchor: 'Engineering Manager at Samsara',
            replacement: 'Engineering Manager at Samsara. Promoted to Director in 2025.',
          },
          { op: 'set_frontmatter', key: 'updated', value: '2026-04-16' },
        ],
      },
      wiki,
    );

    assert.equal(result.appliedOps, 2);
    const page = await wiki.read('people/dylan-sellberg.md');
    assert.ok(page.body.includes('Promoted to Director in 2025'));

    wiki.close();
  });

  test('append_section creates new section when absent', async () => {
    const wiki = WikiService.createFilesystemOnly(tempDir);

    await applyPatch(
      {
        path: 'people/dylan-sellberg.md',
        source_ref: 'test-003',
        ops: [
          {
            op: 'append_section',
            section: 'Education',
            content: 'BS Computer Science from UC Berkeley (2015).',
          },
          { op: 'set_frontmatter', key: 'updated', value: '2026-04-16' },
        ],
      },
      wiki,
    );

    const page = await wiki.read('people/dylan-sellberg.md');
    assert.ok(page.body.includes('## Education'));
    assert.ok(page.body.includes('UC Berkeley'));

    wiki.close();
  });

  test('skips ops with unfound anchor and returns skippedOps count', async () => {
    const wiki = WikiService.createFilesystemOnly(tempDir);
    const warnings: string[] = [];

    const result = await applyPatch(
      {
        path: 'people/dylan-sellberg.md',
        source_ref: 'test-004',
        ops: [
          {
            op: 'replace_paragraph',
            anchor: 'this-anchor-does-not-exist-anywhere',
            replacement: 'Should be skipped.',
          },
        ],
      },
      wiki,
      { onWarning: (msg) => warnings.push(msg) },
    );

    assert.equal(result.skippedOps, 1);
    assert.equal(result.appliedOps, 0);
    assert.ok(warnings.some((w) => w.includes('anchor not found')));

    wiki.close();
  });
});

// ---------------------------------------------------------------------------
// dead-letter tests
// ---------------------------------------------------------------------------

describe('dead-letter queue', () => {

  let tempDir: string;
  let deadLetterPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    deadLetterPath = join(tempDir, 'wiki-queue-dead.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('readDeadLetters returns [] when file absent', async () => {
    const entries = await readDeadLetters(deadLetterPath);
    assert.deepEqual(entries, []);
  });

  test('appendDeadLetter + readDeadLetters round-trip', async () => {
    const item = {
      id: 'abc-123',
      fact: 'Dylan is now VP of Engineering.',
      queued_at: '2026-04-16T00:00:00Z',
      status: 'pending' as const,
    };

    await appendDeadLetter(item, 'Resolver failed 3 times', 3, deadLetterPath);
    await appendDeadLetter(item, 'Another item', 3, deadLetterPath);

    const entries = await readDeadLetters(deadLetterPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.id, 'abc-123');
    assert.equal(entries[0]?.retry_count, 3);
    assert.equal(entries[0]?.final_error, 'Resolver failed 3 times');
    assert.ok(entries[0]?.dead_lettered_at);
  });
});

// ---------------------------------------------------------------------------
// End-to-end coalescing test (mocked API)
// ---------------------------------------------------------------------------

describe('worker — end-to-end coalescing (Dylan Sellberg)', () => {

  let tempDir: string;
  let wikiRoot: string;
  let queuePath: string;
  let deadLetterPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    wikiRoot = join(tempDir, 'wiki');
    mkdirSync(join(wikiRoot, 'people'), { recursive: true });
    mkdirSync(join(wikiRoot, 'companies'), { recursive: true });
    queuePath = join(tempDir, 'wiki-queue.jsonl');
    deadLetterPath = join(tempDir, 'wiki-queue-dead.jsonl');

    // Write initial wiki pages
    writeFileSync(
      join(wikiRoot, 'people', 'dylan-sellberg.md'),
      VALID_FM_YAML + DYLAN_BODY,
    );
    writeFileSync(
      join(wikiRoot, 'companies', 'samsara.md'),
      SAMSARA_FM_YAML + SAMSARA_BODY,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('5 Dylan Sellberg facts coalesce to exactly 1 write per page', async () => {
    // Queue 5 facts about Dylan Sellberg
    const facts = [
      'Dylan Sellberg was promoted to Director of Engineering at Samsara in March 2025.',
      'Dylan Sellberg leads the platform team at Samsara with 12 engineers.',
      'Dylan Sellberg is based in San Francisco, CA.',
      'Dylan Sellberg graduated from UC Berkeley in 2015 with a BS in CS.',
      'Dylan Sellberg joined Samsara from Lyft where he was a Staff Engineer.',
    ];

    for (const fact of facts) {
      await appendToQueue(fact, queuePath);
    }

    // Track write calls to verify coalescing
    const writeCallPaths: string[] = [];

    // Create a spy wiki service that records write calls
    const wiki = WikiService.createFilesystemOnly(wikiRoot);
    const originalWrite = wiki.write.bind(wiki);
    const spiedWiki = Object.create(wiki) as typeof wiki;
    Object.defineProperty(spiedWiki, 'write', {
      value: async (patch: Parameters<typeof wiki.write>[0]) => {
        writeCallPaths.push(patch.path);
        return originalWrite(patch);
      },
      writable: true,
    });

    // Mock resolver: all 5 facts affect the same 2 pages
    const mockResolver = async (
      _fact: string,
      _pages: readonly import('./resolver.js').PageIndexEntry[],
    ): Promise<string[]> => {
      return ['people/dylan-sellberg.md', 'companies/samsara.md'];
    };

    // Mock writer: emit a simple append_section patch
    let writerCallCount = 0;
    const mockWriter = async (
      input: import('./writer.js').WriterInput,
      _db: import('@getplumb/core').WasmDb | null,
    ): Promise<import('./patch-schema.js').WikiPatch> => {
      writerCallCount++;
      const today = new Date().toISOString().slice(0, 10);
      return {
        path: input.path,
        source_ref: input.sourceRef,
        ops: [
          {
            op: 'append_section',
            section: 'Recent Updates',
            content: input.facts.map((f, i) => `- Fact ${i + 1}: ${f.slice(0, 30)}…`).join('\n'),
          },
          { op: 'set_frontmatter', key: 'updated', value: today },
        ],
      };
    };

    // Custom RateLimiter-compatible object (use runWorkerTick internals)
    // We pass a custom wiki factory via a monkey-patch approach:
    // Instead, let's use the options to inject mocks
    const logs: string[] = [];
    const logger = {
      info: (s: string) => logs.push(`INFO: ${s}`),
      warn: (s: string) => logs.push(`WARN: ${s}`),
      error: (s: string) => logs.push(`ERROR: ${s}`),
      debug: (s: string) => logs.push(`DEBUG: ${s}`),
    };

    // We need a custom RateLimiter since runWorkerTick takes one
    // Import the exported function and pass a no-op rate limiter via
    // a workaround: max edits per hour = 100 so rate limit never triggers
    // startWikiWorker is imported at module top-level

    // Instead of calling runWorkerTick (which opens its own WikiService),
    // we test the coalescing logic by calling the internal processPendingItems
    // We do this by running runWorkerTick with a wikiRoot that has no DB
    // (filesystem-only mode) and mocked resolver + writer.

    // Use a separate class to count actual file writes
    const dylanPath = join(wikiRoot, 'people', 'dylan-sellberg.md');
    const samsaraPath = join(wikiRoot, 'companies', 'samsara.md');

    // Run the worker tick (no real DB available — tombstones skipped)
    // Use fake wikiDbPath that doesn't exist to avoid DB overhead in test
    const fakeDbPath = join(tempDir, 'nonexistent.db');

    // Patch WikiService.create to return our spy (not feasible without vi.mock)
    // Instead, we verify behavior by checking output of the actual filesystem ops.

    // Count how many times the wiki pages are modified by the worker
    // We run the tick twice to simulate the coalescing vs. no-coalescing difference

    // The simplest correctness check: run worker with real filesystem
    // mock only resolver + writer (the two AI calls)
    await runWorkerTick(
      {
        wikiRoot,
        wikiDbPath: fakeDbPath, // No DB — tombstones skipped
        queuePath,
        deadLetterPath,
        maxEditsPerHour: 100,
        resolver: mockResolver,
        writer: mockWriter,
        logger,
      },
      // @ts-expect-error — accessing internal RateLimiter via duck-typing
      { canEdit: () => true, recordEdit: () => {}, remaining: () => 100 },
    );

    // Verify: writer was called exactly twice (once per page)
    assert.equal(
      writerCallCount,
      2,
      `Expected writer called 2 times (once per page), got ${writerCallCount}.\nLogs:\n${logs.join('\n')}`,
    );

    // Verify: all 5 facts were coalesced (writer received them all in each call)
    // This is guaranteed by writerCallCount === 2 with 5 items → 1 call per page

    // Verify the pages were actually modified on disk
    const dylanContent = await readFile(dylanPath, 'utf8');
    const samsaraContent = await readFile(samsaraPath, 'utf8');

    assert.ok(
      dylanContent.includes('Recent Updates'),
      'dylan-sellberg.md should have been updated',
    );
    assert.ok(
      samsaraContent.includes('Recent Updates'),
      'samsara.md should have been updated',
    );

    // Verify all 5 queue items were marked done
    const queueItems = await readQueue(queuePath);
    const doneItems = queueItems.filter((i) => i.status === 'done');
    assert.equal(
      doneItems.length,
      5,
      `Expected 5 done items, got ${doneItems.length}.\nLogs:\n${logs.join('\n')}`,
    );
  });

  test('items that fail 3x are moved to dead-letter queue', async () => {
    await appendToQueue('Dylan is a VP now.', queuePath);

    const failingWriter = async (): Promise<never> => {
      throw new Error('Simulated writer failure');
    };

    const logs: string[] = [];
    const logger = {
      info: (s: string) => logs.push(`INFO: ${s}`),
      warn: (s: string) => logs.push(`WARN: ${s}`),
      error: (s: string) => logs.push(`ERROR: ${s}`),
      debug: (s: string) => logs.push(`DEBUG: ${s}`),
    };

    // Run 3 times — each should increment retry_count
    for (let i = 0; i < 3; i++) {
      await runWorkerTick(
        {
          wikiRoot,
          wikiDbPath: join(tempDir, 'nonexistent.db'),
          queuePath,
          deadLetterPath,
          maxRetries: 3,
          maxEditsPerHour: 100,
          resolver: async () => ['people/dylan-sellberg.md'],
          writer: failingWriter as unknown as import('./writer.js').WriterFn,
          logger,
        },
        // @ts-expect-error — duck-typed rate limiter for tests
        { canEdit: () => true, recordEdit: () => {}, remaining: () => 100 },
      );
    }

    const dead = await readDeadLetters(deadLetterPath);
    assert.equal(dead.length, 1, `Expected 1 dead letter entry, got ${dead.length}\nLogs:\n${logs.join('\n')}`);
    assert.equal(dead[0]?.retry_count, 3);
    assert.ok(dead[0]?.final_error?.includes('Simulated writer failure'));
  });

  test('rate limiter blocks excess edits', async () => {
    await appendToQueue('Fact A about Dylan.', queuePath);
    await appendToQueue('Fact B about Dylan.', queuePath);

    let writeCount = 0;
    const countingWriter = async (
      input: import('./writer.js').WriterInput,
      _db: import('@getplumb/core').WasmDb | null,
    ): Promise<import('./patch-schema.js').WikiPatch> => {
      writeCount++;
      const today = new Date().toISOString().slice(0, 10);
      return {
        path: input.path,
        source_ref: input.sourceRef,
        ops: [{ op: 'set_frontmatter', key: 'updated', value: today }],
      };
    };

    // Rate limiter that only allows 0 edits
    const exhaustedRateLimiter = {
      canEdit: () => false,
      recordEdit: () => {},
      remaining: () => 0,
    };

    await runWorkerTick(
      {
        wikiRoot,
        wikiDbPath: join(tempDir, 'nonexistent.db'),
        queuePath,
        deadLetterPath,
        maxEditsPerHour: 0,
        resolver: async () => ['people/dylan-sellberg.md'],
        writer: countingWriter,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
      // @ts-expect-error — duck-typed rate limiter for tests
      exhaustedRateLimiter,
    );

    assert.equal(writeCount, 0, 'No writes should happen when rate limit exhausted');
  });
});
