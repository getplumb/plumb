import { LocalStore } from '@getplumb/core';
import { existsSync } from 'node:fs';
import type { MessageExchange } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface FixOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** User ID to fix data for. Defaults to 'default' */
  userId?: string;
  /** Skip extraction phase (re-embed only) */
  embedOnly?: boolean;
  /** Skip embedding phase (re-extract only) */
  extractOnly?: boolean;
  /** Process at most N rows per phase */
  limit?: number;
  /** Show what would be processed without changes */
  dryRun?: boolean;
  /** Delay between LLM calls in ms (default 200ms) */
  delay?: number;
}

const DEFAULT_DELAY_MS = 200;

/**
 * Sleep helper for rate limiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Serialize embedding to JSON string for storage.
 */
function serializeEmbedding(embedding: Float32Array): string {
  return JSON.stringify(Array.from(embedding));
}

/**
 * Fix command handler.
 * Repairs failed or pending rows in two phases:
 *   Phase 1: Re-embed (embed_status IN ('failed', 'pending'))
 *   Phase 2: Re-extract (extract_status IN ('failed', 'pending'))
 */
export async function fixCommand(options: FixOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';
  const isDryRun = options.dryRun ?? false;
  const embedOnly = options.embedOnly ?? false;
  const extractOnly = options.extractOnly ?? false;
  const limit = options.limit;
  const delay = options.delay ?? DEFAULT_DELAY_MS;

  // Check if database exists
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('No Plumb data found. Nothing to fix.');
    process.exit(1);
  }

  // Open store
  const store = await LocalStore.create({ dbPath, userId });
  const db = store.db;

  let totalFixed = 0;

  // Phase 1: Re-embed
  if (!extractOnly) {
    console.log('Phase 1: Re-embedding failed/pending chunks');
    console.log('─────────────────────────────────────────');

    // Query for rows needing re-embedding
    const embedQuery = `
      SELECT id, chunk_text
      FROM raw_log
      WHERE user_id = ? AND embed_status IN ('failed', 'pending')
      ORDER BY timestamp ASC
      ${limit ? `LIMIT ${limit}` : ''}
    `;

    const embedStmt = db.prepare(embedQuery);
    embedStmt.bind([userId]);

    const embedRows: Array<{ id: string; chunkText: string }> = [];
    while (embedStmt.step()) {
      const row = embedStmt.get({}) as any;
      embedRows.push({ id: row.id, chunkText: row.chunk_text });
    }
    embedStmt.finalize();

    console.log(`Found ${embedRows.length} chunk${embedRows.length !== 1 ? 's' : ''} needing re-embedding`);

    if (embedRows.length > 0 && !isDryRun) {
      console.log();

      // Dynamic import of embed function
      const { embed } = await import('@getplumb/core');

      for (let i = 0; i < embedRows.length; i++) {
        const row = embedRows[i];
        if (!row) continue;

        const progress = `[${i + 1}/${embedRows.length}]`;
        const chunkPreview = row.chunkText.substring(0, 40).replace(/\n/g, ' ');

        try {
          // Embed the chunk
          const embedding = await embed(row.chunkText);
          const embeddingJson = serializeEmbedding(embedding);

          // Begin transaction
          db.exec('BEGIN');

          try {
            // Insert into vec_raw_log
            const vecStmt = db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
            vecStmt.bind([embeddingJson]);
            vecStmt.step();
            vecStmt.finalize();

            const vecRowid = db.selectValue('SELECT last_insert_rowid()') as number;

            // Update raw_log
            const updateStmt = db.prepare(`
              UPDATE raw_log
              SET vec_rowid = ?,
                  embed_status = 'done',
                  embed_error = NULL,
                  embed_model = 'Xenova/bge-small-en-v1.5'
              WHERE id = ?
            `);
            updateStmt.bind([vecRowid, row.id]);
            updateStmt.step();
            updateStmt.finalize();

            db.exec('COMMIT');

            totalFixed++;
            console.log(`${progress} Re-embedded chunk ${chunkPreview}...`);
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          // Update embed_status to failed
          const errorStmt = db.prepare(`
            UPDATE raw_log
            SET embed_status = 'failed',
                embed_error = ?
            WHERE id = ?
          `);
          errorStmt.bind([errorMsg, row.id]);
          errorStmt.step();
          errorStmt.finalize();

          console.error(`${progress} Failed to re-embed chunk ${chunkPreview}...: ${errorMsg}`);
        }
      }

      console.log();
    }

    console.log();
  }

  // Phase 2: Re-extract
  if (!embedOnly) {
    console.log('Phase 2: Re-extracting facts from failed/pending chunks');
    console.log('────────────────────────────────────────────────────');

    // Query for rows needing re-extraction
    const extractQuery = `
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
      WHERE user_id = ? AND extract_status IN ('failed', 'pending')
      ORDER BY timestamp ASC
      ${limit ? `LIMIT ${limit}` : ''}
    `;

    const extractStmt = db.prepare(extractQuery);
    extractStmt.bind([userId]);

    const extractRows: Array<{
      id: string;
      userId: string;
      sessionId: string;
      sessionLabel: string | null;
      userMessage: string;
      agentResponse: string;
      timestamp: string;
      source: string;
    }> = [];

    while (extractStmt.step()) {
      const row = extractStmt.get({}) as any;
      extractRows.push(row);
    }
    extractStmt.finalize();

    console.log(`Found ${extractRows.length} chunk${extractRows.length !== 1 ? 's' : ''} needing re-extraction`);

    if (extractRows.length > 0 && !isDryRun) {
      console.log();

      // Dynamic import of extractFacts
      const { extractFacts } = await import('@getplumb/core');

      for (let i = 0; i < extractRows.length; i++) {
        const row = extractRows[i];
        if (!row) continue;

        const progress = `[${i + 1}/${extractRows.length}]`;
        const chunkPreview = row.id.substring(0, 8);

        // Delete existing facts from previous failed attempt (if source_chunk_id is set)
        const deleteStmt = db.prepare(`DELETE FROM facts WHERE source_chunk_id = ?`);
        deleteStmt.bind([row.id]);
        deleteStmt.step();
        const deletedCount = db.selectValue('SELECT changes()') as number;
        deleteStmt.finalize();

        if (deletedCount > 0) {
          console.log(`${progress} Cleared ${deletedCount} partial fact(s) from chunk ${chunkPreview}`);
        }

        // Reconstruct MessageExchange
        const exchange: MessageExchange = {
          userMessage: row.userMessage,
          agentResponse: row.agentResponse,
          timestamp: new Date(row.timestamp),
          source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
          sessionId: row.sessionId,
          ...(row.sessionLabel !== null ? { sessionLabel: row.sessionLabel } : {}),
        };

        try {
          // Extract facts
          const facts = await extractFacts(exchange, userId, store, undefined, row.id);

          totalFixed++;
          console.log(`${progress} Re-extracted chunk ${chunkPreview} -> ${facts.length} fact${facts.length !== 1 ? 's' : ''}`);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`${progress} Failed to re-extract chunk ${chunkPreview}: ${errorMsg}`);
        }

        // Rate limit between LLM calls
        if (i < extractRows.length - 1) {
          await sleep(delay);
        }
      }

      console.log();
    }

    console.log();
  }

  store.close();

  // Summary
  if (isDryRun) {
    console.log('[DRY RUN] No changes made');
  } else {
    console.log(`Fix complete. ${totalFixed} row${totalFixed !== 1 ? 's' : ''} processed.`);
  }
}
