/**
 * contextual-assembly.ts — budget-aware parent-section windowing plus E039
 * same-page sibling completion for `plumb_wiki_search` results.
 *
 * This is a deliberate duplicate of the equivalent logic in
 * packages/openclaw-plugin/src/wiki-injection.ts (childCenteredContext,
 * appendSiblingCompletion and friends), not a shared import. The two
 * consumers have different lifecycles (long-lived OpenClaw gateway vs a
 * per-session MCP subprocess) and different rollout risk; keeping them
 * separate means a change here can't destabilize the already-validated
 * production injection path, and vice versa. Same mechanism, same constants,
 * verified independently by this package's own tests.
 */
import type { WikiSearchResult } from '@getplumb/core';

export const CONTEXTUAL_PARENT_BUDGETS = [400, 300, 125, 100, 75];
export const CONTEXTUAL_MAX_TOTAL_TOKENS = 1000;

const SIBLING_MAX = 2;
const SIBLING_MIN_ROOM_TOKENS = 24;
const SIBLING_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those',
  'as', 'how', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'did', 'do', 'does',
  'has', 'have', 'had', 'his', 'her', 'their', 'our', 'we', 'he', 'she', 'they', 'i', 'you',
  'about', 'into', 'than', 'then', 'there', 'any', 'all', 'not', 'no', 'but', 'if', 'so',
]);

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeContextText(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function oneLineContext(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

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

/** Port of wiki-injection.ts's childCenteredContext: window the parent section around the matched child, under budget. */
export function childCenteredWindow(parentContext: string, matchedChild: string, budgetTokens: number): string {
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

/** E039: append up to 2 same-page sibling chunks (other sections) within the page's remaining budget. */
export function appendSiblingCompletion(
  baseSnippet: string,
  siblingCandidates: WikiSearchResult['siblingCandidates'],
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

/**
 * Assemble a budget-capped, sibling-completed snippet for one contextual
 * result at the given rank (0-indexed), matching production's rank-decayed
 * per-page budgets and overall cap.
 */
export function assembleContextualSnippet(
  result: WikiSearchResult,
  rank: number,
  remainingGlobalTokens: number,
  query: string,
): { snippet: string; tokens: number } | null {
  const budget = Math.min(
    CONTEXTUAL_PARENT_BUDGETS[rank] ?? CONTEXTUAL_PARENT_BUDGETS[CONTEXTUAL_PARENT_BUDGETS.length - 1] ?? 75,
    remainingGlobalTokens,
  );
  if (budget <= 0) return null;
  const normalizedParent = normalizeContextText(result.parentContext ?? result.snippet);
  const matchedChild = normalizeContextText(result.matchedChildSnippet ?? result.snippet);
  let snippet = estimateTokens(normalizedParent) <= budget
    ? oneLineContext(normalizedParent)
    : childCenteredWindow(normalizedParent, matchedChild, budget);
  snippet = appendSiblingCompletion(snippet, result.siblingCandidates, budget, query);
  return { snippet, tokens: estimateTokens(snippet) };
}
