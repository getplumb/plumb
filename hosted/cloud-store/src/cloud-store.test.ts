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
import type { MessageExchange } from '@getplumb/core';

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
      await store.close();
    }
  });

  it('should expose userId', { skip: skipIfNoSupabase }, () => {
    expect(store.userId).toBe(testUserId);
  });

  it('should return status', { skip: skipIfNoSupabase }, async () => {
    const status = await store.status();
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
});
