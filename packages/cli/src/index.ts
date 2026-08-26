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
import { wikiLintCommand } from './commands/wiki-lint.js';
import { wikiSurgicalRepairCommand } from './commands/wiki-surgical-repair.js';
import { wikiDreamCommand } from './commands/wiki-dream.js';
import { wikiContextualBackfillCommand } from './commands/wiki-contextual-backfill.js';
import { wikiCoverageGateCommand } from './commands/wiki-coverage-gate.js';
import { wikiIntegrityCommand } from './commands/wiki-integrity.js';
import { wikiVerifyEditCommand } from './commands/wiki-verify-edit.js';
import { wikiFanoutCommand } from './commands/wiki-fanout.js';

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
  .command('contextual-backfill')
  .description('Backfill opt-in contextual child embeddings into the wiki sidecar table')
  .option('--db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--model <model>', 'Contextual embedding model. E017 supports only Xenova/bge-small-en-v1.5')
  .option('--limit <n>', 'Maximum chunks to process this run', parseInt)
  .option('--batch-size <n>', 'Maximum chunks to process before returning interrupted=true', parseInt)
  .option('--verbose', 'Print per-chunk progress')
  .option('--json', 'Print machine-readable stats')
  .action(async (options) => {
    await wikiContextualBackfillCommand({
      db: options.db,
      model: options.model,
      limit: options.limit,
      batchSize: options.batchSize,
      verbose: options.verbose,
      json: options.json,
    });
  });

wikiCmd
  .command('coverage-gate')
  .description(
    'Deterministic check that wiki_pages matches the wiki tree on disk: missing pages, ghost rows, and the wiki_chunks/wiki_chunk_context_embeddings gap. Exits nonzero on any violation.',
  )
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--json', 'Print machine-readable report')
  .option(
    '--remediate',
    'Additive only: re-index missing and stale pages and backfill any contextual gap, then re-check. Never deletes rows.',
  )
  .option(
    '--prune',
    'Delete index rows for pages that are gone or now excluded (ghosts). Index rows only, never files. Refuses to remove more than 20% of the index without --force.',
  )
  .option('--force', 'Bypass the --prune blast-radius guardrail.')
  .action(async (options) => {
    await wikiCoverageGateCommand({
      wiki: options.wiki,
      db: options.db,
      json: options.json,
      remediate: options.remediate,
      prune: options.prune,
      force: options.force,
    });
  });

wikiCmd
  .command('integrity')
  .description(
    'Every deterministic structural fact about the wiki in one pass — link findings by class, orphans, frontmatter, index/disk agreement, chunk/contextual gap, link-graph resolved/unresolved. Writes integrity.json and exits nonzero on a threshold breach.',
  )
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--out <path>', 'Where to write integrity.json (defaults to ~/.plumb/integrity.json)')
  .option('--json', 'Print the full machine-readable report to stdout')
  .option('--no-write', 'Compute and report without writing the artifact')
  .action(async (options) => {
    await wikiIntegrityCommand({
      wiki: options.wiki,
      db: options.db,
      out: options.out,
      json: options.json,
      // commander maps `--no-write` onto `options.write === false`
      noWrite: options.write === false,
    });
  });

wikiCmd
  .command('verify-edit')
  .description(
    "Before/after structural reading, for holding an automated writer to a post-condition. With --before, reports only the link and frontmatter findings the interval INTRODUCED and exits 1 if there are any; without it, just writes a baseline. File-only and DB-free, unlike `plumb wiki integrity`.",
  )
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--before <path>', 'Previous snapshot to compare against; omit to take a baseline only')
  .option('--out <path>', 'Where to write the reading just taken, for reuse as the next baseline')
  .option('--json', 'Print the machine-readable verdict to stdout')
  .action(async (options) => {
    await wikiVerifyEditCommand({
      wiki: options.wiki,
      before: options.before,
      out: options.out,
      json: options.json,
    });
  });

