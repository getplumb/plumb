/**
 * resolver.ts — Haiku-based resolver that picks affected wiki pages for a fact.
 *
 * Design: cheap (~200-token) call to claude-haiku-4-5 that takes:
 *   - The fact text
 *   - A lightweight page index (path + title + type, no content)
 *
 * Returns a list of relative page paths that should be updated.
 * Used instead of full vector search to avoid embedding overhead and to give
 * the model explicit control over which pages are candidates.
 */

import type { WikiPageRecord } from '@getplumb/wiki';
import type { WasmDb } from '@getplumb/core';
import { computeCost, recordLlmCost } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageIndexEntry {
  path: string;
  title: string;
  type: string;
}

export type ResolverFn = (
  fact: string,
  pages: readonly PageIndexEntry[],
  db?: WasmDb | null,
) => Promise<string[]>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const RESOLVER_SYSTEM = `You are a routing assistant for a personal knowledge base.
Given a fact and a list of wiki pages (path, title, type), output a JSON array of paths that should be updated to incorporate the fact.

Rules:
- Only include pages directly related to the entities or concepts mentioned in the fact.
- Return at most 3 paths.
- Return [] if no existing page is clearly relevant.
- Output ONLY valid JSON — a bare array of strings, no markdown fences, no explanation.

Example output: ["people/jordan-lee.md","companies/samsara.md"]`;

// ---------------------------------------------------------------------------
// Haiku API call
// ---------------------------------------------------------------------------

const RESOLVER_MODEL = 'claude-haiku-4-5-20251001';

interface HaikuResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function callHaiku(system: string, userContent: string): Promise<HaikuResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const AnthropicModule = await import('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: RESOLVER_MODEL,
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) throw new Error('Haiku returned empty response');
  return {
    text,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Build a compact page index string for the prompt (path | title | type).
 * Truncated to ~150 entries to stay under ~200 tokens.
 */
function buildIndexString(pages: readonly PageIndexEntry[]): string {
  const lines = pages.slice(0, 150).map((p) => `${p.path} | ${p.title} | ${p.type}`);
  return lines.join('\n');
}

/**
 * Resolve which wiki pages are affected by a given fact.
 *
 * Uses claude-haiku-4-5 for a cheap, low-latency classification call.
 * Returns at most 3 relative page paths.
 *
 * @param fact   Plain-English fact to incorporate
 * @param pages  Full page index (path + title + type only)
 * @returns      Subset of paths that should be updated
 */
export async function resolveAffectedPages(
  fact: string,
  pages: readonly PageIndexEntry[],
  db?: WasmDb | null,
): Promise<string[]> {
  if (pages.length === 0) return [];

  const index = buildIndexString(pages);
  const userContent = `## Fact\n${fact}\n\n## Wiki page index\n${index}`;

  let result: HaikuResult;
  try {
    result = await callHaiku(RESOLVER_SYSTEM, userContent);
  } catch (err) {
    throw new Error(`Resolver Haiku call failed: ${err}`);
  }

  // Record cost if a DB handle is available
  if (db != null) {
    const costUsd = computeCost(RESOLVER_MODEL, result.tokensIn, result.tokensOut);
    recordLlmCost(db, {
      source: 'worker:resolver',
      model: RESOLVER_MODEL,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd,
    });
  }

  const raw = result.text;

  // Strip optional markdown code fence if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Resolver returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Resolver returned non-array JSON: ${cleaned.slice(0, 200)}`);
  }

  // Filter to strings and validate that they appear in the page index
  const validPaths = new Set(pages.map((p) => p.path));
  const resolved = (parsed as unknown[])
    .filter((v): v is string => typeof v === 'string')
    .filter((p) => validPaths.has(p))
    .slice(0, 3);

  return resolved;
}

/**
 * Build a PageIndexEntry array from WikiPageRecord objects.
 * Convenience helper for callers that query wiki.db.
 */
export function recordsToPageIndex(records: WikiPageRecord[]): PageIndexEntry[] {
  return records.map((r) => ({ path: r.path, title: r.title, type: r.type }));
}
