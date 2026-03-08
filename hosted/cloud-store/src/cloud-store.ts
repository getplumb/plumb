/**
 * CloudStore — hosted storage driver for Plumb using Supabase (Postgres + pgvector).
 *
 * Drop-in replacement for LocalStore — implements the same MemoryStore interface
 * but uses Postgres + pgvector instead of SQLite + sqlite-vec.
 *
 * Design constraints:
 *   - Implements MemoryStore interface from @plumb/core
 *   - Same hybrid search pipeline (BM25 + vector + RRF + rerank)
 *   - Same schema structure (facts, raw_log, nudge_log tables)
 *   - Per-userId scoping (application-level enforcement, not RLS)
 *
 * License: BSL 1.1 (Business Source License)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type { MemoryStore, IngestResult, MessageExchange, StoreStatus } from '@getplumb/core';
import { embed, embedQuery, rerankScores, formatExchange, Bm25 } from '@getplumb/core';
import pg from 'pg';

const { Pool } = pg;

// ─── Constants ────────────────────────────────────────────────────────────────

const RRF_K = 60;
const RERANK_TOP_K = 20;
const RECENCY_LAMBDA = 0.012; // Medium decay for raw logs


// ─── Internal DB row shapes ───────────────────────────────────────────────────

interface RawLogRow {
  id: string;
  session_id: string;
  session_label: string | null;
  timestamp: string;
  chunk_text: string;
}

export interface RawLogSearchResult {
  readonly chunk_text: string;
  readonly session_id: string;
  readonly session_label: string | null;
  readonly timestamp: string;
  readonly final_score: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ageInDays(timestamp: string): number {
  return (Date.now() - new Date(timestamp).getTime()) / (1_000 * 60 * 60 * 24);
}

function recencyDecayRawLog(timestamp: string): number {
  return Math.exp(-RECENCY_LAMBDA * ageInDays(timestamp));
}

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

// ─── CloudStore class ─────────────────────────────────────────────────────────

export interface CloudStoreOptions {
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase service role key (not anon key — for server-side use) */
  supabaseKey: string;
  /** User ID for scoping all data */
  userId: string;
}

export class CloudStore implements MemoryStore {
  readonly #supabase: SupabaseClient;
  readonly #pool: pg.Pool;
  readonly #userId: string;

  /** Expose userId for plugin use */
  get userId(): string {
    return this.#userId;
  }

  constructor(options: CloudStoreOptions) {
    this.#userId = options.userId;
    this.#supabase = createClient(options.supabaseUrl, options.supabaseKey);

    // Create a pg Pool for direct Postgres access (needed for pgvector queries)
    // Extract connection string from Supabase URL
    const url = new URL(options.supabaseUrl);
    const projectRef = url.hostname.split('.')[0];
    const connectionString = `postgresql://postgres:${options.supabaseKey}@db.${projectRef}.supabase.co:5432/postgres`;

    this.#pool = new Pool({ connectionString });
  }