wikiCmd
  .command('fanout-candidates')
  .description(
    'Which OTHER pages carry a claim a just-applied fact changes. Candidates are the inbound wikilinks of the edited pages unioned with search hits, each returned with the lines that actually name the entity. Read-only; deciding what to do with them is the caller\'s job.',
  )
  .requiredOption('--pages <paths>', 'Comma-separated wiki-relative paths the primary edit wrote')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--query <text>', 'Free text to search for, usually the queued fact; omit to skip search')
  .option('--limit <n>', 'Cap on candidates returned', '8')
  .option('--top-k <n>', 'How many search results to union in', '10')
  .option('--json', 'Print the machine-readable candidate set to stdout')
  .action(async (options) => {
    await wikiFanoutCommand({
      wiki: options.wiki,
      db: options.db,
      pages: options.pages,
      query: options.query,
      limit: options.limit,
      topK: options.topK,
      json: options.json,
    });
  });

wikiCmd
  .command('dream-scan')
  .description('Nightly Haiku catch-up scan: compare today\'s facts vs wiki, enqueue missed items')
  .option('--db <path>', 'Path to memory database (defaults to ~/.plumb/memory.db)')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--sessions <path>', 'OpenClaw sessions directory (defaults to ~/.openclaw/agents/main/sessions)')
  .option('--queue <path>', 'Path to wiki-queue.jsonl (defaults to ~/.plumb/wiki-queue.jsonl)')
  .option('--batch-size <n>', 'Facts per Haiku request (default 50)', parseInt)
  .option('--date <YYYY-MM-DD>', 'Date to scan (defaults to today)')
  .option('--user-id <id>', 'User ID to filter facts by (defaults to "default")')
  .option('--dry-run', 'Skip Haiku calls, print what would be sent')
  .action(async (options) => {
    await wikiDreamScanCommand({
      db: options.db,
      wiki: options.wiki,
      sessions: options.sessions,
      queue: options.queue,
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

wikiCmd
  .command('dream-lint')
  .description('Nightly lint phase: detect orphan pages, broken wikilinks, stale pages, and frontmatter issues')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--sessions <path>', 'OpenClaw sessions directory (defaults to ~/.openclaw/agents/main/sessions)')
  .option('--date <YYYY-MM-DD>', 'Date string (defaults to today)')
  .option('--dry-run', 'Print report but do not write to log.md')
  .action(async (options) => {
    await wikiLintCommand({
      wiki: options.wiki,
      sessions: options.sessions,
      date: options.date,
      dryRun: options.dryRun,
    });
  });

wikiCmd
  .command('dream-repair')
  .description('Deterministic surgical wiki repair: broken wikilinks and frontmatter only')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--date <YYYY-MM-DD>', 'Date string (defaults to today)')
  .option('--dry-run', 'Print repairs but do not write files')
  .action(async (options) => {
    await wikiSurgicalRepairCommand({
      wiki: options.wiki,
      date: options.date,
      dryRun: options.dryRun,
    });
  });

wikiCmd
  .command('dream')
  .description('Nightly wiki dream cron: catch-up → link-rebuild → lint → surgical repair → refactor → commit + push')
  .option('--wiki <path>', 'Wiki root directory (defaults to ~/.plumb/wiki)')
  .option('--db <path>', 'Path to memory database (defaults to ~/.plumb/memory.db)')
  .option('--wiki-db <path>', 'Path to wiki.db (defaults to ~/.plumb/wiki.db)')
  .option('--sessions <path>', 'OpenClaw sessions directory (defaults to ~/.openclaw/agents/main/sessions)')
  .option('--date <YYYY-MM-DD>', 'Date to run for (defaults to today)')
  .option('--user-id <id>', 'User ID to filter facts by (defaults to "default")')
  .option('--dry-run', 'Skip all writes, commits, and API calls')
  .option('--register-cron', 'Register the dream cron job with OpenClaw at 2:00 AM MT daily and exit')
  .action(async (options) => {
    await wikiDreamCommand({
      wiki: options.wiki,
      db: options.db,
      wikiDb: options.wikiDb,
      sessions: options.sessions,
      date: options.date,
      userId: options.userId,
      dryRun: options.dryRun,
      registerCron: options.registerCron,
    });
  });

// Parse command-line arguments
program.parse();
