import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, type WasmDb } from './wasm-db.js';
import { applySchema } from './schema.js';
import type { MemoryStore } from './store.js';
import type { IngestResult, MessageExchange, StoreStatus, IngestMemoryFactInput, Fact, SearchResult } from './types.js';
import { embed, warmEmbedder, warmReranker } from './embedder.js';
import { formatExchange } from './chunker.js';
import { searchRawLog, type RawLogSearchResult } from './raw-log-search.js';
import { serializeEmbedding, deserializeEmbedding } from './vector-search.js';

export type { RawLogSearchResult };

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
}

export interface ExportData {
  readonly rawLog: readonly RawLogEntry[];
}

export interface LocalStoreOptions {
  /** Absolute path to the SQLite database file. Defaults to ~/.plumb/memory.db */
  dbPath?: string;
  /** User ID for scoping all data. Defaults to 'default' (single-user local install). */
  userId?: string;
  /**
   * Backlog processor tuning. Controls idle behavior for embed drain loop.
   * Defaults: embedIdleMs=5000
   */
  backlog?: {
    /** Sleep duration when embed queue is empty (default 5000ms) */
    embedIdleMs?: number;
  };
}

/**
 * Split text into overlapping child chunks for parent-child chunking (T-108).
 * Target: ~250 chars per chunk with ~50 char overlap.
 * Prefers sentence boundaries, falls back to word boundaries, hard-cuts at 300 chars max.
 *
 * Uses a generator to avoid materializing the full chunk array in memory,
 * which prevents OOM crashes on large inputs (fix for splitIntoChildren array limit bug).
 */
