import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { LocalStore, DecayRate } from '@getplumb/core';
import { exportCommand } from './commands/export.js';

// Use a unique temp path per test run.
const dbPath = join(tmpdir(), `plumb-export-test-${Date.now()}.db`);
const userId = 'test-user';

// Set up test data.
const store = new LocalStore({ dbPath, userId });

// Add some test facts.
await store.store({
  subject: 'Alice',
  predicate: 'likes',
  object: 'TypeScript',
  confidence: 0.95,
  decayRate: DecayRate.slow,
  timestamp: new Date('2026-03-01T10:00:00Z'),
  sourceSessionId: 'session-1',
  sourceSessionLabel: 'test-session',
  context: 'mentioned in conversation',
});

await store.store({
  subject: 'Bob',
  predicate: 'uses',
  object: 'Rust',
  confidence: 0.85,
  decayRate: DecayRate.medium,
  timestamp: new Date('2026-03-02T15:00:00Z'),
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

// Wait for fact extraction to complete.
await store.drain();
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

test('exportAll() returns facts and rawLog', () => {
  const store2 = new LocalStore({ dbPath, userId });
  const data = store2.exportAll(userId);
  store2.close();

  assert.ok(data.facts.length >= 2, 'should have at least 2 facts');
  assert.ok(data.rawLog.length >= 1, 'should have at least 1 raw log entry');

  // Check fact structure.
  const fact = data.facts[0]!;
  assert.ok(fact.id, 'fact should have id');
  assert.ok(fact.subject, 'fact should have subject');
  assert.ok(fact.predicate, 'fact should have predicate');
  assert.ok(fact.object, 'fact should have object');
  assert.ok(typeof fact.confidence === 'number', 'fact should have confidence');
  assert.ok(fact.decayRate, 'fact should have decayRate');
  assert.ok(fact.timestamp, 'fact should have timestamp');
  assert.ok(typeof fact.deleted === 'boolean', 'fact should have deleted boolean');

  // Check raw log structure.
  const entry = data.rawLog[0]!;
  assert.ok(entry.id, 'entry should have id');
  assert.ok(entry.userMessage, 'entry should have userMessage');
  assert.ok(entry.agentResponse, 'entry should have agentResponse');
  assert.ok(entry.timestamp, 'entry should have timestamp');
  assert.ok(entry.source, 'entry should have source');
});

test('exportCommand creates directory with all files', () => {
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

    // Check that all required files exist.
    assert.ok(existsSync(join(exportDir, 'facts.json')), 'facts.json should exist');
    assert.ok(existsSync(join(exportDir, 'facts.md')), 'facts.md should exist');
    assert.ok(existsSync(join(exportDir, 'raw-log.json')), 'raw-log.json should exist');
    assert.ok(existsSync(join(exportDir, 'raw-log.md')), 'raw-log.md should exist');
    assert.ok(existsSync(join(exportDir, 'export-summary.json')), 'export-summary.json should exist');

    // Check facts.json structure.
    const factsJson = JSON.parse(readFileSync(join(exportDir, 'facts.json'), 'utf-8'));
    assert.ok(Array.isArray(factsJson), 'facts.json should be an array');
    assert.ok(factsJson.length >= 2, 'facts.json should have at least 2 items');

    // Check raw-log.json structure.
    const rawLogJson = JSON.parse(readFileSync(join(exportDir, 'raw-log.json'), 'utf-8'));
    assert.ok(Array.isArray(rawLogJson), 'raw-log.json should be an array');
    assert.ok(rawLogJson.length >= 1, 'raw-log.json should have at least 1 item');

    // Check export-summary.json structure.
    const summary = JSON.parse(readFileSync(join(exportDir, 'export-summary.json'), 'utf-8'));
    assert.ok(summary.exportedAt, 'summary should have exportedAt');
    assert.equal(summary.userId, userId, 'summary should have correct userId');
    assert.ok(typeof summary.factCount === 'number', 'summary should have factCount');
    assert.ok(typeof summary.rawLogCount === 'number', 'summary should have rawLogCount');
    assert.equal(summary.dbPath, dbPath, 'summary should have correct dbPath');

    // Check that Markdown files are non-empty.
    const factsMd = readFileSync(join(exportDir, 'facts.md'), 'utf-8');
    assert.ok(factsMd.length > 0, 'facts.md should not be empty');
    assert.ok(factsMd.includes('# Plumb Facts Export'), 'facts.md should have header');

    const rawLogMd = readFileSync(join(exportDir, 'raw-log.md'), 'utf-8');
    assert.ok(rawLogMd.length > 0, 'raw-log.md should not be empty');
    assert.ok(rawLogMd.includes('# Plumb Raw Log Export'), 'raw-log.md should have header');
  } finally {
    console.log = originalLog;
  }
});
