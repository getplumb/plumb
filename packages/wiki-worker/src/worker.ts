/**
 * worker.ts — Main wiki queue worker (T-237 pipeline).
 *
 * Replaces the old prose-rewrite worker with a resolver→patch→applier pipeline:
 *
 *   1. Scan git diff for manual deletions → create tombstones
 *   2. Read all pending queue items
 *   3. For each item, call the Haiku resolver to find affected pages
 *   4. Coalesce: group items by affected page set → one writer call per page
 *   5. Call Sonnet writer to produce structured WikiPatch objects
 *   6. Call applier → wiki.write (never fs.writeFile)
 *   7. Mark items done; on failure, increment retry_count (3x → dead letter)
 *   8. Rate limiting: honor MAX_EDITS_PER_HOUR, coalescing helps stay under it
 *
 * The worker is designed to be called from a setInterval hook in openclaw-plugin.
 * Each call to runWorkerTick() is idempotent.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import {
  readQueue,
  updateQueueItemStatus,
  defaultQueuePath,
  runWikiEmbed,
  openDb,
  isOverDailyBudget,
  nextMidnightMT,
  ensureDefaultConfig,
} from '@getplumb/core';
import type { WikiQueueItem, WasmDb } from '@getplumb/core';
import { WikiService } from '@getplumb/wiki';
import { resolveAffectedPages, recordsToPageIndex } from './resolver.js';
import type { ResolverFn, PageIndexEntry } from './resolver.js';
import { writePatch } from './writer.js';
import type { WriterFn } from './writer.js';
import { applyPatch } from './applier.js';
import { appendDeadLetter, defaultDeadLetterPath } from './dead-letter.js';
import {
  ensureTombstoneTable,
  scanGitDiffForDeletions,
  pruneExpiredTombstones,
} from './tombstone.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiWorkerOptions {
  /** Absolute path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Absolute path to wiki.db. Defaults to ~/.plumb/wiki.db */
  wikiDbPath?: string;
  /** Absolute path to wiki-queue.jsonl. Defaults to ~/.plumb/wiki-queue.jsonl */
  queuePath?: string;
  /** Absolute path to wiki-queue-dead.jsonl. Defaults to ~/.plumb/wiki-queue-dead.jsonl */
  deadLetterPath?: string;
  /** Maximum edits per hour across all pages. Defaults to 20. */
  maxEditsPerHour?: number;
  /** Maximum retries before moving to dead letter. Defaults to 3. */
  maxRetries?: number;
  /** Worker poll interval in milliseconds. Defaults to 60000 (60s). */
  intervalMs?: number;
  /** Override the resolver function (for testing). */
  resolver?: ResolverFn;
  /** Override the writer function (for testing). */
  writer?: WriterFn;
  /** Logger instance. */
  logger?: {
    info: (s: string) => void;
    warn: (s: string) => void;
    error: (s: string) => void;
    debug?: (s: string) => void;
  };
}

/** Extended queue item that tracks retry count in the JSONL file. */
export interface WorkerQueueItem extends WikiQueueItem {
  retry_count?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EDITS_PER_HOUR = 20;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Simple token bucket rate limiter (in-memory, per-worker-instance).
 * Tracks edit timestamps in a rolling window of 1 hour.
 */
class RateLimiter {
  private readonly editTimestamps: number[] = [];
  private readonly maxPerHour: number;

  constructor(maxPerHour: number) {
    this.maxPerHour = maxPerHour;
  }

  /** Return true if another edit is allowed within the current hour window. */
  canEdit(): boolean {
    this.prune();
    return this.editTimestamps.length < this.maxPerHour;
  }

  /** Record an edit. */
  recordEdit(): void {
    this.editTimestamps.push(Date.now());
  }

  /** How many edits remain in the current hour window. */
  remaining(): number {
    this.prune();
    return Math.max(0, this.maxPerHour - this.editTimestamps.length);
  }

