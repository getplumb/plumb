/**
 * wiki-injection.ts — [PLUMB WIKI] injection block for v2 mode.
 *
 * Before each response (when wikiMode='v2'):
 *   1. Extract the user's query from the event.
 *   2. Search wiki.db for the top relevant chunks.
 *   3. Format as the [PLUMB WIKI] injection block.
 *   4. Return it for prepending to the system prompt.
 *
 * In v2-shadow mode: search runs, block is logged, but nothing is injected.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { WikiSearch, normalizeContextualConfig, type ContextualRetrievalConfig } from '@getplumb/core';

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
const TOP_K = 8;
const ACTIVE_CONTEXTUAL_TOP_K = 5;
const INJECTION_TOKEN_BUDGET = 1000;
const ACTIVE_CONTEXTUAL_DEFAULT_TOKEN_BUDGET = 900;
const PARENT_SECTION_CHAR_BUDGET = 1000;
const NEIGHBOR_CHUNK_WINDOW_EXTRA_CHAR_BUDGET = 500;
const MIN_INJECTED_PAGES = 3;

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
  /** E017 child contextual retrieval. Defaults to off and preserves current behavior. */
  contextualRetrieval?: Partial<ContextualRetrievalConfig> | ContextualRetrievalConfig;
  /** Optional local hook for prompt-injection telemetry. Never sent externally by this module. */
  onTelemetry?: (event: WikiInjectionTelemetryEvent) => void;
}

export type WikiInjectionTelemetryStatus = 'fired' | 'skipped';

export type WikiInjectionTelemetryReason =
  | 'ok'
  | 'empty_query'
  | 'timeout'
  | 'search_error'
  | 'shadow_mode'
  | 'requires_live_data';

export interface WikiInjectionTelemetryPage {
  path: string;
  title: string;
  type: string;
  score: number;
  tokens?: number;
}

export interface WikiInjectionTelemetryEvent {
  event: 'plumb.wiki_injection';
  status: WikiInjectionTelemetryStatus;
  reason: WikiInjectionTelemetryReason;
  mode: 'v2' | 'v2-shadow';
  query: string;
  candidatePages: WikiInjectionTelemetryPage[];
  injectedPages: WikiInjectionTelemetryPage[];
  budgetTokens: number;
  tokensUsed: number;
  elapsedMs: number;
  topK: number;
}

// ---------------------------------------------------------------------------
// Lazy WikiSearch singleton (one per injection hook instance)
// ---------------------------------------------------------------------------

