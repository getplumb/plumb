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
import { embed } from './embedder.js';
import { formatExchange } from './chunker.js';
import { searchRawLog, type RawLogSearchResult } from './raw-log-search.js';
import { searchFacts } from './fact-search.js';
import { ExtractionQueue, type ExtractFn } from './extraction-queue.js';
import { serializeEmbedding } from './vector-search.js';

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
}

export type { LLMConfig };

export class LocalStore implements MemoryStore {
  readonly #db: WasmDb;
  readonly #userId: string;
  readonly #llmConfig: LLMConfig | undefined;
  readonly #extractionQueue: ExtractionQueue;

  // Backlog processor state (T-087)
  #embedBacklogTimer: ReturnType<typeof setInterval> | null = null;
  #extractBacklogTimer: ReturnType<typeof setInterval> | null = null;
  #embedBacklogRunning = false;
  #extractBacklogRunning = false;
  readonly #embedBacklogIntervalMs: number;
  readonly #embedBacklogBatchSize: number;
  readonly #extractBacklogIntervalMs: number;
  readonly #extractBacklogBatchSize: number;

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
    extractionQueue: ExtractionQueue
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#llmConfig = llmConfig;
    this.#extractionQueue = extractionQueue;

    // Initialize backlog processor config from env vars (T-087)
    this.#embedBacklogIntervalMs = Number(process.env.PLUMB_EMBED_BACKLOG_INTERVAL_MS ?? 60_000);
    this.#embedBacklogBatchSize = Number(process.env.PLUMB_EMBED_BACKLOG_BATCH_SIZE ?? 5);
    this.#extractBacklogIntervalMs = Number(process.env.PLUMB_EXTRACT_BACKLOG_INTERVAL_MS ?? 120_000);
    this.#extractBacklogBatchSize = Number(process.env.PLUMB_EXTRACT_BACKLOG_BATCH_SIZE ?? 3);
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
    const store = new LocalStore(db, userId, llmConfig, extractionQueue);
    storeRef = store;