function* splitIntoChildren(text: string): Generator<string> {
  const TARGET_SIZE = 250;
  const OVERLAP = 50;
  const MAX_SIZE = 300;
  const SENTENCE_ENDINGS = /[.!?]\s+/g;

  if (text.length <= TARGET_SIZE) {
    // Text is already small enough — yield as single child
    if (text.trim().length > 0) yield text;
    return;
  }

  let pos = 0;

  while (pos < text.length) {
    let endPos = Math.min(pos + TARGET_SIZE, text.length);

    // If we're at the end of the text, take the rest
    if (endPos >= text.length) {
      const last = text.slice(pos).trim();
      if (last.length > 0) yield last;
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

    const chunk = text.slice(pos, endPos).trim();
    if (chunk.length > 0) yield chunk;

    // Move position forward, with overlap
    pos = endPos - OVERLAP;
    if (pos < 0) pos = endPos; // Safety: don't go negative
  }
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

  // Backlog processor state (T-095: drain loop)
  #embedDrainStopped = false;
  #embedDrainPromise: Promise<void> | null = null;
  readonly #embedIdleMs: number;

  // T-103/T-115: In-memory embedding cache for vec_raw_log (eliminates ~3,700ms SQLite load on each query)
  // T-115: Capped at MAX_CACHE_ENTRIES to prevent OOM crashes
  #rawLogEmbeddingCache: Array<{ rowid: number; embedding: Float32Array }> = [];
  static readonly MAX_CACHE_ENTRIES = 10000;
  static readonly HEAP_GUARD_THRESHOLD = 1_500_000_000; // 1.5GB in bytes

  // FIX 3: WAL checkpoint throttling to prevent unbounded WAL growth
  #lastCheckpoint = Date.now();
  #checkpointIntervalMs = 60000; // Checkpoint every minute

  // FIX 4: Health check to detect stuck drain loops
  #lastActivityTimestamp = Date.now();
  #healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Expose database for plugin use (e.g., NudgeManager) */
  get db(): WasmDb {
    return this.#db;
  }

  /** Expose userId for plugin use */
  get userId(): string {
    return this.#userId;
  }

  private constructor(
    db: WasmDb,
    userId: string,
    backlog?: LocalStoreOptions['backlog']
  ) {
    this.#db = db;
    this.#userId = userId;

    // Initialize backlog processor config
    this.#embedIdleMs = backlog?.embedIdleMs ?? 5000;
  }

  /**
   * T-115: Add entry to #rawLogEmbeddingCache with FIFO eviction.
   * Evicts oldest 10% when cache exceeds MAX_CACHE_ENTRIES.
   */
  #pushToCache(entry: { rowid: number; embedding: Float32Array }): void {
    this.#rawLogEmbeddingCache.push(entry);

    // Check if cache exceeds limit
    if (this.#rawLogEmbeddingCache.length > LocalStore.MAX_CACHE_ENTRIES) {
      // Evict oldest 10% to amortize splice cost
      const evictCount = Math.floor(LocalStore.MAX_CACHE_ENTRIES * 0.1);
      this.#rawLogEmbeddingCache.splice(0, evictCount);
    }
  }

  /**
   * Create a new LocalStore instance (async factory).
   * Required because WASM initialization is async.
   */
  static async create(options: LocalStoreOptions = {}): Promise<LocalStore> {
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'memory.db');
    const userId = options.userId ?? 'default';

    mkdirSync(dirname(dbPath), { recursive: true });

    const db = await openDb(dbPath);

    // Enable WAL mode and foreign keys
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    applySchema(db);

    // Create store
    const store = new LocalStore(db, userId, options.backlog);

    // T-096: Warm embedder pipeline to eliminate 365ms cold-start on first query
    await warmEmbedder();

    // T-101: Warm reranker pipeline to eliminate ~200ms cold-start on first query
    // (intentionally loads ~80MB model at init for consistent <250ms query performance)
    await warmReranker();

    // T-103/T-108/T-115: Load vec_raw_log embeddings for child rows only (eliminates ~3,700ms SQLite load per query)
    // T-115: Limit to MAX_CACHE_ENTRIES most recent rows to prevent OOM on startup
    // Child rows have parent_id IS NOT NULL. Parent rows are not embedded (embed_status='no_embed').
    const rawLogVecStmt = db.prepare(`
      SELECT v.rowid, v.embedding
      FROM vec_raw_log v
      JOIN raw_log r ON r.vec_rowid = v.rowid
      WHERE r.parent_id IS NOT NULL
      ORDER BY v.rowid DESC
      LIMIT ?
    `);
    rawLogVecStmt.bind([LocalStore.MAX_CACHE_ENTRIES]);
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

  async status(): Promise<StoreStatus> {
    // Count only parent rows (parent_id IS NULL) — one per ingest() call
    const rawLogStmt = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM raw_log WHERE user_id = ? AND parent_id IS NULL`
    );
    rawLogStmt.bind([this.#userId]);
    rawLogStmt.step();
    const rawLogCount = rawLogStmt.get(0) as number;
    rawLogStmt.finalize();

    // Count non-deleted memory facts
    const factCountStmt = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM memory_facts WHERE user_id = ? AND (deleted_at IS NULL)`
    );
    factCountStmt.bind([this.#userId]);
    factCountStmt.step();
    const factCount = factCountStmt.get(0) as number;
    factCountStmt.finalize();

    const lastIngestionStmt = this.#db.prepare(
      `SELECT MAX(timestamp) AS ts FROM raw_log WHERE user_id = ? AND parent_id IS NULL`
    );
    lastIngestionStmt.bind([this.#userId]);
    lastIngestionStmt.step();
    const lastIngestionTs = lastIngestionStmt.get(0);
    lastIngestionStmt.finalize();

    const pageCount = this.#db.selectValue('PRAGMA page_count') as number;
    const pageSize = this.#db.selectValue('PRAGMA page_size') as number;

    return {
      rawLogCount,
      factCount,
      lastIngestion: lastIngestionTs !== null ? new Date(lastIngestionTs as string) : null,
      storageBytes: pageCount * pageSize,
    };
  }

  async ingest(exchange: MessageExchange): Promise<IngestResult> {
    const rawLogId = crypto.randomUUID();
    const chunkText = formatExchange(exchange);

    // Compute content hash for deduplication (scoped per userId).
    const contentHash = createHash('sha256').update(chunkText).digest('hex');

    // Attempt insert — catch UNIQUE constraint violations (duplicate content_hash).
    try {
      this.#db.exec('BEGIN');

      // T-108: Insert parent row (no embedding, no vec_rowid).
      const rawLogStmt = this.#db.prepare(`
        INSERT INTO raw_log
          (id, user_id, session_id, session_label,
           user_message, agent_response, timestamp, source, chunk_text, chunk_index, content_hash,
           embed_status, embed_error, embed_model, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        null, // parent_id=NULL for parent rows
      ]);
      rawLogStmt.step();
      rawLogStmt.finalize();

      // T-108: Split parent into child chunks and embed each child.
      // splitIntoChildren is a generator — iterate lazily to avoid OOM on large inputs.
      let i = 0;
      for (const childText of splitIntoChildren(chunkText)) {

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
             embed_status, embed_error, embed_model, parent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

          // T-103/T-115: Append child embedding to in-memory cache (with eviction)
          this.#pushToCache({ rowid: vecRowid, embedding: childEmbedding! });
        }

        i++;
      }

      this.#db.exec('COMMIT');
    } catch (err: unknown) {
      this.#db.exec('ROLLBACK');

      // Check for SQLite UNIQUE constraint error on content_hash.
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        // Duplicate content — skip ingestion.
        return {
          rawLogId: '',
          skipped: true,
          factsExtracted: 0,
          factIds: [],
        };
      }
      // Re-throw other errors (e.g., real DB issues).
      throw err;
    }

    return {
      rawLogId,
      factsExtracted: 0,
      factIds: [],
    };
  }

  /**
   * Ingest a curated memory fact (T-118).
   * Facts are stored as single chunks (no splitting) with embed_status='pending'.
   */
  async ingestMemoryFact(input: IngestMemoryFactInput): Promise<{ factId: string }> {
    const factId = crypto.randomUUID();
    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;

    const stmt = this.#db.prepare(`
      INSERT INTO memory_facts
        (id, user_id, content, source_session_id, tags, created_at, embed_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.bind([
      factId,
      this.#userId,
      input.content,
      input.sourceSessionId,
      tagsJson,
      new Date().toISOString(),
      'pending',
    ]);
    stmt.step();
    stmt.finalize();

    return { factId };
  }

  /**
   * Hybrid search over raw_log (Layer 1 retrieval).
   * See raw-log-search.ts for the full pipeline description.
   */
  async searchRawLog(query: string, limit = 10): Promise<readonly RawLogSearchResult[]> {
    // T-103/T-115: Pass in-memory embedding cache to searchRawLog (eliminates ~3,700ms SQLite load per query)
    // T-115: If cache is incomplete (capped due to MAX_CACHE_ENTRIES), fall back to SQLite load
    const totalVecRows = this.#db.selectValue('SELECT COUNT(*) FROM vec_raw_log') as number;
    const cacheComplete = this.#rawLogEmbeddingCache.length >= totalVecRows;

    return searchRawLog(
      this.#db,
      this.#userId,
      query,
      limit,
      cacheComplete ? this.#rawLogEmbeddingCache : undefined
    );
  }

  /**
   * Store a domain Fact into memory_facts (Layer 2).
   * Returns the UUID of the inserted fact.
   * Accepts an optional `context` field (stored in content for extra context).
   */
  async store(fact: Fact & { context?: string }): Promise<string> {
    const factId = (fact as { id?: string }).id ?? crypto.randomUUID();
    const baseContent = `${fact.subject} ${fact.predicate} ${fact.object}`;
    const content = fact.context ? `${baseContent} — ${fact.context}` : baseContent;

    const stmt = this.#db.prepare(`
      INSERT OR REPLACE INTO memory_facts
        (id, user_id, content, subject, predicate, object, confidence, decay_rate,
         source_session_id, source_session_label, tags, created_at, embed_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.bind([
      factId,
      this.#userId,
      content,
      fact.subject,
      fact.predicate,
      fact.object,
      fact.confidence,
      fact.decayRate,
      fact.sourceSessionId,
      fact.sourceSessionLabel ?? null,
      null, // tags
      fact.timestamp.toISOString(),
      'pending',
    ]);
    stmt.step();
    stmt.finalize();

    return factId;
  }

  /**
   * Soft-delete a memory fact by id (sets deleted_at timestamp).
   * Soft-deleted facts are excluded from search results.
   */
  async delete(factId: string): Promise<void> {
    const stmt = this.#db.prepare(`
      UPDATE memory_facts SET deleted_at = ? WHERE id = ? AND user_id = ?
    `);
    stmt.bind([new Date().toISOString(), factId, this.#userId]);
    stmt.step();
    stmt.finalize();
  }

  /**
   * Search memory_facts using keyword (LIKE) matching on content (Layer 2).
   * Returns SearchResult[] with full Fact objects reconstructed from stored data.
   *
   * Note: T-119 will add vector search for memory_facts. For now, LIKE search
   * is sufficient for tests and basic use.
   */
  async search(query: string, limit = 10): Promise<readonly SearchResult[]> {
    const likePattern = `%${query}%`;

    const stmt = this.#db.prepare(`
      SELECT id, content, subject, predicate, object, confidence, decay_rate,
             source_session_id, source_session_label, created_at
      FROM memory_facts
      WHERE user_id = ? AND content LIKE ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `);
    stmt.bind([this.#userId, likePattern, limit]);

    type MemFactRow = {
      id: string;
      content: string;
      subject: string | null;
      predicate: string | null;
      object: string | null;
      confidence: number | null;
      decay_rate: string | null;
      source_session_id: string;
      source_session_label: string | null;
      created_at: string;
    };

    const rows: MemFactRow[] = [];
    while (stmt.step()) {
      rows.push(stmt.get({}) as MemFactRow);
    }
    stmt.finalize();

    return rows.map((row) => {
      const fact: Fact = {
        id: row.id,
        subject: row.subject ?? row.content,
        predicate: row.predicate ?? 'contains',
        object: row.object ?? '',
        confidence: row.confidence ?? 0.9,
        decayRate: (row.decay_rate ?? 'slow') as Fact['decayRate'],
        timestamp: new Date(row.created_at),
        sourceSessionId: row.source_session_id,
        ...(row.source_session_label !== null
          ? { sourceSessionLabel: row.source_session_label }
          : {}),
      };
      const ageInDays =
        (Date.now() - fact.timestamp.getTime()) / (1_000 * 60 * 60 * 24);
      return { fact, score: 1.0, ageInDays };
    });
  }

  /**
   * Export all data for a user (for plumb export command).
   * Returns raw database rows (no vector data).
   */
  exportAll(userId: string): ExportData {
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
        embed_model AS embedModel
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

    return { rawLog };
  }

  /**
   * Start background backlog processor drain loop (T-095).
   * Launches continuous async loop for embed backlog.
   */
  startBacklogProcessor(): void {
    // Start embed drain loop
    if (this.#embedDrainPromise === null) {
      this.#embedDrainStopped = false;
      this.#embedDrainPromise = this.#embedDrainLoop();
    }

    // FIX 4: Health check - detect runaway loop that isn't processing or stopping
    if (this.#healthCheckInterval === null) {
      this.#healthCheckInterval = setInterval(() => {
        const idleTime = Date.now() - this.#lastActivityTimestamp;
        const MAX_IDLE_TIME = 300000; // 5 minutes of no activity

        // If loop is running but idle for too long, force stop
        if (idleTime > MAX_IDLE_TIME && !this.#embedDrainStopped) {
          console.warn(`[plumb] Drain loop idle for ${Math.round(idleTime/1000)}s, forcing stop`);
          void this.stopBacklogProcessor();
        }
      }, 60000); // Check every minute
    }
  }

  /**
   * Stop background backlog processor drain loop (T-095).
   * Signals loop to stop and awaits in-flight work.
   */
  async stopBacklogProcessor(): Promise<void> {
    // FIX 4: Clear health check interval
    if (this.#healthCheckInterval !== null) {
      clearInterval(this.#healthCheckInterval);
      this.#healthCheckInterval = null;
    }

    // Signal loop to stop
    this.#embedDrainStopped = true;

    // Await drain loop Promise (waits for in-flight work to complete)
    if (this.#embedDrainPromise !== null) {
      await this.#embedDrainPromise;
      this.#embedDrainPromise = null;
    }
  }

  /**
   * Continuous drain loop for embed backlog (T-095).
   * Runs as fast as the Worker thread allows, with no artificial throttling.
   * Only sleeps when the queue is empty.
   */
  async #embedDrainLoop(): Promise<void> {
    // FIX 2: Safety counter to detect infinite loops
    let consecutiveEmptyBatches = 0;
    const MAX_EMPTY_BATCHES = 1000; // Safety limit: stop after many empty iterations

    while (!this.#embedDrainStopped) {
      const processed = await this.#processEmbedBatch();

      if (processed === 0) {
        consecutiveEmptyBatches++;

        // FIX 2: Safety check - if idle too long, verify stop flag
        if (consecutiveEmptyBatches >= MAX_EMPTY_BATCHES) {
          console.warn('[plumb] Embed drain loop: hit safety limit, verifying stop flag');
          if (this.#embedDrainStopped) break;
          consecutiveEmptyBatches = 0; // Reset and continue
        }

        // Queue is empty — sleep before checking again
        await new Promise(resolve => setTimeout(resolve, this.#embedIdleMs));
      } else {
        consecutiveEmptyBatches = 0;
        // FIX 4: Update activity timestamp
        this.#lastActivityTimestamp = Date.now();
      }
      // If processed > 0: immediately loop to grab the next batch
    }
  }

  /**
   * Process one batch of embed backlog rows (T-095, T-118).
   * Uses Promise.all for parallelism across the batch (embed runs in Worker, no API limits).
   * Processes both raw_log and memory_facts rows.
   * Returns count of rows processed.
   */
  async #processEmbedBatch(): Promise<number> {
    // T-115: Heap guard — skip batch if memory pressure is high
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > LocalStore.HEAP_GUARD_THRESHOLD) {
      // Memory pressure detected — sleep and retry later
      await new Promise(resolve => setTimeout(resolve, this.#embedIdleMs));
      return 0;
    }

    // T-115: Reduced from 50 to 8 to prevent OOM crashes from tensor pile-up
    const BATCH_SIZE = 8;

    // T-108: Fetch pending child rows only (parent_id IS NOT NULL).
    // Old parent rows (parent_id IS NULL, embed_status='pending') are left as-is for fallback search.
    const rawLogStmt = this.#db.prepare(`
      SELECT id, chunk_text FROM raw_log
      WHERE user_id = ? AND embed_status = 'pending' AND parent_id IS NOT NULL
      ORDER BY rowid ASC
      LIMIT ?
    `);
    rawLogStmt.bind([this.#userId, BATCH_SIZE]);

    const pendingRows: Array<{ id: string; chunk_text: string; table: 'raw_log' | 'memory_facts' }> = [];
    while (rawLogStmt.step()) {
      const row = rawLogStmt.get({}) as { id: string; chunk_text: string };
      pendingRows.push({ ...row, table: 'raw_log' });
    }
    rawLogStmt.finalize();

    // T-118: Also fetch pending memory_facts rows
    const remainingSlots = BATCH_SIZE - pendingRows.length;
    if (remainingSlots > 0) {
      const memoryFactsStmt = this.#db.prepare(`
        SELECT id, content AS chunk_text FROM memory_facts
        WHERE user_id = ? AND embed_status = 'pending'
        ORDER BY rowid ASC
        LIMIT ?
      `);
      memoryFactsStmt.bind([this.#userId, remainingSlots]);

      while (memoryFactsStmt.step()) {
        const row = memoryFactsStmt.get({}) as { id: string; chunk_text: string };
        pendingRows.push({ ...row, table: 'memory_facts' });
      }
      memoryFactsStmt.finalize();
    }

    if (pendingRows.length === 0) return 0;

    // Process rows concurrently with Promise.all
    await Promise.all(
      pendingRows.map(async (row) => {
        try {
          const embedding = await embed(row.chunk_text);
          const embeddingJson = serializeEmbedding(embedding);
          const embedModel = 'Xenova/bge-small-en-v1.5';

          // Insert into vec_raw_log (transaction per row for isolation)
          // T-118: Both raw_log and memory_facts share the same vec_raw_log table
          this.#db.exec('BEGIN');
          const vecStmt = this.#db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
          vecStmt.bind([embeddingJson]);
          vecStmt.step();
          vecStmt.finalize();

          const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

          // Update table (raw_log or memory_facts): embed_status='done', vec_rowid, embed_model
          const tableName = row.table;
          const updateStmt = this.#db.prepare(`
            UPDATE ${tableName}
            SET embed_status = 'done', embed_error = NULL, embed_model = ?, vec_rowid = ?
            WHERE id = ?
          `);
          updateStmt.bind([embedModel, vecRowid, row.id]);
          updateStmt.step();
          updateStmt.finalize();

          this.#db.exec('COMMIT');

          // T-103/T-115: Append new embedding to in-memory cache (with eviction)
          // Note: cache is used for raw_log search; memory_facts search (T-119) will handle its own cache
          if (row.table === 'raw_log') {
            this.#pushToCache({ rowid: vecRowid, embedding });
          }
        } catch (err: unknown) {
          // Embedding failed — update embed_status='failed' with error
          const errorMsg = err instanceof Error ? err.message : String(err);
          const tableName = row.table;
          const updateStmt = this.#db.prepare(`
            UPDATE ${tableName}
            SET embed_status = 'failed', embed_error = ?
            WHERE id = ?
          `);
          updateStmt.bind([errorMsg, row.id]);
          updateStmt.step();
          updateStmt.finalize();
        }
      })
    );

    // FIX 3: Periodic WAL checkpoint to prevent unbounded growth
    const now = Date.now();
    if (now - this.#lastCheckpoint > this.#checkpointIntervalMs) {
      try {
        this.#db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        this.#lastCheckpoint = now;
      } catch (e) {
        console.warn('[plumb] WAL checkpoint failed:', e);
      }
    }

    return pendingRows.length;
  }

  /** Close the database connection. Call when done (e.g. in tests). */
  close(): void {
    this.#db.close();
  }
}
