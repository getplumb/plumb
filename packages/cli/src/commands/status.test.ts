import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { statusCommand } from './status.js';
import { LocalStore, DecayRate } from '@getplumb/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Use a unique temp path per test run.
const dbPath = join(tmpdir(), `plumb-status-test-${Date.now()}.db`);
const userId = 'test-user';

// Set up test data.
const store = new LocalStore({ dbPath, userId });

// Add some test facts.
await store.store({
  subject: 'TestSubject1',
  predicate: 'likes',
  object: 'TypeScript',
  confidence: 0.9,
  decayRate: DecayRate.fast,
  timestamp: new Date('2024-01-01T12:00:00Z'),
  sourceSessionId: 'session-1',
  sourceSessionLabel: 'Test Session',
  context: 'test context',
});

await store.store({
  subject: 'TestSubject1',
  predicate: 'uses',
  object: 'Node.js',
  confidence: 0.85,
  decayRate: DecayRate.medium,
  timestamp: new Date('2024-01-02T12:00:00Z'),
  sourceSessionId: 'session-1',
  sourceSessionLabel: 'Test Session',
});

await store.store({
  subject: 'TestSubject2',
  predicate: 'prefers',
  object: 'ESM',
  confidence: 0.8,
  decayRate: DecayRate.slow,
  timestamp: new Date('2024-01-03T12:00:00Z'),
  sourceSessionId: 'session-2',
});

// Add a raw log entry.
await store.ingest({
  userMessage: 'Hello',
  agentResponse: 'Hi there!',
  timestamp: new Date('2024-01-01T12:00:00Z'),
  source: 'openclaw',
  sessionId: 'session-1',
  sessionLabel: 'Test Session',
});

// Wait for fact extraction to complete.
await store.drain();
store.close();

after(() => {
  rmSync(dbPath, { force: true });
});

test('prints human-readable status with fact count, raw log count, and top subjects', async () => {
  // Capture console output
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    await statusCommand({ db: dbPath, userId });

    const fullOutput = logs.join('\n');

    assert.ok(fullOutput.includes('Plumb Memory — Local Store'), 'Should have header');
    assert.ok(fullOutput.includes('Facts:'), 'Should show fact count');
    assert.ok(fullOutput.includes('Raw log:'), 'Should show raw log count');
    assert.ok(fullOutput.includes('Last ingestion:'), 'Should show last ingestion time');
    assert.ok(fullOutput.includes('Storage:'), 'Should show storage size');
    assert.ok(fullOutput.includes('Top subjects:'), 'Should show top subjects section');
    assert.ok(fullOutput.includes('TestSubject1'), 'Should list top subject');
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
    assert.ok(typeof parsed.rawLogCount === 'number', 'Should have rawLogCount');
    assert.ok(parsed.lastIngestion === null || typeof parsed.lastIngestion === 'string', 'Should have lastIngestion');
    assert.ok(typeof parsed.storageBytes === 'number', 'Should have storageBytes');
    assert.ok(Array.isArray(parsed.topSubjects), 'Should have topSubjects array');
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
    process.exit = mock.fn((code?: string | number | null | undefined) => {
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
