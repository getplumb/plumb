#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommand } from './commands/export.js';
import { statusCommand } from './commands/status.js';
import { connectCommand } from './commands/connect.js';
import { setupCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { healthCommand } from './commands/health.js';
import { wikiEmbedCommand } from './commands/wiki-embed.js';
import { wikiDreamScanCommand } from './commands/wiki-dream-scan.js';
import { wikiDreamWriteCommand } from './commands/wiki-dream-write.js';

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

// Export command
program
  .command('export')
  .description('Export all memory facts to JSON')
  .option('--json', 'Suppress extra output (stdout only)')
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

// Wiki command group
const wikiCmd = program
  .command('wiki')
  .description('Wiki management commands');

wikiCmd
  .command('embed')
  .description('Embed all wiki pages into wiki.db for vector search')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--verbose', 'Print per-page progress')
  .action(async (options) => {
    await wikiEmbedCommand({
      wiki: options.wiki,
      db: options.db,
      verbose: options.verbose,
    });
  });

wikiCmd
  .command('dream-scan')
  .description('Nightly Haiku scan: read today\'s facts and chat logs, produce a wiki changeset')
  .option('--db <path>', 'Path to memory database (defaults to ~/.plumb/memory.db)')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--sessions <path>', 'OpenClaw sessions directory (defaults to ~/.openclaw/agents/main/sessions)')
  .option('--out <path>', 'Output changeset path (defaults to /tmp/wiki-dream-changeset-<date>.json)')
  .option('--batch-size <n>', 'Facts per Haiku request (default 50)', parseInt)
  .option('--date <YYYY-MM-DD>', 'Date to scan (defaults to today)')
  .option('--user-id <id>', 'User ID to filter facts by (defaults to "default")')
  .option('--dry-run', 'Skip Haiku calls, print what would be sent')
  .action(async (options) => {
    await wikiDreamScanCommand({
      db: options.db,
      wiki: options.wiki,
      sessions: options.sessions,
      out: options.out,
      batchSize: options.batchSize,
      date: options.date,
      userId: options.userId,
      dryRun: options.dryRun,
    });
  });

wikiCmd
  .command('dream-write')
  .description('Nightly Sonnet write phase: create/update wiki pages from changeset, resolve contradictions, split oversized pages')
  .option('--changeset <path>', 'Path to changeset JSON (defaults to /tmp/wiki-dream-changeset-<date>.json)')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--date <YYYY-MM-DD>', 'Date string (defaults to today)')
  .option('--concurrency <n>', 'Max concurrent Sonnet calls (default 3)', parseInt)
  .option('--dry-run', 'Skip writes and print what would happen')
  .action(async (options) => {
    await wikiDreamWriteCommand({
      changeset: options.changeset,
      wiki: options.wiki,
      date: options.date,
      concurrency: options.concurrency,
      dryRun: options.dryRun,
    });
  });

// Parse command-line arguments
program.parse();
