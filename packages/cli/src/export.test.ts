import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { LocalStore } from '@getplumb/core';
import { exportCommand } from './commands/export.js';

// Use a unique temp path per test run.
const dbPath = join(tmpdir(), `plumb-export-test-${Date.now()}.db`);
const userId = 'test-user';

// Set up test data using ingestMemoryFact only (raw log removed in T-128).
const store = await LocalStore.create({ dbPath, userId });

await store.ingestMemoryFact({
  content: 'User prefers TypeScript over JavaScript',
  sourceSessionId: 'session-1',
  tags: ['preferences', 'languages'],
});

await store.ingestMemoryFact({
  content: 'User uses Rust for systems programming',
  sourceSessionId: 'session-2',
});

store.close();

after(() => {
  rmSync(dbPath, { force: true });
});

test('exportCommand prints facts as JSON to stdout', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => {};

  try {
    await exportCommand({ db: dbPath, userId, json: true });

    const fullOutput = logs.join('\n');
    const parsed = JSON.parse(fullOutput);

    assert.ok(Array.isArray(parsed), 'output should be a JSON array');
    assert.ok(parsed.length >= 2, 'should have at least 2 facts');

    const fact = parsed[0];
    assert.ok(fact.id, 'fact should have id');
    assert.ok(fact.content, 'fact should have content');
    assert.ok(fact.source_session_id, 'fact should have source_session_id');
    assert.ok(fact.created_at, 'fact should have created_at');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('exportCommand prints human summary when not in json mode', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  console.error = (...args: unknown[]) => errors.push(args.join(' '));

  try {
    await exportCommand({ db: dbPath, userId });

    // Should still output the JSON array to stdout
    const fullOutput = logs.join('\n');
    const parsed = JSON.parse(fullOutput);
    assert.ok(Array.isArray(parsed), 'should output JSON array');

    // Human summary goes to stderr
    const errOutput = errors.join('\n');
    assert.ok(errOutput.includes('Exported'), 'stderr should confirm export count');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
