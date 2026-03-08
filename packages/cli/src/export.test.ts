import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { LocalStore } from '@getplumb/core';
import { exportCommand } from './commands/export.js';

// Use a unique temp path per test run.
const dbPath = join(tmpdir(), `plumb-export-test-${Date.now()}.db`);
const userId = 'test-user';

// Set up test data using ingestMemoryFact and ingest.
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

// Add a raw log entry.
await store.ingest({
  userMessage: 'What is Plumb?',
  agentResponse: 'Plumb is an AI memory system.',
  timestamp: new Date('2026-03-03T12:00:00Z'),
  source: 'openclaw',
  sessionId: 'session-3',
  sessionLabel: 'onboarding',
});

store.close();

after(() => {
  rmSync(dbPath, { force: true });

  // Clean up any export directories created during tests.
  const exportDirs = readdirSync(process.cwd()).filter((name) =>
    name.startsWith('plumb-export-'),
  );
  for (const dir of exportDirs) {
    rmSync(join(process.cwd(), dir), { recursive: true, force: true });
  }
});

test('exportAll() returns rawLog entries', () => {
  const store2 = new LocalStore({ dbPath, userId });
  const data = store2.exportAll(userId);
  store2.close();

  assert.ok(data.rawLog.length >= 1, 'should have at least 1 raw log entry');

  // Check raw log structure.
  const entry = data.rawLog[0]!;
  assert.ok(entry.id, 'entry should have id');
  assert.ok(entry.userMessage, 'entry should have userMessage');
  assert.ok(entry.agentResponse, 'entry should have agentResponse');
  assert.ok(entry.timestamp, 'entry should have timestamp');
  assert.ok(entry.source, 'entry should have source');
});

test('exportCommand creates directory with raw log files', () => {
  // Capture original console.log
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  try {
    exportCommand({ db: dbPath, userId });

    // Find the created export directory.
    const exportDirs = readdirSync(process.cwd()).filter((name) =>
      name.startsWith('plumb-export-'),
    );
    assert.ok(exportDirs.length > 0, 'should create an export directory');

    const exportDir = join(process.cwd(), exportDirs[exportDirs.length - 1]!);
    assert.ok(existsSync(exportDir), 'export directory should exist');

    // Check that required files exist.
    assert.ok(existsSync(join(exportDir, 'raw-log.json')), 'raw-log.json should exist');
    assert.ok(existsSync(join(exportDir, 'raw-log.md')), 'raw-log.md should exist');
    assert.ok(existsSync(join(exportDir, 'export-summary.json')), 'export-summary.json should exist');

    // Check raw-log.json structure.
    const rawLogJson = JSON.parse(readFileSync(join(exportDir, 'raw-log.json'), 'utf-8'));
    assert.ok(Array.isArray(rawLogJson), 'raw-log.json should be an array');
    assert.ok(rawLogJson.length >= 1, 'raw-log.json should have at least 1 item');

    // Check export-summary.json structure.
    const summary = JSON.parse(readFileSync(join(exportDir, 'export-summary.json'), 'utf-8'));
    assert.ok(summary.exportedAt, 'summary should have exportedAt');
    assert.equal(summary.userId, userId, 'summary should have correct userId');
    assert.ok(typeof summary.rawLogCount === 'number', 'summary should have rawLogCount');
    assert.equal(summary.dbPath, dbPath, 'summary should have correct dbPath');

    // Check that Markdown files are non-empty.
    const rawLogMd = readFileSync(join(exportDir, 'raw-log.md'), 'utf-8');
    assert.ok(rawLogMd.length > 0, 'raw-log.md should not be empty');
    assert.ok(rawLogMd.includes('# Plumb Raw Log Export'), 'raw-log.md should have header');
  } finally {
    console.log = originalLog;
  }
});
