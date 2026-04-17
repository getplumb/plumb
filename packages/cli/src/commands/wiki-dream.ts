/**
 * wiki-dream.ts — Nightly dream cron orchestrator (T-239: deterministic phases only).
 *
 * Phases (Haiku-only — zero Sonnet calls):
 *   1. Haiku catch-up scan — compares today's facts/chat vs wiki, enqueues missed items
 *   2. Deterministic link-graph rebuild — full DELETE + re-insert from markdown source
 *   3. Lint report — orphans, broken links, stale pages, frontmatter, dead-letter queue
 *   4. Single git commit + push
 *
 * All Sonnet content writes happen via the normal wiki-worker (picks up enqueued items).
 * This keeps dream cost low and SLO predictable.
 *
 * Per-run cost is logged to wiki_changelog and to log.md.
 * A weekly 7-day cost roll-up is appended to log.md when today is Sunday.
 *
 * Usage:
 *   plumb wiki dream [--wiki <path>] [--db <path>] [--sessions <path>]
 *                    [--wiki-db <path>] [--date <YYYY-MM-DD>] [--dry-run]
 *                    [--register-cron] [--user-id <id>]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { openDb, applyWikiSchema } from '@getplumb/core';
import { wikiDreamScanCommand } from './wiki-dream-scan.js';
import type { WikiDreamScanResult } from './wiki-dream-scan.js';
import { wikiLinkRebuildCommand } from './wiki-link-rebuild.js';
import { wikiLintCommand } from './wiki-lint.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiDreamOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to Plumb memory database. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  wikiDb?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
  /** Date string YYYY-MM-DD. Defaults to today */
  date?: string;
  /** Skip all writes/commits/API calls — dry run passthrough */
  dryRun?: boolean;
  /** Register the dream cron job with OpenClaw and exit */
  registerCron?: boolean;
  /** User ID to filter facts by. Defaults to 'default' */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/** Haiku (claude-haiku-4-5) pricing: $0.80 / MTok in, $4.00 / MTok out */
const HAIKU_COST_PER_MTok_IN = 0.80;
const HAIKU_COST_PER_MTok_OUT = 4.00;

