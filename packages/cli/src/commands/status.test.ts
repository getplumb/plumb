import { test, afterAll as after, vi } from 'vitest';
import assert from 'node:assert/strict';
import { statusCommand } from './status.js';
import { LocalStore } from '@getplumb/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Use a unique temp path per test run.
const dbPath = join(tmpdir(), `plumb-status-test-${Date.now()}.db`);
const userId = 'test-user';

// Set up test data using ingestMemoryFact only (raw log removed in T-128).
const store = await LocalStore.create({ dbPath, userId });

await store.ingestMemoryFact({
  content: 'User prefers TypeScript',
  sourceSessionId: 'session-1',
  tags: ['languages'],
});

await store.ingestMemoryFact({
  content: 'User uses Node.js for backend work',
  sourceSessionId: 'session-1',
});

await store.ingestMemoryFact({
  content: 'User prefers ESM modules over CJS',
  sourceSessionId: 'session-2',
});

store.close();

after(() => {
  rmSync(dbPath, { force: true });
});

test('prints human-readable status with fact count', async () => {
  // Capture console output
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await statusCommand({ db: dbPath, userId });

    const fullOutput = logs.join('\n');

    assert.ok(fullOutput.includes('Plumb Memory — Local Store'), 'Should have header');
    assert.ok(fullOutput.includes('Memory facts:'), 'Should show fact count');
    assert.ok(fullOutput.includes('Storage:'), 'Should show storage size');
  } finally {
    console.log = originalLog;
  }
});

test('prints JSON output when --json flag is set', async () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await statusCommand({ db: dbPath, json: true, userId });

    const fullOutput = logs.join('\n');
    const parsed = JSON.parse(fullOutput);

    assert.ok(typeof parsed.factCount === 'number', 'Should have factCount');
    assert.ok(parsed.lastIngestion === null || typeof parsed.lastIngestion === 'string', 'Should have lastIngestion');
    assert.ok(typeof parsed.storageBytes === 'number', 'Should have storageBytes');
    assert.ok(typeof parsed.mcpServer === 'object', 'Should have mcpServer object');
    assert.ok(typeof parsed.mcpServer.installed === 'boolean', 'Should have mcpServer.installed');
  } finally {
    console.log = originalLog;
  }
});

test('handles database not found gracefully', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errors.push(args.join(' '));

  try {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = vi.fn((code?: string | number | null | undefined) => {
      exitCode = typeof code === 'number' ? code : 1;
      throw new Error('exit');
    }) as typeof process.exit;

    try {
      await statusCommand({ db: '/nonexistent/path/to/db.db', userId: 'test-user' });
    } catch (err) {
      // Expected to throw due to process.exit
    }

    assert.ok(errors.some(e => e.includes('Database not found')), 'Should show error message');
    assert.equal(exitCode, 1, 'Should exit with code 1');

    process.exit = originalExit;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
