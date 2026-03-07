/**
 * Read path — Layer 1 retrieval (raw log search only).
 *
 * buildMemoryContext() is called before every agent response. It queries
 * the raw_log table with hybrid search and returns a MemoryContext ready
 * for formatContextBlock().
 *
 * Search is always cross-session — no session filter is applied.
 */

import type { RawLogSearchResult } from './local-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawChunk {
  readonly chunkText: string;
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly timestamp: Date;
  /** Final score from hybrid search (RRF × decay × reranker). */
  readonly score: number;
}

export interface MemoryContext {
  readonly relatedConversations: RawChunk[];
}

export interface ReadPathOptions {
  /** Max raw log chunks returned. Default: 3. */
  maxRawChunks?: number;
}

/**
 * Minimal store interface required by the read path.
 * LocalStore satisfies this; tests can pass a mock.
 */
export interface ReadPathStore {
  searchRawLog(query: string, limit?: number): Promise<readonly RawLogSearchResult[]>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a structured MemoryContext for a given query.
 *
 * Queries Layer 1 (raw log hybrid search) and returns ranked chunks.
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
  const maxRawChunks = options?.maxRawChunks ?? 3;
  const rawCandidateLimit = maxRawChunks * 3;

  // ── Query Layer 1 (raw log) ───────────────────────────────────────────────
  const rawLogResults = await store.searchRawLog(query, rawCandidateLimit);

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

  return { relatedConversations };
}
