import { buildMemoryContext, formatContextBlock } from '@plumb/core';
import type { LocalStore } from '@plumb/core';

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

/**
 * Creates a hook handler that retrieves and injects memory context before each agent response.
 *
 * The hook queries the store with the incoming user message, formats the retrieved memories
 * into a [PLUMB MEMORY] block, and prepends it to the system prompt.
 *
 * @param store LocalStore instance for memory retrieval
 * @param shadowMode If true, retrieves and logs what would be injected but doesn't actually inject
 * @returns Hook handler for before_prompt_build event
 */
export function createPreResponseHook(store: LocalStore | null, shadowMode = false) {
  return async (
    event: PluginHookBeforePromptBuildEvent,
    _ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    if (!store) {
      return;
    }

    try {
      // Race between retrieval and timeout
      const memoryContext = await Promise.race([
        buildMemoryContext(event.prompt, store),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), INJECTION_TIMEOUT_MS)
        ),
      ]);

      // Format the memory context into a prompt block
      const formattedContext = formatContextBlock(memoryContext);

      // Skip injection if no memories were found
      if (!formattedContext || !formattedContext.trim()) {
        return;
      }

      // Wrap in [PLUMB MEMORY] delimiters
      const block = `[PLUMB MEMORY]\n${formattedContext}\n[/PLUMB MEMORY]`;

      // In shadow mode, log what would be injected but don't actually inject
      if (shadowMode) {
        console.debug('[plumb] shadow mode — would inject:', block.slice(0, 200));
        return;
      }

      // Return the block to be prepended to the system prompt
      return { prependContext: block };
    } catch (e: unknown) {
      // Handle timeout silently — never slow down a response
      if (e instanceof Error && e.message === 'timeout') {
        console.warn('[plumb] memory retrieval timeout — skipping injection');
      }
      return;
    }
  };
}
