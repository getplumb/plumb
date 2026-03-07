import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, type WasmDb } from './wasm-db.js';
import { applySchema } from './schema.js';
import type { MemoryStore } from './store.js';
import type { Fact, IngestResult, MessageExchange, SearchResult, StoreStatus } from './types.js';
import { extractFacts } from './extractor.js';
import { callLLMWithConfig, type LLMConfig } from './llm-client.js';
import { embed, warmEmbedder, warmReranker } from './embedder.js';
import { formatExchange } from './chunker.js';
import { searchRawLog, type RawLogSearchResult } from './raw-log-search.js';
import { searchFacts } from './fact-search.js';
import { ExtractionQueue, type ExtractFn } from './extraction-queue.js';
import { serializeEmbedding, deserializeEmbedding, cosineDistance } from './vector-search.js';

export type { RawLogSearchResult };

export interface RawFact {
  readonly id: string;
  readonly userId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
  readonly decayRate: string;
  readonly timestamp: string;
  readonly sourceSessionId: string;
  readonly sourceSessionLabel: string | null;
  readonly context: string | null;
  readonly deleted: boolean;
  readonly deletedAt: string | null;
}

export interface RawLogEntry {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly userMessage: string;
  readonly agentResponse: string;
  readonly timestamp: string;
  readonly source: string;
  readonly chunkText: string;
  readonly chunkIndex: number;
  readonly contentHash: string | null;
  readonly embedStatus: string;
  readonly embedError: string | null;
  readonly embedModel: string | null;
  readonly extractStatus: string;
  readonly extractError: string | null;
}

export interface ExportData {
  readonly facts: readonly RawFact[];
  readonly rawLog: readonly RawLogEntry[];
}

export interface LocalStoreOptions {
  /** Absolute path to the SQLite database file. Defaults to ~/.plumb/memory.db */
  dbPath?: string;
  /** User ID for scoping all data. Defaults to 'default' (single-user local install). */
  userId?: string;
  /**
   * LLM configuration for fact extraction. When provided, these values are used directly
   * instead of reading from environment variables, avoiding process.env mutation.
   */
  llmConfig?: LLMConfig;
  /**
   * Extraction queue for batched fact extraction. When provided, ingest() enqueues exchanges
   * instead of immediately calling extractFacts(). Defaults to a new ExtractionQueue instance.
   */
  extractionQueue?: ExtractionQueue;
  /**
   * Backlog processor tuning. Controls concurrency and idle behavior for drain loops.
   * Defaults: concurrency=5, embedIdleMs=5000, extractIdleMs=5000, retryBackoffMs=2000
   */
  backlog?: {
    /** Parallel extract requests (default 5) */
    concurrency?: number;
    /** Sleep duration when embed queue is empty (default 5000ms) */
    embedIdleMs?: number;
    /** Sleep duration when extract queue is empty (default 5000ms) */
    extractIdleMs?: number;
    /** Base backoff for 429 retries (default 2000ms) */
    retryBackoffMs?: number;
  };
}

export type { LLMConfig };

/**
 * Split text into overlapping child chunks for parent-child chunking (T-108).
 * Target: ~250 chars per chunk with ~50 char overlap.
 * Prefers sentence boundaries, falls back to word boundaries, hard-cuts at 300 chars max.
 */
function splitIntoChildren(text: string): string[] {
  const TARGET_SIZE = 250;
  const OVERLAP = 50;
  const MAX_SIZE = 300;
  const SENTENCE_ENDINGS = /[.!?]\s+/g;

  if (text.length <= TARGET_SIZE) {
    // Text is already small enough — return as single child
    return [text];
  }

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    let endPos = Math.min(pos + TARGET_SIZE, text.length);

    // If we're at the end of the text, take the rest
    if (endPos >= text.length) {
      chunks.push(text.slice(pos));
      break;
    }

    // Try to find a sentence boundary within the target range
    const segment = text.slice(pos, Math.min(pos + MAX_SIZE, text.length));
    const sentenceMatches = Array.from(segment.matchAll(SENTENCE_ENDINGS));

    if (sentenceMatches.length > 0) {
      // Find the last sentence boundary before TARGET_SIZE
      let bestMatch = sentenceMatches[0]!; // Safe: array is non-empty
      for (const match of sentenceMatches) {
        if (match.index !== undefined && match.index <= TARGET_SIZE) {
          bestMatch = match;
        } else {
          break;
        }
      }

      if (bestMatch.index !== undefined && bestMatch[0] !== undefined) {
        endPos = pos + bestMatch.index + bestMatch[0].length;
      } else {
        // Fall back to word boundary
        endPos = findWordBoundary(text, pos, TARGET_SIZE, MAX_SIZE);
      }
    } else {
      // No sentence boundary found — fall back to word boundary
      endPos = findWordBoundary(text, pos, TARGET_SIZE, MAX_SIZE);
    }

    chunks.push(text.slice(pos, endPos).trim());

    // Move position forward, with overlap
    pos = endPos - OVERLAP;
    if (pos < 0) pos = endPos; // Safety: don't go negative
  }

  return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Find a word boundary near the target position.
 * Prefers breaking at TARGET_SIZE, but will extend up to MAX_SIZE if needed.
 */
