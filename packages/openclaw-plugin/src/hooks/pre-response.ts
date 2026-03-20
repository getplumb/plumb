import { buildMemoryContext, formatContextBlock } from '@getplumb/core';
import type { LocalStore } from '@getplumb/core';
import Database from 'better-sqlite3';
import { OrientationManager } from '../orientation.js';
import { patchWorkspaceFiles } from '../workspace-patcher.js';

// Define types inline since they aren't re-exported from openclaw/plugin-sdk
type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
};

type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

const INJECTION_TIMEOUT_MS = 800;
const MAX_PENDING_PROMPTS = 1000;

/**
 * Strip [PLUMB MEMORY]...[/PLUMB MEMORY] blocks from text.
 *
 * On subsequent turns, OpenClaw bakes the injected memory block into the user message
 * content (since it was prepended via prependContext). If we use that contaminated text
 * as the retrieval query, we get a self-referential feedback loop where the search keeps
 * returning the same memories. Stripping these blocks ensures we search on the user's
 * actual question.
 */
function stripPlumbBlocks(text: string): string {
  return text.replace(/\[PLUMB MEMORY\][\s\S]*?\[\/PLUMB MEMORY\]/g, '').trim();
}

/**
 * Extract the user's actual message from event.prompt on the first turn.
 *
 * On a fresh session (messages.length === 0), OpenClaw passes the inbound message as
 * event.prompt with metadata envelope prepended:
 *
 *   Sender (untrusted metadata):\n```json\n{...}\n```\n\nActual user message here
 *
 * This function strips the metadata envelope and returns just the user's message.
 * Returns null if no meaningful content remains after stripping.
 */
function extractFromPromptEnvelope(prompt: string): string | null {
  // Strip "Sender (untrusted metadata):" followed by a JSON code block
  const stripped = prompt
    .replace(/^Sender\s*\(untrusted metadata\)\s*:\s*```json[\s\S]*?```\s*/i, '')
    .trim();
  // Also strip standalone "[timestamp] [channel]" prefix lines
  const withoutTimestamp = stripped
    .replace(/^\[.*?\]\s*\[.*?\]\s*\n?/, '')
    .trim();
  return withoutTimestamp || null;
}

/**
 * Extracts the text content of the last user message from a messages array.
 *
 * Handles both string content and array content. OpenClaw's session messages use
 * two formats: plain string content, or an array of blocks where each block has a
 * `.text` field (mirroring OpenClaw's internal extractMessageText logic). Both cases
 * are handled here — no `type` field check needed on the block.
 *
 * Automatically strips [PLUMB MEMORY] blocks to avoid feedback-loop contamination.
 *
 * Returns null if no user message is found.
 */
function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (!msg || msg.role !== 'user') continue;
    // Plain string content
    if (typeof msg.content === 'string') {
      const trimmed = stripPlumbBlocks(msg.content);
      if (trimmed) return trimmed;
    }
    // Array content — extract .text from each block (OpenClaw internal format)
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === 'object' && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim();
          if (t) parts.push(t);
        }
      }
      const joined = parts.join(' ');
      const cleaned = stripPlumbBlocks(joined);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/**
 * Creates a hook handler that retrieves and injects memory context before each agent response.
 *
 * The hook queries the store with the incoming user message (extracted from event.messages),
 * falling back to event.prompt if no user message is present. This ensures fresh sessions
 * get query-relevant memories injected on the very first message (Tier 2 fix).
 *
 * Also stores the resolved query text in the pendingPrompts map (keyed by sessionId) so the
 * post-exchange hook can associate the user's question with the LLM's response for ingestion.
 *
 * On the very first call (fresh database), injects a one-time orientation block before normal memory.
 *
 * @param store LocalStore instance for memory retrieval
 * @param dbPath Path to the Plumb database for orientation check
 * @param shadowMode If true, retrieves and logs what would be injected but doesn't actually inject
 * @param pendingPrompts Shared map for passing the resolved query to the post-exchange hook
 * @returns Hook handler for before_prompt_build event
 */
