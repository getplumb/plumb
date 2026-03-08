/**
 * Read path — Layer 1 (raw log) + Layer 2 (memory facts) retrieval.
 *
 * buildMemoryContext() is called before every agent response. It queries
 * both layers in parallel, applies score boosting to memory facts, merges
 * results, and returns a MemoryContext ready for formatContextBlock().
 *
 * Search is always cross-session — no session filter is applied.
 */

import type { RawLogSearchResult, MemoryFactSearchResult } from './local-store.js';
import { MEMORY_FACT_MIN_SCORE } from './scorer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawChunk {
  readonly chunkText: string;
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly timestamp: Date;
  /** Final score from hybrid search (RRF × decay × reranker). */
  readonly score: number;
}

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
 * relatedMemories holds curated memory facts (high-signal, with MEMORY_FACT_BOOST applied).
 * relatedConversations holds raw log chunks (low-signal fallback).
 */
export interface MemoryContext {
  readonly relatedMemories: MemoryFactChunk[];
  readonly relatedConversations: RawChunk[];
}

export interface ReadPathOptions {
  /** Max memory facts returned. Default: 5. */
  maxMemoryFacts?: number;
  /** Max raw log chunks returned. Default: 3 (or 1 if memory facts qualify). */
  maxRawChunks?: number;
}

/**
 * Minimal store interface required by the read path.
 * LocalStore satisfies this; tests can pass a mock.
 */
export interface ReadPathStore {
  /** Layer 2: hybrid search over curated memory facts. */
  searchMemoryFacts(query: string, limit?: number): Promise<readonly MemoryFactSearchResult[]>;
  /** Layer 1: hybrid search over raw conversation log. */
  searchRawLog(query: string, limit?: number): Promise<readonly RawLogSearchResult[]>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a structured MemoryContext for a given query.
 *
 * Queries Layer 1 (raw log hybrid search) and Layer 2 (memory facts hybrid search)
 * in parallel. Memory facts get MEMORY_FACT_BOOST (2.0×) applied to their scores.
 * If any memory fact scores >= MEMORY_FACT_MIN_SCORE, raw log results are capped at 1.
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
  const maxMemoryFacts = options?.maxMemoryFacts ?? 5;
  const maxRawChunks = options?.maxRawChunks ?? 3;

  const memoryCandidateLimit = maxMemoryFacts * 2;
  const rawCandidateLimit = maxRawChunks * 3;

  // ── Query Layer 1 (raw log) and Layer 2 (memory facts) in parallel ───────
  const [rawLogResults, memoryFactResults] = await Promise.all([
    store.searchRawLog(query, rawCandidateLimit),
    store.searchMemoryFacts(query, memoryCandidateLimit),
  ]);

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

  // ── Apply fallback logic: cap raw_log results if memory facts qualify ────
  // If any memory fact has score >= MEMORY_FACT_MIN_SCORE, cap raw_log at 1.
  const hasQualifyingMemories = relatedMemories.some((m) => m.score >= MEMORY_FACT_MIN_SCORE);
  const rawChunkLimit = hasQualifyingMemories ? 1 : maxRawChunks;

  // ── Build raw chunks from Layer 1 (already ranked by hybrid search score) ─
  const relatedConversations: RawChunk[] = rawLogResults
    .slice(0, rawChunkLimit)
    .map((r: RawLogSearchResult) => ({
      chunkText: r.chunk_text,
      sessionId: r.session_id,
      sessionLabel: r.session_label,
      timestamp: new Date(r.timestamp),
      score: r.final_score,
    }));

  return {
    relatedMemories,
    relatedConversations,
  };
}
