import type { LocalStore } from '@plumb/core';

// Import from full path since these aren't re-exported from openclaw/plugin-sdk
type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

/**
 * Creates a hook handler that ingests every LLM exchange into the local store.
 *
 * Fire-and-forget pattern: returns void synchronously, ingests in background.
 * Errors are caught and logged silently to avoid disrupting the agent flow.
 */
export function createPostExchangeHook(store: LocalStore, userId: string) {
  return (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
    const exchange = {
      id: crypto.randomUUID(),
      userId,
      sessionId: ctx.sessionId ?? event.sessionId ?? crypto.randomUUID(),
      sessionLabel: ctx.sessionKey,
      userMessage: (event as any).prompt ?? '',
      agentResponse: event.assistantTexts.join('\n'),
      timestamp: new Date().toISOString(),
      source: 'openclaw' as const,
    };

    // Fire-and-forget ingest — never blocks the hook
    (async () => {
      await store.ingest({
        userMessage: exchange.userMessage,
        agentResponse: exchange.agentResponse,
        timestamp: new Date(exchange.timestamp),
        source: exchange.source,
        sessionId: exchange.sessionId,
        ...(exchange.sessionLabel && { sessionLabel: exchange.sessionLabel }),
      });
    })().catch((e: unknown) => {
      console.debug('[plumb] ingest error:', e);
    });
  };
}
