/**
 * Raw-log hybrid search (Layer 1 retrieval).
 *
 * Pipeline:
 *   1. BM25 keyword search over all raw_log chunk_text (built at query time)
 *   2. KNN vector search via JS cosine similarity (replaces sqlite-vec)
 *   3. Reciprocal Rank Fusion (RRF, k=60) merges both ranked lists
 *   4. Recency decay: score *= e^(-0.012 × age_in_days)
 *   5. Cross-encoder reranker (top-20 candidates → Xenova/ms-marco-MiniLM-L-6-v2)
 *   6. Return top-k by reranker score (falls back to RRF×decay if reranker fails)
 *
 * Search is cross-session: no session filter is applied.
 * The caller (LocalStore) passes its internal db handle — no separate DB connection.
 */

import type { WasmDb } from './wasm-db.js';
import { Bm25 } from './bm25.js';
import { embedQuery, rerankScores } from './embedder.js';
import { knnSearch, deserializeEmbedding } from './vector-search.js';

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
  parent_id: string | null;
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
 * @param db                The WASM SQLite Database instance
 * @param userId            Scopes the search to this user's data
 * @param query             Natural language query string
 * @param limit             Number of results to return (default 10)
 * @param preloadedCorpus   Optional pre-loaded vec_raw_log corpus (T-103: in-memory cache)
 */
