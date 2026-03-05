import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPreResponseHook } from './pre-response.js';
import type { LocalStore, MemoryContext } from '@getplumb/core';

// Mock the @plumb/core functions
vi.mock('@plumb/core', async () => {
  const actual = await vi.importActual('@plumb/core');
  return {
    ...actual,
    buildMemoryContext: vi.fn(),
    formatContextBlock: vi.fn(),
  };
});

import { buildMemoryContext, formatContextBlock } from '@getplumb/core';

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

describe('createPreResponseHook', () => {
  let mockStore: LocalStore;
  let buildMemoryContextSpy: ReturnType<typeof vi.fn>;
  let formatContextBlockSpy: ReturnType<typeof vi.fn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockStore = {} as LocalStore;
    buildMemoryContextSpy = vi.mocked(buildMemoryContext);
    formatContextBlockSpy = vi.mocked(formatContextBlock);
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleDebugSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('returns prependContext with [PLUMB MEMORY] block when store has relevant results', async () => {
    const mockMemoryContext: MemoryContext = {
      highConfidence: [
        {
          fact: {
            id: 'fact-1',
            userId: 'test-user',
            subject: 'user',
            predicate: 'is building',
            object: 'Plumb',
            timestamp: new Date(),
            sourceSessionId: 'session-1',
            sourceSessionLabel: 'tech-planning',
            confidence: 0.9,
            lastAccessed: new Date(),
          },
          score: 0.85,
          ageInDays: 0,
        },
      ],
      mediumConfidence: [],
      lowConfidence: [],
      relatedConversations: [],
    };

    const formattedContext = '[MEMORY CONTEXT]\n\n## High confidence facts\n- user is building Plumb (0.85, session: tech-planning, today)';

    buildMemoryContextSpy.mockResolvedValue(mockMemoryContext);
    formatContextBlockSpy.mockReturnValue(formattedContext);

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'What am I working on?',
      messages: [],
    };
    const ctx: PluginHookAgentContext = { sessionId: 'test-session' };

    const result = await hook(event, ctx);

    expect(buildMemoryContextSpy).toHaveBeenCalledWith('What am I working on?', mockStore);
    expect(formatContextBlockSpy).toHaveBeenCalledWith(mockMemoryContext);
    expect(result).toEqual({
      prependContext: `[PLUMB MEMORY]\n${formattedContext}\n[/PLUMB MEMORY]`,
    });
  });

  it('returns void when store returns empty memory context', async () => {
    const emptyMemoryContext: MemoryContext = {
      highConfidence: [],
      mediumConfidence: [],
      lowConfidence: [],
      relatedConversations: [],
    };

    buildMemoryContextSpy.mockResolvedValue(emptyMemoryContext);
    formatContextBlockSpy.mockReturnValue('');

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Random query',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
  });

  it('returns void when formatContextBlock returns whitespace-only string', async () => {
    const mockMemoryContext: MemoryContext = {
      highConfidence: [],
      mediumConfidence: [],
      lowConfidence: [],
      relatedConversations: [],
    };

    buildMemoryContextSpy.mockResolvedValue(mockMemoryContext);
    formatContextBlockSpy.mockReturnValue('   \n  ');

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Test',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
  });

  it('returns void and logs warning when retrieval exceeds 800ms timeout', async () => {
    // Mock buildMemoryContext to delay longer than 800ms
    buildMemoryContextSpy.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                highConfidence: [],
                mediumConfidence: [],
                lowConfidence: [],
                relatedConversations: [],
              }),
            1000
          )
        )
    );

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Slow query',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[plumb] memory retrieval timeout — skipping injection'
    );
  });

  it('returns void when store is null', async () => {
    const hook = createPreResponseHook(null, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Test query',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
    expect(buildMemoryContextSpy).not.toHaveBeenCalled();
  });

  it('in shadow mode: logs but returns void even when memories exist', async () => {
    const mockMemoryContext: MemoryContext = {
      highConfidence: [
        {
          fact: {
            id: 'fact-1',
            userId: 'test-user',
            subject: 'user',
            predicate: 'prefers',
            object: 'TypeScript',
            timestamp: new Date(),
            sourceSessionId: 'session-1',
            sourceSessionLabel: 'dev-chat',
            confidence: 0.8,
            lastAccessed: new Date(),
          },
          score: 0.75,
          ageInDays: 1,
        },
      ],
      mediumConfidence: [],
      lowConfidence: [],
      relatedConversations: [],
    };

    const formattedContext = '[MEMORY CONTEXT]\n\n## High confidence facts\n- user prefers TypeScript (0.75, session: dev-chat, yesterday)';

    buildMemoryContextSpy.mockResolvedValue(mockMemoryContext);
    formatContextBlockSpy.mockReturnValue(formattedContext);

    const hook = createPreResponseHook(mockStore, null, true); // shadowMode = true
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'What language do I use?',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(buildMemoryContextSpy).toHaveBeenCalledWith('What language do I use?', mockStore);
    expect(formatContextBlockSpy).toHaveBeenCalledWith(mockMemoryContext);
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      '[plumb] shadow mode — would inject:',
      expect.stringContaining('[PLUMB MEMORY]')
    );
    expect(result).toBeUndefined();
  });

  it('handles errors from buildMemoryContext gracefully', async () => {
    buildMemoryContextSpy.mockRejectedValue(new Error('Database error'));

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Test query',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
    // Should not log warning for non-timeout errors
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('handles errors from formatContextBlock gracefully', async () => {
    const mockMemoryContext: MemoryContext = {
      highConfidence: [],
      mediumConfidence: [],
      lowConfidence: [],
      relatedConversations: [],
    };

    buildMemoryContextSpy.mockResolvedValue(mockMemoryContext);
    formatContextBlockSpy.mockImplementation(() => {
      throw new Error('Formatting error');
    });

    const hook = createPreResponseHook(mockStore, null, false);
    const event: PluginHookBeforePromptBuildEvent = {
      prompt: 'Test query',
      messages: [],
    };
    const ctx: PluginHookAgentContext = {};

    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
  });
});
