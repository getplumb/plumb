#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommand } from './commands/export.js';
import { statusCommand } from './commands/status.js';
import { connectCommand } from './commands/connect.js';
import { ingestCommand } from './commands/ingest.js';
import { setupCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { healthCommand } from './commands/health.js';

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
);

const program = new Command();

program
  .name('plumb')
  .description('Plumb CLI — memory export and status tools')
  .version(packageJson.version);

// Setup command
program
  .command('setup')
  .description('Interactive wizard to configure LLM provider and API key')
  .action(async () => {
    await setupCommand();
  });

// Status command
program
  .command('status')
  .description('Show memory graph health and statistics')
  .option('--json', 'Print status as JSON to stdout')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to show status for (defaults to "default")')
  .action(async (options) => {
    await statusCommand({
      db: options.db,
      json: options.json,
      userId: options.userId,
    });
  });

// Connect command
program
  .command('connect [tool]')
  .description('Interactive setup wizard for connecting MCP clients')
  .action(async (tool) => {
    await connectCommand({ tool });
  });

// Ingest command
program
  .command('ingest [file]')
  .description('Ingest text, markdown, files, or directories into memory graph')
  .option('--text <content>', 'Ingest raw text inline')
  .option('--stdin', 'Read from stdin (for piping)')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to ingest data for (defaults to "default")')
  .option('--dry-run', 'Preview what would be ingested without writing to DB')
  .option('--delay <ms>', 'Delay in ms between chunks (default: 0 for dirs, 800ms for single file)', parseInt)
  .option('--concurrency <n>', 'Concurrency level (default: 1, max: 5)', parseInt)
  .option('--glob <pattern>', 'Glob pattern for filtering files in directory mode')
  .action(async (file, options) => {
    await ingestCommand({
      db: options.db,
      userId: options.userId,
      text: options.text,
      stdin: options.stdin,
      file,
      dryRun: options.dryRun,
      delay: options.delay,
      concurrency: options.concurrency,
      glob: options.glob,
    });
  });

// Export command
program
  .command('export')
  .description('Export all raw log entries to JSON + Markdown')
  .option('--json', 'Print raw-log.json to stdout only (for piping)')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to export data for (defaults to "default")')
  .action(async (options) => {
    await exportCommand({
      db: options.db,
      json: options.json,
      userId: options.userId,
    });
  });

// Uninstall command
program
  .command('uninstall')
  .description('Remove Plumb from OpenClaw and optionally uninstall CLI')
  .action(async () => {
    await uninstallCommand();
  });

// Health command
program
  .command('health')
  .description('Check pipeline health and processing status')
  .option('--json', 'Print health data as JSON to stdout')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to check health for (defaults to "default")')
  .action(async (options) => {
    await healthCommand({
      db: options.db,
      json: options.json,
      userId: options.userId,
    });
  });

// Parse command-line arguments
program.parse();
