import { LocalStore } from '@getplumb/core';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { formatFactsMarkdown, formatRawLogMarkdown } from '../formatters/markdown.js';
import { getDefaultDbPath } from '../utils/db-path.js';

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
 * Two modes:
 *   1. plumb export          → creates ./plumb-export-<timestamp>/ directory with JSON + Markdown files
 *   2. plumb export --json   → prints facts.json to stdout only (for piping)
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

  // Open LocalStore and export data.
  const store = await LocalStore.create({ dbPath, userId });
  const exportData = store.exportAll(userId);
  store.close();

  // Mode 1: --json flag → print JSON to stdout and exit.
  if (options.json) {
    console.log(JSON.stringify(exportData.facts, null, 2));
    return;
  }

  // Mode 2: default → create timestamped directory with all export files.
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  const exportDir = join(process.cwd(), `plumb-export-${timestamp}`);

  mkdirSync(exportDir, { recursive: true });

  // Write facts.json
  writeFileSync(
    join(exportDir, 'facts.json'),
    JSON.stringify(exportData.facts, null, 2),
    'utf-8',
  );

  // Write facts.md
  writeFileSync(
    join(exportDir, 'facts.md'),
    formatFactsMarkdown(exportData.facts),
    'utf-8',
  );

  // Write raw-log.json
  writeFileSync(
    join(exportDir, 'raw-log.json'),
    JSON.stringify(exportData.rawLog, null, 2),
    'utf-8',
  );

  // Write raw-log.md
  writeFileSync(
    join(exportDir, 'raw-log.md'),
    formatRawLogMarkdown(exportData.rawLog),
    'utf-8',
  );

  // Write export-summary.json
  const summary = {
    exportedAt: new Date().toISOString(),
    userId,
    factCount: exportData.facts.length,
    rawLogCount: exportData.rawLog.length,
    dbPath,
  };
  writeFileSync(
    join(exportDir, 'export-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );

  console.log(`✓ Exported ${exportData.facts.length} facts and ${exportData.rawLog.length} log entries`);
  console.log(`✓ Export written to: ${exportDir}`);
}
