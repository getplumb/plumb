import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
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

export interface LocalStoreOptions {
  /** Absolute path to the SQLite database file. Defaults to ~/.plumb/memory.db */
  dbPath?: string;
  /** User ID for scoping all data. Defaults to 'default' (single-user local install). */
  userId?: string;
}

export class LocalStore implements MemoryStore {
  readonly #db: Database.Database;
  readonly #userId: string;

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

    // Embed before opening the synchronous DB transaction.
    const embedding = await embed(chunkText);
    const vecBlob = Buffer.from(embedding.buffer);

    // Layer 1: write raw exchange to raw_log and store vector in vec_raw_log.
    // vec_raw_log auto-assigns its own rowid; we store it back in raw_log.vec_rowid
    // so raw-log-search can join the two tables without a separate mapping table.
    const doInsert = this.#db.transaction(() => {
      this.#db.prepare<[
        string, string, string, string | null,
        string, string, string, string, string, number
      ]>(`
        INSERT INTO raw_log
          (id, user_id, session_id, session_label,
           user_message, agent_response, timestamp, source, chunk_text, chunk_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    doInsert();

    // Layer 2: fire-and-forget fact extraction — never blocks ingest().
    extractFacts(exchange, this.#userId, this).catch((err: unknown) => {
      console.error('[plumb/local-store] Fact extraction failed:', err);
    });

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

  /** Close the database connection. Call when done (e.g. in tests). */
  close(): void {
    this.#db.close();
  }
}
