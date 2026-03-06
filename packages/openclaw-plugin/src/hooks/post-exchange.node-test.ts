import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPostExchangeHook } from './post-exchange.js';
import type { LocalStore, MessageExchange } from '@getplumb/core';

type PluginHookLlmOutputEvent = {
  runId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: unknown;
};

type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

/** Creates a minimal LocalStore stub that records ingest calls. */
function makeStore(opts?: { rejectWith?: Error }) {
  const calls: MessageExchange[] = [];
  const store: Partial<LocalStore> = {
    ingest: async (exchange: MessageExchange) => {
      if (opts?.rejectWith) throw opts.rejectWith;
      calls.push(exchange);
      return { rawLogId: 'test-id', factsExtracted: 0, factIds: [] };
    },
  };
  return { store: store as LocalStore, calls };
}

/** Wait one microtask/macro cycle for fire-and-forget async to settle. */
function tick(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createPostExchangeHook — pendingPrompts wiring', () => {
  test('userMessage comes from pendingPrompts keyed by ctx.sessionId', async () => {
    const { store, calls } = makeStore();
    const pendingPrompts = new Map<string, string>();
    pendingPrompts.set('ctx-session-xyz', 'Test user prompt');

    const hook = createPostExchangeHook(store, 'user1', pendingPrompts);
    const event: PluginHookLlmOutputEvent = {
      runId: 'run-1',
      sessionId: 'event-session',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Hello', 'world'],
    };
    const ctx: PluginHookAgentContext = {
      sessionId: 'ctx-session-xyz',
      sessionKey: 'agent:main:test:2026-03-05-xxxx',
      workspaceDir: '/workspace',
    };

    hook(event, ctx);
    await tick();

    assert.equal(calls.length, 1, 'ingest called once');
    const exchange = calls[0]!;
    assert.equal(exchange.userMessage, 'Test user prompt');
    assert.equal(exchange.agentResponse, 'Hello\nworld');
    assert.equal(exchange.sessionId, 'ctx-session-xyz');
    assert.equal(exchange.source, 'openclaw');
  });

  test('pendingPrompts entry is deleted after exchange is ingested', async () => {
    const { store } = makeStore();
    const pendingPrompts = new Map<string, string>();
    pendingPrompts.set('session-abc', 'some prompt');

    const hook = createPostExchangeHook(store, 'user1', pendingPrompts);
    const event: PluginHookLlmOutputEvent = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'session-abc' };

    hook(event, ctx);
    await tick();

    assert.equal(pendingPrompts.has('session-abc'), false, 'entry removed after ingest');
  });

  test('falls back to event.sessionId when ctx.sessionId is undefined', async () => {
    const { store, calls } = makeStore();
    const pendingPrompts = new Map<string, string>();
    pendingPrompts.set('event-session-123', 'prompt via event session');

    const hook = createPostExchangeHook(store, 'user1', pendingPrompts);
    const event: PluginHookLlmOutputEvent = {
      sessionId: 'event-session-123',
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = {};

    hook(event, ctx);
    await tick();

    assert.equal(calls[0]?.sessionId, 'event-session-123');
  });

  test('userMessage is empty string when sessionId not in map', async () => {
    const { store, calls } = makeStore();
    const pendingPrompts = new Map<string, string>();

    const hook = createPostExchangeHook(store, 'user1', pendingPrompts);
    const event: PluginHookLlmOutputEvent = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'unknown-session' };

    hook(event, ctx);
    await tick();

    assert.equal(calls[0]?.userMessage, '');
  });

  test('works without pendingPrompts map (backwards compat)', async () => {
    const { store, calls } = makeStore();

    const hook = createPostExchangeHook(store, 'user1');
    const event: PluginHookLlmOutputEvent = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'session-xyz' };

    hook(event, ctx);
    await tick();

    assert.equal(calls[0]?.userMessage, '');
  });

  test('joins multiple assistantTexts with newline', async () => {
    const { store, calls } = makeStore();
    const hook = createPostExchangeHook(store, 'user1');

    const event: PluginHookLlmOutputEvent = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['Part 1', 'Part 2', 'Part 3'],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'session-xyz' };

    hook(event, ctx);
    await tick();

    assert.equal(calls[0]?.agentResponse, 'Part 1\nPart 2\nPart 3');
  });

  test('does not throw when store.ingest rejects', async () => {
    const { store } = makeStore({ rejectWith: new Error('DB unreachable') });
    const hook = createPostExchangeHook(store, 'user1');

    const event: PluginHookLlmOutputEvent = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'session-xyz' };

    // Must not throw synchronously
    assert.doesNotThrow(() => hook(event, ctx));
    await tick();
    // No assertion needed — just verifying it doesn't crash the process
  });

  test('generates a valid UUID sessionId when both ctx and event sessionId are missing', async () => {
    const { store, calls } = makeStore();
    const hook = createPostExchangeHook(store, 'user1');

    const event: Partial<PluginHookLlmOutputEvent> = {
      provider: 'anthropic',
      model: 'claude',
      assistantTexts: ['response'],
    };
    const ctx: PluginHookAgentContext = {};

    hook(event as PluginHookLlmOutputEvent, ctx);
    await tick();

    assert.match(
      calls[0]?.sessionId ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
