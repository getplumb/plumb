/**
 * wiki-dream.ts — Orchestrator for the nightly wiki dream cron (spec §5.2).
 *
 * Chains all phases in order:
 *   1. Scan (Haiku) — wiki-dream-scan
 *   2. Write (Sonnet) — wiki-dream-write
 *   3. Re-embed modified pages — wiki-embed
 *   4. Lint — wiki-lint
 *   5. Git commit + push inside ~/.plumb/wiki/
 *   6. Append total elapsed time + cost estimate to log.md
 *
 * After all phases: git add -A && git commit -m 'dream: YYYY-MM-DD — <summary>'
 * inside ~/.plumb/wiki/ (must be a git repo; skip gracefully if not).
 * Then pushes to remote if configured.
 *
 * Usage:
 *   plumb wiki dream [--wiki <path>] [--db <path>] [--sessions <path>]
 *                    [--date <YYYY-MM-DD>] [--dry-run] [--skip-embed]
 *                    [--register-cron] [--user-id <id>]
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { wikiDreamScanCommand } from './wiki-dream-scan.js';
import { wikiDreamWriteCommand } from './wiki-dream-write.js';
import { wikiEmbedCommand } from './wiki-embed.js';
import { wikiLintCommand } from './wiki-lint.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiDreamOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to Plumb memory database. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
  /** Date string YYYY-MM-DD. Defaults to today */
  date?: string;
  /** Skip all writes/commits/API calls — dry run passthrough */
  dryRun?: boolean;
  /** Skip the re-embed phase (useful if embeddings are up to date) */
  skipEmbed?: boolean;
  /** Register the dream cron job with OpenClaw and exit */
  registerCron?: boolean;
  /** User ID to filter facts by. Defaults to 'default' */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** Run a git command inside the given directory. Returns {stdout, stderr, status}. */
function gitRun(args: string[], cwd: string): { stdout: string; stderr: string; ok: boolean } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    ok: result.status === 0,
  };
}

/** Check if a directory is a git repository. */
function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const result = gitRun(['rev-parse', '--git-dir'], dir);
  return result.ok;
}