async function openWikiSearch(
  wikiRoot: string,
  wikiDbPath: string,
  contextualRetrieval: ContextualRetrievalConfig,
  onTelemetry?: (event: any) => void,
): Promise<WikiSearch> {
  return WikiSearch.create({
    wikiRoot,
    dbPath: wikiDbPath,
    preCheck: false,
    contextualRetrieval,
    ...(onTelemetry && { onContextualTelemetry: onTelemetry }),
  });
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function telemetryPages(
  results: Array<{ path: string; title: string; type: string; snippet: string; score: number; section?: string; chunkIndex?: number }>,
): WikiInjectionTelemetryPage[] {
  return results.map((r) => ({
    path: r.path,
    title: r.title,
    type: r.type,
    score: r.score,
  }));
}

type WikiBlockResult = {
  path: string;
  title: string;
  type: string;
  snippet: string;
  score: number;
  section?: string;
  chunkIndex?: number;
  matchedChildSnippet?: string;
  parentContext?: string;
  sourceChunkId?: number;
  siblingCandidates?: Array<{ chunkIndex: number; section: string; content: string; score: number }>;
};

function normalizeContextText(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function oneLineContext(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function shouldSkipWikiInjectionForLiveData(query: string): boolean {
  const normalized = query.toLowerCase();
  const hasRouteIntent = /\b(?:route|traffic|directions)\b/.test(normalized)
    || /\bfastest\s+way\b/.test(normalized)
    || /\bdriving\s+time\b/.test(normalized);
  const hasCurrentIntent = /\b(?:current|live|today|now)\b/.test(normalized)
    || /\bright\s+now\b/.test(normalized);
  return hasRouteIntent && hasCurrentIntent;
}

function childCenteredContext(parentContext: string, matchedChild: string, section: string | undefined, budgetTokens: number): string {
  void section;
  const budgetChars = Math.max(0, budgetTokens * 4);
  if (budgetChars <= 0) return '';
  const parent = normalizeContextText(parentContext);
  if (estimateTokens(oneLineContext(parent)) <= budgetTokens) return oneLineContext(parent);
  const child = matchedChild.trim();
  const windowBudget = budgetChars;

  const childIndex = child ? parent.indexOf(child) : -1;
  const center = childIndex >= 0 ? childIndex + Math.floor(child.length / 2) : 0;
  let start = Math.max(0, center - Math.floor(windowBudget / 2));
  let end = Math.min(parent.length, start + windowBudget);
  start = Math.max(0, end - windowBudget);

  if (childIndex >= 0 && (childIndex < start || childIndex + child.length > end)) {
    start = Math.max(0, Math.min(childIndex, parent.length - windowBudget));
    end = Math.min(parent.length, start + windowBudget);
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < parent.length ? '…' : '';
  const window = `${prefix}${parent.slice(start, end).trim()}${suffix}`.trim();
  return oneLineContext(window).slice(0, budgetChars).trimEnd();
}

// ---------------------------------------------------------------------------
// E039: label-free same-page sibling completion
//
// After a page's parent section is capped to its rank-decayed budget, spend
// any leftover room on the highest-scoring OTHER-section chunks the retriever
// already ranked for that page (WikiSearchResult.siblingCandidates). Ported
// from the benchmark harness (plumb-benchmark/real-wiki/src/baseline.ts),
// verified byte-parity there against the original E039 experiment numbers
// before being carried into production. See autoresearch/experiments/
// E039-pre-registration-for-test.json in plumb-benchmark for the test result.
// ---------------------------------------------------------------------------

const SIBLING_MAX = 2;
const SIBLING_MIN_ROOM_TOKENS = 24;
const SIBLING_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those',
  'as', 'how', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'did', 'do', 'does',
  'has', 'have', 'had', 'his', 'her', 'their', 'our', 'we', 'he', 'she', 'they', 'i', 'you',
  'about', 'into', 'than', 'then', 'there', 'any', 'all', 'not', 'no', 'but', 'if', 'so',
]);

function siblingNormalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function siblingTokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'\-.]*/g) ?? [];
}

function siblingQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of siblingTokenize(query)) {
    if (SIBLING_STOP.has(t) || t.length <= 2) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function siblingAnchorOffset(text: string, query: string, windowChars: number): number {
  const terms = siblingQueryTerms(query);
  if (!terms.length) return 0;
  const low = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const t of terms) {
    const w = t.length;
    let start = 0;
    while (true) {
      const i = low.indexOf(t, start);
      if (i < 0) break;
      hits.push([i, w]);
      start = i + Math.max(1, t.length);
    }
  }
  if (!hits.length) return 0;
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = Math.max(1, Math.floor(windowChars / 2));
  let bestPos = hits[0]![0];
  let bestScore = -1;
  for (let i = 0; i < hits.length; i++) {
    const pos = hits[i]![0];
    const hi = pos + windowChars;
    const seen = new Map<string, number>();
    let score = 0;
    for (let j = i; j < hits.length; j++) {
      const [pos2, w2] = hits[j]!;
      if (pos2 >= hi) break;
      const key = `${w2}:${low.slice(pos2, pos2 + w2)}`;
      if (!seen.has(key)) {
        seen.set(key, w2);
        score += w2;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestPos = Math.min(pos + half, text.length);
    }
  }
  return bestPos;
}

function capSiblingWindow(text: string, anchor: number, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens * 4);
  if (estimateTokens(text) <= maxTokens) return text;
  let start = Math.max(0, anchor - Math.floor(maxChars / 2));
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  let window = text.slice(start, end).trim();
  if (start > 0) window = `…${window}`;
  if (end < text.length) window = `${window}…`;
  while (estimateTokens(window) > maxTokens && window.length > 1) window = window.slice(0, -4).trimEnd();
  return window;
}