    return store;
  }

  async store(fact: Omit<Fact, 'id'>, sourceChunkId?: string): Promise<string> {
    const id = crypto.randomUUID();

    // Embed concatenated fact text for vector search.
    const text = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.context ?? ''}`.trim();
    const embedding = await embed(text);
    const embeddingJson = serializeEmbedding(embedding);

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
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    return id;
  }

  async search(query: string, limit = 20): Promise<readonly SearchResult[]> {
    return searchFacts(this.#db, this.#userId, query, limit);
  }

  async delete(id: string): Promise<void> {
    // Soft delete only — never hard delete.
    const stmt = this.#db.prepare(`
      UPDATE facts SET deleted_at = ? WHERE id = ? AND user_id = ?
    `);
    stmt.bind([new Date().toISOString(), id, this.#userId]);
    stmt.step();
    stmt.finalize();
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

    // T-079: Try to embed before opening the DB transaction.
    let embedding: Float32Array | null = null;
    let embeddingJson: string | null = null;
    let embedStatus = 'pending';
    let embedError: string | null = null;
    let embedModel: string | null = null;

    try {
      embedding = await embed(chunkText);
      embeddingJson = serializeEmbedding(embedding);
      embedStatus = 'done';
      embedModel = 'Xenova/bge-small-en-v1.5';
    } catch (err: unknown) {
      // Embedding failed — store the chunk anyway, but mark embed_status='failed'.
      embedStatus = 'failed';
      embedError = err instanceof Error ? err.message : String(err);
    }

    // T-079: Determine extract_status upfront: 'no_llm' if no config, otherwise 'pending'.
    const extractStatus = this.#llmConfig ? 'pending' : 'no_llm';

    // Attempt insert — catch UNIQUE constraint violations (duplicate content_hash).
    try {
      this.#db.exec('BEGIN');

      // Insert into raw_log with processing state columns (T-079).
      const rawLogStmt = this.#db.prepare(`
        INSERT INTO raw_log
          (id, user_id, session_id, session_label,
           user_message, agent_response, timestamp, source, chunk_text, chunk_index, content_hash,
           embed_status, embed_error, embed_model, extract_status)
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
        embedStatus,
        embedError,
        embedModel,
        extractStatus,
      ]);
      rawLogStmt.step();
      rawLogStmt.finalize();

      // Insert embedding into vec_raw_log only if embedding succeeded.
      if (embeddingJson !== null) {
        const vecStmt = this.#db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
        vecStmt.bind([embeddingJson]);
        vecStmt.step();
        vecStmt.finalize();

        const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

        // Back-fill vec_rowid so raw-log-search can join without a mapping table.
        const updateStmt = this.#db.prepare(`UPDATE raw_log SET vec_rowid = ? WHERE id = ?`);
        updateStmt.bind([vecRowid, rawLogId]);
        updateStmt.step();
        updateStmt.finalize();
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
    return searchRawLog(this.#db, this.#userId, query, limit);
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
   * Start background backlog processor loops (T-087).
   * Processes rows with embed_status='pending' and extract_status='pending'.
   * Call this after store.extractionQueue.start() in plugin-module.ts.
   */
  startBacklogProcessor(): void {
    // Start embed backlog loop
    if (this.#embedBacklogTimer === null) {
      this.#embedBacklogTimer = setInterval(() => void this.#processEmbedBacklog(), this.#embedBacklogIntervalMs);
    }

    // Start extract backlog loop (only if LLM config is present)
    if (this.#llmConfig && this.#extractBacklogTimer === null) {
      this.#extractBacklogTimer = setInterval(() => void this.#processExtractBacklog(), this.#extractBacklogIntervalMs);
    }
  }

  /**
   * Stop background backlog processor loops (T-087).
   * Waits for any in-flight batch to complete before returning.
   * Call this alongside store.extractionQueue.stop() in session_end and process exit handlers.
   */
  async stopBacklogProcessor(): Promise<void> {
    // Clear intervals
    if (this.#embedBacklogTimer !== null) {
      clearInterval(this.#embedBacklogTimer);
      this.#embedBacklogTimer = null;
    }
    if (this.#extractBacklogTimer !== null) {
      clearInterval(this.#extractBacklogTimer);
      this.#extractBacklogTimer = null;
    }

    // Wait for any in-flight batches to complete
    while (this.#embedBacklogRunning || this.#extractBacklogRunning) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Process embed backlog: fetch pending rows, call embed(), update DB.
   * T-087: Sequential processing (one row at a time) to keep CPU load predictable.
   */
  async #processEmbedBacklog(): Promise<void> {
    // Concurrent guard — skip if previous batch is still running
    if (this.#embedBacklogRunning) return;
    this.#embedBacklogRunning = true;

    try {
      // Fetch pending rows
      const stmt = this.#db.prepare(`
        SELECT id, chunk_text FROM raw_log
        WHERE user_id = ? AND embed_status = 'pending'
        ORDER BY rowid ASC
        LIMIT ?
      `);
      stmt.bind([this.#userId, this.#embedBacklogBatchSize]);

      const pendingRows: Array<{ id: string; chunk_text: string }> = [];
      while (stmt.step()) {
        pendingRows.push(stmt.get({}) as any);
      }
      stmt.finalize();

      if (pendingRows.length === 0) return;

      // Process rows sequentially
      for (const row of pendingRows) {
        try {
          const embedding = await embed(row.chunk_text);
          const embeddingJson = serializeEmbedding(embedding);
          const embedModel = 'Xenova/bge-small-en-v1.5';

          // Insert into vec_raw_log
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
      }
    } finally {
      this.#embedBacklogRunning = false;
    }
  }

  /**
   * Process extract backlog: fetch pending rows, enqueue to ExtractionQueue.
   * T-087: Smaller batch size than embed (LLM calls cost money).
   */
  async #processExtractBacklog(): Promise<void> {
    // Concurrent guard — skip if previous batch is still running
    if (this.#extractBacklogRunning) return;
    this.#extractBacklogRunning = true;

    try {
      // Fetch pending rows
      const stmt = this.#db.prepare(`
        SELECT id, user_message, agent_response, timestamp, session_id, session_label, source
        FROM raw_log
        WHERE user_id = ? AND extract_status = 'pending'
        ORDER BY rowid ASC
        LIMIT ?
      `);
      stmt.bind([this.#userId, this.#extractBacklogBatchSize]);

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

      if (pendingRows.length === 0) return;

      // Enqueue each row to ExtractionQueue (the drain loop handles the actual LLM call)
      for (const row of pendingRows) {
        const exchange: MessageExchange = {
          userMessage: row.user_message,
          agentResponse: row.agent_response,
          timestamp: new Date(row.timestamp),
          source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
          sessionId: row.session_id,
          ...(row.session_label !== null ? { sessionLabel: row.session_label } : {}),
        };

        this.#extractionQueue.enqueue(exchange, this.#userId, row.id);
      }
    } finally {
      this.#extractBacklogRunning = false;
    }
  }

  /** Close the database connection. Call when done (e.g. in tests). */
  close(): void {
    this.#db.close();
  }
}
