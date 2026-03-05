#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommand } from './commands/export.js';
import { statusCommand } from './commands/status.js';
import { connectCommand } from './commands/connect.js';
import { ingestCommand } from './commands/ingest.js';

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
  .action((tool) => {
    connectCommand({ tool });
  });

// Ingest command
program
  .command('ingest [file]')
  .description('Ingest text, markdown, or files into memory graph')
  .option('--text <content>', 'Ingest raw text inline')
  .option('--stdin', 'Read from stdin (for piping)')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to ingest data for (defaults to "default")')
  .action(async (file, options) => {
    await ingestCommand({
      db: options.db,
      userId: options.userId,
      text: options.text,
      stdin: options.stdin,
      file,
    });
  });

// Export command
program
  .command('export')
  .description('Export all facts and raw log to JSON + Markdown')
  .option('--json', 'Print facts.json to stdout only (for piping)')
  .option('--db <path>', 'Path to database file (defaults to ~/.plumb/memory.db)')
  .option('--user-id <id>', 'User ID to export data for (defaults to "default")')
  .action((options) => {
    exportCommand({
      db: options.db,
      json: options.json,
      userId: options.userId,
    });
  });

// Parse command-line arguments
program.parse();
