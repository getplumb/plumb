import { getDefaultDbPath } from '../utils/db-path.js';
import { existsSync } from 'node:fs';
import { openDb } from '@getplumb/core';

export interface ExportOptions {
  /** Path to the database file. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Print JSON to stdout instead of writing to a directory */
  json?: boolean;
  /** User ID to export data for. Defaults to 'default' */
  userId?: string;
}

/**
 * Export command handler.
 * Exports memory_facts to JSON (raw_log layer has been removed from Plumb).
 */
export async function exportCommand(options: ExportOptions): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const userId = options.userId ?? 'default';

  // Check if database exists.
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('Run plumb from a directory with a Plumb database, or use --db to specify a custom path.');
    process.exit(1);
  }

  // Query memory_facts directly
  const db = await openDb(dbPath);
  const stmt = db.prepare(`
    SELECT
      id,
      user_id,
      content,
      source_session_id,
      source_session_label,
      tags,
      confidence,
      decay_rate,
      created_at,
      deleted_at
    FROM memory_facts
    WHERE user_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
  `);
  stmt.bind([userId]);

  const facts: any[] = [];
  while (stmt.step()) {
    facts.push(stmt.get({}));
  }
  stmt.finalize();
  db.close();

  console.log(JSON.stringify(facts, null, 2));

  if (!options.json) {
    console.error(`\n✓ Exported ${facts.length} memory fact${facts.length !== 1 ? 's' : ''}`);
  }
}
