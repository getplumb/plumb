/**
 * Read path — Layer 2 (memory facts) retrieval.
 *
 * buildMemoryContext() is called before every agent response. It queries
 * memory_facts, applies score boosting, and returns a MemoryContext ready
 * for formatContextBlock().
 *
 * Search is always cross-session — no session filter is applied.
 */

import type { MemoryFactSearchResult } from './local-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A memory fact chunk with metadata and boosted score. */
export interface MemoryFactChunk {
  readonly content: string;
  readonly sourceSessionId: string;
  readonly sourceSessionLabel: string | null;
  readonly timestamp: Date;
  readonly tags: readonly string[] | null;
  /** Final score from hybrid search with MEMORY_FACT_BOOST applied. */
  readonly score: number;
}

/**
 * Memory context returned by buildMemoryContext().
 *
 * relatedMemories holds curated memory facts (high-signal).
 */
export interface MemoryContext {
  readonly relatedMemories: MemoryFactChunk[];
}

export interface ReadPathOptions {
  /** Max memory facts returned. Default: 8 (E56 config). */
  maxMemoryFacts?: number;
}

/**
 * Minimal store interface required by the read path.
 * LocalStore satisfies this; tests can pass a mock.
 */
export interface ReadPathStore {
  /** Layer 2: hybrid search over curated memory facts. */
  searchMemoryFacts(query: string, limit?: number): Promise<readonly MemoryFactSearchResult[]>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a structured MemoryContext for a given query.
 *
 * Queries Layer 2 (memory facts hybrid search).
 * Memory facts get MEMORY_FACT_BOOST (2.0×) applied to their scores.
 *
 * @param query   Natural language query (the incoming user message or context).
 * @param store   Any store implementing ReadPathStore (typically LocalStore).
 * @param options Optional limits.
 */
export async function buildMemoryContext(
  query: string,
  store: ReadPathStore,
  options?: ReadPathOptions,
): Promise<MemoryContext> {
  const maxMemoryFacts = options?.maxMemoryFacts ?? 8;

  const memoryCandidateLimit = maxMemoryFacts * 2;

  // ── Query Layer 2 (memory facts) ─────────────────────────────────────────
  const memoryFactResults = await store.searchMemoryFacts(query, memoryCandidateLimit);

  // ── Build memory fact chunks (scores already have MEMORY_FACT_BOOST applied) ─
  const relatedMemories: MemoryFactChunk[] = memoryFactResults
    .slice(0, maxMemoryFacts)
    .map((r: MemoryFactSearchResult) => ({
      content: r.content,
      sourceSessionId: r.source_session_id,
      sourceSessionLabel: r.source_session_label,
      timestamp: new Date(r.created_at),
      tags: r.tags,
      score: r.final_score,
    }));

  return {
    relatedMemories,
  };
}
