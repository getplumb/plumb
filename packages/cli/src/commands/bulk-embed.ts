import { openDb, embed, serializeEmbedding } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

export interface BulkEmbedOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** User ID to process embeddings for. Defaults to 'default' */
  userId?: string;
}

/**
 * Format duration in seconds to human-readable string (e.g., "3m 12s").
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Bulk embed command handler.
 * Processes all pending embed rows serially (one at a time) with progress output.
 *
 * This is an offline maintenance tool — the gateway should be stopped before running.
 */
export async function bulkEmbedCommand(options: BulkEmbedOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';

  console.log(`[plumb bulk-embed] Opening database: ${dbPath}`);

  // Open database directly (bypassing LocalStore)
  const db = await openDb(dbPath);

  // Enable WAL mode and foreign keys
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Count pending rows (child rows only: parent_id IS NOT NULL)
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM raw_log
    WHERE user_id = ? AND embed_status = 'pending' AND parent_id IS NOT NULL
  `);
  countStmt.bind([userId]);
  countStmt.step();
  const totalPending = countStmt.get(0) as number;
  countStmt.finalize();

  if (totalPending === 0) {
    console.log('[plumb bulk-embed] No pending rows found. Backlog is empty.');
    db.close();
    process.exit(0);
  }

  console.log(`[plumb bulk-embed] Found ${totalPending} pending rows. Starting serial embedding...`);

  const HEAP_GUARD_THRESHOLD = 1_500_000_000; // 1.5GB in bytes
  const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
  const PROGRESS_INTERVAL = 100;

  let processed = 0;
  const startTime = Date.now();

  // Main loop: process rows serially until backlog is empty
  while (true) {
    // Heap guard: check memory before each row
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > HEAP_GUARD_THRESHOLD) {
      // Trigger garbage collection if available
      if (global.gc) {
        global.gc();
      }
      // Sleep 2 seconds to let GC run
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Fetch next pending row
    const stmt = db.prepare(`
      SELECT id, chunk_text FROM raw_log
      WHERE user_id = ? AND embed_status = 'pending' AND parent_id IS NOT NULL
      ORDER BY rowid ASC
      LIMIT 1
    `);
    stmt.bind([userId]);

    if (!stmt.step()) {
      stmt.finalize();
      break; // No more pending rows
    }

    const row = stmt.get({}) as { id: string; chunk_text: string };
    stmt.finalize();

    // Embed the row
    try {
      const embedding = await embed(row.chunk_text);
      const embeddingJson = serializeEmbedding(embedding);

      // Write to vec_raw_log and update raw_log (transaction per row)
      db.exec('BEGIN');

      const vecStmt = db.prepare(`INSERT INTO vec_raw_log(embedding) VALUES (?)`);
      vecStmt.bind([embeddingJson]);
      vecStmt.step();
      vecStmt.finalize();

      const vecRowid = db.selectValue('SELECT last_insert_rowid()') as number;

      // Update raw_log: embed_status='done', vec_rowid, embed_model
      const updateStmt = db.prepare(`
        UPDATE raw_log
        SET embed_status = 'done', embed_error = NULL, embed_model = ?, vec_rowid = ?
        WHERE id = ?
      `);
      updateStmt.bind([EMBED_MODEL, vecRowid, row.id]);
      updateStmt.step();
      updateStmt.finalize();

      db.exec('COMMIT');
    } catch (err: unknown) {
      // Embedding failed — update embed_status='failed' with error
      const errorMsg = err instanceof Error ? err.message : String(err);
      const updateStmt = db.prepare(`
        UPDATE raw_log
        SET embed_status = 'failed', embed_error = ?
        WHERE id = ?
      `);
      updateStmt.bind([errorMsg, row.id]);
      updateStmt.step();
      updateStmt.finalize();
    }

    processed++;

    // Progress output every 100 rows
    if (processed % PROGRESS_INTERVAL === 0 || processed === totalPending) {
      const elapsed = (Date.now() - startTime) / 1000; // seconds
      const percentage = ((processed / totalPending) * 100).toFixed(1);
      const rowsPerSec = processed / elapsed;
      const remaining = totalPending - processed;
      const etaSeconds = remaining / rowsPerSec;

      console.log(
        `[plumb bulk-embed] ${processed}/${totalPending} rows embedded (${percentage}%) — est. ${formatDuration(etaSeconds)} remaining`
      );
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`[plumb bulk-embed] Completed ${processed} rows in ${formatDuration(elapsed)}`);

  db.close();
  process.exit(0);
}
