import { buildMemoryContext, formatContextBlock } from '@getplumb/core';
import type { LocalStore } from '@getplumb/core';

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
const MAX_PENDING_PROMPTS = 1000; // Prevent memory leaks

/**
 * Creates a hook handler that retrieves and injects memory context before each agent response.
 *
 * The hook queries the store with the incoming user message, formats the retrieved memories
 * into a [PLUMB MEMORY] block, and prepends it to the system prompt.
 *
 * @param store LocalStore instance for memory retrieval
 * @param shadowMode If true, retrieves and logs what would be injected but doesn't actually inject
 * @param pendingPrompts Shared map for storing prompts to be consumed by post-exchange hook
 * @returns Hook handler for before_prompt_build event
 */
export function createPreResponseHook(
  store: LocalStore | null,
  shadowMode = false,
  pendingPrompts?: Map<string, string>
) {
  return async (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    // Store the user prompt in shared state for the post-exchange hook
    if (pendingPrompts && ctx.sessionId && event.prompt) {
      // Prevent memory leaks by enforcing a size cap
      if (pendingPrompts.size >= MAX_PENDING_PROMPTS) {
        // Remove the oldest entry (first entry in the map)
        const firstKey = pendingPrompts.keys().next().value;
        if (firstKey) {
          pendingPrompts.delete(firstKey);
        }
      }
      pendingPrompts.set(ctx.sessionId, event.prompt);
    }

    if (!store) {
      return;
    }

    let formattedContext = '';

    try {
      // Race between retrieval and timeout
      const memoryContext = await Promise.race([
        buildMemoryContext(event.prompt, store),
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

    // Wrap in [PLUMB MEMORY] delimiters
    const finalBlock = `[PLUMB MEMORY]\n${formattedContext}\n[/PLUMB MEMORY]`;

    // In shadow mode, log what would be injected but don't actually inject
    if (shadowMode) {
      console.debug('[plumb] shadow mode — would inject:', finalBlock.slice(0, 200));
      return;
    }

    // Return the block to be prepended to the system prompt
    return { prependContext: finalBlock };
  };
}
