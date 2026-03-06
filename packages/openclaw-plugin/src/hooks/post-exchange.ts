import { randomUUID } from 'node:crypto';
import type { LocalStore } from '@getplumb/core';
import { appendError } from '../error-logger.js';

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
 *
 * @param store LocalStore instance for ingestion
 * @param userId User ID for the exchange
 * @param pendingPrompts Shared map containing user prompts stored by pre-response hook
 */
export function createPostExchangeHook(
  store: LocalStore,
  userId: string,
  pendingPrompts?: Map<string, string>,
  dbPath?: string
) {
  return (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext): void => {
    const sessionId = ctx.sessionId ?? event.sessionId ?? randomUUID();

    // Retrieve and clear the user message from shared state
    const userMessage = pendingPrompts?.get(sessionId) ?? '';
    if (pendingPrompts && sessionId) {
      pendingPrompts.delete(sessionId);
    }

    const exchange = {
      id: randomUUID(),
      userId,
      sessionId,
      sessionLabel: ctx.sessionKey,
      userMessage,
      agentResponse: event.assistantTexts.join('\n'),
      timestamp: new Date().toISOString(),
      source: 'openclaw' as const,
    };

    // Fire-and-forget ingest — never blocks the hook
    (async () => {
      try {
        await store.ingest({
          userMessage: exchange.userMessage,
          agentResponse: exchange.agentResponse,
          timestamp: new Date(exchange.timestamp),
          source: exchange.source,
          sessionId: exchange.sessionId,
          ...(exchange.sessionLabel && { sessionLabel: exchange.sessionLabel }),
        });
      } catch (e: unknown) {
        // Log error to ~/.plumb/errors.log for debugging
        const errorEntry = {
          timestamp: new Date().toISOString(),
          type: 'ingest_error',
          message: e instanceof Error ? e.message : String(e),
          context: {
            sessionId: exchange.sessionId,
            userId,
            source: exchange.source,
          },
          ...(e instanceof Error && e.stack ? { stack: e.stack } : {}),
        };

        appendError(errorEntry, dbPath);

        // Also log to console for immediate visibility during development
        console.debug('[plumb] ingest error:', e);
      }
    })();
  };
}