  private prune(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    while (this.editTimestamps.length > 0 && (this.editTimestamps[0] ?? 0) < oneHourAgo) {
      this.editTimestamps.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Queue item retry management
// ---------------------------------------------------------------------------

/**
 * Increment retry_count on a queue item in the JSONL file.
 * Does not change the item status (still 'pending').
 */
async function incrementRetryCount(
  id: string,
  queuePath: string,
): Promise<number> {
  const items = (await readQueue(queuePath)) as WorkerQueueItem[];
  let newCount = 1;

  const updated = items.map((item): WorkerQueueItem => {
    if (item.id !== id) return item;
    newCount = (item.retry_count ?? 0) + 1;
    return { ...item, retry_count: newCount };
  });

  const content = updated.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await writeFile(queuePath, content, 'utf8');
  return newCount;
}

/** Read retry_count for an item (0 if not set). */
function getRetryCount(item: WorkerQueueItem): number {
  return item.retry_count ?? 0;
}

// ---------------------------------------------------------------------------
// Git commit helper
// ---------------------------------------------------------------------------

function gitCommitWiki(wikiRoot: string, message: string): void {
  try {
    execSync('git rev-parse --git-dir', { cwd: wikiRoot, stdio: 'pipe' });
  } catch {
    return;
  }
  try {
    execSync('git add -A', { cwd: wikiRoot, stdio: 'pipe' });
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: wikiRoot, stdio: 'pipe' });
  } catch {
    // Nothing to commit or commit failed — non-fatal
    return;
  }
  try {
    execSync('git push origin main', { cwd: wikiRoot, stdio: 'pipe' });
  } catch {
    // Push failed (offline, auth issue) — non-fatal, local commit is safe
  }
}

// ---------------------------------------------------------------------------
// Core processing logic
// ---------------------------------------------------------------------------

/**
 * Group pending items by their resolved affected pages.
 *
 * Returns a map: pageKey (sorted paths joined by '|') → {paths, items}.
 * Items that the resolver returns no pages for are grouped under '' for
 * no-op processing (they'll be marked done immediately).
 */
async function groupItemsByAffectedPages(
  items: WorkerQueueItem[],
  pageIndex: readonly PageIndexEntry[],
  resolver: ResolverFn,
  logger: NonNullable<WikiWorkerOptions['logger']>,
  db?: WasmDb | null,
): Promise<Map<string, { paths: string[]; items: WorkerQueueItem[] }>> {
  const groups = new Map<string, { paths: string[]; items: WorkerQueueItem[] }>();

  for (const item of items) {
    let paths: string[];
    try {
      paths = await resolver(item.fact, pageIndex, db);
    } catch (err) {
      logger.warn(`[wiki-worker] Resolver failed for item ${item.id}: ${err}`);
      paths = [];
    }

    const key = paths.slice().sort().join('|');
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { paths, items: [item] });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

export async function runWorkerTick(
  options: WikiWorkerOptions,
  rateLimiter: RateLimiter,
): Promise<void> {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const wikiDbPath = options.wikiDbPath ?? join(homedir(), '.plumb', 'wiki.db');
  const queuePath = options.queuePath ?? defaultQueuePath();
  const deadLetterPath = options.deadLetterPath ?? defaultDeadLetterPath();
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const resolver = options.resolver ?? resolveAffectedPages;
  const writer = options.writer ?? writePatch;
  const logger = options.logger ?? {
    info: (s: string) => console.log(s),
    warn: (s: string) => console.warn(s),
    error: (s: string) => console.error(s),
    debug: (s: string) => console.debug(s),
  };

  // --- Open wiki service and a direct DB handle for tombstones ---
  let wiki: WikiService;
  let db: WasmDb | null = null;
  try {
    wiki = await WikiService.create({ wikiRoot, db: { dbPath: wikiDbPath } });
  } catch (err) {
    logger.error(`[wiki-worker] Could not open WikiService: ${err}`);
    return;
  }

  try {
    // Open a separate DB handle for tombstone management (WikiService keeps its own private)
    try {
      db = await openDb(wikiDbPath);
    } catch {
      // DB not available — tombstone checks will be skipped
    }

    // --- Tombstone setup and git diff scan ---
    if (db !== null) {
      ensureTombstoneTable(db);
      pruneExpiredTombstones(db);
      const tombstoneCount = scanGitDiffForDeletions(wikiRoot, db);
      if (tombstoneCount > 0) {
        logger.info(`[wiki-worker] Recorded ${tombstoneCount} tombstone(s) from git diff`);
      }
    }

    // --- Daily budget ceiling check ---
    ensureDefaultConfig();
    if (db !== null && isOverDailyBudget(db)) {
      const resumeDate = nextMidnightMT();
      logger.warn(`[wiki-worker] throttled until ${resumeDate} 00:00 MT — daily budget reached; queue preserved`);
      return;
    }

    // --- Read pending items ---
    let allItems: WorkerQueueItem[];
    try {
      allItems = (await readQueue(queuePath)) as WorkerQueueItem[];
    } catch (err) {
      logger.warn(`[wiki-worker] Could not read queue: ${err}`);
      return;
    }

    const pending = allItems.filter((i) => i.status === 'pending');
    if (pending.length === 0) return;

    logger.info(`[wiki-worker] ${pending.length} pending item(s), ${rateLimiter.remaining()} edits/hour remaining`);

    // --- Build page index from wiki.db ---
    let pageIndex: PageIndexEntry[] = [];
    try {
      const records = await wiki.query({ status: 'active' });
      pageIndex = recordsToPageIndex(records);
    } catch (err) {
      logger.warn(`[wiki-worker] Could not build page index: ${err}`);
    }

    // --- Group items by affected pages (coalescing) ---
    const groups = await groupItemsByAffectedPages(pending, pageIndex, resolver, logger, db);

    // --- Process each group ---
    const modifiedPaths = new Set<string>();

    for (const [pageKey, group] of groups) {
      const { paths, items: groupItems } = group;

      // No affected pages — mark all done immediately
      if (paths.length === 0 || pageKey === '') {
        for (const item of groupItems) {
          await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
          logger.info(`[wiki-worker] Item ${item.id}: no affected pages, marked done`);
        }
        continue;
      }

      // Rate limit check (per page write)
      if (!rateLimiter.canEdit()) {
        logger.warn(`[wiki-worker] Rate limit reached — deferring ${groupItems.length} item(s) for ${paths.join(', ')}`);
        continue;
      }

      // --- Write patches for each affected page ---
      const allFacts = groupItems.map((i) => i.fact);
      const coalescedRef = groupItems.map((i) => i.id).join(',');
      let allSucceeded = true;
      let lastError = '';

      for (const pagePath of paths) {
        if (!rateLimiter.canEdit()) {
          logger.warn(`[wiki-worker] Rate limit reached mid-group — stopping`);
          allSucceeded = false;
          lastError = 'rate limit reached';
          break;
        }

        try {
          // Read existing content for the writer
          let existingContent = '';
          try {
            const page = await wiki.read(pagePath);
            existingContent = page.body; // writer only needs body context
          } catch {
            // New page — empty content is fine
          }

          const patch = await writer(
            {
              path: pagePath,
              existingContent,
              facts: allFacts,
              sourceRef: coalescedRef,
            },
            db,
          );

          await applyPatch(patch, wiki, {
            onWarning: (msg) => logger.warn(`[wiki-worker] ${msg}`),
          });

          rateLimiter.recordEdit();
          modifiedPaths.add(pagePath);
          logger.info(
            `[wiki-worker] Patched ${pagePath} with ${allFacts.length} coalesced fact(s)`,
          );
        } catch (err) {
          logger.warn(`[wiki-worker] Failed to patch ${pagePath}: ${err}`);
          allSucceeded = false;
          lastError = String(err);
        }
      }

      // --- Mark items done or handle retries ---
      for (const item of groupItems) {
        if (allSucceeded) {
          await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
          logger.info(`[wiki-worker] Item ${item.id} done`);
        } else {
          const newRetryCount = await incrementRetryCount(item.id, queuePath);
          if (newRetryCount >= maxRetries) {
            // Dead-letter after max retries
            await updateQueueItemStatus(
              item.id,
              'failed',
              `exhausted ${maxRetries} retries: ${lastError}`,
              queuePath,
            );
            await appendDeadLetter(item, lastError, newRetryCount, deadLetterPath);
            logger.warn(
              `[wiki-worker] Item ${item.id} dead-lettered after ${newRetryCount} retries`,
            );
          } else {
            logger.warn(
              `[wiki-worker] Item ${item.id} failed (retry ${newRetryCount}/${maxRetries}): ${lastError}`,
            );
          }
        }
      }
    }

    // --- Git commit modified pages ---
    if (modifiedPaths.size > 0) {
      const pathSummary = [...modifiedPaths].slice(0, 3).join(', ') +
        (modifiedPaths.size > 3 ? ` +${modifiedPaths.size - 3} more` : '');
      gitCommitWiki(wikiRoot, `wiki: patch ${modifiedPaths.size} page(s) — ${pathSummary}`);
      logger.info(`[wiki-worker] Committed ${modifiedPaths.size} updated page(s)`);
    }

    // --- Re-embed modified pages ---
    if (modifiedPaths.size > 0) {
      try {
        await runWikiEmbed({ wikiRoot, dbPath: wikiDbPath, verbose: false });
        logger.debug?.(`[wiki-worker] Re-embedded ${modifiedPaths.size} page(s)`);
      } catch (err) {
        logger.warn(`[wiki-worker] Re-embed failed: ${err}`);
      }
    }
  } finally {
    wiki.close();
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the wiki queue worker.
 *
 * Runs the resolver→patch→applier pipeline on a setInterval.
 * Each tick is idempotent and processes all pending queue items.
 *
 * @returns Interval handle — pass to clearInterval() to stop.
 */
export function startWikiWorker(options: WikiWorkerOptions = {}): ReturnType<typeof setInterval> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxEditsPerHour = options.maxEditsPerHour ?? DEFAULT_MAX_EDITS_PER_HOUR;
  const rateLimiter = new RateLimiter(maxEditsPerHour);

  const logger = options.logger ?? {
    info: (s: string) => console.log(s),
    warn: (s: string) => console.warn(s),
    error: (s: string) => console.error(s),
    debug: (s: string) => console.debug(s),
  };

  logger.info(`[wiki-worker] Started (interval: ${intervalMs}ms, max ${maxEditsPerHour} edits/hour)`);

  return setInterval(() => {
    void runWorkerTick(options, rateLimiter).catch((err) => {
      logger.error(`[wiki-worker] Tick error: ${err}`);
    });
  }, intervalMs);
}