function findWordBoundary(text: string, start: number, targetSize: number, maxSize: number): number {
  const targetPos = start + targetSize;
  const maxPos = Math.min(start + maxSize, text.length);

  // Look for whitespace near the target position
  let endPos = targetPos;

  // First try: find whitespace after targetPos
  for (let i = targetPos; i < maxPos; i++) {
    if (/\s/.test(text[i] ?? '')) {
      endPos = i + 1; // Include the whitespace
      break;
    }
  }

  // If we hit maxPos without finding whitespace, hard cut at maxPos
  if (endPos === targetPos && targetPos < maxPos) {
    endPos = maxPos;
  }

  return endPos;
}

export class LocalStore implements MemoryStore {
  readonly #db: WasmDb;
  readonly #userId: string;
  readonly #llmConfig: LLMConfig | undefined;
  readonly #extractionQueue: ExtractionQueue;

  // Backlog processor state (T-095: drain loops)
  #embedDrainStopped = false;
  #extractDrainStopped = false;
  #embedDrainPromise: Promise<void> | null = null;
  #extractDrainPromise: Promise<void> | null = null;
  readonly #embedIdleMs: number;
  readonly #extractIdleMs: number;
  readonly #extractConcurrency: number;
  readonly #retryBackoffMs: number;
  readonly #extractFn: ExtractFn;

  // T-096: In-memory embedding cache for vec_facts (eliminates 292ms SQLite load on each query)
  #embeddingCache: Array<{ rowid: number; embedding: Float32Array }> = [];

  // T-103: In-memory embedding cache for vec_raw_log (eliminates ~3,700ms SQLite load on each query)
  #rawLogEmbeddingCache: Array<{ rowid: number; embedding: Float32Array }> = [];

  /** Expose database for plugin use (e.g., NudgeManager) */
  get db(): WasmDb {
    return this.#db;
  }

  /** Expose userId for plugin use */
  get userId(): string {
    return this.#userId;
  }

  /** Expose extraction queue for lifecycle management (start/stop) */
  get extractionQueue(): ExtractionQueue {
    return this.#extractionQueue;
  }

  private constructor(
    db: WasmDb,
    userId: string,
    llmConfig: LLMConfig | undefined,
    extractionQueue: ExtractionQueue,
    extractFn: ExtractFn,
    backlog?: LocalStoreOptions['backlog']
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#llmConfig = llmConfig;
    this.#extractionQueue = extractionQueue;
    this.#extractFn = extractFn;

    // Initialize backlog processor config — defaults run as fast as possible with concurrency.
    this.#embedIdleMs = backlog?.embedIdleMs ?? 5000;
    this.#extractIdleMs = backlog?.extractIdleMs ?? 5000;
    this.#extractConcurrency = backlog?.concurrency ?? 5;
    this.#retryBackoffMs = backlog?.retryBackoffMs ?? 2000;
  }

  /**
   * Create a new LocalStore instance (async factory).
   * Required because WASM initialization is async.
   */
  static async create(options: LocalStoreOptions = {}): Promise<LocalStore> {
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'memory.db');
    const userId = options.userId ?? 'default';
    const llmConfig = options.llmConfig;

    mkdirSync(dirname(dbPath), { recursive: true });

    const db = await openDb(dbPath);

    // Enable WAL mode and foreign keys
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    applySchema(db);

    // Use a mutable cell to hold the store reference (needed for circular dependency)
    let storeRef: LocalStore | null = null;

    // Initialize extraction queue with deferred store lookup
    // T-079: Wrapper handles extract_status updates on success/failure.
    const extractFn: ExtractFn = async (exchange, userId, sourceChunkId) => {
      if (!storeRef) throw new Error('Store not initialized');
      const llmFn = llmConfig
        ? (prompt: string) => callLLMWithConfig(prompt, llmConfig!)
        : undefined;

      try {
        const facts = await extractFacts(exchange, userId, storeRef, llmFn, sourceChunkId);
        // T-079: Update extract_status='done' on success.
        const updateStmt = db.prepare(`
          UPDATE raw_log SET extract_status = 'done' WHERE id = ?
        `);
        updateStmt.bind([sourceChunkId]);
        updateStmt.step();
        updateStmt.finalize();
        return facts;
      } catch (err: unknown) {
        // T-079: Update extract_status='failed' with error message.
        const errorMsg = err instanceof Error ? err.message : String(err);
        const updateStmt = db.prepare(`
          UPDATE raw_log SET extract_status = 'failed', extract_error = ? WHERE id = ?
        `);
        updateStmt.bind([errorMsg, sourceChunkId]);
        updateStmt.step();
        updateStmt.finalize();
        // Re-throw so Promise.allSettled() in flush() sees the rejection.
        throw err;
      }
    };