export async function searchRawLog(
  db: WasmDb,
  userId: string,
  query: string,
  limit = 10,
  preloadedCorpus?: Array<{ rowid: number; embedding: Float32Array }>,
): Promise<readonly RawLogSearchResult[]> {
  // ── 1. Fetch searchable rows: children + parent-only fallback (T-108) ───
  // Child rows: parent_id IS NOT NULL (small chunks for fast reranking)
  // Parent-only rows: parent_id IS NULL AND not a parent of any children (old data from pre-T-108)
  const childStmt = db.prepare(
    `SELECT id, session_id, session_label, timestamp, chunk_text, vec_rowid, parent_id
     FROM raw_log
     WHERE user_id = ? AND parent_id IS NOT NULL
     ORDER BY timestamp DESC`
  );
  childStmt.bind([userId]);

  const childRows: Array<RawLogRow & { vec_rowid: number | null }> = [];
  while (childStmt.step()) {
    childRows.push(childStmt.get({}) as any);
  }
  childStmt.finalize();

  // Fetch parent-only rows (old data) — rows that are parents (parent_id IS NULL) but have no children.
  const parentOnlyStmt = db.prepare(
    `SELECT id, session_id, session_label, timestamp, chunk_text, vec_rowid, parent_id
     FROM raw_log
     WHERE user_id = ? AND parent_id IS NULL
       AND id NOT IN (SELECT DISTINCT parent_id FROM raw_log WHERE parent_id IS NOT NULL)
     ORDER BY timestamp DESC`
  );
  parentOnlyStmt.bind([userId]);

  const parentOnlyRows: Array<RawLogRow & { vec_rowid: number | null }> = [];
  while (parentOnlyStmt.step()) {
    parentOnlyRows.push(parentOnlyStmt.get({}) as any);
  }
  parentOnlyStmt.finalize();

  // Combine both sets for search
  const allRows = [...childRows, ...parentOnlyRows];

  if (allRows.length === 0) return [];

  const idToRow = new Map<string, RawLogRow>(allRows.map((r) => [r.id, r]));

  // ── 2. BM25 search ───────────────────────────────────────────────────────
  const corpus = allRows.map((r) => r.chunk_text);
  const bm25 = new Bm25(corpus);
  const bm25RawScores = bm25.scores(query);

  const bm25Ranked: Array<[string, number]> = allRows
    .map((r, i): [string, number] => [r.id, bm25RawScores[i] ?? 0])
    .sort((a, b) => b[1] - a[1]);

  // ── 3. Vector search via JS cosine similarity ───────────────────────────
  const queryVec = await embedQuery(query);

  // T-103: Use preloaded corpus if provided, otherwise fetch from vec_raw_log
  let vecCorpus: Array<{ id: number; embedding: Float32Array }>;
  if (preloadedCorpus !== undefined) {
    // Map rowid → id for knnSearch compatibility
    vecCorpus = preloadedCorpus.map(entry => ({ id: entry.rowid, embedding: entry.embedding }));
  } else {
    // Fetch all embeddings from vec_raw_log (legacy path, used if cache not provided)
    const vecStmt = db.prepare(`SELECT id, embedding FROM vec_raw_log`);
    vecCorpus = [];
    while (vecStmt.step()) {
      const row = vecStmt.get({}) as { id: number; embedding: string };
      vecCorpus.push({
        id: row.id,
        embedding: deserializeEmbedding(row.embedding),
      });
    }
    vecStmt.finalize();
  }

  // Perform KNN search
  const vecFetchLimit = Math.min(allRows.length, Math.max(RERANK_TOP_K * 2, limit * 3, 50));
  const vecResults = knnSearch(queryVec, vecCorpus, vecFetchLimit);

  // Map vec_raw_log ids back to raw_log ids
  const vecRanked: Array<[string, number]> = [];
  for (const vecResult of vecResults) {
    const logRow = allRows.find((r) => r.vec_rowid === vecResult.id);
    if (logRow !== undefined) {
      vecRanked.push([logRow.id, 1 - vecResult.distance]);
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
  // Truncate passages to 512 chars before reranking — the cross-encoder
  // (ms-marco-MiniLM-L-6-v2) has a 512-token limit and silently truncates
  // longer inputs. Passing multi-kilobyte chunks causes 2–3s latency per
  // call and saturates scores to 1.000 (all signal lost). Truncating to
  // ~512 chars keeps inference fast (~6ms/passage) and restores score variance.
  const RERANKER_MAX_CHARS = 512;
  const passages = candidates.map(([id]) => {
    const text = idToRow.get(id)?.chunk_text ?? '';
    return text.length > RERANKER_MAX_CHARS ? text.slice(0, RERANKER_MAX_CHARS) : text;
  });
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

  // ── 8. Deduplicate by parent_id (T-108) ────────────────────────────────
  // For child rows (parent_id IS NOT NULL), keep the highest-scoring child per parent.
  // For parent-only rows (parent_id IS NULL), keep them as-is.
  const seenParents = new Set<string>();
  const deduplicated: Array<{ id: string; finalScore: number }> = [];

  for (const item of ranked) {
    const row = idToRow.get(item.id);
    if (!row) continue;

    if (row.parent_id !== null) {
      // Child row — deduplicate by parent_id
      if (seenParents.has(row.parent_id)) {
        continue; // Skip: already saw a higher-scoring child from this parent
      }
      seenParents.add(row.parent_id);
      deduplicated.push(item);
    } else {
      // Parent-only row — keep as-is (no dedup needed)
      deduplicated.push(item);
    }
  }

  // ── 9. Fetch parent chunk_text for child rows ──────────────────────────
  // For child rows, return parent chunk_text. For parent-only rows, return their own chunk_text.
  const parentIds = new Set<string>();
  for (const item of deduplicated.slice(0, limit)) {
    const row = idToRow.get(item.id);
    if (row && row.parent_id !== null) {
      parentIds.add(row.parent_id);
    }
  }

  // Fetch parent rows in one query
  const parentMap = new Map<string, RawLogRow>();
  if (parentIds.size > 0) {
    const placeholders = Array.from(parentIds).map(() => '?').join(',');
    const parentStmt = db.prepare(
      `SELECT id, session_id, session_label, timestamp, chunk_text, parent_id
       FROM raw_log
       WHERE id IN (${placeholders})`
    );
    parentStmt.bind(Array.from(parentIds));
    while (parentStmt.step()) {
      const parent = parentStmt.get({}) as RawLogRow;
      parentMap.set(parent.id, parent);
    }
    parentStmt.finalize();
  }

  // ── 10. Build output ────────────────────────────────────────────────────
  return deduplicated.slice(0, limit).map(({ id, finalScore }) => {
    const row = idToRow.get(id)!;

    // If this is a child row, return parent chunk_text. Otherwise, return own chunk_text.
    let displayRow = row;
    if (row.parent_id !== null) {
      const parent = parentMap.get(row.parent_id);
      if (parent) {
        displayRow = parent; // Use parent's chunk_text, session_id, etc.
      }
    }

    return {
      chunk_text: displayRow.chunk_text,
      session_id: displayRow.session_id,
      session_label: displayRow.session_label,
      timestamp: displayRow.timestamp,
      final_score: finalScore,
    };
  });
}
