/**
 * Fact hybrid search (Layer 2 retrieval).
 *
 * Pipeline:
 *   1. BM25 keyword search over concatenated fact text (subject+predicate+object+context)
 *   2. KNN vector search via JS cosine similarity (replaces sqlite-vec)
 *   3. Reciprocal Rank Fusion (RRF, k=60) merges both ranked lists
 *   4. Recency decay: score *= e^(-lambda × age_in_days), using per-fact decay_rate
 *   5. Cross-encoder reranker (top-20 candidates → Xenova/ms-marco-MiniLM-L-6-v2)
 *   6. Return top-k by reranker score (falls back to RRF×decay if reranker fails)
 *
 * Decay lambdas by fact decay_rate:
 *   slow=0.003 (half-life ~231 days) — identity, stable preferences
 *   medium=0.012 (half-life ~58 days) — project context, tool choices
 *   fast=0.05 (half-life ~14 days) — transient state
 */

import type { WasmDb } from './wasm-db.js';
import { Bm25 } from './bm25.js';
import { embedQuery, rerankScores } from './embedder.js';
import type { SearchResult } from './types.js';
import { DecayRate } from './types.js';
import { knnSearch, deserializeEmbedding } from './vector-search.js';

// RRF constant (standard k=60).
const RRF_K = 60;

// Number of candidates passed to the cross-encoder.
const RERANK_TOP_K = 20;

// Decay lambdas by fact decay_rate field.
const DECAY_LAMBDAS: Record<string, number> = {
  slow: 0.003,
  medium: 0.012,
  fast: 0.05,
};

// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface FactRow {
  id: string;
  user_id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  decay_rate: string;
  timestamp: string;
  source_session_id: string;
  source_session_label: string | null;
  context: string | null;
  deleted_at: string | null;
  vec_rowid: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function factText(row: FactRow): string {
  return `${row.subject} ${row.predicate} ${row.object} ${row.context ?? ''}`.trim();
}

function ageInDays(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / (1_000 * 60 * 60 * 24);
}

function recencyDecay(timestamp: string, decayRate: string): number {
  const lambda = DECAY_LAMBDAS[decayRate] ?? DECAY_LAMBDAS.medium!;
  return Math.exp(-lambda * ageInDays(timestamp));
}

function rowToFact(row: FactRow) {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    decayRate: row.decay_rate as DecayRate,
    timestamp: new Date(row.timestamp),
    sourceSessionId: row.source_session_id,
    ...(row.source_session_label !== null ? { sourceSessionLabel: row.source_session_label } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  };
}

/**
 * Merge two ranked lists via Reciprocal Rank Fusion.
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
 * Hybrid search over facts.
 *
 * @param db                The WASM SQLite Database instance
 * @param userId            Scopes the search to this user's data
 * @param query             Natural language query string
 * @param limit             Number of results to return (default 20)
 * @param preloadedCorpus   Optional pre-loaded vec_facts corpus (T-096: in-memory cache)
 */
export async function searchFacts(
  db: WasmDb,
  userId: string,
  query: string,
  limit = 20,
  preloadedCorpus?: Array<{ rowid: number; embedding: Float32Array }>,
): Promise<readonly SearchResult[]> {
  // ── 1. Fetch all non-deleted fact rows for this user ────────────────────
  const stmt = db.prepare(
    `SELECT id, user_id, subject, predicate, object, confidence,
            decay_rate, timestamp, source_session_id, source_session_label,
            context, deleted_at, vec_rowid
     FROM facts
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY timestamp DESC`
  );
  stmt.bind([userId]);

  const allRows: FactRow[] = [];
  while (stmt.step()) {
    allRows.push(stmt.get({}) as any);
  }
  stmt.finalize();

  if (allRows.length === 0) return [];

  const idToRow = new Map<string, FactRow>(allRows.map((r) => [r.id, r]));

  // ── 2. BM25 search ───────────────────────────────────────────────────────
  const corpus = allRows.map(factText);
  const bm25 = new Bm25(corpus);
  const bm25RawScores = bm25.scores(query);

  const bm25Ranked: Array<[string, number]> = allRows
    .map((r, i): [string, number] => [r.id, bm25RawScores[i] ?? 0])
    .sort((a, b) => b[1] - a[1]);

  // ── 3. Vector search via JS cosine similarity ───────────────────────────
  const queryVec = await embedQuery(query);

  // T-096: Use preloaded corpus if provided, otherwise fetch from vec_facts
  let vecCorpus: Array<{ id: number; embedding: Float32Array }>;
  if (preloadedCorpus !== undefined) {
    // Map rowid → id for knnSearch compatibility
    vecCorpus = preloadedCorpus.map(entry => ({ id: entry.rowid, embedding: entry.embedding }));
  } else {
    // Fetch all embeddings from vec_facts (legacy path, used if cache not provided)
    const vecStmt = db.prepare(`SELECT id, embedding FROM vec_facts`);
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

  // Map vec_facts ids back to fact ids
  const vecRanked: Array<[string, number]> = [];
  for (const vecResult of vecResults) {
    const factRow = allRows.find((r) => r.vec_rowid === vecResult.id);
    if (factRow !== undefined) {
      vecRanked.push([factRow.id, 1 - vecResult.distance]);
    }
  }

  // ── 4. RRF merge ────────────────────────────────────────────────────────
  const rrfScores = rrf(vecRanked, bm25Ranked);

  // ── 5. Recency decay (per-fact lambda) ──────────────────────────────────
  const decayedScores: Array<[string, number]> = [];
  for (const [id, rrfScore] of rrfScores) {
    const row = idToRow.get(id);
    if (row === undefined) continue;
    const decay = recencyDecay(row.timestamp, row.decay_rate);
    decayedScores.push([id, rrfScore * decay]);
  }
  decayedScores.sort((a, b) => b[1] - a[1]);

  // ── 6. Take top candidates for reranking ────────────────────────────────
  const candidates = decayedScores.slice(0, Math.max(RERANK_TOP_K, limit));

  // ── 7. Cross-encoder reranking ──────────────────────────────────────────
  const passages = candidates.map(([id]) => factText(idToRow.get(id)!));
  const rerankerScores = await rerankScores(query, passages);

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
    const fact = rowToFact(row);
    return {
      fact,
      score: finalScore,
      ageInDays: ageInDays(row.timestamp),
    };
  });
}
