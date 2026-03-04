import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from './extractor.js';
import type { MemoryStore } from './store.js';
import type { Fact, MessageExchange, SearchResult, StoreStatus } from './types.js';
import { DecayRate } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testExchange: MessageExchange = {
  userMessage: 'I prefer dark mode for all my editors.',
  agentResponse: 'Noted, I will use dark mode settings.',
  timestamp: new Date('2026-01-01T12:00:00Z'),
  source: 'openclaw',
  sessionId: 'session-001',
  sessionLabel: 'prefs-chat',
};

const testExchangeNoLabel: MessageExchange = {
  userMessage: 'I use TypeScript for everything.',
  agentResponse: 'Great choice.',
  timestamp: new Date('2026-01-01T13:00:00Z'),
  source: 'openclaw',
  sessionId: 'session-002',
};

// ---------------------------------------------------------------------------
// In-memory mock store
// ---------------------------------------------------------------------------

function createMockStore(): { store: MemoryStore; stored: Fact[] } {
  const stored: Fact[] = [];

  const store: MemoryStore = {
    async store(fact: Omit<Fact, 'id'>): Promise<string> {
      const id = crypto.randomUUID();
      stored.push({ id, ...fact });
      return id;
    },
    async search(_query: string, _limit?: number): Promise<readonly SearchResult[]> {
      return [];
    },
    async delete(_id: string): Promise<void> {},
    async status(): Promise<StoreStatus> {
      return { factCount: stored.length, rawLogCount: 0, lastIngestion: null, storageBytes: 0 };
    },
    async ingest(_exchange: MessageExchange) {
      return { rawLogId: crypto.randomUUID(), factsExtracted: 0, factIds: [] };
    },
  };

  return { store, stored };
}

// ---------------------------------------------------------------------------
// LLM mock helpers
// ---------------------------------------------------------------------------

function mockLLM(responseJson: unknown): (prompt: string) => Promise<string> {
  return async (_prompt: string) => JSON.stringify(responseJson);
}

function mockLLMWithFences(responseJson: unknown): (prompt: string) => Promise<string> {
  return async (_prompt: string) => '```json\n' + JSON.stringify(responseJson) + '\n```';
}

// ---------------------------------------------------------------------------
// Tests: structured output parsing
// ---------------------------------------------------------------------------

test('extractFacts: parses a valid JSON array and stores each fact', async () => {
  const { store, stored } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLM([
      {
        subject: 'user',
        predicate: 'prefers',
        object: 'dark mode',
        context: 'mentioned for all editors',
        confidence: 0.9,
        decay_rate: 'slow',
      },
    ]),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]!.subject, 'user');
  assert.equal(result[0]!.predicate, 'prefers');
  assert.equal(result[0]!.object, 'dark mode');
  assert.equal(result[0]!.context, 'mentioned for all editors');
  assert.equal(result[0]!.confidence, 0.9);
  assert.equal(result[0]!.decayRate, DecayRate.slow);
  assert.equal(result[0]!.sourceSessionId, 'session-001');
  assert.equal(result[0]!.sourceSessionLabel, 'prefs-chat');
  assert.match(result[0]!.id, /^[0-9a-f-]{36}$/);
  assert.equal(stored.length, 1);
});

test('extractFacts: strips markdown code fences before parsing', async () => {
  const { store } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLMWithFences([
      { subject: 'user', predicate: 'uses', object: 'TypeScript', confidence: 0.95, decay_rate: 'medium' },
    ]),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]!.object, 'TypeScript');
  assert.equal(result[0]!.decayRate, DecayRate.medium);
});

test('extractFacts: returns [] and stores nothing when LLM returns []', async () => {
  const { store, stored } = createMockStore();
  const result = await extractFacts(testExchange, 'user-1', store, mockLLM([]));
  assert.equal(result.length, 0);
  assert.equal(stored.length, 0);
});

test('extractFacts: returns [] gracefully when LLM returns invalid JSON', async () => {
  const { store, stored } = createMockStore();
  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    async () => 'This is definitely not JSON.',
  );
  assert.equal(result.length, 0);
  assert.equal(stored.length, 0);
});

test('extractFacts: handles multiple facts in one LLM response', async () => {
  const { store, stored } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLM([
      { subject: 'user', predicate: 'prefers', object: 'dark mode', confidence: 0.9, decay_rate: 'slow' },
      { subject: 'user', predicate: 'uses', object: 'vim keybindings', confidence: 0.8, decay_rate: 'medium' },
    ]),
  );

  assert.equal(result.length, 2);
  assert.equal(stored.length, 2);
});

test('extractFacts: clamps confidence to [0, 1]', async () => {
  const { store } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLM([
      { subject: 'a', predicate: 'b', object: 'c', confidence: 1.5, decay_rate: 'slow' },
      { subject: 'd', predicate: 'e', object: 'f', confidence: -0.3, decay_rate: 'fast' },
    ]),
  );

  assert.equal(result[0]!.confidence, 1.0);
  assert.equal(result[1]!.confidence, 0.0);
});

test('extractFacts: unknown decay_rate defaults to medium', async () => {
  const { store } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLM([{ subject: 'a', predicate: 'b', object: 'c', confidence: 0.5, decay_rate: 'unknown-rate' }]),
  );

  assert.equal(result[0]!.decayRate, DecayRate.medium);
});

test('extractFacts: sourceSessionLabel is omitted when exchange has no sessionLabel', async () => {
  const { store } = createMockStore();

  const result = await extractFacts(
    testExchangeNoLabel,
    'user-1',
    store,
    mockLLM([{ subject: 'user', predicate: 'uses', object: 'TypeScript', confidence: 0.9, decay_rate: 'slow' }]),
  );

  assert.equal(result[0]!.sourceSessionId, 'session-002');
  assert.equal(result[0]!.sourceSessionLabel, undefined);
});

test('extractFacts: context field is omitted when LLM does not include it', async () => {
  const { store } = createMockStore();

  const result = await extractFacts(
    testExchange,
    'user-1',
    store,
    mockLLM([{ subject: 'user', predicate: 'prefers', object: 'dark mode', confidence: 0.9, decay_rate: 'slow' }]),
  );

  assert.equal(result[0]!.context, undefined);
});

// ---------------------------------------------------------------------------
// Tests: deduplication strategy
// ---------------------------------------------------------------------------

test('extractFacts dedup: inserts new entry when same subject+predicate already exists', async () => {
  const { store, stored } = createMockStore();

  const singleFact = [
    { subject: 'user', predicate: 'prefers', object: 'dark mode', confidence: 0.9, decay_rate: 'slow' },
  ];

  // First extraction
  await extractFacts(testExchange, 'user-1', store, mockLLM(singleFact));
  assert.equal(stored.length, 1);

  // Second extraction with same subject+predicate
  await extractFacts(testExchange, 'user-1', store, mockLLM(singleFact));
  assert.equal(stored.length, 2, 'should insert new entry, not overwrite existing');

  // Both entries have unique IDs
  assert.notEqual(stored[0]!.id, stored[1]!.id);

  // Both have same subject+predicate
  assert.equal(stored[0]!.subject, stored[1]!.subject);
  assert.equal(stored[0]!.predicate, stored[1]!.predicate);
});
