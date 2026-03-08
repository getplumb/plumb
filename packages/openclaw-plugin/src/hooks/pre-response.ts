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

/**
 * Creates a hook handler that retrieves and injects memory context before each agent response.
 *
 * The hook queries the store with the incoming user message, formats the retrieved memories
 * into a [PLUMB MEMORY] block, and prepends it to the system prompt.
 *
 * On the very first call (fresh database), injects a one-time orientation block before normal memory.
 *
 * @param store LocalStore instance for memory retrieval
 * @param shadowMode If true, retrieves and logs what would be injected but doesn't actually inject
 * @param dbPath Path to the Plumb database for orientation check
 * @returns Hook handler for before_prompt_build event
 */
export function createPreResponseHook(
  store: LocalStore | null,
  shadowMode = false,
  dbPath?: string
) {
  return async (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
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
