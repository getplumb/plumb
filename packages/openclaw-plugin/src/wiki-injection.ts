/**
 * wiki-injection.ts — [PLUMB WIKI] injection block for v2 mode.
 *
 * Before each response (when wikiMode='v2'):
 *   1. Extract the user's query from the event.
 *   2. Search wiki.db for the top-5 relevant pages.
 *   3. Format as the [PLUMB WIKI] injection block.
 *   4. Return it for prepending to the system prompt.
 *
 * In v2-shadow mode: search runs, block is logged, but nothing is injected.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { WikiSearch } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types (inline — not re-exported from openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INJECTION_TIMEOUT_MS = 1000;
const TOP_K = 5;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WikiInjectionOptions {
  /** Absolute path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Absolute path to wiki.db. Defaults to ~/.plumb/wiki.db */
  wikiDbPath?: string;
  /**
   * v2: inject block into prompt.
   * v2-shadow: compute block but don't inject (log only).
   */
  wikiMode: 'v2' | 'v2-shadow';
}

// ---------------------------------------------------------------------------
// Lazy WikiSearch singleton (one per injection hook instance)
// ---------------------------------------------------------------------------

async function openWikiSearch(wikiRoot: string, wikiDbPath: string): Promise<WikiSearch> {
  return WikiSearch.create({ wikiRoot, dbPath: wikiDbPath, preCheck: false });
}

// ---------------------------------------------------------------------------
// Query extraction helpers (mirrors pre-response.ts pattern)
// ---------------------------------------------------------------------------

function stripWikiAndMemoryBlocks(text: string): string {
  return text
    .replace(/\[PLUMB MEMORY\][\s\S]*?\[\/PLUMB MEMORY\]/g, '')
    .replace(/\[PLUMB WIKI\][\s\S]*?\[\/PLUMB WIKI\]/g, '')
    .trim();
}

function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (!msg || msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      const trimmed = stripWikiAndMemoryBlocks(msg.content);
      if (trimmed) return trimmed;
    }
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === 'object' && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim();
          if (t) parts.push(t);
        }
      }
      const joined = parts.join(' ');
      const cleaned = stripWikiAndMemoryBlocks(joined);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function extractFromPromptEnvelope(prompt: string): string | null {
  const stripped = prompt
    .replace(/^Sender\s*\(untrusted metadata\)\s*:\s*```json[\s\S]*?```\s*/i, '')
    .trim();
  const withoutTimestamp = stripped.replace(/^\[.*?\]\s*\[.*?\]\s*\n?/, '').trim();
  return withoutTimestamp || null;
}

// ---------------------------------------------------------------------------
// Injection block formatter (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Format the [PLUMB WIKI] injection block.
 *
 * Structure:
 *   [PLUMB WIKI]
 *   Relevant wiki pages:
 *
 *   1. **Title** (path) [type]
 *      Snippet text...
 *
 *   ...
 *
 *   Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links
 *   [/PLUMB WIKI]
 */
function formatWikiBlock(
  results: Array<{ path: string; title: string; type: string; snippet: string; score: number }>,
): string {
  const lines: string[] = ['[PLUMB WIKI]'];

  if (results.length === 0) {
    lines.push('No relevant wiki pages found for this query.');
  } else {
    lines.push('Relevant wiki pages:');
    lines.push('');
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      lines.push(`${i + 1}. **${r.title}** (${r.path}) [${r.type}]`);
      const snippet = r.snippet.slice(0, 250).replace(/\n+/g, ' ');
      lines.push(`   ${snippet}`);
      lines.push('');
    }
  }

  lines.push(
    'Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links',
  );
  lines.push('[/PLUMB WIKI]');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create the before_prompt_build hook that injects a [PLUMB WIKI] block.
 *
 * The returned hook:
 *   - Extracts the user query from event.messages or event.prompt.
 *   - Searches wiki.db for top-5 relevant pages (with a 1s timeout).
 *   - In v2 mode: returns prependContext with the formatted block.
 *   - In v2-shadow mode: logs the block but returns nothing (V1 injection continues).
 *
 * @param options  wikiRoot, wikiDbPath, wikiMode
 */
export function createWikiInjectionHook(options: WikiInjectionOptions) {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const wikiDbPath = options.wikiDbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const { wikiMode } = options;

  // One shared search instance, lazily initialized on first use.
  let searchPromise: Promise<WikiSearch> | null = null;
  function getSearch(): Promise<WikiSearch> {
    if (!searchPromise) {
      searchPromise = openWikiSearch(wikiRoot, wikiDbPath).catch((err) => {
        // Reset so it can retry next time
        searchPromise = null;
        throw err;
      });
    }
    return searchPromise;
  }

  return async (
    event: PluginHookBeforePromptBuildEvent,
    _ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    // Extract the user query
    const userMessage = extractLastUserMessage(event.messages);
    const envelopeMessage = userMessage ? null : extractFromPromptEnvelope(event.prompt);
    const queryText = userMessage ?? envelopeMessage ?? event.prompt;

    if (!queryText) return;

    let block: string;
    try {
      const results = await Promise.race([
        (async () => {
          const search = await getSearch();
          return search.search(queryText, TOP_K);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), INJECTION_TIMEOUT_MS),
        ),
      ]);
      block = formatWikiBlock(results);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'timeout') {
        console.warn('[plumb:wiki] wiki search timeout — skipping injection');
      } else {
        console.warn('[plumb:wiki] wiki search error:', e);
      }
      return;
    }

    if (wikiMode === 'v2-shadow') {
      console.debug('[plumb:wiki] shadow mode — would inject:', block.slice(0, 200));
      return;
    }

    // v2: inject the block
    return { prependContext: block };
  };
}
