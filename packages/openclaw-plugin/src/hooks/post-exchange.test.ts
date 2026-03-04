import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPostExchangeHook } from './post-exchange.js';
import type { LocalStore, MessageExchange } from '@plumb/core';
import type { PluginHookLlmOutputEvent, PluginHookAgentContext } from 'openclaw/plugin-sdk';

describe('createPostExchangeHook', () => {
  let mockStore: LocalStore;
  let ingestSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ingestSpy = vi.fn().mockResolvedValue({
      rawLogId: 'test-id',
      factsExtracted: 0,
      factIds: [],
    });

    mockStore = {
      ingest: ingestSpy,
    } as unknown as LocalStore;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('constructs exchange with correct fields from event and context', async () => {
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: PluginHookLlmOutputEvent & { prompt?: string } = {
      runId: 'run-123',
      sessionId: 'session-abc',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Hello', 'world'],
      prompt: 'Test prompt',
    };

    const ctx: PluginHookAgentContext = {
      sessionId: 'ctx-session-xyz',
      sessionKey: 'agent:main:test:2026-03-04',
      workspaceDir: '/workspace',
    };

    hook(event, ctx);

    // Wait for async ingest to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(ingestSpy).toHaveBeenCalledOnce();
    const call = ingestSpy.mock.calls[0]?.[0] as MessageExchange;
    expect(call).toBeDefined();

    expect(call.userMessage).toBe('Test prompt');
    expect(call.agentResponse).toBe('Hello\nworld');
    expect(call.sessionId).toBe('ctx-session-xyz');
    expect(call.sessionLabel).toBe('agent:main:test:2026-03-04');
    expect(call.source).toBe('openclaw');
    expect(call.timestamp).toBeInstanceOf(Date);
  });

  it('joins multiple assistantTexts with newline', async () => {
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: PluginHookLlmOutputEvent & { prompt?: string } = {
      runId: 'run-123',
      sessionId: 'session-abc',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Part 1', 'Part 2', 'Part 3'],
      prompt: 'Multi-part test',
    };

    const ctx: PluginHookAgentContext = {
      sessionId: 'session-xyz',
    };

    hook(event, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));

    const call = ingestSpy.mock.calls[0]?.[0] as MessageExchange;
    expect(call).toBeDefined();
    expect(call.agentResponse).toBe('Part 1\nPart 2\nPart 3');
  });

  it('falls back to event.sessionId when ctx.sessionId is undefined', async () => {
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: PluginHookLlmOutputEvent & { prompt?: string } = {
      runId: 'run-123',
      sessionId: 'event-session-123',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Response'],
      prompt: 'Prompt',
    };

    const ctx: PluginHookAgentContext = {};

    hook(event, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));

    const call = ingestSpy.mock.calls[0]?.[0] as MessageExchange;
    expect(call).toBeDefined();
    expect(call.sessionId).toBe('event-session-123');
  });

  it('generates random sessionId when both ctx and event sessionId are undefined', async () => {
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: Partial<PluginHookLlmOutputEvent> & { prompt?: string } = {
      runId: 'run-123',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Response'],
      prompt: 'Prompt',
    };

    const ctx: PluginHookAgentContext = {};

    hook(event as PluginHookLlmOutputEvent, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));

    const call = ingestSpy.mock.calls[0]?.[0] as MessageExchange;
    expect(call).toBeDefined();
    // Should be a valid UUID format
    expect(call.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('does not throw when store.ingest rejects', async () => {
    ingestSpy.mockRejectedValue(new Error('Database unreachable'));
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: PluginHookLlmOutputEvent & { prompt?: string } = {
      runId: 'run-123',
      sessionId: 'session-abc',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Response'],
      prompt: 'Prompt',
    };

    const ctx: PluginHookAgentContext = {
      sessionId: 'session-xyz',
    };

    // Should not throw
    expect(() => hook(event, ctx)).not.toThrow();

    // Wait for promise rejection to be caught
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('handles missing prompt field gracefully', async () => {
    const hook = createPostExchangeHook(mockStore, 'test-user');

    const event: PluginHookLlmOutputEvent = {
      runId: 'run-123',
      sessionId: 'session-abc',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      assistantTexts: ['Response'],
    };

    const ctx: PluginHookAgentContext = {
      sessionId: 'session-xyz',
    };

    hook(event, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));

    const call = ingestSpy.mock.calls[0]?.[0] as MessageExchange;
    expect(call).toBeDefined();
    expect(call.userMessage).toBe('');
  });
});