  async status(): Promise<StoreStatus> {

    const { count: rawLogCount, error: rawLogError } = await this.#supabase
      .from('raw_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', this.#userId);

    if (rawLogError) {
      throw new Error(`Failed to count raw_log: ${rawLogError.message}`);
    }

    const { data: lastIngestionRow, error: lastIngestionError } = await this.#supabase
      .from('raw_log')
      .select('timestamp')
      .eq('user_id', this.#userId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastIngestionError) {
      throw new Error(`Failed to get last ingestion: ${lastIngestionError.message}`);
    }

    // For Supabase/cloud, storage bytes calculation is approximate or requires pg_database_size
    // For now, return 0 (TODO: implement via direct Postgres query if needed)
    const storageBytes = 0;

    return {
      rawLogCount: rawLogCount ?? 0,
      factCount: 0, // T-118: cloud-store does not yet support memory_facts
      lastIngestion: lastIngestionRow?.timestamp ? new Date(lastIngestionRow.timestamp) : null,
      storageBytes,
    };
  }

  async ingest(exchange: MessageExchange): Promise<IngestResult> {
    const chunkText = formatExchange(exchange);

    // Compute content hash for deduplication (scoped per userId)
    const contentHash = createHash('sha256').update(chunkText).digest('hex');

    // Embed before inserting
    const embedding = await embed(chunkText);
    const embeddingArray = Array.from(embedding);

    // Layer 1: write raw exchange to raw_log
    let rawLogId: string;
    try {
      const { data, error } = await this.#supabase
        .from('raw_log')
        .insert({
          user_id: this.#userId,
          session_id: exchange.sessionId,
          session_label: exchange.sessionLabel ?? null,
          user_message: exchange.userMessage,
          agent_response: exchange.agentResponse,
          timestamp: exchange.timestamp.toISOString(),
          source: exchange.source,
          chunk_text: chunkText,
          chunk_index: 0,
          content_hash: contentHash,
          embedding: embeddingArray,
        })
        .select('id')
        .single();

      if (error) {
        // Check for unique constraint violation (duplicate content_hash)
        if (error.code === '23505') {
          // Postgres unique violation
          return {
            rawLogId: '',
            skipped: true,
            factsExtracted: 0,
            factIds: [],
          };
        }
        throw new Error(`Failed to insert raw_log: ${error.message}`);
      }

      rawLogId = data.id;
    } catch (err: unknown) {
      throw err;
    }

    return {
      rawLogId,
      factsExtracted: 0,
      factIds: [],
    };
  }

  /**
   * Hybrid search over raw_log (Layer 1 retrieval).
   */
  async searchRawLog(query: string, limit = 10): Promise<readonly RawLogSearchResult[]> {
    // ── 1. Fetch all raw_log rows for this user ──────────────────────────────
    const { data: allRows, error: fetchError } = await this.#supabase
      .from('raw_log')
      .select('id, session_id, session_label, timestamp, chunk_text')
      .eq('user_id', this.#userId)
      .order('timestamp', { ascending: false });

    if (fetchError) {
      throw new Error(`Failed to fetch raw_log: ${fetchError.message}`);
    }

    if (!allRows || allRows.length === 0) return [];

    const idToRow = new Map<string, RawLogRow>(allRows.map((r) => [r.id, r as RawLogRow]));

    // ── 2. BM25 search ───────────────────────────────────────────────────────
    const corpus = allRows.map((r) => r.chunk_text);
    const bm25 = new Bm25(corpus);
    const bm25RawScores = bm25.scores(query);

    const bm25Ranked: Array<[string, number]> = allRows
      .map((r, i): [string, number] => [r.id, bm25RawScores[i] ?? 0])
      .sort((a, b) => b[1] - a[1]);

    // ── 3. Vector search via pgvector ─────────────────────────────────────────
    const queryVec = await embedQuery(query);
    const queryArray = Array.from(queryVec);
    const vecFetchLimit = Math.min(allRows.length, Math.max(RERANK_TOP_K * 2, limit * 3, 50));

    // Use pg driver directly for pgvector KNN query
    const client = await this.#pool.connect();
    try {
      const vecQuery = `
        SELECT id, embedding <=> $1::vector AS distance
        FROM raw_log
        WHERE user_id = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `;
      const vecResult = await client.query(vecQuery, [`[${queryArray.join(',')}]`, this.#userId, vecFetchLimit]);

      const vecRanked: Array<[string, number]> = vecResult.rows.map((row: { id: string; distance: number }) => [
        row.id,
        1 - row.distance,
      ]);

      // ── 4. RRF merge ────────────────────────────────────────────────────────
      const rrfScores = rrf(vecRanked, bm25Ranked);

      // ── 5. Recency decay ────────────────────────────────────────────────────
      const decayedScores: Array<[string, number]> = [];
      for (const [id, rrfScore] of rrfScores) {
        const row = idToRow.get(id);
        if (row === undefined) continue;
        const decay = recencyDecayRawLog(row.timestamp);
        decayedScores.push([id, rrfScore * decay]);
      }
      decayedScores.sort((a, b) => b[1] - a[1]);

      // ── 6. Take top candidates for reranking ────────────────────────────────
      const candidates = decayedScores.slice(0, Math.max(RERANK_TOP_K, limit));

      // ── 7. Cross-encoder reranking ──────────────────────────────────────────
      const passages = candidates.map(([id]) => idToRow.get(id)?.chunk_text ?? '');
      const rerankerScores = await rerankScores(query, passages);

      const hasRerankerSignal = rerankerScores.some((s: number) => s !== 0);

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
    } finally {
      client.release();
    }
  }

  /**
   * Close the Postgres pool connection.
   */
  async close(): Promise<void> {
    await this.#pool.end();
  }
}