function appendSiblingCompletion(
  baseSnippet: string,
  siblingCandidates: Array<{ chunkIndex: number; section: string; content: string; score: number }> | undefined,
  pageBudget: number,
  query: string,
): string {
  if (!siblingCandidates?.length) return baseSnippet;
  let snippet = baseSnippet;
  let added = 0;
  for (const sib of siblingCandidates) {
    if (added >= SIBLING_MAX) break;
    const sibNorm = siblingNormalize(sib.content).slice(0, 120);
    if (sibNorm && siblingNormalize(snippet).includes(sibNorm)) continue;
    const header = `\n\n[same-page chunk ${sib.chunkIndex} | ${sib.section || 'section'}]\n`;
    const room = pageBudget - estimateTokens(snippet) - estimateTokens(header);
    if (room <= SIBLING_MIN_ROOM_TOKENS) break;
    let body: string;
    if (estimateTokens(sib.content) > room) {
      const anchor = siblingAnchorOffset(sib.content, query, Math.max(1, room * 4));
      body = capSiblingWindow(sib.content, anchor, room);
    } else {
      body = sib.content;
    }
    if (!body.trim()) continue;
    let candidate = snippet + header + body;
    if (estimateTokens(candidate) > pageBudget) {
      const shrinkBudget = Math.max(1, pageBudget - estimateTokens(snippet) - estimateTokens(header));
      let shrunk = body;
      while (estimateTokens(shrunk) > shrinkBudget && shrunk.length > 1) shrunk = shrunk.slice(0, -4).trimEnd();
      body = shrunk;
      if (!body.trim()) continue;
      candidate = snippet + header + body;
      if (estimateTokens(candidate) > pageBudget) continue;
    }
    snippet = candidate;
    added++;
  }
  return snippet;
}

// ---------------------------------------------------------------------------
// Injection block formatter (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Format the [PLUMB WIKI] injection block.
 *
 * Structure:
 *   [PLUMB WIKI]
 *   Relevant wiki chunks:
 *
 *   1. **Title** (path) [type] — section
 *      Snippet text...
 *
 *   ...
 *
 *   Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links
 *   [/PLUMB WIKI]
 */
