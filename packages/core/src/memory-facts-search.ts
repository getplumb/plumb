/**
 * Memory facts hybrid search (Layer 2 retrieval).
 *
 * Pipeline:
 *   1. BM25 keyword search over memory_facts content
 *   2. KNN vector search via JS cosine similarity
 *   3. Reciprocal Rank Fusion (RRF, k=60) merges both ranked lists
 *   4. Apply MEMORY_FACT_BOOST (2.0×) to RRF scores
 *   5. Apply recency decay based on decay_rate and created_at
 *      (slow: λ=0.01 ≈ 70-day half-life, medium: λ=0.05, fast: λ=0.1)
 *   6. Return top-k by final score
 *
 * Search is cross-session: no session filter is applied.
 * The caller (LocalStore) passes its internal db handle — no separate DB connection.
 */

import type { WasmDb } from './wasm-db.js';
import { Bm25 } from './bm25.js';
import { embedQuery } from './embedder.js';
import { knnSearch, deserializeEmbedding } from './vector-search.js';
import { scoreMemoryFact, computeDecay } from './scorer.js';

// Lambda values per decay_rate tier.
const DECAY_LAMBDAS: Record<string, number> = {
  slow: 0.010,
  medium: 0.050,
  fast: 0.100,
};

function decayLambda(decayRate: string): number {
  return DECAY_LAMBDAS[decayRate] ?? DECAY_LAMBDAS['slow']!;
}

// RRF constant (standard k=60; higher = less weight on top-1 rank).
const RRF_K = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryFactSearchResult {
  readonly content: string;
  readonly source_session_id: string;
  readonly source_session_label: string | null;
  readonly created_at: string;
  readonly tags: readonly string[] | null;
  /** Final score after RRF × MEMORY_FACT_BOOST. */
  readonly final_score: number;
}

// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface MemoryFactRow {
  id: string;
  content: string;
  source_session_id: string;
  source_session_label: string | null;
  tags: string | null;
  created_at: string;
  decay_rate: string;
  vec_rowid: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Merge two ranked lists via Reciprocal Rank Fusion.
 * Each list entry is [id, score] ordered by descending relevance (rank 1 = index 0).
 * Returns a map of id → rrf_score.
 */
function rrf(
  vecRanked: Array<[string, number]>,
  bm25Ranked: Array<[string, number]>,
): Map<string, number> {
  const scores = new Map<string, number>();

  for (let rank = 0; rank < vecRanked.length; rank++) {
    const id = vecRanked[rank]?.[0];
    if (id === undefined) continue;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  }
  for (let rank = 0; rank < bm25Ranked.length; rank++) {
    const id = bm25Ranked[rank]?.[0];
    if (id === undefined) continue;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  }

  return scores;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Hybrid search over memory_facts.
 *
 * @param db      The WASM SQLite Database instance
 * @param userId  Scopes the search to this user's data
 * @param query   Natural language query string
 * @param limit   Number of results to return (default 10)
 */
export async function searchMemoryFacts(
  db: WasmDb,
  userId: string,
  query: string,
  limit = 10,
): Promise<readonly MemoryFactSearchResult[]> {
  // ── 1. Fetch all memory_facts rows (non-deleted, with embeddings) ────────
  const stmt = db.prepare(
    `SELECT id, content, source_session_id, source_session_label, tags, created_at, decay_rate, vec_rowid
     FROM memory_facts
     WHERE user_id = ? AND deleted_at IS NULL AND embed_status = 'done'
     ORDER BY created_at DESC`
  );
  stmt.bind([userId]);

  const allRows: MemoryFactRow[] = [];
  while (stmt.step()) {
    allRows.push(stmt.get({}) as MemoryFactRow);
  }
  stmt.finalize();

  if (allRows.length === 0) return [];

  const idToRow = new Map<string, MemoryFactRow>(allRows.map((r) => [r.id, r]));

  // ── 2. BM25 search ───────────────────────────────────────────────────────
  const corpus = allRows.map((r) => r.content);
  const bm25 = new Bm25(corpus);
  const bm25RawScores = bm25.scores(query);

  const bm25Ranked: Array<[string, number]> = allRows
    .map((r, i): [string, number] => [r.id, bm25RawScores[i] ?? 0])
    .sort((a, b) => b[1] - a[1]);

  // ── 3. Vector search via JS cosine similarity ───────────────────────────
  const queryVec = await embedQuery(query);

  // Fetch all embeddings from vec_raw_log (memory_facts use same table)
  const vecRowids = allRows
    .filter((r) => r.vec_rowid !== null)
    .map((r) => r.vec_rowid!);

  if (vecRowids.length === 0) {
    // No embeddings available — fall back to BM25 only
    const now = Date.now();
    const bm25Only: MemoryFactSearchResult[] = bm25Ranked
      .slice(0, limit)
      .map(([id, score]) => {
        const row = idToRow.get(id)!;
        const ageDays = (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
        const lambda = decayLambda(row.decay_rate);
        const finalScore = scoreMemoryFact(score) * computeDecay(lambda, ageDays);
        return {
          content: row.content,
          source_session_id: row.source_session_id,
          source_session_label: row.source_session_label,
          created_at: row.created_at,
          tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
          final_score: finalScore,
        };
      });
    return bm25Only;
  }

  // Fetch embeddings for these vec_rowids
  const placeholders = vecRowids.map(() => '?').join(',');
  const vecStmt = db.prepare(`SELECT id, embedding FROM vec_raw_log WHERE id IN (${placeholders})`);
  vecStmt.bind(vecRowids);

  const vecCorpus: Array<{ id: number; embedding: Float32Array }> = [];
  while (vecStmt.step()) {
    const row = vecStmt.get({}) as { id: number; embedding: string };
    vecCorpus.push({
      id: row.id,
      embedding: deserializeEmbedding(row.embedding),
    });
  }
  vecStmt.finalize();

  // Perform KNN search
  const vecFetchLimit = Math.min(allRows.length, Math.max(limit * 3, 50));
  const vecResults = knnSearch(queryVec, vecCorpus, vecFetchLimit);

  // Map vec_raw_log ids back to memory_facts ids
  const vecRanked: Array<[string, number]> = [];
  for (const vecResult of vecResults) {
    const factRow = allRows.find((r) => r.vec_rowid === vecResult.id);
    if (factRow !== undefined) {
      vecRanked.push([factRow.id, 1 - vecResult.distance]);
    }
  }

  // ── 4. RRF merge ────────────────────────────────────────────────────────
  const rrfScores = rrf(vecRanked, bm25Ranked);

  // ── 5. Apply MEMORY_FACT_BOOST × recency decay ───────────────────────────
  const now = Date.now();
  const boostedScores: Array<[string, number]> = [];
  for (const [id, rrfScore] of rrfScores) {
    const row = idToRow.get(id)!;
    const ageDays = (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const lambda = decayLambda(row.decay_rate);
    const finalScore = scoreMemoryFact(rrfScore) * computeDecay(lambda, ageDays);
    boostedScores.push([id, finalScore]);
  }
  boostedScores.sort((a, b) => b[1] - a[1]);

  // ── 6. Build output ─────────────────────────────────────────────────────
  return boostedScores.slice(0, limit).map(([id, finalScore]) => {
    const row = idToRow.get(id)!;
    return {
      content: row.content,
      source_session_id: row.source_session_id,
      source_session_label: row.source_session_label,
      created_at: row.created_at,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      final_score: finalScore,
    };
  });
}