export function createPreResponseHook(
  store: LocalStore | null,
  dbPath?: string | null,
  shadowMode = false,
  pendingPrompts?: Map<string, string>
) {
  return async (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    // Resolve the best query signal for memory retrieval.
    //
    // Priority chain:
    //   1. Last user message from event.messages (with [PLUMB MEMORY] blocks stripped)
    //   2. User's actual message extracted from event.prompt envelope (first turn only:
    //      on fresh sessions, event.messages is empty and event.prompt contains the
    //      inbound message wrapped in a metadata envelope)
    //   3. Raw event.prompt as last resort
    //
    // Bug fixes addressed:
    //   - First message: event.messages is empty, so we parse the envelope from event.prompt
    //   - Subsequent messages: user content is contaminated with injected [PLUMB MEMORY]
    //     blocks from the previous turn, so we strip them before using as search query
    const userMessage = extractLastUserMessage(event.messages);
    const envelopeMessage = userMessage ? null : extractFromPromptEnvelope(event.prompt);
    const queryText = userMessage ?? envelopeMessage ?? event.prompt;

    // Store the resolved query in pendingPrompts BEFORE the store guard so that even when
    // store is null the prompt is available to the post-exchange hook.
    if (pendingPrompts && ctx.sessionId && queryText) {
      // Evict the oldest entry if at capacity (insertion-order eviction via Map)
      if (pendingPrompts.size >= MAX_PENDING_PROMPTS) {
        const firstKey = pendingPrompts.keys().next().value;
        if (firstKey !== undefined) pendingPrompts.delete(firstKey);
      }
      pendingPrompts.set(ctx.sessionId, queryText);
    }

    if (!store) {
      return;
    }

    // Check for first activation orientation (T-124)
    let orientationText = '';
    if (dbPath) {
      try {
        const db = new Database(dbPath);
        const orientationManager = new OrientationManager();

        if (!orientationManager.hasOrientationFired(db)) {
          orientationText = orientationManager.getOrientationText(dbPath);
          orientationManager.recordOrientation(db);
          console.debug('[plumb] First activation — orientation injected');

          // T-125: Patch workspace files on first activation (fire-and-forget)
          void patchWorkspaceFiles(ctx.workspaceDir, console).catch(() => {
            // Errors are caught internally in patchWorkspaceFiles
          });
        }

        db.close();
      } catch (e: unknown) {
        console.warn('[plumb] Orientation check failed:', e);
        // Continue with normal memory injection even if orientation fails
      }
    }

    let formattedContext = '';

    try {
      // Race between retrieval and timeout
      const memoryContext = await Promise.race([
        buildMemoryContext(queryText, store),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), INJECTION_TIMEOUT_MS)
        ),
      ]);

      // Format the memory context into a prompt block
      formattedContext = formatContextBlock(memoryContext);
    } catch (e: unknown) {
      // Handle timeout silently — never slow down a response
      if (e instanceof Error && e.message === 'timeout') {
        console.warn('[plumb] memory retrieval timeout — skipping injection');
      }
    }

    // If we have orientation text, prepend it before normal memory
    // Otherwise, wrap normal memory in [PLUMB MEMORY] delimiters
    let finalBlock: string;
    if (orientationText) {
      // Orientation already has [PLUMB MEMORY] wrapper
      if (formattedContext) {
        // Append normal memory after orientation
        finalBlock = `${orientationText}\n\n[PLUMB MEMORY]\n${formattedContext}\n[/PLUMB MEMORY]`;
      } else {
        // Just orientation, no normal memory
        finalBlock = orientationText;
      }
    } else {
      // No orientation, just wrap normal memory
      finalBlock = `[PLUMB MEMORY]\n${formattedContext}\n[/PLUMB MEMORY]`;
    }

    // In shadow mode, log what would be injected but don't actually inject
    if (shadowMode) {
      console.debug('[plumb] shadow mode — would inject:', finalBlock.slice(0, 200));
      return;
    }

    // Return the block to be prepended to the system prompt
    return { prependContext: finalBlock };
  };
}