export function formatWikiBlock(
  results: WikiBlockResult[],
  options: { activeContextual?: boolean; parentTokenBudgets?: number[]; maxParentTokens?: number; injectionTokenBudget?: number; query?: string } = {},
): { block: string; injectedPages: WikiInjectionTelemetryPage[]; tokensUsed: number } {
  const lines: string[] = ['[PLUMB WIKI]'];
  const injectedPages: WikiInjectionTelemetryPage[] = [];
  const trailingLines = [
    'Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links',
    '[/PLUMB WIKI]',
  ];
  const defaultInjectionTokenBudget = options.activeContextual
    ? (options.maxParentTokens ?? ACTIVE_CONTEXTUAL_DEFAULT_TOKEN_BUDGET)
    : INJECTION_TOKEN_BUDGET;
  const injectionTokenBudget = Math.min(options.injectionTokenBudget ?? defaultInjectionTokenBudget, INJECTION_TOKEN_BUDGET);
  const contentTokenBudget = injectionTokenBudget - estimateTokens(trailingLines.join('\n'));

  if (results.length === 0) {
    lines.push('No relevant wiki chunks found for this query.');
  } else {
    lines.push('Relevant wiki chunks:');
    lines.push('');
    const seenChunkKeys = new Set<string>();
    const parentSectionChars = new Map<string, number>();
    const injectedChunkIndexesByParent = new Map<string, Set<number>>();
    const parentBudgets = options.parentTokenBudgets ?? [360, 260, 100, 50, 25];
    const maxParentTokens = options.maxParentTokens ?? injectionTokenBudget;
    const candidatePageCount = new Set(results.map((r) => r.path)).size;
    const minimumPages = Math.min(MIN_INJECTED_PAGES, candidatePageCount);
    const injectedPagePaths = new Set<string>();
    let rankedIndex = 0;

    for (const r of results) {
      const matchedChildSnippet = normalizeContextText(r.matchedChildSnippet ?? r.snippet);
      const normalizedSnippet = options.activeContextual
        ? normalizeContextText(r.parentContext ?? r.snippet)
        : r.snippet.replace(/\n+/g, ' ').trim();
      if (!normalizedSnippet && !matchedChildSnippet) continue;

      const parentSectionKey = `${r.path}\u0000${r.section ?? ''}`;
      const injectedChunkIndexes = injectedChunkIndexesByParent.get(parentSectionKey);
      let snippet = normalizedSnippet;
      if (options.activeContextual) {
        const order = rankedIndex;
        const remainingGlobalTokens = Math.max(0, maxParentTokens - injectedPages.reduce((sum, page) => sum + (page.tokens ?? 0), 0));
        const budget = Math.min(parentBudgets[order] ?? parentBudgets[parentBudgets.length - 1] ?? 75, remainingGlobalTokens);
        if (budget <= 0) continue;
        snippet = estimateTokens(normalizedSnippet) <= budget
          ? oneLineContext(normalizedSnippet)
          : childCenteredContext(normalizedSnippet, matchedChildSnippet, r.section, budget);
        // E039: spend any leftover room in this page's own budget on same-page
        // sibling chunks from other sections before moving to the next page.
        snippet = appendSiblingCompletion(snippet, r.siblingCandidates, budget, options.query ?? '');
      } else {
        const parentCharsUsed = parentSectionChars.get(parentSectionKey) ?? 0;
        const isNeighborChunk =
          r.chunkIndex !== undefined &&
          injectedChunkIndexes !== undefined &&
          [...injectedChunkIndexes].some((chunkIndex) => Math.abs(chunkIndex - r.chunkIndex!) === 1);
        const parentCharLimit =
          PARENT_SECTION_CHAR_BUDGET + (isNeighborChunk ? NEIGHBOR_CHUNK_WINDOW_EXTRA_CHAR_BUDGET : 0);
        const parentCharsRemaining = parentCharLimit - parentCharsUsed;
        if (parentCharsRemaining <= 0) continue;
        snippet = normalizedSnippet.slice(0, parentCharsRemaining);
      }
      const chunkKey = `${parentSectionKey}\u0000${snippet}`;
      if (seenChunkKeys.has(chunkKey)) continue;

      const isNewPage = !injectedPagePaths.has(r.path);
      const belowMinimumPageFloor = injectedPagePaths.size < minimumPages;
      const sectionLabel = r.section ? ` — ${r.section}` : '';
      const provenance = r.chunkIndex !== undefined ? ` (chunk ${r.chunkIndex})` : '';
      const resultHeader = `${rankedIndex + 1}. **${r.title}** (${r.path}) [${r.type}]${sectionLabel}${provenance}`;
      let nextLines = [
        resultHeader,
        `   ${snippet}`,
        '',
      ];
      const usedTokens = estimateTokens(lines.join('\n'));
      let projectedTokens = usedTokens + estimateTokens(nextLines.join('\n'));
      if (projectedTokens > contentTokenBudget) {
        const headerOnlyTokens = estimateTokens([resultHeader, '   ', ''].join('\n'));
        const remainingSnippetTokens = contentTokenBudget - usedTokens - headerOnlyTokens;
        if (remainingSnippetTokens <= 0) {
          if (belowMinimumPageFloor && isNewPage) continue;
          break;
        }
        snippet = snippet.slice(0, remainingSnippetTokens * 4).trimEnd();
        if (!snippet) continue;
        nextLines = [resultHeader, `   ${snippet}`, ''];
        projectedTokens = usedTokens + estimateTokens(nextLines.join('\n'));
        while (projectedTokens > contentTokenBudget && snippet.length > 0) {
          snippet = snippet.slice(0, Math.max(0, snippet.length - 8)).trimEnd();
          if (!snippet) break;
          nextLines = [resultHeader, `   ${snippet}`, ''];
          projectedTokens = usedTokens + estimateTokens(nextLines.join('\n'));
        }
        if (!snippet || projectedTokens > contentTokenBudget) break;
      }

      seenChunkKeys.add(chunkKey);
      parentSectionChars.set(parentSectionKey, (parentSectionChars.get(parentSectionKey) ?? 0) + snippet.length);
      if (r.chunkIndex !== undefined) {
        const parentChunkIndexes = injectedChunkIndexesByParent.get(parentSectionKey) ?? new Set<number>();
        parentChunkIndexes.add(r.chunkIndex);
        injectedChunkIndexesByParent.set(parentSectionKey, parentChunkIndexes);
      }
      lines.push(...nextLines);
      rankedIndex++;
      injectedPagePaths.add(r.path);
      injectedPages.push({
        path: r.path,
        title: r.title,
        type: r.type,
        score: r.score,
        tokens: estimateTokens(snippet),
      });
    }
  }

  lines.push(...trailingLines);

  const block = lines.join('\n');
  return { block, injectedPages, tokensUsed: estimateTokens(block) };
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
  const emitTelemetry = options.onTelemetry;
  const contextualRetrieval = normalizeContextualConfig(options.contextualRetrieval);

  // One shared search instance, lazily initialized on first use.
  let searchPromise: Promise<WikiSearch> | null = null;
  function getSearch(): Promise<WikiSearch> {
    if (!searchPromise) {
      searchPromise = openWikiSearch(wikiRoot, wikiDbPath, contextualRetrieval, emitTelemetry).catch((err) => {
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
    const startedAt = Date.now();
    const emit = (
      status: WikiInjectionTelemetryStatus,
      reason: WikiInjectionTelemetryReason,
      query: string,
      candidatePages: WikiInjectionTelemetryPage[] = [],
      injectedPages: WikiInjectionTelemetryPage[] = [],
      tokensUsed = 0,
    ) => {
      const activeContextual = contextualRetrieval.mode === 'active';
      const injectionTokenBudget = activeContextual
        ? Math.min(contextualRetrieval.maxParentTokens, INJECTION_TOKEN_BUDGET)
        : INJECTION_TOKEN_BUDGET;
      emitTelemetry?.({
        event: 'plumb.wiki_injection',
        status,
        reason,
        mode: wikiMode,
        query,
        candidatePages,
        injectedPages,
        budgetTokens: injectionTokenBudget,
        tokensUsed,
        elapsedMs: Date.now() - startedAt,
        topK: contextualRetrieval.mode === 'active' ? ACTIVE_CONTEXTUAL_TOP_K : TOP_K,
      });
    };

    // Extract the user query
    const userMessage = extractLastUserMessage(event.messages);
    const envelopeMessage = userMessage ? null : extractFromPromptEnvelope(event.prompt);
    const queryText = userMessage ?? envelopeMessage ?? event.prompt;

    if (!queryText) {
      emit('skipped', 'empty_query', '');
      return;
    }

    if (shouldSkipWikiInjectionForLiveData(queryText)) {
      emit('skipped', 'requires_live_data', queryText);
      return;
    }


    let block: string;
    let candidatePages: WikiInjectionTelemetryPage[] = [];
    let injectedPages: WikiInjectionTelemetryPage[] = [];
    let tokensUsed = 0;
    try {
      const results = await Promise.race([
        (async () => {
          const search = await getSearch();
          return search.search(queryText, contextualRetrieval.mode === 'active' ? ACTIVE_CONTEXTUAL_TOP_K : TOP_K);
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), INJECTION_TIMEOUT_MS),
        ),
      ]);
      candidatePages = telemetryPages(results);
      const activeContextual = contextualRetrieval.mode === 'active';
      const injectionTokenBudget = activeContextual
        ? Math.min(contextualRetrieval.maxParentTokens, INJECTION_TOKEN_BUDGET)
        : INJECTION_TOKEN_BUDGET;
      const formatted = formatWikiBlock(results, {
        activeContextual,
        parentTokenBudgets: contextualRetrieval.parentTokenBudgets,
        maxParentTokens: injectionTokenBudget,
        injectionTokenBudget,
        query: queryText,
      });
      block = formatted.block;
      injectedPages = formatted.injectedPages;
      tokensUsed = formatted.tokensUsed;
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'timeout') {
        console.warn('[plumb:wiki] wiki search timeout — skipping injection');
        emit('skipped', 'timeout', queryText);
      } else {
        console.warn('[plumb:wiki] wiki search error:', e);
        emit('skipped', 'search_error', queryText);
      }
      return;
    }

    if (wikiMode === 'v2-shadow') {
      console.debug('[plumb:wiki] shadow mode — would inject:', block.slice(0, 200));
      emit('skipped', 'shadow_mode', queryText, candidatePages, injectedPages, tokensUsed);
      return;
    }

    // v2: inject the block
    emit('fired', 'ok', queryText, candidatePages, injectedPages, tokensUsed);
    return { prependContext: block };
  };
}