/** Check if a git remote is configured. */
function hasGitRemote(dir: string): boolean {
  const result = gitRun(['remote'], dir);
  return result.ok && result.stdout.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Git commit + push
// ---------------------------------------------------------------------------

interface CommitSummary {
  nCreated: number;
  nUpdated: number;
}

/**
 * Stage all changes in wikiRoot, commit, and optionally push.
 * Skips gracefully if not a git repo or nothing to commit.
 */
async function gitCommitAndPush(
  wikiRoot: string,
  today: string,
  summary: CommitSummary,
  dryRun: boolean,
): Promise<void> {
  console.log('\nGit commit phase…');

  if (!isGitRepo(wikiRoot)) {
    console.log(
      `  Warning: ${wikiRoot} is not a git repository. Skipping commit.\n` +
      `  Tip: run \`git init && git add -A && git commit -m "init"\` in ${wikiRoot} to enable git tracking.`,
    );
    return;
  }

  // Check for changes
  const statusResult = gitRun(['status', '--porcelain'], wikiRoot);
  if (!statusResult.ok) {
    console.error(`  Warning: git status failed: ${statusResult.stderr}`);
    return;
  }

  if (!statusResult.stdout.trim()) {
    console.log('  Nothing to commit (working tree clean).');
    return;
  }

  const partsArr: string[] = [];
  if (summary.nCreated > 0) {
    partsArr.push(`${summary.nCreated} page${summary.nCreated !== 1 ? 's' : ''} created`);
  }
  if (summary.nUpdated > 0) {
    partsArr.push(`${summary.nUpdated} page${summary.nUpdated !== 1 ? 's' : ''} updated`);
  }
  if (partsArr.length === 0) {
    partsArr.push('index + lint report');
  }
  const summaryStr = partsArr.join(', ');
  const commitMsg = `dream: ${today} — ${summaryStr}`;

  if (dryRun) {
    console.log(`  [dry-run] Would commit: "${commitMsg}"`);
    return;
  }

  // Stage all changes
  const addResult = gitRun(['add', '-A'], wikiRoot);
  if (!addResult.ok) {
    console.error(`  Warning: git add failed: ${addResult.stderr}`);
    return;
  }

  // Commit
  const commitResult = gitRun(['commit', '-m', commitMsg], wikiRoot);
  if (!commitResult.ok) {
    if (commitResult.stdout.includes('nothing to commit')) {
      console.log('  Nothing to commit.');
    } else {
      console.error(`  Warning: git commit failed: ${commitResult.stderr}`);
    }
    return;
  }

  console.log(`  Committed: "${commitMsg}"`);

  // Push if remote is configured
  if (hasGitRemote(wikiRoot)) {
    console.log('  Pushing to remote…');
    const pushResult = gitRun(['push'], wikiRoot);
    if (pushResult.ok) {
      console.log('  Push succeeded.');
    } else {
      console.error(`  Warning: git push failed: ${pushResult.stderr}`);
      console.error('  (continuing — push failure is non-fatal)');
    }
  } else {
    console.log('  No remote configured — skipping push.');
  }
}

// ---------------------------------------------------------------------------
// Elapsed time + cost estimate logging
// ---------------------------------------------------------------------------

/**
 * Rough cost estimate for a dream session:
 *   - Scan: ~N_facts × 0.00025¢ (Haiku input) + 0.00125¢ (Haiku output) per batch
 *   - Write: ~N_changes × 0.003¢ (Sonnet input) + 0.015¢ (Sonnet output) per page
 * This is a VERY rough estimate; real usage depends on token counts.
 */
function estimateCost(elapsedMs: number): string {
  // We don't have exact token counts at this layer, so just report time.
  const elapsedSec = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

async function appendElapsedToLog(
  wikiRoot: string,
  today: string,
  timeStr: string,
  elapsedMs: number,
  dryRun: boolean,
): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');
  const elapsed = estimateCost(elapsedMs);

  const entry = `\n## ${today}\n\n### Dream Orchestrator (${timeStr} MT)\n\n- Total elapsed: ${elapsed}\n- Note: see scan/write/lint sections above for detailed changes\n`;

  if (dryRun) {
    console.log('\n[dry-run] Would append to log.md:');
    console.log(entry);
    return;
  }

  if (!existsSync(logPath)) {
    // log.md will be created by the write/lint phases; if still missing, create it
    writeFileSync(
      logPath,
      '# Wiki Activity Log\n\nAppend-only. New entries go at the top (newest first). Never edit or delete past entries.\n\n---\n',
      'utf8',
    );
  }

  try {
    const existing = readFileSync(logPath, 'utf8');
    const separatorIdx = existing.indexOf('\n---\n');
    if (separatorIdx !== -1) {
      const before = existing.slice(0, separatorIdx + 5);
      const after = existing.slice(separatorIdx + 5);
      writeFileSync(logPath, before + entry + after, 'utf8');
    } else {
      await appendFile(logPath, entry, 'utf8');
    }
  } catch {
    await appendFile(logPath, entry, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// OpenClaw cron registration
// ---------------------------------------------------------------------------

const CRON_JOB_ID = 'plumb-wiki-dream-nightly';

interface CronJob {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: {
    kind: string;
    expr: string;
    tz: string;
  };
  sessionTarget: string;
  wakeMode: string;
  payload: {
    kind: string;
    message: string;
    timeoutSeconds: number;
    model: string;
  };
  delivery: {
    mode: string;
  };
  state: {
    nextRunAtMs: number;
    lastRunAtMs: number | null;
    lastRunStatus: string | null;
    consecutiveErrors: number;
  };
}

interface CronJobsFile {
  version: number;
  jobs: CronJob[];
}

/**
 * Register (or update) the plumb-wiki-dream-nightly cron job in OpenClaw's jobs.json.
 * 2:00 AM MT daily, running `plumb wiki dream`.
 */
async function registerDreamCron(): Promise<void> {
  const cronPath = join(homedir(), '.openclaw', 'cron', 'jobs.json');

  if (!existsSync(cronPath)) {
    console.error(`Error: OpenClaw cron file not found at ${cronPath}`);
    console.error('Is OpenClaw installed? Expected ~/.openclaw/cron/jobs.json');
    process.exit(1);
  }

  let cronFile: CronJobsFile;
  try {
    cronFile = JSON.parse(readFileSync(cronPath, 'utf8')) as CronJobsFile;
  } catch (err) {
    console.error(`Error: Could not parse ${cronPath}: ${err}`);
    process.exit(1);
  }

  const now = Date.now();

  // Compute next 2:00 AM MT from now
  // America/Denver is UTC-7 (MST) or UTC-6 (MDT); cron handles DST automatically
  const nextRun2AM = (() => {
    const d = new Date();
    // Approximate: 2:00 AM America/Denver is 8:00 AM or 9:00 AM UTC
    // Let the cron scheduler handle precise timing; we just set a reasonable nextRunAtMs
    d.setUTCHours(9, 0, 0, 0); // ~2 AM MDT (UTC-7)
    if (d.getTime() <= now) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.getTime();
  })();

  const newJob: CronJob = {
    id: CRON_JOB_ID,
    agentId: 'main',
    name: 'Plumb Wiki Dream (nightly)',
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: {
      kind: 'cron',
      expr: '0 2 * * *',
      tz: 'America/Denver',
    },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message:
        'Run the Plumb wiki dream cron: execute `plumb wiki dream` via shell and report results.\n\n' +
        'Run: `export PATH="$PATH:/home/openclaw-host/.npm-global/bin" && plumb wiki dream`\n\n' +
        'Wait for it to finish (it may take several minutes). Report success or failure.',
      timeoutSeconds: 1800,
      model: 'anthropic/claude-haiku-4-5',
    },
    delivery: {
      mode: 'none',
    },
    state: {
      nextRunAtMs: nextRun2AM,
      lastRunAtMs: null,
      lastRunStatus: null,
      consecutiveErrors: 0,
    },
  };

  // Check if already registered
  const existingIdx = cronFile.jobs.findIndex((j) => j.id === CRON_JOB_ID);
  if (existingIdx !== -1) {
    // Update existing
    cronFile.jobs[existingIdx] = { ...newJob, createdAtMs: cronFile.jobs[existingIdx]!.createdAtMs };
    console.log(`Updated existing cron job "${CRON_JOB_ID}" in ${cronPath}`);
  } else {
    cronFile.jobs.push(newJob);
    console.log(`Registered new cron job "${CRON_JOB_ID}" in ${cronPath}`);
  }

  try {
    writeFileSync(cronPath, JSON.stringify(cronFile, null, 2), 'utf8');
    console.log(`  Schedule: 0 2 * * * (2:00 AM MT daily)`);
    console.log(`  Command:  plumb wiki dream`);
    console.log(`  Agent:    main (isolated session)`);
  } catch (err) {
    console.error(`Error writing ${cronPath}: ${err}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all wiki dream phases in order.
 * Returns a summary of created/updated pages for the commit message.
 */
async function runAllPhases(
  options: WikiDreamOptions,
  today: string,
): Promise<CommitSummary> {
  const {
    wiki: wikiRoot = join(homedir(), '.plumb', 'wiki'),
    db,
    sessions,
    dryRun = false,
    skipEmbed = false,
    userId,
  } = options;

  const changesetPath = `/tmp/wiki-dream-changeset-${today}.json`;

  // --- Phase 1: Scan (Haiku) ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 1 of 4: Dream scan (Haiku)');
  console.log('─'.repeat(60));
  await wikiDreamScanCommand({
    ...(db !== undefined ? { db } : {}),
    wiki: wikiRoot,
    ...(sessions !== undefined ? { sessions } : {}),
    out: changesetPath,
    date: today,
    ...(userId !== undefined ? { userId } : {}),
    dryRun,
  });

  // --- Phase 2: Write (Sonnet) ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 2 of 4: Dream write (Sonnet)');
  console.log('─'.repeat(60));
  await wikiDreamWriteCommand({
    changeset: changesetPath,
    wiki: wikiRoot,
    date: today,
    dryRun,
  });

  // Read changeset to determine commit summary
  let nCreated = 0;
  let nUpdated = 0;
  try {
    if (existsSync(changesetPath)) {
      const cs = JSON.parse(readFileSync(changesetPath, 'utf8')) as {
        entities_to_create?: unknown[];
        pages_to_update?: unknown[];
      };
      nCreated = Array.isArray(cs.entities_to_create) ? cs.entities_to_create.length : 0;
      nUpdated = Array.isArray(cs.pages_to_update) ? cs.pages_to_update.length : 0;
    }
  } catch {
    // Non-fatal; summary will just say "index + lint report"
  }

  // --- Phase 3: Re-embed modified pages ---
  if (!skipEmbed) {
    console.log('\n' + '─'.repeat(60));
    console.log('Phase 3 of 4: Re-embed wiki pages');
    console.log('─'.repeat(60));
    try {
      await wikiEmbedCommand({
        wiki: wikiRoot,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Warning: embed phase failed: ${msg}`);
      console.error('  (continuing — embed failure is non-fatal)');
    }
  } else {
    console.log('\nPhase 3 of 4: Re-embed — skipped (--skip-embed)');
  }

  // --- Phase 4: Lint ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 4 of 4: Wiki lint');
  console.log('─'.repeat(60));
  await wikiLintCommand({
    wiki: wikiRoot,
    ...(sessions !== undefined ? { sessions } : {}),
    date: today,
    dryRun,
  });

  return { nCreated, nUpdated };
}

// ---------------------------------------------------------------------------
// Exported command
// ---------------------------------------------------------------------------

export async function wikiDreamCommand(options: WikiDreamOptions = {}): Promise<void> {
  // --- Register-cron mode ---
  if (options.registerCron) {
    await registerDreamCron();
    return;
  }

  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dryRun = options.dryRun ?? false;
  const startMs = Date.now();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           Plumb Wiki Dream — Nightly Orchestrator        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  date:     ${today}`);
  console.log(`  wiki:     ${wikiRoot}`);
  if (dryRun) console.log('  [dry-run mode — no writes, no commits]');
  console.log('');

  let summary: CommitSummary = { nCreated: 0, nUpdated: 0 };

  try {
    summary = await runAllPhases(options, today);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFatal error during dream phases: ${msg}`);
    // Still attempt the log append before exiting
    const elapsedMs = Date.now() - startMs;
    const timeStr = nowHHMM();
    await appendElapsedToLog(wikiRoot, today, timeStr, elapsedMs, dryRun).catch(() => {});
    process.exit(1);
  }

  const elapsedMs = Date.now() - startMs;
  const timeStr = nowHHMM();

  // --- Git commit + push ---
  await gitCommitAndPush(wikiRoot, today, summary, dryRun);

  // --- Append total elapsed + cost estimate to log.md ---
  console.log('\nAppending elapsed time to log.md…');
  await appendElapsedToLog(wikiRoot, today, timeStr, elapsedMs, dryRun);

  // --- Final summary ---
  const elapsed = estimateCost(elapsedMs);
  console.log('\n' + '═'.repeat(60));
  console.log('Dream complete.');
  console.log(`  Pages created:  ${summary.nCreated}`);
  console.log(`  Pages updated:  ${summary.nUpdated}`);
  console.log(`  Elapsed:        ${elapsed}`);
  console.log('═'.repeat(60));
}