    const extractionQueue = options.extractionQueue ?? new ExtractionQueue(extractFn);

    // Create store and assign to ref
    const store = new LocalStore(db, userId, llmConfig, extractionQueue, extractFn, options.backlog);
    storeRef = store;

    // T-096: Warm embedder pipeline to eliminate 365ms cold-start on first query
    await warmEmbedder();

    // T-101: Warm reranker pipeline to eliminate ~200ms cold-start on first query
    // (intentionally loads ~80MB model at init for consistent <250ms query performance)
    await warmReranker();

    // T-096: Load all vec_facts embeddings into in-memory cache (eliminates 292ms SQLite load per query)
    const vecStmt = db.prepare(`SELECT rowid, embedding FROM vec_facts`);
    while (vecStmt.step()) {
      const row = vecStmt.get({}) as { rowid: number; embedding: string };
      store.#embeddingCache.push({
        rowid: row.rowid,
        embedding: deserializeEmbedding(row.embedding),
      });
    }
    vecStmt.finalize();

    // T-103/T-108: Load vec_raw_log embeddings for child rows only (eliminates ~3,700ms SQLite load per query)
    // Child rows have parent_id IS NOT NULL. Parent rows are not embedded (embed_status='no_embed').
    const rawLogVecStmt = db.prepare(`
      SELECT v.rowid, v.embedding
      FROM vec_raw_log v
      JOIN raw_log r ON r.vec_rowid = v.rowid
      WHERE r.parent_id IS NOT NULL
    `);
    while (rawLogVecStmt.step()) {
      const row = rawLogVecStmt.get({}) as { rowid: number; embedding: string };
      store.#rawLogEmbeddingCache.push({
        rowid: row.rowid,
        embedding: deserializeEmbedding(row.embedding),
      });
    }
    rawLogVecStmt.finalize();

    return store;
  }

  async store(fact: Omit<Fact, 'id'>, sourceChunkId?: string): Promise<string> {
    // T-097: Cross-chunk fact deduplication — prevent storing duplicate facts across different chunks.
    // A fact is considered a duplicate if it has the same subject+predicate and the object is either:
    // 1. Identical (case-insensitive, normalized whitespace), OR
    // 2. Semantically similar (cosine similarity >= 0.92 on embeddings)
    //
    // Pre-filter by subject+predicate via SQL (uses index, avoids full corpus scan).
    const candidateStmt = this.#db.prepare(`
      SELECT id, object, vec_rowid
      FROM facts
      WHERE user_id = ? AND subject = ? AND predicate = ? AND deleted_at IS NULL
    `);
    candidateStmt.bind([this.#userId, fact.subject, fact.predicate]);

    const candidates: Array<{ id: string; object: string; vec_rowid: number | null }> = [];
    while (candidateStmt.step()) {
      candidates.push(candidateStmt.get({}) as any);
    }
    candidateStmt.finalize();

    // Helper: Normalize text for exact-match check (lowercase, trim, collapse multiple spaces)
    const normalizeText = (text: string): string =>
      text.toLowerCase().trim().replace(/\s+/g, ' ');

    const normalizedNewObject = normalizeText(fact.object);

    // Check for exact object match first (avoids embedding call in the common case)
    for (const candidate of candidates) {
      if (normalizeText(candidate.object) === normalizedNewObject) {
        // Exact duplicate found — return existing fact ID without inserting
        return candidate.id;
      }
    }

    // No exact match found. Now embed the new fact for semantic similarity check and insertion.
    const text = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.context ?? ''}`.trim();
    const embedding = await embed(text);
    const embeddingJson = serializeEmbedding(embedding);

    // Check semantic similarity against candidates (only if we have candidates with embeddings)
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        if (candidate.vec_rowid === null) continue;

        // Find candidate embedding in in-memory cache (T-096)
        const cachedEntry = this.#embeddingCache.find(entry => entry.rowid === candidate.vec_rowid);
        if (!cachedEntry) continue;

        // Compute cosine similarity. Distance = 1 - similarity, so similarity >= 0.92 means distance <= 0.08.
        const distance = cosineDistance(embedding, cachedEntry.embedding);
        if (distance <= 0.08) {
          // Semantically equivalent fact found — return existing ID without inserting
          return candidate.id;
        }
      }
    }

    // No duplicate found (neither exact nor semantic) — proceed with normal insertion
    const id = crypto.randomUUID();

    // Begin transaction
    this.#db.exec('BEGIN');

    try {
      // Insert fact (T-079: include source_chunk_id)
      const factStmt = this.#db.prepare(`
        INSERT INTO facts
          (id, user_id, subject, predicate, object,
           confidence, decay_rate, timestamp, source_session_id,
           source_session_label, context, source_chunk_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      factStmt.bind([
        id,
        this.#userId,
        fact.subject,
        fact.predicate,
        fact.object,
        fact.confidence,
        fact.decayRate,
        fact.timestamp.toISOString(),
        fact.sourceSessionId,
        fact.sourceSessionLabel ?? null,
        fact.context ?? null,
        sourceChunkId ?? null,
      ]);
      factStmt.step();
      factStmt.finalize();

      // Insert embedding into vec_facts (auto-assigned id).
      const vecStmt = this.#db.prepare(`INSERT INTO vec_facts(embedding) VALUES (?)`);
      vecStmt.bind([embeddingJson]);
      vecStmt.step();
      vecStmt.finalize();

      const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

      // Back-fill vec_rowid so fact-search can join without a mapping table.
      const updateStmt = this.#db.prepare(`UPDATE facts SET vec_rowid = ? WHERE id = ?`);
      updateStmt.bind([vecRowid, id]);
      updateStmt.step();
      updateStmt.finalize();

      this.#db.exec('COMMIT');

      // T-096: Append new embedding to in-memory cache
      this.#embeddingCache.push({ rowid: vecRowid, embedding });
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    return id;
  }

  async search(query: string, limit = 20): Promise<readonly SearchResult[]> {
    // T-096: Pass in-memory embedding cache to searchFacts (eliminates 292ms SQLite load per query)
    return searchFacts(this.#db, this.#userId, query, limit, this.#embeddingCache);
  }

  async delete(id: string): Promise<void> {
    // T-096: Get vec_rowid before soft-deleting so we can remove from cache
    const vecRowidStmt = this.#db.prepare(`
      SELECT vec_rowid FROM facts WHERE id = ? AND user_id = ?
    `);
    vecRowidStmt.bind([id, this.#userId]);
    vecRowidStmt.step();
    const vecRowid = vecRowidStmt.get(0) as number | null;
    vecRowidStmt.finalize();

    // Soft delete only — never hard delete.
    const stmt = this.#db.prepare(`
      UPDATE facts SET deleted_at = ? WHERE id = ? AND user_id = ?
    `);
    stmt.bind([new Date().toISOString(), id, this.#userId]);
    stmt.step();
    stmt.finalize();

    // T-096: Remove from in-memory embedding cache
    if (vecRowid !== null) {
      const cacheIdx = this.#embeddingCache.findIndex(entry => entry.rowid === vecRowid);
      if (cacheIdx !== -1) {
        this.#embeddingCache.splice(cacheIdx, 1);
      }
    }
  }

  async status(): Promise<StoreStatus> {
    const factStmt = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM facts WHERE user_id = ? AND deleted_at IS NULL`
    );
    factStmt.bind([this.#userId]);
    factStmt.step();
    const factCount = factStmt.get(0) as number;
    factStmt.finalize();

    const rawLogStmt = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM raw_log WHERE user_id = ?`
    );
    rawLogStmt.bind([this.#userId]);
    rawLogStmt.step();
    const rawLogCount = rawLogStmt.get(0) as number;
    rawLogStmt.finalize();

    const lastIngestionStmt = this.#db.prepare(
      `SELECT MAX(timestamp) AS ts FROM raw_log WHERE user_id = ?`
    );
    lastIngestionStmt.bind([this.#userId]);
    lastIngestionStmt.step();
    const lastIngestionTs = lastIngestionStmt.get(0);
    lastIngestionStmt.finalize();

    const pageCount = this.#db.selectValue('PRAGMA page_count') as number;
    const pageSize = this.#db.selectValue('PRAGMA page_size') as number;

    return {
      factCount,
      rawLogCount,
      lastIngestion: lastIngestionTs !== null ? new Date(lastIngestionTs as string) : null,
      storageBytes: pageCount * pageSize,
    };
  }

  async ingest(exchange: MessageExchange): Promise<IngestResult> {
    const rawLogId = crypto.randomUUID();
    const chunkText = formatExchange(exchange);

    // Compute content hash for deduplication (scoped per userId).
    const contentHash = createHash('sha256').update(chunkText).digest('hex');

    // T-108: Parent-child chunking — don't embed parent, only children.
    // Parent extract_status: 'no_llm' if no config, otherwise 'pending' (extraction runs on parent only).
    const extractStatus = this.#llmConfig ? 'pending' : 'no_llm';

    // Attempt insert — catch UNIQUE constraint violations (duplicate content_hash).
    try {
      this.#db.exec('BEGIN');

      // T-108: Insert parent row (no embedding, no vec_rowid).
      const rawLogStmt = this.#db.prepare(`
        INSERT INTO raw_log
          (id, user_id, session_id, session_label,
           user_message, agent_response, timestamp, source, chunk_text, chunk_index, content_hash,
           embed_status, embed_error, embed_model, extract_status, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      rawLogStmt.bind([
        rawLogId,
        this.#userId,
        exchange.sessionId,
        exchange.sessionLabel ?? null,
        exchange.userMessage,
        exchange.agentResponse,
        exchange.timestamp.toISOString(),
        exchange.source,
        chunkText,
        0,
        contentHash,
        'no_embed', // Parent is not embedded (T-108)
        null,
        null,
        extractStatus,
        null, // parent_id=NULL for parent rows
      ]);
      rawLogStmt.step();
      rawLogStmt.finalize();

      // T-108: Split parent into child chunks and embed each child.
      const childChunks = splitIntoChildren(chunkText);

      for (let i = 0; i < childChunks.length; i++) {
        const childText = childChunks[i];
        if (!childText) continue;

        const childId = crypto.randomUUID();
        let childEmbedding: Float32Array | null = null;
        let childEmbeddingJson: string | null = null;
        let childEmbedStatus = 'pending';
        let childEmbedError: string | null = null;
        let childEmbedModel: string | null = null;

        // Embed the child chunk
        try {
          childEmbedding = await embed(childText);
          childEmbeddingJson = serializeEmbedding(childEmbedding);
          childEmbedStatus = 'done';
          childEmbedModel = 'Xenova/bge-small-en-v1.5';
        } catch (err: unknown) {
          childEmbedStatus = 'failed';
          childEmbedError = err instanceof Error ? err.message : String(err);
        }

        // Insert child row
        const childStmt = this.#db.prepare(`
          INSERT INTO raw_log
            (id, user_id, session_id, session_label,
             user_message, agent_response, timestamp, source, chunk_text, chunk_index, content_hash,
             embed_status, embed_error, embed_model, extract_status, parent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        childStmt.bind([
          childId,
          this.#userId,
          exchange.sessionId,
          exchange.sessionLabel ?? null,
          exchange.userMessage,
          exchange.agentResponse,
          exchange.timestamp.toISOString(),
          exchange.source,
          childText,
          i, // chunk_index for ordering
          null, // No content_hash for children (they don't participate in dedup)
          childEmbedStatus,
          childEmbedError,
          childEmbedModel,
          'child', // T-108: Mark as 'child' to prevent extraction
          rawLogId, // parent_id points to parent
        ]);
        childStmt.step();
        childStmt.finalize();

        // Insert child embedding into vec_raw_log if embedding succeeded
        if (childEmbeddingJson !== null) {
          const vecStmt = this.#db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
          vecStmt.bind([childEmbeddingJson]);
          vecStmt.step();
          vecStmt.finalize();

          const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

          // Back-fill vec_rowid on child row
          const updateStmt = this.#db.prepare(`UPDATE raw_log SET vec_rowid = ? WHERE id = ?`);
          updateStmt.bind([vecRowid, childId]);
          updateStmt.step();
          updateStmt.finalize();

          // T-103: Append child embedding to in-memory cache
          this.#rawLogEmbeddingCache.push({ rowid: vecRowid, embedding: childEmbedding! });
        }
      }

      this.#db.exec('COMMIT');
    } catch (err: unknown) {
      this.#db.exec('ROLLBACK');

      // Check for SQLite UNIQUE constraint error on content_hash.
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        // Duplicate content — skip ingestion and fact extraction.
        return {
          rawLogId: '',
          factsExtracted: 0,
          factIds: [],
          skipped: true,
        };
      }
      // Re-throw other errors (e.g., real DB issues).
      throw err;
    }

    // Layer 2: enqueue exchange for batched fact extraction (T-071) only if LLM config is present.
    // If no LLM config, extract_status is already set to 'no_llm', so skip enqueue.
    if (this.#llmConfig) {
      this.#extractionQueue.enqueue(exchange, this.#userId, rawLogId);
    }

    return {
      rawLogId,
      factsExtracted: 0,
      factIds: [],
    };
  }

  /**
   * Hybrid search over raw_log (Layer 1 retrieval).
   * See raw-log-search.ts for the full pipeline description.
   */
  async searchRawLog(query: string, limit = 10): Promise<readonly RawLogSearchResult[]> {
    // T-103: Pass in-memory embedding cache to searchRawLog (eliminates ~3,700ms SQLite load per query)
    return searchRawLog(this.#db, this.#userId, query, limit, this.#rawLogEmbeddingCache);
  }

  /**
   * Wait for all queued fact extractions to complete.
   * Call this before close() to ensure all async work is done.
   * Delegates to ExtractionQueue.flush().
   */
  async drain(): Promise<void> {
    await this.#extractionQueue.flush();
  }

  /**
   * Re-extract facts for orphaned raw_log chunks (chunks with no corresponding facts).
   *
   * This is useful when fact extraction failed during initial ingest (e.g., missing API key,
   * rate limits, crashes). Re-running the normal seeder won't help because content-hash dedup
   * skips already-ingested chunks before reaching the extraction phase.
   *
   * This method directly calls extractFacts() for each orphaned chunk, bypassing the dedup gate.
   *
   * @param throttleMs - Delay between extractions (default 1000ms) to stay under rate limits
   * @returns Statistics: orphansFound, factsCreated
   */
  async reextractOrphans(throttleMs = 1000): Promise<{ orphansFound: number; factsCreated: number }> {
    // Query for raw_log entries with no corresponding facts.
    const stmt = this.#db.prepare(`
      SELECT
        id,
        user_id AS userId,
        session_id AS sessionId,
        session_label AS sessionLabel,
        user_message AS userMessage,
        agent_response AS agentResponse,
        timestamp,
        source
      FROM raw_log
      WHERE user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM facts
          WHERE facts.source_session_id = raw_log.session_id
        )
      ORDER BY timestamp ASC
    `);
    stmt.bind([this.#userId]);

    const orphanRows: Array<{
      id: string;
      userId: string;
      sessionId: string;
      sessionLabel: string | null;
      userMessage: string;
      agentResponse: string;
      timestamp: string;
      source: string;
    }> = [];

    while (stmt.step()) {
      const row = stmt.get({}) as any;
      orphanRows.push(row);
    }
    stmt.finalize();

    const orphansFound = orphanRows.length;

    if (orphansFound === 0) {
      return { orphansFound: 0, factsCreated: 0 };
    }

    let factsCreated = 0;

    for (let i = 0; i < orphanRows.length; i++) {
      const row = orphanRows[i];
      if (!row) continue;

      // Reconstruct MessageExchange from raw_log data
      const exchange: MessageExchange = {
        userMessage: row.userMessage,
        agentResponse: row.agentResponse,
        timestamp: new Date(row.timestamp),
        source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
        sessionId: row.sessionId,
        ...(row.sessionLabel !== null ? { sessionLabel: row.sessionLabel } : {}),
      };

      // Extract facts directly (bypasses ingest dedup gate)
      try {
        const llmFn = this.#llmConfig
          ? (prompt: string) => callLLMWithConfig(prompt, this.#llmConfig!)
          : undefined;
        const facts = await extractFacts(exchange, this.#userId, this, llmFn);
        factsCreated += facts.length;

        console.log(`  ✅ [${i + 1}/${orphansFound}] Re-extracted ${facts.length} fact(s) from session ${row.sessionId}`);
      } catch (err: unknown) {
        console.error(`  ❌ [${i + 1}/${orphansFound}] Failed to re-extract facts from session ${row.sessionId}:`, err);
      }

      // Throttle to stay under rate limits (skip delay after last item)
      if (i < orphanRows.length - 1) {
        await new Promise(resolve => setTimeout(resolve, throttleMs));
      }
    }

    return { orphansFound, factsCreated };
  }

  /**
   * Get top subjects by fact count (for plumb status command).
   * Returns subjects ordered by number of facts (non-deleted only).
   */
  topSubjects(userId: string, limit = 5): Array<{ subject: string; count: number }> {
    const stmt = this.#db.prepare(`
      SELECT subject, COUNT(*) as count
      FROM facts
      WHERE user_id = ? AND deleted_at IS NULL
      GROUP BY subject
      ORDER BY count DESC
      LIMIT ?
    `);
    stmt.bind([userId, limit]);

    const results: Array<{ subject: string; count: number }> = [];
    while (stmt.step()) {
      results.push(stmt.get({}) as { subject: string; count: number });
    }
    stmt.finalize();

    return results;
  }

  /**
   * Export all data for a user (for plumb export command).
   * Returns raw database rows (no vector data).
   * Includes soft-deleted facts for transparency.
   */
  exportAll(userId: string): ExportData {
    // Export all non-deleted facts only (soft-deleted facts are excluded).
    const factStmt = this.#db.prepare(`
      SELECT
        id,
        user_id AS userId,
        subject,
        predicate,
        object,
        confidence,
        decay_rate AS decayRate,
        timestamp,
        source_session_id AS sourceSessionId,
        source_session_label AS sourceSessionLabel,
        context,
        deleted_at AS deletedAt
      FROM facts
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY timestamp DESC
    `);
    factStmt.bind([userId]);

    const factRows: Array<{
      id: string;
      userId: string;
      subject: string;
      predicate: string;
      object: string;
      confidence: number;
      decayRate: string;
      timestamp: string;
      sourceSessionId: string;
      sourceSessionLabel: string | null;
      context: string | null;
      deletedAt: string | null;
    }> = [];

    while (factStmt.step()) {
      factRows.push(factStmt.get({}) as any);
    }
    factStmt.finalize();

    const facts: RawFact[] = factRows.map((row) => ({
      ...row,
      deleted: false, // All exported facts are non-deleted
    }));

    // Export all raw_log entries (no vector data).
    const rawLogStmt = this.#db.prepare(`
      SELECT
        id,
        user_id AS userId,
        session_id AS sessionId,
        session_label AS sessionLabel,
        user_message AS userMessage,
        agent_response AS agentResponse,
        timestamp,
        source,
        chunk_text AS chunkText,
        chunk_index AS chunkIndex,
        content_hash AS contentHash,
        embed_status AS embedStatus,
        embed_error AS embedError,
        embed_model AS embedModel,
        extract_status AS extractStatus,
        extract_error AS extractError
      FROM raw_log
      WHERE user_id = ?
      ORDER BY timestamp DESC
    `);
    rawLogStmt.bind([userId]);

    const rawLog: RawLogEntry[] = [];
    while (rawLogStmt.step()) {
      rawLog.push(rawLogStmt.get({}) as any);
    }
    rawLogStmt.finalize();

    return { facts, rawLog };
  }

  /**
   * Start background backlog processor drain loops (T-095).
   * Launches continuous async loops for embed and extract backlogs.
   * Call this after store.extractionQueue.start() in plugin-module.ts.
   */
  startBacklogProcessor(): void {
    // Start embed drain loop
    if (this.#embedDrainPromise === null) {
      this.#embedDrainStopped = false;
      this.#embedDrainPromise = this.#embedDrainLoop();
    }

    // Start extract drain loop (only if LLM config is present)
    if (this.#llmConfig && this.#extractDrainPromise === null) {
      this.#extractDrainStopped = false;
      this.#extractDrainPromise = this.#extractDrainLoop();
    }
  }

  /**
   * Stop background backlog processor drain loops (T-095).
   * Signals both loops to stop and awaits in-flight work.
   * Call this alongside store.extractionQueue.stop() in session_end and process exit handlers.
   */
  async stopBacklogProcessor(): Promise<void> {
    // Signal loops to stop
    this.#embedDrainStopped = true;
    this.#extractDrainStopped = true;

    // Await drain loop Promises (waits for in-flight work to complete)
    const promises: Promise<void>[] = [];
    if (this.#embedDrainPromise !== null) {
      promises.push(this.#embedDrainPromise);
      this.#embedDrainPromise = null;
    }
    if (this.#extractDrainPromise !== null) {
      promises.push(this.#extractDrainPromise);
      this.#extractDrainPromise = null;
    }

    await Promise.all(promises);
  }

  /**
   * Continuous drain loop for embed backlog (T-095).
   * Runs as fast as the Worker thread allows, with no artificial throttling.
   * Only sleeps when the queue is empty.
   */
  async #embedDrainLoop(): Promise<void> {
    while (!this.#embedDrainStopped) {
      const processed = await this.#processEmbedBatch();
      if (processed === 0) {
        // Queue is empty — sleep before checking again
        await new Promise(resolve => setTimeout(resolve, this.#embedIdleMs));
      }
      // If processed > 0: immediately loop to grab the next batch
    }
  }

  /**
   * Process one batch of embed backlog rows (T-095).
   * Uses Promise.all for parallelism across the batch (embed runs in Worker, no API limits).
   * Returns count of rows processed.
   */
  async #processEmbedBatch(): Promise<number> {
    const BATCH_SIZE = 50; // Large batch — embed is CPU-bound, no rate limit

    // T-108: Fetch pending child rows only (parent_id IS NOT NULL).
    // Old parent rows (parent_id IS NULL, embed_status='pending') are left as-is for fallback search.
    const stmt = this.#db.prepare(`
      SELECT id, chunk_text FROM raw_log
      WHERE user_id = ? AND embed_status = 'pending' AND parent_id IS NOT NULL
      ORDER BY rowid ASC
      LIMIT ?
    `);
    stmt.bind([this.#userId, BATCH_SIZE]);

    const pendingRows: Array<{ id: string; chunk_text: string }> = [];
    while (stmt.step()) {
      pendingRows.push(stmt.get({}) as any);
    }
    stmt.finalize();

    if (pendingRows.length === 0) return 0;

    // Process rows concurrently with Promise.all
    await Promise.all(
      pendingRows.map(async (row) => {
        try {
          const embedding = await embed(row.chunk_text);
          const embeddingJson = serializeEmbedding(embedding);
          const embedModel = 'Xenova/bge-small-en-v1.5';

          // Insert into vec_raw_log (transaction per row for isolation)
          this.#db.exec('BEGIN');
          const vecStmt = this.#db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
          vecStmt.bind([embeddingJson]);
          vecStmt.step();
          vecStmt.finalize();

          const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

          // Update raw_log: embed_status='done', vec_rowid, embed_model
          const updateStmt = this.#db.prepare(`
            UPDATE raw_log
            SET embed_status = 'done', embed_error = NULL, embed_model = ?, vec_rowid = ?
            WHERE id = ?
          `);
          updateStmt.bind([embedModel, vecRowid, row.id]);
          updateStmt.step();
          updateStmt.finalize();

          this.#db.exec('COMMIT');

          // T-103: Append new embedding to in-memory cache
          this.#rawLogEmbeddingCache.push({ rowid: vecRowid, embedding });
        } catch (err: unknown) {
          // Embedding failed — update embed_status='failed' with error
          const errorMsg = err instanceof Error ? err.message : String(err);
          const updateStmt = this.#db.prepare(`
            UPDATE raw_log
            SET embed_status = 'failed', embed_error = ?
            WHERE id = ?
          `);
          updateStmt.bind([errorMsg, row.id]);
          updateStmt.step();
          updateStmt.finalize();
        }
      })
    );

    return pendingRows.length;
  }

  /**
   * Continuous drain loop for extract backlog (T-095).
   * Fetches up to `concurrency` rows and processes them concurrently with 429 backoff.
   * Only sleeps when the queue is empty.
   */
  async #extractDrainLoop(): Promise<void> {
    while (!this.#extractDrainStopped) {
      // Fetch pending rows (up to concurrency limit)
      const stmt = this.#db.prepare(`
        SELECT id, user_message, agent_response, timestamp, session_id, session_label, source
        FROM raw_log
        WHERE user_id = ? AND extract_status = 'pending'
        ORDER BY rowid ASC
        LIMIT ?
      `);
      stmt.bind([this.#userId, this.#extractConcurrency]);

      const pendingRows: Array<{
        id: string;
        user_message: string;
        agent_response: string;
        timestamp: string;
        session_id: string;
        session_label: string | null;
        source: string;
      }> = [];

      while (stmt.step()) {
        pendingRows.push(stmt.get({}) as any);
      }
      stmt.finalize();

      if (pendingRows.length === 0) {
        // Queue is empty — sleep before checking again
        await new Promise(resolve => setTimeout(resolve, this.#extractIdleMs));
        continue;
      }

      // Process rows concurrently with 429 backoff
      await Promise.all(
        pendingRows.map(async (row) => {
          const exchange: MessageExchange = {
            userMessage: row.user_message,
            agentResponse: row.agent_response,
            timestamp: new Date(row.timestamp),
            source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
            sessionId: row.session_id,
            ...(row.session_label !== null ? { sessionLabel: row.session_label } : {}),
          };

          await this.#extractRowWithBackoff(exchange, row.id);
        })
      );
    }
  }

  /**
   * Extract facts for one row with exponential backoff on 429 errors (T-095).
   * Calls extractFn directly (bypasses ExtractionQueue for backlog processing).
   * extractFn already handles DB status updates (extract_status=done/failed).
   */
  async #extractRowWithBackoff(exchange: MessageExchange, sourceChunkId: string): Promise<void> {
    const MAX_RETRIES = 4;
    let attempt = 0;

    while (attempt <= MAX_RETRIES) {
      try {
        await this.#extractFn(exchange, this.#userId, sourceChunkId);
        return; // Success
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const is429 = errorMsg.toLowerCase().includes('429') ||
                      errorMsg.toLowerCase().includes('rate') ||
                      errorMsg.toLowerCase().includes('quota');

        if (is429 && attempt < MAX_RETRIES) {
          // Exponential backoff: 2s, 4s, 8s, 16s
          const backoffMs = this.#retryBackoffMs * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          attempt++;
        } else {
          // Not a 429, or max retries reached — extractFn already marked extract_status='failed'
          return;
        }
      }
    }
  }

  /** Close the database connection. Call when done (e.g. in tests). */
  close(): void {
    this.#db.close();
  }
}
