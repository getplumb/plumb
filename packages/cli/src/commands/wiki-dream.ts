/**
 * wiki-dream.ts - Nightly dream cron orchestrator (T-239).
 *
 * Phases:
 *   1. OpenClaw GPT 5.5 catch-up scan - compares today's facts/chat vs wiki, enqueues missed items
 *   2. Deterministic link-graph rebuild - full DELETE + re-insert from markdown source
 *   3. Lint report - orphans, broken links, stale pages, frontmatter, dead-letter queue
 *   4. Surgical repair - deterministic broken-wikilink/frontmatter fixes only
 *   5. Orphan resolver - add safe backlinks for semantically connected orphan pages
 *   6. Page refactor - H2-boundary splits for oversized pages
 *   7. Single git commit + push
 *
 * Most content writes happen via the normal wiki-worker (picks up enqueued items).
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

import {
  openDb,
  applyWikiSchema,
  getWeeklyCostBySource,
  listWikiPages,
  parseFrontmatter,
  extractTitle,
  extractWikilinks,
} from '@getplumb/core';
import { wikiDreamScanCommand } from './wiki-dream-scan.js';
import type { WikiDreamScanResult } from './wiki-dream-scan.js';
import { wikiLinkRebuildCommand } from './wiki-link-rebuild.js';
import { wikiLintCommand } from './wiki-lint.js';
import { wikiSurgicalRepairCommand } from './wiki-surgical-repair.js';
import type { WikiSurgicalRepairResult } from './wiki-surgical-repair.js';
import { wikiRefactorPhase } from '@getplumb/wiki';
import type { RefactorPhaseResult } from '@getplumb/wiki';

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

// OpenClaw subscription-backed model calls do not have per-API-call cost here.
function computeModelCost(_tokensIn: number, _tokensOut: number): number {
  return 0;
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
  repairResult: WikiSurgicalRepairResult,
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
  const totalRepairs = repairResult.wikilinksRepaired + repairResult.frontmatterRepaired;
  if (totalRepairs > 0) {
    parts.push(`${totalRepairs} surgical repair${totalRepairs !== 1 ? 's' : ''}`);
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
        model: process.env['PLUMB_DREAM_MODEL'] ?? 'openai-codex/gpt-5.5',
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      });

      // Insert with dedicated cost columns (T-244) and legacy action='dream_run' for compatibility
      const stmt = db.prepare(`
        INSERT INTO wiki_changelog
          (page_id, action, detail, source_ref, source, tokens_in, tokens_out, cost_usd, created_at)
        VALUES (NULL, 'dream_run', ?, ?, 'dream', ?, ?, ?, ?)
      `);
      stmt.bind([
        detail,
        `dream:${today}`,
        tokensIn,
        tokensOut,
        parseFloat(costUsd.toFixed(8)),
        new Date().toISOString(),
      ]);
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
    `- Phases: catch-up scan, link-graph rebuild, lint, orphan resolver, refactor`,
    `- Facts examined: ${scanResult.factsExamined}`,
    `- Items enqueued for worker: ${scanResult.enqueuedCount}`,
    `- Model usage: ${scanResult.tokensIn.toLocaleString()} in / ${scanResult.tokensOut.toLocaleString()} out (OpenClaw subscription)`,
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
    let bySource: ReturnType<typeof getWeeklyCostBySource> = [];
    let lastWeekCost = 0;
    try {
      db.exec('PRAGMA foreign_keys = ON');
      applyWikiSchema(db);
      bySource = getWeeklyCostBySource(db, 7);

      // Fetch prior-week total for regression detection
      const twoWeeksAgo = new Date(today);
      twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);
      const oneWeekAgo = new Date(today);
      oneWeekAgo.setUTCDate(oneWeekAgo.getUTCDate() - 7);
      const prevStmt = db.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM wiki_changelog
         WHERE cost_usd IS NOT NULL AND created_at >= ? AND created_at < ?`,
      );
      prevStmt.bind([twoWeeksAgo.toISOString(), oneWeekAgo.toISOString()]);
      if (prevStmt.step()) {
        const row = prevStmt.get({}) as { total?: number } | null;
        lastWeekCost = (row as { total?: number } | null)?.total ?? 0;
      }
      prevStmt.finalize();
    } finally {
      db.close();
    }

    if (bySource.length === 0) return;

    const totalCost = bySource.reduce((s, r) => s + r.totalCost, 0);
    const totalIn   = bySource.reduce((s, r) => s + r.totalTokensIn, 0);
    const totalOut  = bySource.reduce((s, r) => s + r.totalTokensOut, 0);

    const SOURCE_LABELS: Record<string, string> = {
      dream: 'Dream (OpenClaw GPT 5.5 scan)',
      'worker:resolver': 'Worker resolver',
      'worker:writer': 'Worker writer',
      embed: 'Embedding (local)',
      rerank: 'Rerank (local)',
    };

    const sourceRows = bySource
      .map((r) => {
        const label = SOURCE_LABELS[r.source] ?? r.source;
        return `| ${label} | ${formatCost(r.totalCost)} | ${r.totalTokensIn.toLocaleString()} / ${r.totalTokensOut.toLocaleString()} | ${r.callCount} |`;
      })
      .join('\n');

    const lines = [
      `\n## ${today}\n`,
      `### Weekly Cost Roll-Up (last 7 days)`,
      '',
      `| Source | Cost | Tokens in / out | Calls |`,
      `| --- | --- | --- | --- |`,
      sourceRows,
      `| **Total** | **${formatCost(totalCost)}** | **${totalIn.toLocaleString()} / ${totalOut.toLocaleString()}** | |`,
      '',
    ];

    // Regression warning inline: this week > 2× last week
    if (lastWeekCost > 0 && totalCost >= lastWeekCost * 2) {
      lines.push(
        `> ⚠ **Cost regression**: this week ${formatCost(totalCost)} is ${(totalCost / lastWeekCost).toFixed(1)}× last week's ${formatCost(lastWeekCost)}. Check for runaway loops.`,
        '',
      );
      console.warn(`\n⚠ COST REGRESSION: this week ${formatCost(totalCost)} vs last week ${formatCost(lastWeekCost)}`);
    }

    await writeToLog(wikiRoot, lines.join('\n'), dryRun);
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
// Orphan resolver
// ---------------------------------------------------------------------------

interface DreamPageInfo {
  relPath: string;
  title: string;
  aliases: string[];
  body: string;
  raw: string;
  links: string[];
}

interface OrphanResolverResult {
  examined: number;
  orphans: number;
  backlinksAdded: number;
  reviewItems: number;
}

function slugifyLinkTarget(target: string): string {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function linkToken(target: string): string {
  return target.split('|')[0]?.trim() ?? target.trim();
}

function containsWikilinkTo(raw: string, title: string): boolean {
  const titleLc = title.toLowerCase();
  const slug = slugifyLinkTarget(title);
  return extractWikilinks(raw).some((target) => {
    const token = linkToken(target);
    return token.toLowerCase() === titleLc || slugifyLinkTarget(token) === slug;
  });
}

function insertBacklink(raw: string, title: string, today: string): string {
  const updated = raw.replace(/^updated:\s*.*$/m, `updated: ${today}`);
  const backlink = `- [[${title}]] — related page linked by nightly orphan resolver.`;

  if (/^## Related\s*$/m.test(updated)) {
    return updated.replace(/(^## Related\s*$)/m, `$1\n\n${backlink}`);
  }

  return `${updated.trimEnd()}\n\n## Related\n\n${backlink}\n`;
}

async function appendOrphanReviewItem(
  wikiRoot: string,
  today: string,
  page: DreamPageInfo,
  dryRun: boolean,
): Promise<void> {
  const reviewPath = join(wikiRoot, 'REVIEW.md');
  const entry = `\n## ${today} — Orphan page needs review\n\n- Page: ${page.relPath}\n- Title: ${page.title}\n- Reason: no inbound wikilinks and no resolvable outbound wikilinks to an existing content page.\n- Suggested action: link it from a relevant existing page, merge it into another page, or archive it if it is not useful.\n\n---\n`;

  if (dryRun) {
    console.log(`  [dry-run] Would append orphan review item for ${page.relPath}`);
    return;
  }

  await appendFile(reviewPath, entry, 'utf8');
}

async function resolveOrphanPages(
  wikiRoot: string,
  today: string,
  dryRun: boolean,
): Promise<OrphanResolverResult> {
  console.log('Resolving semantic orphan pages…');

  const relPaths = await listWikiPages(wikiRoot);
  const pages = new Map<string, DreamPageInfo>();
  const titleToPath = new Map<string, string>();
  const slugToPath = new Map<string, string>();

  for (const relPath of relPaths) {
    const raw = readFileSync(join(wikiRoot, relPath), 'utf8');
    let body = raw;
    let aliases: string[] = [];
    try {
      const parsed = parseFrontmatter(raw);
      body = parsed.body;
      const aliasesRaw = (parsed.frontmatter as Record<string, unknown>)['aliases'];
      aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        : [];
    } catch {
      // Keep raw body fallback so malformed pages can still be considered.
    }

    const title = extractTitle(body) ?? relPath.replace(/^.*\//, '').replace(/\.md$/, '');
    const info: DreamPageInfo = {
      relPath,
      title,
      aliases,
      body,
      raw,
      links: extractWikilinks(body),
    };
    pages.set(relPath, info);
    titleToPath.set(title.toLowerCase(), relPath);
    for (const alias of aliases) titleToPath.set(alias.toLowerCase(), relPath);
    slugToPath.set(relPath.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase(), relPath);
  }

  const resolveTarget = (target: string): string | null => {
    const token = linkToken(target);
    const direct = titleToPath.get(token.toLowerCase());
    if (direct) return direct;
    const slug = slugifyLinkTarget(token);
    return slugToPath.get(slug) ?? null;
  };

  const inbound = new Map<string, number>();
  for (const relPath of relPaths) inbound.set(relPath, 0);
  for (const [sourcePath, page] of pages.entries()) {
    for (const link of page.links) {
      const targetPath = resolveTarget(link);
      if (targetPath && targetPath !== sourcePath) {
        inbound.set(targetPath, (inbound.get(targetPath) ?? 0) + 1);
      }
    }
  }

  const orphanPaths = relPaths.filter((relPath) => (inbound.get(relPath) ?? 0) === 0);
  let backlinksAdded = 0;
  let reviewItems = 0;

  for (const orphanPath of orphanPaths) {
    const orphan = pages.get(orphanPath);
    if (!orphan) continue;

    const outboundTargets = orphan.links
      .map((link) => resolveTarget(link))
      .filter((targetPath): targetPath is string => Boolean(targetPath) && targetPath !== orphanPath);

    const uniqueTargets = [...new Set(outboundTargets)];
    if (uniqueTargets.length === 0) {
      await appendOrphanReviewItem(wikiRoot, today, orphan, dryRun);
      reviewItems++;
      continue;
    }

    const targetPath = uniqueTargets.find((path) => (inbound.get(path) ?? 0) > 0) ?? uniqueTargets[0]!;
    const target = pages.get(targetPath);
    if (!target) continue;

    if (containsWikilinkTo(target.raw, orphan.title)) continue;

    const nextRaw = insertBacklink(target.raw, orphan.title, today);
    if (dryRun) {
      console.log(`  [dry-run] Would link ${targetPath} → [[${orphan.title}]]`);
    } else {
      writeFileSync(join(wikiRoot, targetPath), nextRaw, 'utf8');
      console.log(`  Linked ${targetPath} → [[${orphan.title}]]`);
    }
    backlinksAdded++;
  }

  console.log(`  Orphans found: ${orphanPaths.length}`);
  console.log(`  Backlinks added: ${backlinksAdded}`);
  console.log(`  Review items: ${reviewItems}`);

  return {
    examined: relPaths.length,
    orphans: orphanPaths.length,
    backlinksAdded,
    reviewItems,
  };
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
        'Run: `plumb wiki dream` (ensure your npm global bin is on PATH)\n\n' +
        'Wait for it to finish (it may take several minutes). Report success or failure.',
      timeoutSeconds: 900, // narrowed: catch-up + link-rebuild + lint << 15 min
      model: 'openai-codex/gpt-5.5',
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
  console.log('  phases:  catch-up(OpenClaw GPT 5.5) -> link-rebuild -> lint -> surgical-repair -> re-lint -> orphan-resolver -> refactor(OpenClaw GPT 5.5/deterministic) -> commit');
  if (dryRun) console.log('  [dry-run mode — no writes, no commits, no API calls]');
  console.log('');

  // Pull latest from GitHub before any writes
  if (!dryRun) gitPullLatest(wikiRoot);

  // --- Phase 1: OpenClaw GPT 5.5 catch-up scan ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 1 of 7: OpenClaw GPT 5.5 catch-up scan');
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

  const costUsd = computeModelCost(scanResult.tokensIn, scanResult.tokensOut);

  // --- Phase 2: Link-graph rebuild ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 2 of 7: Deterministic link-graph rebuild');
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
  console.log('Phase 3 of 7: Wiki lint');
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
    console.error('  (continuing with surgical repair phase)');
  }

  // --- Phase 4: Surgical repair ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 4 of 7: Surgical repair');
  console.log('─'.repeat(60));

  let repairResult: WikiSurgicalRepairResult = {
    pagesExamined: 0,
    pagesTouched: 0,
    wikilinksRepaired: 0,
    frontmatterRepaired: 0,
    skippedAmbiguous: 0,
    skippedUnsafe: 0,
  };

  try {
    repairResult = await wikiSurgicalRepairCommand({
      wiki: wikiRoot,
      date: today,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: surgical repair failed: ${msg}`);
    console.error('  (continuing with re-lint phase)');
  }

  // Rebuild and re-lint after surgical repairs so the run records remaining debt.
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 4b of 7: Post-repair link-graph rebuild + lint');
  console.log('─'.repeat(60));

  try {
    await wikiLinkRebuildCommand({
      wiki: wikiRoot,
      db: wikiDbPath,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: post-repair link-graph rebuild failed: ${msg}`);
  }

  try {
    await wikiLintCommand({
      wiki: wikiRoot,
      ...(options.sessions !== undefined ? { sessions: options.sessions } : {}),
      date: today,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: post-repair lint failed: ${msg}`);
  }

  // --- Phase 5: Orphan resolver ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 5 of 7: Orphan resolver');
  console.log('─'.repeat(60));

  let orphanResult: OrphanResolverResult = {
    examined: 0,
    orphans: 0,
    backlinksAdded: 0,
    reviewItems: 0,
  };

  try {
    orphanResult = await resolveOrphanPages(wikiRoot, today, dryRun);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: orphan resolver failed: ${msg}`);
    console.error('  (continuing with refactor phase)');
  }

  // --- Phase 6: Page refactor (H2-boundary splits) ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 6 of 7: Page refactor (H2-boundary splits)');
  console.log('─'.repeat(60));

  let refactorResult: RefactorPhaseResult = {
    splits: [],
    pagesExamined: 0,
    sonnetTokensIn: 0,
    sonnetTokensOut: 0,
  };

  try {
    refactorResult = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath,
      today,
      dryRun,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Warning: refactor phase failed: ${msg}`);
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

  // --- Phase 7: Git commit + push ---
  console.log('\n' + '─'.repeat(60));
  console.log('Phase 7 of 7: Git commit phase');
  console.log('─'.repeat(60));
  await gitCommitAndPush(wikiRoot, today, scanResult.enqueuedCount, repairResult, dryRun);

  // --- Final summary ---
  console.log('\n' + '═'.repeat(60));
  console.log('Dream complete.');
  console.log(`  Facts examined:  ${scanResult.factsExamined}`);
  console.log(`  Items enqueued:  ${scanResult.enqueuedCount}`);
  console.log(`  Model usage:     ${scanResult.tokensIn}in / ${scanResult.tokensOut}out (OpenClaw subscription)`);
  if (refactorResult.splits.length > 0 || refactorResult.pagesExamined > 0) {
    console.log(`  Refactor:        ${refactorResult.splits.length} split(s) from ${refactorResult.pagesExamined} page(s) examined`);
    if (refactorResult.sonnetTokensIn > 0) {
      console.log(`  Model (refactor): ${refactorResult.sonnetTokensIn}in / ${refactorResult.sonnetTokensOut}out`);
    }
  }
  if (orphanResult.examined > 0) {
    console.log(`  Orphans:         ${orphanResult.backlinksAdded} backlink(s), ${orphanResult.reviewItems} review item(s) from ${orphanResult.orphans} orphan(s)`);
  }
  if (repairResult.pagesExamined > 0) {
    console.log(`  Surgical repair: ${repairResult.wikilinksRepaired} wikilink(s), ${repairResult.frontmatterRepaired} frontmatter repair(s), ${repairResult.skippedAmbiguous + repairResult.skippedUnsafe} skipped`);
  }
  console.log(`  Elapsed:         ${formatElapsed(elapsedMs)}`);
  console.log('═'.repeat(60));
}
