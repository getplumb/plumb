import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { LocalStore } from '@getplumb/core';
import { ingestCommand } from './ingest.js';

// Use a unique temp path per test run.
const testDir = join(tmpdir(), `plumb-ingest-test-${Date.now()}`);
const dbPath = join(testDir, 'memory.db');
const userId = 'test-user';

// Create test directory.
mkdirSync(testDir, { recursive: true });

// Clean up after all tests.
after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test('ingestCommand handles file input', async () => {
  // Create a test file with multiple paragraphs.
  const testFile = join(testDir, 'test-notes.md');
  const content = `This is the first paragraph with more than 100 characters. It contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.

This is the second paragraph with more than 100 characters. It also contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.

This is too short.

This is the third paragraph with more than 100 characters. It also contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.`;

  writeFileSync(testFile, content, 'utf-8');

  // Capture console output.
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await ingestCommand({ db: dbPath, userId, file: testFile });

    // Check that chunks were ingested.
    const output = logs.join('\n');
    assert.ok(output.includes('Ingesting 3 chunks'), 'should ingest 3 chunks (filtered)');
    assert.ok(output.includes('Ingested chunk'), 'should show ingestion progress');
    assert.ok(output.includes('Waiting for fact extraction'), 'should wait for extraction');
    assert.ok(output.includes('Summary:'), 'should print summary');

    // Verify data was written to DB.
    const store = new LocalStore({ dbPath, userId });
    const status = await store.status();
    store.close();

    assert.ok(status.rawLogCount >= 3, 'should have at least 3 raw log entries');
  } finally {
    console.log = originalLog;
  }
});

test('ingestCommand handles --text input', async () => {
  const dbPath2 = join(testDir, 'memory-text.db');
  const textContent = 'This is a manual memory entry with more than 100 characters. It contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.';

  // Capture console output.
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await ingestCommand({ db: dbPath2, userId, text: textContent });

    // Check that chunk was ingested.
    const output = logs.join('\n');
    assert.ok(output.includes('Ingesting 1 chunk'), 'should ingest 1 chunk');
    assert.ok(output.includes('from manual'), 'should show manual source');

    // Verify data was written to DB.
    const store = new LocalStore({ dbPath: dbPath2, userId });
    const status = await store.status();
    store.close();

    assert.equal(status.rawLogCount, 1, 'should have 1 raw log entry');
  } finally {
    console.log = originalLog;
  }
});

test('ingestCommand handles empty input gracefully', async () => {
  const dbPath3 = join(testDir, 'memory-empty.db');
  const emptyFile = join(testDir, 'empty.md');
  writeFileSync(emptyFile, '', 'utf-8');

  // Capture console output.
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  let exitCode = 0;
  const originalExit = process.exit;
  // @ts-expect-error - mocking process.exit
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
  };

  try {
    await ingestCommand({ db: dbPath3, userId, file: emptyFile });

    const output = logs.join('\n');
    assert.ok(output.includes('Nothing to ingest'), 'should show nothing to ingest');
    assert.equal(exitCode, 0, 'should exit with code 0');
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }
});

test('ingestCommand handles non-existent file gracefully', async () => {
  const dbPath4 = join(testDir, 'memory-nofile.db');
  const nonExistentFile = join(testDir, 'does-not-exist.md');

  // Capture console output.
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.join(' '));

  let exitCode = 0;
  const originalExit = process.exit;
  // @ts-expect-error - mocking process.exit
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
  };

  try {
    await ingestCommand({ db: dbPath4, userId, file: nonExistentFile });

    const output = errors.join('\n');
    assert.ok(output.includes('File not found'), 'should show file not found error');
    assert.equal(exitCode, 1, 'should exit with code 1');
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }
});

test('ingestCommand skips duplicate chunks', async () => {
  const dbPath5 = join(testDir, 'memory-duplicate.db');
  const testFile = join(testDir, 'test-duplicate.md');
  const content = 'This is a test chunk with more than 100 characters. It contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.';

  writeFileSync(testFile, content, 'utf-8');

  // Capture console output.
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    // First ingest.
    await ingestCommand({ db: dbPath5, userId, file: testFile });

    logs.length = 0; // Clear logs

    // Second ingest of the same content (should skip).
    await ingestCommand({ db: dbPath5, userId, file: testFile });

    const output = logs.join('\n');
    assert.ok(output.includes('Skipped chunk'), 'should show chunk was skipped');

    // Verify only one raw log entry exists.
    const store = new LocalStore({ dbPath: dbPath5, userId });
    const status = await store.status();
    store.close();

    assert.equal(status.rawLogCount, 1, 'should have only 1 raw log entry (duplicate skipped)');
  } finally {
    console.log = originalLog;
  }
});

test('ingestCommand filters chunks smaller than 100 chars', async () => {
  const dbPath6 = join(testDir, 'memory-filter.db');
  const testFile = join(testDir, 'test-filter.md');
  const content = `This is a long chunk with more than 100 characters. It contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.

Short chunk.

Another long chunk with more than 100 characters. It contains enough text to meet the minimum chunk size requirement for ingestion into the memory graph.`;

  writeFileSync(testFile, content, 'utf-8');

  // Capture console output.
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await ingestCommand({ db: dbPath6, userId, file: testFile });

    const output = logs.join('\n');
    assert.ok(output.includes('Ingesting 2 chunks'), 'should ingest only 2 chunks (filtered)');

    // Verify only 2 raw log entries exist.
    const store = new LocalStore({ dbPath: dbPath6, userId });
    const status = await store.status();
    store.close();

    assert.equal(status.rawLogCount, 2, 'should have 2 raw log entries (short chunk filtered)');
  } finally {
    console.log = originalLog;
  }
});
