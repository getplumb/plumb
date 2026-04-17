#!/usr/bin/env node
/**
 * dream-cron.js — Entry point for the nightly wiki dream cron (T-239).
 *
 * Wraps the plumb CLI wikiDreamCommand with argument parsing.
 * Designed to be invoked directly by node or scheduled via OpenClaw cron.
 *
 * Usage:
 *   node plumb/scripts/dream-cron.js [--dry-run] [--date=YYYY-MM-DD] [--date=today]
 *
 * Verify command:
 *   node plumb/scripts/dream-cron.js --dry-run --date=today
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.some((a) => a === '--dry-run' || a === '-n');

const dateArg = args.find((a) => a.startsWith('--date='));
let date;
if (dateArg) {
  const raw = dateArg.slice('--date='.length);
  if (raw === 'today' || raw === 'now') {
    date = new Date().toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date = raw;
  } else {
    console.error(`Invalid --date value: "${raw}". Expected YYYY-MM-DD or "today".`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Locate CLI dist
// ---------------------------------------------------------------------------

// This script lives at <workspace>/plumb/scripts/dream-cron.js
// The CLI dist is at <workspace>/packages/cli/dist/
const workspaceRoot = resolve(__dirname, '..', '..');
const cliDistPath = join(workspaceRoot, 'packages', 'cli', 'dist', 'commands', 'wiki-dream.js');

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let wikiDreamCommand;
try {
  const mod = await import(cliDistPath);
  wikiDreamCommand = mod.wikiDreamCommand;
} catch (err) {
  console.error(`Error: could not load CLI dist at ${cliDistPath}`);
  console.error(`  Have you run: pnpm --filter plumb-memory build ?`);
  console.error(`  Details: ${err.message}`);
  process.exit(1);
}

console.log(`dream-cron.js: date=${date ?? 'today (default)'} dry-run=${dryRun}`);

try {
  await wikiDreamCommand({
    ...(date ? { date } : {}),
    dryRun,
  });
  process.exit(0);
} catch (err) {
  console.error(`\nFatal: dream cron failed: ${err.message}`);
  process.exit(1);
}
