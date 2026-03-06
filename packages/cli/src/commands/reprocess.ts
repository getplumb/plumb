import { LocalStore } from '@getplumb/core';
import { existsSync } from 'node:fs';
import type { MessageExchange } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';
import * as readline from 'node:readline';

export interface ReprocessOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** User ID to reprocess data for. Defaults to 'default' */
  userId?: string;
  /** Reprocess chunks ingested after this date (ISO date or relative: 7d, 30d, 90d) */
  since?: string;
  /** Reprocess all chunks from a specific session_id */
  session?: string;
  /** Reprocess all chunks from a specific source label */
  source?: string;
  /** Reprocess all chunks (requires --yes) */
  all?: boolean;
  /** Also re-embed (default: re-extract only) */
  embed?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Show what would change without modifying DB */
  dryRun?: boolean;
  /** Process at most N chunks */
  limit?: number;
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
 * Parse a date string that can be:
 * - ISO date (2026-01-15)
 * - Relative shortcut (7d, 30d, 90d)
 */
function parseSinceDate(since: string): Date {
  // Try relative format first (e.g., 7d, 30d, 90d)
  const relativeMatch = since.match(/^(\d+)d$/);
  if (relativeMatch) {
    const days = parseInt(relativeMatch[1] ?? '0', 10);
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  // Try ISO date format
  const date = new Date(since);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${since}. Use ISO date (2026-01-15) or relative (7d, 30d, 90d)`);
  }

  return date;
}

/**
 * Prompt user for confirmation.
 */
async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Reprocess command handler.
 * Re-runs extraction (and optionally embedding) on already-processed data.
 */
export async function reprocessCommand(options: ReprocessOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';
  const isDryRun = options.dryRun ?? false;
  const skipConfirm = options.yes ?? false;
  const alsoEmbed = options.embed ?? false;
  const limit = options.limit;
  const delay = options.delay ?? DEFAULT_DELAY_MS;

  // Validate targeting flags (at least one required)
  const hasTargeting = !!(options.since || options.session || options.source || options.all);
  if (!hasTargeting) {
    console.error('Error: At least one targeting flag is required');
    console.error('');
    console.error('Targeting flags:');
    console.error('  --since <date>    Chunks ingested after this date (ISO date or relative: 7d, 30d, 90d)');
    console.error('  --session <id>    All chunks from a specific session_id');
    console.error('  --source <name>   All chunks from a specific source label (e.g., openclaw, cli-ingest)');
    console.error('  --all             All chunks (requires --yes)');
    console.error('');
    console.error('Examples:');
    console.error('  plumb reprocess --since 7d');
    console.error('  plumb reprocess --session abc123');
    console.error('  plumb reprocess --source cli-ingest --yes');
    console.error('  plumb reprocess --all --yes');
    process.exit(1);
  }

  // Validate --all requires --yes
  if (options.all && !skipConfirm && !isDryRun) {
    console.error('Error: --all requires --yes flag to prevent accidents');
    console.error('Use: plumb reprocess --all --yes');
    process.exit(1);
  }

  // Check if database exists
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('No Plumb data found. Nothing to reprocess.');
    process.exit(1);
  }

  // Open store
  const store = await LocalStore.create({ dbPath, userId });
  const db = store.db;

  // Build query for matching rows (only extract_status='done')
  const whereClauses: string[] = ['user_id = ?', 'extract_status = ?'];
  const params: any[] = [userId, 'done'];

  if (options.since) {
    const sinceDate = parseSinceDate(options.since);
    whereClauses.push('timestamp >= ?');
    params.push(sinceDate.toISOString());
  }

  if (options.session) {
    whereClauses.push('session_id = ?');
    params.push(options.session);
  }

  if (options.source) {
    whereClauses.push('source = ?');
    params.push(options.source);
  }

  const query = `
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
      vec_rowid AS vecRowid
    FROM raw_log
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY timestamp ASC
    ${limit ? `LIMIT ${limit}` : ''}
  `;

  const stmt = db.prepare(query);
  stmt.bind(params);

  const rows: Array<{
    id: string;
    userId: string;
    sessionId: string;
    sessionLabel: string | null;
    userMessage: string;
    agentResponse: string;
    timestamp: string;
    source: string;
    chunkText: string;
    vecRowid: number | null;
  }> = [];

  while (stmt.step()) {
    const row = stmt.get({}) as any;
    rows.push(row);
  }
  stmt.finalize();

  if (rows.length === 0) {
    console.log('No chunks found matching criteria.');
    store.close();
    process.exit(0);
  }

  // Count facts that will be deleted (using raw_log.id as source_chunk_id)
  let totalFactsToDelete = 0;
  if (!isDryRun) {
    for (const row of rows) {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM facts WHERE source_chunk_id = ?');
      countStmt.bind([row.id]);
      if (countStmt.step()) {
        const result = countStmt.get({}) as any;
        totalFactsToDelete += result.count;
      }
      countStmt.finalize();
    }
  }

  // Print warning and prompt for confirmation
  console.log('\x1b[1m\x1b[33mWARNING:\x1b[0m This will:');
  console.log(`  - Re-extract from ${rows.length} chunk${rows.length !== 1 ? 's' : ''}`);
  if (totalFactsToDelete > 0) {
    console.log(`  - Delete ${totalFactsToDelete} existing fact${totalFactsToDelete !== 1 ? 's' : ''}`);
  }
  if (alsoEmbed) {
    console.log(`  - Re-embed ${rows.length} chunk${rows.length !== 1 ? 's' : ''}`);
  }
  console.log('  - This cannot be undone');
  console.log();

  if (options.all) {
    console.log('\x1b[1m\x1b[31mWARNING: This will reprocess ALL chunks and replace all extracted facts.\x1b[0m');
    console.log();
  }

  if (isDryRun) {
    console.log('[DRY RUN] No changes will be made');
    console.log();
    console.log('Chunks that would be reprocessed:');
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const row = rows[i];
      if (!row) continue;
      const preview = row.chunkText.substring(0, 60).replace(/\n/g, ' ');
      console.log(`  [${i + 1}] ${row.id.substring(0, 8)} - ${preview}...`);
    }
    if (rows.length > 10) {
      console.log(`  ... and ${rows.length - 10} more`);
    }
    store.close();
    return;
  }

  // Confirm with user
  if (!skipConfirm) {
    const shouldProceed = await confirm('Continue?');
    if (!shouldProceed) {
      console.log('Aborted.');
      store.close();
      process.exit(0);
    }
  }

  console.log();
  console.log('Reprocessing chunks...');
  console.log();

  let chunksProcessed = 0;
  let factsDeleted = 0;
  let factsExtracted = 0;
  let errors = 0;

  // Dynamic import of functions
  const { extractFacts, embed } = await import('@getplumb/core');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const progress = `[${i + 1}/${rows.length}]`;
    const chunkPreview = row.id.substring(0, 8);

    try {
      // Step 1: Re-embed if --embed flag is set
      if (alsoEmbed) {
        // Delete old vec_raw_log row if it exists
        if (row.vecRowid !== null) {
          const deleteVecStmt = db.prepare('DELETE FROM vec_raw_log WHERE id = ?');
          deleteVecStmt.bind([row.vecRowid]);
          deleteVecStmt.step();
          deleteVecStmt.finalize();
        }

        // Embed the chunk
        const embedding = await embed(row.chunkText);
        const embeddingJson = serializeEmbedding(embedding);

        // Insert into vec_raw_log
        db.exec('BEGIN');
        try {
          const vecStmt = db.prepare('INSERT INTO vec_raw_log(embedding) VALUES (?)');
          vecStmt.bind([embeddingJson]);
          vecStmt.step();
          vecStmt.finalize();

          const vecRowid = db.selectValue('SELECT last_insert_rowid()') as number;

          // Update raw_log with new vec_rowid
          const updateVecStmt = db.prepare(`
            UPDATE raw_log
            SET vec_rowid = ?,
                embed_status = 'done',
                embed_error = NULL,
                embed_model = 'Xenova/bge-small-en-v1.5'
            WHERE id = ?
          `);
          updateVecStmt.bind([vecRowid, row.id]);
          updateVecStmt.step();
          updateVecStmt.finalize();

          db.exec('COMMIT');

          console.log(`${progress} Re-embedded chunk ${chunkPreview}`);
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }

      // Step 2: Delete existing facts (using raw_log.id as source_chunk_id)
      const deleteStmt = db.prepare('DELETE FROM facts WHERE source_chunk_id = ?');
      deleteStmt.bind([row.id]);
      deleteStmt.step();
      const deletedCount = db.selectValue('SELECT changes()') as number;
      deleteStmt.finalize();

      if (deletedCount > 0) {
        factsDeleted += deletedCount;
        console.log(`${progress} Deleted ${deletedCount} fact${deletedCount !== 1 ? 's' : ''} from chunk ${chunkPreview}`);
      }

      // Step 3: Reconstruct MessageExchange and re-extract
      const exchange: MessageExchange = {
        userMessage: row.userMessage,
        agentResponse: row.agentResponse,
        timestamp: new Date(row.timestamp),
        source: row.source as 'openclaw' | 'claude-code' | 'claude-desktop',
        sessionId: row.sessionId,
        ...(row.sessionLabel !== null ? { sessionLabel: row.sessionLabel } : {}),
      };

      const facts = await extractFacts(exchange, userId, store, undefined, row.id);

      factsExtracted += facts.length;
      chunksProcessed++;
      console.log(`${progress} Re-extracted chunk ${chunkPreview} -> ${facts.length} fact${facts.length !== 1 ? 's' : ''}`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors++;

      // Update extract_status to failed
      const errorStmt = db.prepare(`
        UPDATE raw_log
        SET extract_status = 'failed',
            extract_error = ?
        WHERE id = ?
      `);
      errorStmt.bind([errorMsg, row.id]);
      errorStmt.step();
      errorStmt.finalize();

      console.error(`${progress} \x1b[31mFailed\x1b[0m to reprocess chunk ${chunkPreview}: ${errorMsg}`);
    }

    // Rate limit between LLM calls
    if (i < rows.length - 1) {
      await sleep(delay);
    }
  }

  store.close();

  // Summary
  console.log();
  console.log('─'.repeat(50));
  console.log('Summary:');
  console.log(`  Chunks processed:    ${chunksProcessed}`);
  console.log(`  Facts deleted:       ${factsDeleted}`);
  console.log(`  Facts extracted:     ${factsExtracted}`);
  if (errors > 0) {
    console.log(`  Errors:              ${errors}`);
  }
  console.log();

  if (errors > 0) {
    console.log('Some chunks failed to reprocess. Run `plumb fix` to retry.');
    process.exit(1);
  }
}
