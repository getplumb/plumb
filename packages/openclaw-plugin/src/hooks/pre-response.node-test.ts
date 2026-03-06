import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPreResponseHook } from './pre-response.js';
import type { LocalStore } from '@getplumb/core';

type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

/**
 * Minimal LocalStore stub whose `search()` returns an empty results array.
 * This causes buildMemoryContext to produce an empty MemoryContext, so
 * createPreResponseHook returns void without needing to mock @getplumb/core.
 */
function makeEmptyStore(): LocalStore {
  return {
    search: async (_query: string, _opts?: unknown) => [],
    ingest: async () => ({ rawLogId: 'x', factsExtracted: 0, factIds: [] }),
    // satisfy any other required fields with no-ops
  } as unknown as LocalStore;
}

describe('createPreResponseHook — pendingPrompts wiring', () => {
  test('stores prompt in pendingPrompts map keyed by ctx.sessionId', async () => {
    const store = makeEmptyStore();
    const pendingPrompts = new Map<string, string>();

    const hook = createPreResponseHook(store, null, false, pendingPrompts);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'What am I working on?',
      messages: [],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'session-abc' };

    await hook(event, ctx);

    assert.equal(
      pendingPrompts.get('session-abc'),
      'What am I working on?',
      'prompt stored before retrieval'
    );
  });

  test('does not store prompt when ctx.sessionId is missing', async () => {
    const store = makeEmptyStore();
    const pendingPrompts = new Map<string, string>();

    const hook = createPreResponseHook(store, null, false, pendingPrompts);
    const event: PluginHookBeforePromptBuildEvent = { prompt: 'hello', messages: [] };
    const ctx: PluginHookAgentContext = {};

    await hook(event, ctx);

    assert.equal(pendingPrompts.size, 0);
  });

  test('does not store prompt when event.prompt is empty', async () => {
    const store = makeEmptyStore();
    const pendingPrompts = new Map<string, string>();

    const hook = createPreResponseHook(store, null, false, pendingPrompts);
    const event: PluginHookBeforePromptBuildEvent = { prompt: '', messages: [] };
    const ctx: PluginHookAgentContext = { sessionId: 'session-abc' };

    await hook(event, ctx);

    assert.equal(pendingPrompts.size, 0);
  });

  test('enforces MAX_PENDING_PROMPTS (1000) size cap: evicts oldest entry', async () => {
    const store = makeEmptyStore();
    const pendingPrompts = new Map<string, string>();

    // Pre-fill to max
    for (let i = 0; i < 1000; i++) {
      pendingPrompts.set(`session-${i}`, `prompt-${i}`);
    }

    const hook = createPreResponseHook(store, null, false, pendingPrompts);
    const event: PluginHookBeforePromptBuildEvent = { prompt: 'new prompt', messages: [] };
    const ctx: PluginHookAgentContext = { sessionId: 'new-session' };

    await hook(event, ctx);

    assert.equal(pendingPrompts.size, 1000, 'size stays at cap');
    assert.equal(pendingPrompts.get('new-session'), 'new prompt', 'new entry added');
    assert.equal(pendingPrompts.has('session-0'), false, 'oldest entry evicted');
  });

  test('works without pendingPrompts map (backwards compat)', async () => {
    const store = makeEmptyStore();
    const hook = createPreResponseHook(store, null, false); // no pendingPrompts

    const event: PluginHookBeforePromptBuildEvent = { prompt: 'test', messages: [] };
    const ctx: PluginHookAgentContext = { sessionId: 'session-abc' };

    // Should not throw
    await assert.doesNotReject(async () => hook(event, ctx));
  });

  test('returns void when store is null', async () => {
    const pendingPrompts = new Map<string, string>();
    const hook = createPreResponseHook(null, null, false, pendingPrompts);

    const event: PluginHookBeforePromptBuildEvent = { prompt: 'test', messages: [] };
    const ctx: PluginHookAgentContext = { sessionId: 'session-abc' };

    const result = await hook(event, ctx);

    // Even with null store, prompt should still be stored (stored before guard)
    assert.equal(pendingPrompts.get('session-abc'), 'test');
    assert.equal(result, undefined);
  });
});
