/**
 * Read path — Layer 1 + Layer 2 retrieval, scoring, and tiering.
 *
 * buildMemoryContext() is called before every agent response. It queries both
 * memory layers in parallel, re-scores facts with decay, tiers by confidence
 * band, and returns a MemoryContext ready for formatContextBlock().
 *
 * Search is always cross-session — no session filter is applied.
 */

import { scoreFact } from './scorer.js';
import type { SearchResult, Fact } from './types.js';
import type { RawLogSearchResult } from './local-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScoredFact {
  readonly fact: Fact;
  /** Decay-adjusted score in [0,1]. */
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

export interface MemoryContext {
  readonly highConfidence: ScoredFact[];
  readonly mediumConfidence: ScoredFact[];
  readonly lowConfidence: ScoredFact[];
  readonly relatedConversations: RawChunk[];
}

export interface ReadPathOptions {
  /** Max facts returned per confidence tier. Default: 5. */
  maxFactsPerTier?: number;
  /** Max raw log chunks returned. Default: 3. */
  maxRawChunks?: number;
  /** Point-in-time for decay computation. Default: new Date(). */
  now?: Date;
}

/**
 * Minimal store interface required by the read path.
 * LocalStore satisfies this; tests can pass a mock.
 */
export interface ReadPathStore {
  search(query: string, limit?: number): Promise<readonly SearchResult[]>;
  searchRawLog(query: string, limit?: number): Promise<readonly RawLogSearchResult[]>;
}

// ─── Confidence band boundaries ───────────────────────────────────────────────

const HIGH_THRESHOLD = 0.7;
const LOW_THRESHOLD = 0.3;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a structured MemoryContext for a given query.
 *
 * Queries Layer 1 (raw log hybrid search) and Layer 2 (fact store) in parallel.
 * Facts are re-scored with scoreFact() and tiered by confidence band.
 * Raw chunks are returned in hybrid-search score order.
 *
 * @param query   Natural language query (the incoming user message or context).
 * @param store   Any store implementing ReadPathStore (typically LocalStore).
 * @param options Optional limits and now-override.
 */
export async function buildMemoryContext(
  query: string,
  store: ReadPathStore,
  options?: ReadPathOptions,
): Promise<MemoryContext> {
  const maxFactsPerTier = options?.maxFactsPerTier ?? 5;
  const maxRawChunks = options?.maxRawChunks ?? 3;
  const now = options?.now ?? new Date();

  // Fetch more candidates than needed so tiering has enough to fill each band.
  const factCandidateLimit = maxFactsPerTier * 3 * 3; // 3 tiers × 3× headroom
  const rawCandidateLimit = maxRawChunks * 3;

  // ── Query Layer 1 and Layer 2 in parallel ─────────────────────────────────
  const [searchResults, rawLogResults] = await Promise.all([
    store.search(query, factCandidateLimit),
    store.searchRawLog(query, rawCandidateLimit),
  ]);

  // ── Re-score facts with decay ──────────────────────────────────────────────
  const scoredFacts: ScoredFact[] = searchResults.map((result: SearchResult) => {
    const { score } = scoreFact(result.fact, now);
    const ageInDays =
      (now.getTime() - result.fact.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
    return { fact: result.fact, score, ageInDays };
  });

  // Sort by score descending.
  scoredFacts.sort((a, b) => b.score - a.score);

  // ── Tier facts into confidence bands ──────────────────────────────────────
  const highConfidence: ScoredFact[] = [];
  const mediumConfidence: ScoredFact[] = [];
  const lowConfidence: ScoredFact[] = [];

  for (const sf of scoredFacts) {
    if (sf.score > HIGH_THRESHOLD) {
      if (highConfidence.length < maxFactsPerTier) highConfidence.push(sf);
    } else if (sf.score >= LOW_THRESHOLD) {
      if (mediumConfidence.length < maxFactsPerTier) mediumConfidence.push(sf);
    } else {
      if (lowConfidence.length < maxFactsPerTier) lowConfidence.push(sf);
    }
  }

  // ── Build raw chunks (already ranked by hybrid search score) ──────────────
  const relatedConversations: RawChunk[] = rawLogResults
    .slice(0, maxRawChunks)
    .map((r: RawLogSearchResult) => ({
      chunkText: r.chunk_text,
      sessionId: r.session_id,
      sessionLabel: r.session_label,
      timestamp: new Date(r.timestamp),
      score: r.final_score,
    }));

  return { highConfidence, mediumConfidence, lowConfidence, relatedConversations };
}
