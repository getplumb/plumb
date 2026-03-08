import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, type WasmDb } from './wasm-db.js';
import { applySchema } from './schema.js';
import type { MemoryStore } from './store.js';
import type { IngestResult, StoreStatus, IngestMemoryFactInput } from './types.js';
import { embed, warmEmbedder, warmReranker } from './embedder.js';
import { searchMemoryFacts, type MemoryFactSearchResult } from './memory-facts-search.js';
import { serializeEmbedding, deserializeEmbedding } from './vector-search.js';

export type { MemoryFactSearchResult };

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
  /**
   * Skip pre-warming the embedder/reranker pipelines at init time.
   * Use in CLI tools (e.g. seed-dev.mjs) where startup latency matters and
   * the model will load on first embed() call anyway.
   * Default: false (warm at init for consistent query latency in the gateway).
   */
  skipWarm?: boolean;
}


export class LocalStore implements MemoryStore {
  readonly #db: WasmDb;
  readonly #userId: string;

  // Backlog processor state for memory_facts embedding
  #embedDrainStopped = false;
  #embedDrainPromise: Promise<void> | null = null;
  readonly #embedIdleMs: number;

  // WAL checkpoint throttling to prevent unbounded WAL growth
  #lastCheckpoint = Date.now();
  #checkpointIntervalMs = 60000; // Checkpoint every minute

  // Health check to detect stuck drain loops
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

    // Warm embedder and reranker pipelines to eliminate cold-start latency
    // Skip if skipWarm=true (e.g. CLI seeding tools — model loads on first embed() call anyway)
    if (!options.skipWarm) {
      await warmEmbedder();
      await warmReranker();
    }

    return store;
  }

  async status(): Promise<StoreStatus> {
    // Count non-deleted memory facts
    const factCountStmt = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM memory_facts WHERE user_id = ? AND (deleted_at IS NULL)`
    );
    factCountStmt.bind([this.#userId]);
    factCountStmt.step();
    const factCount = factCountStmt.get(0) as number;
    factCountStmt.finalize();

    // Last ingestion is now the most recent memory fact
    const lastFactStmt = this.#db.prepare(
      `SELECT MAX(created_at) AS ts FROM memory_facts WHERE user_id = ?`
    );
    lastFactStmt.bind([this.#userId]);
    lastFactStmt.step();
    const lastFactTs = lastFactStmt.get(0);
    lastFactStmt.finalize();

    const pageCount = this.#db.selectValue('PRAGMA page_count') as number;
    const pageSize = this.#db.selectValue('PRAGMA page_size') as number;

    return {
      factCount,
      lastIngestion: lastFactTs !== null ? new Date(lastFactTs as string) : null,
      storageBytes: pageCount * pageSize,
    };
  }


  /**
   * Ingest a curated memory fact (T-118).
   * Facts are stored as single chunks (no splitting) with embed_status='pending'.
   * Accepts optional confidence (0–1) and decayRate ('slow'|'medium'|'fast').
   */
  async ingestMemoryFact(input: IngestMemoryFactInput): Promise<{ factId: string }> {
    const factId = crypto.randomUUID();
    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;
    const confidence = input.confidence ?? 0.95;
    const decayRate = input.decayRate ?? 'slow';
    const createdAt = input.createdAt
      ? (input.createdAt instanceof Date ? input.createdAt : new Date(input.createdAt)).toISOString()
      : new Date().toISOString();

    const stmt = this.#db.prepare(`
      INSERT INTO memory_facts
        (id, user_id, content, source_session_id, tags, confidence, decay_rate, created_at, embed_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.bind([
      factId,
      this.#userId,
      input.content,
      input.sourceSessionId,
      tagsJson,
      confidence,
      decayRate,
      createdAt,
      'pending',
    ]);
    stmt.step();
    stmt.finalize();

    return { factId };
  }

  /**
   * Hybrid search over memory_facts (Layer 2 retrieval).
   * See memory-facts-search.ts for the full pipeline description.
   */
  async searchMemoryFacts(query: string, limit = 10): Promise<readonly MemoryFactSearchResult[]> {
    return searchMemoryFacts(
      this.#db,
      this.#userId,
      query,
      limit
    );
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
   * Process one batch of memory_facts embed backlog.
   * Uses Promise.all for parallelism across the batch (embed runs in Worker, no API limits).
   * Returns count of rows processed.
   */
  async #processEmbedBatch(): Promise<number> {
    const BATCH_SIZE = 8;

    // Fetch pending memory_facts rows
    const memoryFactsStmt = this.#db.prepare(`
      SELECT id, content AS chunk_text FROM memory_facts
      WHERE user_id = ? AND embed_status = 'pending'
      ORDER BY rowid ASC
      LIMIT ?
    `);
    memoryFactsStmt.bind([this.#userId, BATCH_SIZE]);

    const pendingRows: Array<{ id: string; chunk_text: string }> = [];
    while (memoryFactsStmt.step()) {
      const row = memoryFactsStmt.get({}) as { id: string; chunk_text: string };
      pendingRows.push(row);
    }
    memoryFactsStmt.finalize();

    if (pendingRows.length === 0) return 0;

    // Process rows concurrently with Promise.all
    await Promise.all(
      pendingRows.map(async (row) => {
        try {
          const embedding = await embed(row.chunk_text);
          const embeddingJson = serializeEmbedding(embedding);
          const embedModel = 'Xenova/bge-small-en-v1.5';

          // Insert into vec_raw_log (shared table for all embeddings)
          this.#db.exec('BEGIN');
          const vecStmt = this.#db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
          vecStmt.bind([embeddingJson]);
          vecStmt.step();
          vecStmt.finalize();

          const vecRowid = this.#db.selectValue('SELECT last_insert_rowid()') as number;

          // Update memory_facts: embed_status='done', vec_rowid, embed_model
          const updateStmt = this.#db.prepare(`
            UPDATE memory_facts
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
            UPDATE memory_facts
            SET embed_status = 'failed', embed_error = ?
            WHERE id = ?
          `);
          updateStmt.bind([errorMsg, row.id]);
          updateStmt.step();
          updateStmt.finalize();
        }
      })
    );

    // Periodic WAL checkpoint to prevent unbounded growth
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
