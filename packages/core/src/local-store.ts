import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { applySchema } from './schema.js';
import type { MemoryStore } from './store.js';
import type { Fact, IngestResult, MessageExchange, SearchResult, StoreStatus } from './types.js';
import { extractFacts } from './extractor.js';
import { embed } from './embedder.js';
import { formatExchange } from './chunker.js';
import { searchRawLog, type RawLogSearchResult } from './raw-log-search.js';
import { searchFacts } from './fact-search.js';

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
}

export class LocalStore implements MemoryStore {
  readonly #db: Database.Database;
  readonly #userId: string;
  readonly #inFlightExtractions: Set<Promise<Fact[]>> = new Set();

  /** Expose database for plugin use (e.g., NudgeManager) */
  get db(): Database.Database {
    return this.#db;
  }

  /** Expose userId for plugin use */
  get userId(): string {
    return this.#userId;
  }

  constructor(options: LocalStoreOptions = {}) {
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'memory.db');
    this.#userId = options.userId ?? 'default';

    mkdirSync(dirname(dbPath), { recursive: true });

    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');

    // Load sqlite-vec extension — vector operations implemented in T-004.
    sqliteVec.load(this.#db);

    applySchema(this.#db);
  }

  async store(fact: Omit<Fact, 'id'>): Promise<string> {
    const id = crypto.randomUUID();

    // Embed concatenated fact text for vector search.
    const text = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.context ?? ''}`.trim();
    const embedding = await embed(text);
    const vecBlob = Buffer.from(embedding.buffer);

    const doInsert = this.#db.transaction(() => {
      this.#db.prepare<[
        string, string, string, string, string,
        number, string, string, string,
        string | null, string | null
      ]>(`
        INSERT INTO facts
          (id, user_id, subject, predicate, object,
           confidence, decay_rate, timestamp, source_session_id,
           source_session_label, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      );

      // Insert embedding into vec_facts (auto-assigned rowid).
      const vecInfo = this.#db.prepare<[Buffer]>(
        `INSERT INTO vec_facts(embedding) VALUES (?)`,
      ).run(vecBlob);