function computeHaikuCost(tokensIn: number, tokensOut: number): number {
  return (tokensIn * HAIKU_COST_PER_MTok_IN + tokensOut * HAIKU_COST_PER_MTok_OUT) / 1_000_000;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`; // sub-millicent
  return `$${usd.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** Run a git command inside the given directory. */
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

function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return gitRun(['rev-parse', '--git-dir'], dir).ok;
}

function hasGitRemote(dir: string): boolean {
  const result = gitRun(['remote'], dir);
  return result.ok && result.stdout.trim().length > 0;
}

function gitPullLatest(wikiRoot: string): void {
  if (!isGitRepo(wikiRoot) || !hasGitRemote(wikiRoot)) return;
  console.log('Pulling latest from remote…');
  const result = gitRun(['pull', '--rebase'], wikiRoot);
  if (result.ok) {
    console.log(`  ${result.stdout || 'Already up to date.'}`);
  } else {
    console.warn(`  Warning: git pull failed (continuing): ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Git commit + push
// ---------------------------------------------------------------------------

async function gitCommitAndPush(
  wikiRoot: string,
  today: string,
  enqueuedCount: number,
  dryRun: boolean,
): Promise<void> {
  console.log('\nGit commit phase…');

  if (!isGitRepo(wikiRoot)) {
    console.log(`  Warning: ${wikiRoot} is not a git repository. Skipping commit.`);
    return;
  }

  const statusResult = gitRun(['status', '--porcelain'], wikiRoot);
  if (!statusResult.ok) {
    console.error(`  Warning: git status failed: ${statusResult.stderr}`);
    return;
  }

  if (!statusResult.stdout.trim()) {
    console.log('  Nothing to commit (working tree clean).');
    return;
  }

  const parts: string[] = ['link-graph + lint'];
  if (enqueuedCount > 0) {
    parts.push(`${enqueuedCount} catch-up item${enqueuedCount !== 1 ? 's' : ''} enqueued`);
  }
  const commitMsg = `dream: ${today} — ${parts.join(', ')}`;

  if (dryRun) {
    console.log(`  [dry-run] Would commit: "${commitMsg}"`);
    return;
  }

  const addResult = gitRun(['add', '-A'], wikiRoot);
  if (!addResult.ok) {
    console.error(`  Warning: git add failed: ${addResult.stderr}`);
    return;
  }

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

  if (hasGitRemote(wikiRoot)) {
    console.log('  Pushing to remote…');
    const pushResult = gitRun(['push'], wikiRoot);
    if (pushResult.ok) {
      console.log('  Push succeeded.');
    } else {
      console.error(`  Warning: git push failed: ${pushResult.stderr} (non-fatal)`);
    }
  } else {
    console.log('  No remote configured — skipping push.');
  }
}

// ---------------------------------------------------------------------------
// Cost logging to wiki_changelog
// ---------------------------------------------------------------------------

async function logCostToChangelog(
  wikiDbPath: string,
  today: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`\n[dry-run] Would log cost to wiki_changelog:`);
    console.log(`  tokens_in=${tokensIn}, tokens_out=${tokensOut}, cost_usd=${costUsd.toFixed(6)}`);
    return;
  }

  if (!existsSync(wikiDbPath)) return; // wiki.db not yet created

  try {
    const db = await openDb(wikiDbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      applyWikiSchema(db);

      const detail = JSON.stringify({
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: parseFloat(costUsd.toFixed(6)),
        model: 'claude-haiku-4-5-20251001',
      });

      const stmt = db.prepare(
        `INSERT INTO wiki_changelog (page_id, action, detail, source_ref, created_at)
         VALUES (NULL, 'dream_run', ?, ?, ?)`,
      );
      stmt.bind([detail, `dream:${today}`, new Date().toISOString()]);
      stmt.step();
      stmt.finalize();
    } finally {
      db.close();
    }
  } catch (err) {
    // Non-fatal: cost logging failure should never abort the cron
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: could not log cost to wiki_changelog: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// log.md: per-run entry + weekly cost roll-up
// ---------------------------------------------------------------------------

async function appendRunToLog(
  wikiRoot: string,
  today: string,
  timeStr: string,
  elapsedMs: number,
  scanResult: WikiDreamScanResult,
  costUsd: number,
  dryRun: boolean,
): Promise<void> {
  const elapsed = formatElapsed(elapsedMs);
  const costStr = formatCost(costUsd);

  const entry = [
    `\n## ${today}\n`,
    `### Dream Run (${timeStr} MT)`,
    '',
    `- Phases: catch-up scan, link-graph rebuild, lint`,
    `- Facts examined: ${scanResult.factsExamined}`,
    `- Items enqueued for worker: ${scanResult.enqueuedCount}`,
    `- Haiku usage: ${scanResult.tokensIn.toLocaleString()} in / ${scanResult.tokensOut.toLocaleString()} out`,
    `- Cost: ${costStr}`,
    `- Elapsed: ${elapsed}`,
    '',
  ].join('\n');

  await writeToLog(wikiRoot, entry, dryRun);
}

/** Append weekly 7-day cost roll-up to log.md. Only runs on Sundays. */
async function maybeAppendWeeklyRollup(
  wikiDbPath: string,
  wikiRoot: string,
  today: string,
  dryRun: boolean,
): Promise<void> {
  // Only compute roll-up on Sundays (day 0)
  const dayOfWeek = new Date(today + 'T12:00:00').getDay();
  if (dayOfWeek !== 0) return;

  if (!existsSync(wikiDbPath)) return;

  try {
    const db = await openDb(wikiDbPath);
    let rows: Array<{ detail: string; created_at: string }> = [];
    try {
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

      const stmt = db.prepare(
        `SELECT detail, created_at FROM wiki_changelog
         WHERE action = 'dream_run' AND created_at >= ?
         ORDER BY created_at ASC`,
      );
      stmt.bind([cutoff + 'T00:00:00.000Z']);
      while (stmt.step()) {
        rows.push(stmt.get({}) as { detail: string; created_at: string });
      }
      stmt.finalize();
    } finally {
      db.close();
    }

    if (rows.length === 0) return;

    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;

    for (const row of rows) {
      try {
        const d = JSON.parse(row.detail) as {
          tokens_in?: number;
          tokens_out?: number;
          cost_usd?: number;
        };
        totalIn += d.tokens_in ?? 0;
        totalOut += d.tokens_out ?? 0;
        totalCost += d.cost_usd ?? 0;
      } catch {
        // skip malformed rows
      }
    }

    const rollup = [
      `\n## ${today}\n`,
      `### Weekly Cost Roll-Up (last 7 days, ${rows.length} runs)`,
      '',
      `| Metric | Value |`,
      `| --- | --- |`,
      `| Total tokens in | ${totalIn.toLocaleString()} |`,
      `| Total tokens out | ${totalOut.toLocaleString()} |`,
      `| Total cost | ${formatCost(totalCost)} |`,
      `| Avg cost/run | ${formatCost(totalCost / rows.length)} |`,
      '',
    ].join('\n');

    await writeToLog(wikiRoot, rollup, dryRun);
    if (dryRun) {
      console.log('[dry-run] Would append weekly cost roll-up to log.md');
    } else {
      console.log('Weekly cost roll-up appended to log.md.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: could not compute weekly roll-up: ${msg}`);
  }
}

/** Insert an entry after the '---' separator in log.md (newest-first). */
async function writeToLog(wikiRoot: string, entry: string, dryRun: boolean): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');

  if (dryRun) {
    console.log('\n[dry-run] Would append to log.md:');
    console.log(entry);
    return;
  }

  if (!existsSync(logPath)) {
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

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
  schedule: { kind: string; expr: string; tz: string };
  sessionTarget: string;
  wakeMode: string;
  payload: { kind: string; message: string; timeoutSeconds: number; model: string };
  delivery: { mode: string };
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

async function registerDreamCron(): Promise<void> {
  const cronPath = join(homedir(), '.openclaw', 'cron', 'jobs.json');

  if (!existsSync(cronPath)) {
    console.error(`Error: OpenClaw cron file not found at ${cronPath}`);
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

  const nextRun2AM = (() => {
    const d = new Date();
    d.setUTCHours(9, 0, 0, 0); // ~2 AM MDT (UTC-7)
    if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  })();

  const newJob: CronJob = {
    id: CRON_JOB_ID,
    agentId: 'main',
    name: 'Plumb Wiki Dream (nightly)',
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'America/Denver' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message:
        'Run the Plumb wiki dream cron: execute `plumb wiki dream` via shell and report results.\n\n' +
        'Run: `export PATH="$PATH:/home/openclaw-host/.npm-global/bin" && plumb wiki dream`\n\n' +
        'Wait for it to finish (it may take several minutes). Report success or failure.',
      timeoutSeconds: 900, // narrowed: catch-up + link-rebuild + lint << 15 min
      model: 'anthropic/claude-haiku-4-5',
    },
    delivery: { mode: 'none' },
    state: {
      nextRunAtMs: nextRun2AM,
      lastRunAtMs: null,
      lastRunStatus: null,
      consecutiveErrors: 0,
    },
  };

  const existingIdx = cronFile.jobs.findIndex((j) => j.id === CRON_JOB_ID);
  if (existingIdx !== -1) {
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

export async function wikiDreamCommand(options: WikiDreamOptions = {}): Promise<void> {
  if (options.registerCron) {
    await registerDreamCron();
    return;
  }

  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const wikiDbPath = options.wikiDb ?? join(homedir(), '.plumb', 'wiki.db');
  const dryRun = options.dryRun ?? false;
  const startMs = Date.now();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        Plumb Wiki Dream — Deterministic Nightly Cron     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  date:    ${today}`);
  console.log(`  wiki:    ${wikiRoot}`);
  console.log(`  wiki.db: ${wikiDbPath}`);
  console.log('  phases:  catch-up(Haiku) → link-rebuild → lint → commit');
  if (dryRun) console.log('  [dry-run mode — no writes, no commits, no API calls]');
  console.log('');

  // Pull latest from GitHub before any writes
  if (!dryRun) gitPullLatest(wikiRoot);

  // --- Phase 1: Haiku catch-up scan ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 1 of 3: Haiku catch-up scan');
  console.log('─'.repeat(60));

  let scanResult: WikiDreamScanResult = {
    factsExamined: 0,
    enqueuedCount: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  try {
    scanResult = await wikiDreamScanCommand({
      ...(options.db !== undefined ? { db: options.db } : {}),
      wiki: wikiRoot,
      ...(options.sessions !== undefined ? { sessions: options.sessions } : {}),
      date: today,
      ...(options.userId !== undefined ? { userId: options.userId } : {}),
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: catch-up scan failed: ${msg}`);
    console.error('  (continuing with remaining phases)');
  }

  const costUsd = computeHaikuCost(scanResult.tokensIn, scanResult.tokensOut);

  // --- Phase 2: Link-graph rebuild ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 2 of 3: Deterministic link-graph rebuild');
  console.log('─'.repeat(60));

  try {
    await wikiLinkRebuildCommand({
      wiki: wikiRoot,
      db: wikiDbPath,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: link-graph rebuild failed: ${msg}`);
    console.error('  (continuing with lint phase)');
  }

  // --- Phase 3: Lint report ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 3 of 3: Wiki lint');
  console.log('─'.repeat(60));

  try {
    await wikiLintCommand({
      wiki: wikiRoot,
      ...(options.sessions !== undefined ? { sessions: options.sessions } : {}),
      date: today,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: lint failed: ${msg}`);
    console.error('  (continuing with commit phase)');
  }

  const elapsedMs = Date.now() - startMs;
  const timeStr = nowHHMM();

  // --- Log cost to wiki_changelog ---
  await logCostToChangelog(wikiDbPath, today, scanResult.tokensIn, scanResult.tokensOut, costUsd, dryRun);

  // --- Append run summary + cost to log.md ---
  console.log('\nAppending run summary to log.md…');
  await appendRunToLog(wikiRoot, today, timeStr, elapsedMs, scanResult, costUsd, dryRun);

  // --- Weekly cost roll-up (Sundays only) ---
  await maybeAppendWeeklyRollup(wikiDbPath, wikiRoot, today, dryRun);

  // --- Git commit + push ---
  await gitCommitAndPush(wikiRoot, today, scanResult.enqueuedCount, dryRun);

  // --- Final summary ---
  console.log('\n' + '═'.repeat(60));
  console.log('Dream complete.');
  console.log(`  Facts examined:  ${scanResult.factsExamined}`);
  console.log(`  Items enqueued:  ${scanResult.enqueuedCount}`);
  console.log(`  Haiku cost:      ${formatCost(costUsd)} (${scanResult.tokensIn}in / ${scanResult.tokensOut}out)`);
  console.log(`  Elapsed:         ${formatElapsed(elapsedMs)}`);
  console.log('═'.repeat(60));
}
