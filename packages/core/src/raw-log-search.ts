/**
 * Raw-log hybrid search (Layer 1 retrieval).
 *
 * Pipeline:
 *   1. BM25 keyword search over all raw_log chunk_text (built at query time)
 *   2. KNN vector search via sqlite-vec vec_raw_log virtual table
 *   3. Reciprocal Rank Fusion (RRF, k=60) merges both ranked lists
 *   4. Recency decay: score *= e^(-0.012 × age_in_days)
 *   5. Cross-encoder reranker (top-20 candidates → Xenova/ms-marco-MiniLM-L-6-v2)
 *   6. Return top-k by reranker score (falls back to RRF×decay if reranker fails)
 *
 * Search is cross-session: no session filter is applied.
 * The caller (LocalStore) passes its internal db handle — no separate DB connection.
 */

import type Database from 'better-sqlite3';
import { Bm25 } from './bm25.js';
import { embedQuery, rerankScores } from './embedder.js';

// RRF constant (standard k=60; higher = less weight on top-1 rank).
const RRF_K = 60;

// Recency decay lambda for raw logs (medium — half-life ≈ 58 days).
const RECENCY_LAMBDA = 0.012;

// Number of candidates passed to the cross-encoder.
const RERANK_TOP_K = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawLogSearchResult {
  readonly chunk_text: string;
  readonly session_id: string;
  readonly session_label: string | null;
  readonly timestamp: string;
  /** Final score after RRF × recency_decay × reranker (or RRF × recency if reranker failed). */
  readonly final_score: number;
}

// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface RawLogRow {
  id: string;
  session_id: string;
  session_label: string | null;
  timestamp: string;
  chunk_text: string;
}

interface VecRow {
  rowid: number;
  distance: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ageInDays(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / (1_000 * 60 * 60 * 24);
}

function recencyDecay(timestamp: string): number {
  return Math.exp(-RECENCY_LAMBDA * ageInDays(timestamp));
}

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
 * Hybrid search over raw_log.
 *
 * @param db      The better-sqlite3 Database instance (with sqlite-vec loaded)
 * @param userId  Scopes the search to this user's data
 * @param query   Natural language query string
 * @param limit   Number of results to return (default 10)
 */
export async function searchRawLog(
  db: Database.Database,
  userId: string,
  query: string,
  limit = 10,
): Promise<readonly RawLogSearchResult[]> {
  // ── 1. Fetch all raw_log rows for this user ──────────────────────────────
  const allRows = db
    .prepare<[string], RawLogRow>(
      `SELECT id, session_id, session_label, timestamp, chunk_text
       FROM raw_log
       WHERE user_id = ?
       ORDER BY timestamp DESC`,
    )
    .all(userId);

  if (allRows.length === 0) return [];

  const idToRow = new Map<string, RawLogRow>(allRows.map((r) => [r.id, r]));

  // ── 2. BM25 search ───────────────────────────────────────────────────────
  const corpus = allRows.map((r) => r.chunk_text);
  const bm25 = new Bm25(corpus);
  const bm25RawScores = bm25.scores(query);

  const bm25Ranked: Array<[string, number]> = allRows
    .map((r, i): [string, number] => [r.id, bm25RawScores[i] ?? 0])
    .sort((a, b) => b[1] - a[1]);

  // ── 3. Vector search via sqlite-vec ─────────────────────────────────────
  const queryVec = await embedQuery(query);
  const queryBlob = Buffer.from(queryVec.buffer);

  // Fetch enough candidates for RRF merge (all docs for small corpora, top-N otherwise).
  const vecFetchLimit = Math.min(allRows.length, Math.max(RERANK_TOP_K * 2, limit * 3, 50));

  // Query vec_raw_log for nearest neighbours; resolve back to raw_log via vec_rowid column.
  const vecRows = db
    .prepare<[Buffer, number], VecRow>(
      `SELECT rowid, distance FROM vec_raw_log
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(queryBlob, vecFetchLimit);

  // raw_log.vec_rowid is backfilled during ingest() to the auto-assigned vec_raw_log rowid.
  interface RawLogIdRow { id: string }
  const vecRanked: Array<[string, number]> = [];
  for (const vecRow of vecRows) {
    const logRow = db
      .prepare<[number, string], RawLogIdRow>(
        `SELECT id FROM raw_log WHERE vec_rowid = ? AND user_id = ?`,
      )
      .get(vecRow.rowid, userId);
    if (logRow !== undefined) {
      // sqlite-vec cosine distance is in [0,2] for normalized vectors.
      // Similarity = 1 − distance gives [−1,1]; in practice ≥ 0 for meaningful matches.
      vecRanked.push([logRow.id, 1 - vecRow.distance]);
    }
  }

  // ── 4. RRF merge ────────────────────────────────────────────────────────
  const rrfScores = rrf(vecRanked, bm25Ranked);

  // ── 5. Recency decay ────────────────────────────────────────────────────
  const decayedScores: Array<[string, number]> = [];
  for (const [id, rrfScore] of rrfScores) {
    const row = idToRow.get(id);
    if (row === undefined) continue;
    const decay = recencyDecay(row.timestamp);
    decayedScores.push([id, rrfScore * decay]);
  }
  decayedScores.sort((a, b) => b[1] - a[1]);

  // ── 6. Take top candidates for reranking ────────────────────────────────
  const candidates = decayedScores.slice(0, Math.max(RERANK_TOP_K, limit));

  // ── 7. Cross-encoder reranking ──────────────────────────────────────────
  const passages = candidates.map(([id]) => idToRow.get(id)?.chunk_text ?? '');
  const rerankerScores = await rerankScores(query, passages);

  // Detect all-zero fallback (reranker unavailable) → keep RRF×decay order.
  const hasRerankerSignal = rerankerScores.some((s) => s !== 0);

  const ranked: Array<{ id: string; finalScore: number }> = candidates.map(
    ([id, rrfDecayScore], i) => ({
      id,
      finalScore: hasRerankerSignal ? (rerankerScores[i] ?? 0) : rrfDecayScore,
    }),
  );

  ranked.sort((a, b) => b.finalScore - a.finalScore);

  // ── 8. Build output ─────────────────────────────────────────────────────
  return ranked.slice(0, limit).map(({ id, finalScore }) => {
    const row = idToRow.get(id)!;
    return {
      chunk_text: row.chunk_text,
      session_id: row.session_id,
      session_label: row.session_label,
      timestamp: row.timestamp,
      final_score: finalScore,
    };
  });
}