      // Back-fill vec_rowid so fact-search can join without a mapping table.
      this.#db.prepare<[number | bigint, string]>(
        `UPDATE facts SET vec_rowid = ? WHERE id = ?`,
      ).run(vecInfo.lastInsertRowid, id);
    });

    doInsert();

    return id;
  }

  async search(query: string, limit = 20): Promise<readonly SearchResult[]> {
    return searchFacts(this.#db, this.#userId, query, limit);
  }

  async delete(id: string): Promise<void> {
    // Soft delete only — never hard delete.
    this.#db.prepare<[string, string, string]>(`
      UPDATE facts SET deleted_at = ? WHERE id = ? AND user_id = ?
    `).run(new Date().toISOString(), id, this.#userId);
  }

  async status(): Promise<StoreStatus> {
    const factCount = (this.#db.prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM facts WHERE user_id = ? AND deleted_at IS NULL`
    ).get(this.#userId) as { c: number }).c;

    const rawLogCount = (this.#db.prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM raw_log WHERE user_id = ?`
    ).get(this.#userId) as { c: number }).c;

    const lastIngestionRow = this.#db.prepare<[string], { ts: string | null }>(
      `SELECT MAX(timestamp) AS ts FROM raw_log WHERE user_id = ?`
    ).get(this.#userId) as { ts: string | null };

    const pageCount = this.#db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.#db.pragma('page_size', { simple: true }) as number;

    return {
      factCount,
      rawLogCount,
      lastIngestion: lastIngestionRow.ts !== null ? new Date(lastIngestionRow.ts) : null,
      storageBytes: pageCount * pageSize,
    };
  }

  async ingest(exchange: MessageExchange): Promise<IngestResult> {
    const rawLogId = crypto.randomUUID();
    const chunkText = formatExchange(exchange);

    // Compute content hash for deduplication (scoped per userId).
    const contentHash = createHash('sha256').update(chunkText).digest('hex');

    // Embed before opening the synchronous DB transaction.
    const embedding = await embed(chunkText);
    const vecBlob = Buffer.from(embedding.buffer);

    // Layer 1: write raw exchange to raw_log and store vector in vec_raw_log.
    // vec_raw_log auto-assigns its own rowid; we store it back in raw_log.vec_rowid
    // so raw-log-search can join the two tables without a separate mapping table.
    const doInsert = this.#db.transaction(() => {
      this.#db.prepare<[
        string, string, string, string | null,
        string, string, string, string, string, number, string
      ]>(`
        INSERT INTO raw_log
          (id, user_id, session_id, session_label,
           user_message, agent_response, timestamp, source, chunk_text, chunk_index, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      );

      // Insert embedding into sqlite-vec (auto-assigned rowid).
      const vecInfo = this.#db.prepare<[Buffer]>(
        `INSERT INTO vec_raw_log(embedding) VALUES (?)`,
      ).run(vecBlob);

      // Back-fill vec_rowid so raw-log-search can join without a mapping table.
      this.#db.prepare<[number | bigint, string]>(
        `UPDATE raw_log SET vec_rowid = ? WHERE id = ?`,
      ).run(vecInfo.lastInsertRowid, rawLogId);
    });

    // Attempt insert — catch UNIQUE constraint violations (duplicate content_hash).
    try {
      doInsert();
    } catch (err: unknown) {
      // Check for SQLite UNIQUE constraint error on content_hash.
      if (err instanceof Error && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
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

    // Layer 2: fire-and-forget fact extraction — never blocks ingest().
    // Track the promise so drain() can wait for completion before close().
    const extractionPromise = extractFacts(exchange, this.#userId, this)
      .catch((err: unknown) => {
        console.error('[plumb/local-store] Fact extraction failed:', err);
        return [] as Fact[]; // Return empty array on error
      })
      .finally(() => {
        this.#inFlightExtractions.delete(extractionPromise);
      });

    this.#inFlightExtractions.add(extractionPromise);

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
   * Wait for all in-flight fact extractions to complete.
   * Call this before close() to ensure all async work is done.
   */
  async drain(): Promise<void> {
    if (this.#inFlightExtractions.size === 0) return;
    await Promise.allSettled(Array.from(this.#inFlightExtractions));
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
    // A session_id may have multiple raw_log chunks, but if ANY chunk has facts,
    // we skip the entire session. This is conservative but prevents re-extracting
    // sessions that already have partial facts.
    const orphanRows = this.#db.prepare<[string]>(`
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
    `).all(this.#userId) as Array<{
      id: string;
      userId: string;
      sessionId: string;
      sessionLabel: string | null;
      userMessage: string;
      agentResponse: string;
      timestamp: string;
      source: string;
    }>;

    const orphansFound = orphanRows.length;

    if (orphansFound === 0) {
      return { orphansFound: 0, factsCreated: 0 };
    }

    let factsCreated = 0;

    for (let i = 0; i < orphanRows.length; i++) {
      const row = orphanRows[i];
      if (!row) continue; // Type guard: skip if row is undefined (shouldn't happen)

      // Reconstruct MessageExchange from raw_log data
      const exchange: MessageExchange = {
        userMessage: row.userMessage,
        agentResponse: row.agentResponse,
        timestamp: new Date(row.timestamp),
        source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
        sessionId: row.sessionId,
        // Conditionally include sessionLabel only if it's not null (exactOptionalPropertyTypes)
        ...(row.sessionLabel !== null ? { sessionLabel: row.sessionLabel } : {}),
      };

      // Extract facts directly (bypasses ingest dedup gate)
      try {
        const facts = await extractFacts(exchange, this.#userId, this);
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
    return this.#db.prepare<[string, number]>(`
      SELECT subject, COUNT(*) as count
      FROM facts
      WHERE user_id = ? AND deleted_at IS NULL
      GROUP BY subject
      ORDER BY count DESC
      LIMIT ?
    `).all(userId, limit) as Array<{ subject: string; count: number }>;
  }

  /**
   * Export all data for a user (for plumb export command).
   * Returns raw database rows (no vector data).
   * Includes soft-deleted facts for transparency.
   */
  exportAll(userId: string): ExportData {
    // Export all non-deleted facts only (soft-deleted facts are excluded).
    const factRows = this.#db.prepare<[string]>(`
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
    `).all(userId) as Array<{
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
    }>;

    const facts: RawFact[] = factRows.map((row) => ({
      ...row,
      deleted: false, // All exported facts are non-deleted
    }));

    // Export all raw_log entries (no vector data).
    const rawLog = this.#db.prepare<[string]>(`
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
        content_hash AS contentHash
      FROM raw_log
      WHERE user_id = ?
      ORDER BY timestamp DESC
    `).all(userId) as RawLogEntry[];

    return { facts, rawLog };
  }

  /** Close the database connection. Call when done (e.g. in tests). */
  close(): void {
    this.#db.close();
  }
}
