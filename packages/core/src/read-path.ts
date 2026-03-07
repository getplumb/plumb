/**
 * Read path — Layer 1 (raw log) + Layer 2 (memory facts) retrieval.
 *
 * buildMemoryContext() is called before every agent response. It queries
 * both layers in parallel and returns a tiered MemoryContext ready for
 * formatContextBlock().
 *
 * Search is always cross-session — no session filter is applied.
 */

import type { SearchResult } from './types.js';
import type { RawLogSearchResult } from './local-store.js';
import { scoreFact } from './scorer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type { SearchResult } from './types.js';

/** A Fact paired with its computed score and age (output of read path). */
export interface ScoredFact {
  readonly fact: SearchResult['fact'];
  readonly score: number;
  readonly ageInDays: number;
}

export interface RawChunk {
  readonly chunkText: string;
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly timestamp: Date;
  /** Final score from hybrid search (RRF × decay × reranker). */
  readonly score: number;
}

/**
 * Tiered memory context returned by buildMemoryContext().
 *
 * Tiers are split by scoreFact() result:
 *   highConfidence   → score > 0.7
 *   mediumConfidence → score 0.3–0.7
 *   lowConfidence    → score < 0.3
 *
 * relatedConversations holds raw log chunks from Layer 1.
 */
export interface MemoryContext {
  readonly highConfidence: ScoredFact[];
  readonly mediumConfidence: ScoredFact[];
  readonly lowConfidence: ScoredFact[];
  readonly relatedConversations: RawChunk[];
}

export interface ReadPathOptions {
  /** Max facts returned per confidence tier. Default: 10. */
  maxFactsPerTier?: number;
  /** Max raw log chunks returned. Default: 3. */
  maxRawChunks?: number;
  /** Reference time for scoring. Defaults to current time. */
  now?: Date;
}

/**
 * Minimal store interface required by the read path.
 * LocalStore satisfies this; tests can pass a mock.
 */
export interface ReadPathStore {
  /** Layer 2: search curated memory facts. */
  search(query: string, limit?: number): Promise<readonly SearchResult[]>;
  /** Layer 1: search raw conversation log. */
  searchRawLog(query: string, limit?: number): Promise<readonly RawLogSearchResult[]>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a structured MemoryContext for a given query.
 *
 * Queries Layer 1 (raw log hybrid search) and Layer 2 (memory facts)
 * in parallel and returns ranked, tiered results.
 *
 * @param query   Natural language query (the incoming user message or context).
 * @param store   Any store implementing ReadPathStore (typically LocalStore).
 * @param options Optional limits and reference time.
 */
export async function buildMemoryContext(
  query: string,
  store: ReadPathStore,
  options?: ReadPathOptions,
): Promise<MemoryContext> {
  const maxFactsPerTier = options?.maxFactsPerTier ?? 10;
  const maxRawChunks = options?.maxRawChunks ?? 3;
  const now = options?.now ?? new Date();

  const rawCandidateLimit = maxRawChunks * 3;
  const factCandidateLimit = maxFactsPerTier * 3;

  // ── Query Layer 1 and Layer 2 in parallel ────────────────────────────────
  const [rawLogResults, factResults] = await Promise.all([
    store.searchRawLog(query, rawCandidateLimit),
    store.search(query, factCandidateLimit),
  ]);

  // ── Score and tier facts (Layer 2) ────────────────────────────────────────
  const highConfidence: ScoredFact[] = [];
  const mediumConfidence: ScoredFact[] = [];
  const lowConfidence: ScoredFact[] = [];

  for (const result of factResults) {
    const { score } = scoreFact(result.fact, now);
    const ageInDays =
      (now.getTime() - result.fact.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
    const sf: ScoredFact = { fact: result.fact, score, ageInDays };

    if (score > 0.7) {
      highConfidence.push(sf);
    } else if (score >= 0.3) {
      mediumConfidence.push(sf);
    } else {
      lowConfidence.push(sf);
    }
  }

  // Sort each tier by score descending, then cap at maxFactsPerTier
  const sortDesc = (a: ScoredFact, b: ScoredFact) => b.score - a.score;
  highConfidence.sort(sortDesc);
  mediumConfidence.sort(sortDesc);
  lowConfidence.sort(sortDesc);

  // ── Build raw chunks from Layer 1 (already ranked by hybrid search score) ─
  const relatedConversations: RawChunk[] = rawLogResults
    .slice(0, maxRawChunks)
    .map((r: RawLogSearchResult) => ({
      chunkText: r.chunk_text,
      sessionId: r.session_id,
      sessionLabel: r.session_label,
      timestamp: new Date(r.timestamp),
      score: r.final_score,
    }));

  return {
    highConfidence: highConfidence.slice(0, maxFactsPerTier),
    mediumConfidence: mediumConfidence.slice(0, maxFactsPerTier),
    lowConfidence: lowConfidence.slice(0, maxFactsPerTier),
    relatedConversations,
  };
}
