/**
 * CloudStore integration tests.
 *
 * These tests require a Supabase project with the schema applied.
 * Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars to run.
 *
 * If not set, tests are skipped gracefully (same pattern as ANTHROPIC_API_KEY).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CloudStore } from './cloud-store.js';
import { DecayRate, type MessageExchange } from '@getplumb/core';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const skipIfNoSupabase = SUPABASE_URL === undefined || SUPABASE_SERVICE_ROLE_KEY === undefined;

describe('CloudStore', () => {
  let store: CloudStore;
  const testUserId = `test-user-${Date.now()}`;

  beforeAll(() => {
    if (skipIfNoSupabase) {
      console.log('⚠️  Skipping CloudStore tests: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set');
      return;
    }

    store = new CloudStore({
      supabaseUrl: SUPABASE_URL!,
      supabaseKey: SUPABASE_SERVICE_ROLE_KEY!,
      userId: testUserId,
    });
  });

  afterAll(async () => {
    if (!skipIfNoSupabase && store) {
      await store.drain();
      await store.close();
    }
  });

  it('should expose userId', { skip: skipIfNoSupabase }, () => {
    expect(store.userId).toBe(testUserId);
  });

  it('should store a fact and return an id', { skip: skipIfNoSupabase }, async () => {
    const factId = await store.store({
      subject: 'test-subject',
      predicate: 'likes',
      object: 'test-object',
      confidence: 0.9,
      decayRate: DecayRate.medium,
      timestamp: new Date(),
      sourceSessionId: 'test-session-1',
    });

    expect(factId).toBeTruthy();
    expect(typeof factId).toBe('string');
  });

  it('should search for facts', { skip: skipIfNoSupabase }, async () => {
    // Store a fact first
    await store.store({
      subject: 'Alice',
      predicate: 'works on',
      object: 'Plumb project',
      confidence: 0.95,
      decayRate: DecayRate.slow,
      timestamp: new Date(),
      sourceSessionId: 'test-session-2',
    });

    // Search for it
    const results = await store.search('Alice works on Plumb', 10);
    expect(results.length).toBeGreaterThan(0);
    const topResult = results[0];
    expect(topResult).toBeDefined();
    expect(topResult!.fact.subject).toBe('Alice');
    expect(topResult!.fact.predicate).toBe('works on');
    expect(topResult!.fact.object).toBe('Plumb project');
  });

  it('should soft-delete a fact', { skip: skipIfNoSupabase }, async () => {
    const factId = await store.store({
      subject: 'Bob',
      predicate: 'likes',
      object: 'coffee',
      confidence: 0.8,
      decayRate: DecayRate.fast,
      timestamp: new Date(),
      sourceSessionId: 'test-session-3',
    });

    // Verify it exists
    const beforeDelete = await store.search('Bob likes coffee', 10);
    expect(beforeDelete.length).toBeGreaterThan(0);

    // Delete it
    await store.delete(factId);

    // Verify it's gone from search results
    const afterDelete = await store.search('Bob likes coffee', 10);
    const bobFact = afterDelete.find((r) => r.fact.id === factId);
    expect(bobFact).toBeUndefined();
  });

  it('should return status', { skip: skipIfNoSupabase }, async () => {
    const status = await store.status();
    expect(status.factCount).toBeGreaterThanOrEqual(0);
    expect(status.rawLogCount).toBeGreaterThanOrEqual(0);
    expect(status.storageBytes).toBeGreaterThanOrEqual(0);
  });

  it('should ingest an exchange', { skip: skipIfNoSupabase }, async () => {
    const exchange: MessageExchange = {
      userMessage: 'What is the capital of France?',
      agentResponse: 'The capital of France is Paris.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'test-session-4',
    };

    const result = await store.ingest(exchange);
    expect(result.rawLogId).toBeTruthy();
    expect(result.factsExtracted).toBe(0); // Fire-and-forget, so initially 0
  });

  it('should skip duplicate ingestions', { skip: skipIfNoSupabase }, async () => {
    const exchange: MessageExchange = {
      userMessage: 'Duplicate test message',
      agentResponse: 'Duplicate test response',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'test-session-5',
    };

    // First ingest
    const result1 = await store.ingest(exchange);
    expect(result1.skipped).toBeUndefined();

    // Second ingest (same content hash)
    const result2 = await store.ingest(exchange);
    expect(result2.skipped).toBe(true);
  });

  it('should search raw logs', { skip: skipIfNoSupabase }, async () => {
    // Ingest an exchange first
    const exchange: MessageExchange = {
      userMessage: 'Tell me about Supabase',
      agentResponse: 'Supabase is a Firebase alternative with Postgres.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'test-session-6',
    };

    await store.ingest(exchange);

    // Search raw logs
    const results = await store.searchRawLog('Supabase Postgres', 10);
    expect(results.length).toBeGreaterThan(0);
    const topResult = results[0];
    expect(topResult).toBeDefined();
    expect(topResult!.chunk_text).toContain('Supabase');
  });

  it('should drain in-flight extractions', { skip: skipIfNoSupabase }, async () => {
    // Ingest an exchange (triggers async fact extraction)
    const exchange: MessageExchange = {
      userMessage: 'My favorite color is blue',
      agentResponse: 'Great! Blue is a nice color.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'test-session-7',
    };

    await store.ingest(exchange);

    // Drain should wait for extraction to complete
    await expect(store.drain()).resolves.toBeUndefined();
  });
});
