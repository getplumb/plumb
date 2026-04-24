/**
 * wiki-queue-worker.ts — Background worker that drains the wiki edit queue.
 *
 * Implements spec §5.1 worker:
 *   - Runs every 60s inside the OpenClaw plugin via setInterval.
 *   - Reads pending items from ~/.plumb/wiki-queue.jsonl.
 *   - Determines which wiki pages are affected (WikiSearch).
 *   - Generates updated page prose via Sonnet.
 *   - Saves to disk and git-commits: "wiki: <summary>".
 *   - Re-embeds changed pages via WikiEmbedder.
 *   - Marks items done/failed (never deletes them).
 *   - Processes items sequentially to avoid git lock conflicts.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import {
  appendToQueue,
  readQueue,
  updateQueueItemStatus,
  defaultQueuePath,
  WikiSearch,
  runWikiEmbed,
} from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiQueueWorkerOptions {
  /** Absolute path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Absolute path to wiki.db. Defaults to ~/.plumb/wiki.db */
  wikiDbPath?: string;
  /** Absolute path to wiki-queue.jsonl. Defaults to ~/.plumb/wiki-queue.jsonl */
  queuePath?: string;
  /** Worker poll interval in milliseconds. Defaults to 60000 (60s). */
  intervalMs?: number;
  /** Logger instance (from plugin api). */
  logger?: {
    info: (s: string) => void;
    warn: (s: string) => void;
    error: (s: string) => void;
    debug?: (s: string) => void;
  };
}

// Re-export appendToQueue so the plugin-module can call it for the MCP tool.
export { appendToQueue };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WIKI_ROOT = join(homedir(), '.plumb', 'wiki');
const DEFAULT_WIKI_DB_PATH = join(homedir(), '.plumb', 'wiki.db');
const DEFAULT_INTERVAL_MS = 60_000;

/** Minimum RRF score for a page to be considered "affected" by a fact. */
const MIN_RELEVANCE_SCORE = 0.005;

/** Max pages to update per queue item. */
const MAX_PAGES_PER_ITEM = 2;

// ---------------------------------------------------------------------------
// Sonnet prompts
// ---------------------------------------------------------------------------

const UPDATE_SYSTEM_PROMPT = `You are a wiki page editor for a personal knowledge base called Plumb.
You will receive an existing wiki page and a new fact to incorporate.

Your job:
1. Integrate the new fact into the most appropriate section of the page
2. Update the "updated" date in frontmatter to today's date
3. Preserve all existing content that is not contradicted by the new fact
4. Keep the page under ~800 words; condense older content if necessary
5. Maintain correct frontmatter structure and YAML validity
6. Use [[Wikilink]] style for references to other pages

Output ONLY the updated wiki page (frontmatter + body), no preamble or explanation.`;

// ---------------------------------------------------------------------------
// Sonnet API call
// ---------------------------------------------------------------------------

async function callSonnet(system: string, userContent: string): Promise<string> {
  // Use bracket notation to avoid esbuild define replacement.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot call Sonnet');
  }

  // Dynamic import keeps @anthropic-ai/sdk external in the esbuild bundle.
  const AnthropicModule = await import('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) throw new Error('Sonnet returned empty response');
  return text;
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

/**
 * Git-commit all modified files in the wiki root.
 * Silently skips if the directory is not a git repo or there's nothing to commit.
 */
function gitCommitWiki(wikiRoot: string, message: string): void {
  try {
    // Check if this is a git repo
    execSync('git rev-parse --git-dir', { cwd: wikiRoot, stdio: 'pipe' });
  } catch {
    return; // Not a git repo — skip commit
  }

  try {
    execSync('git add -A', { cwd: wikiRoot, stdio: 'pipe' });
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      cwd: wikiRoot,
      stdio: 'pipe',
    });
  } catch {
    // Nothing to commit, or commit failed — both are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Single-item processing
// ---------------------------------------------------------------------------

async function processQueueItem(
  item: { id: string; fact: string },
  wikiRoot: string,
  wikiDbPath: string,
  queuePath: string,
  logger: NonNullable<WikiQueueWorkerOptions['logger']>,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // --- Step 0: Atomically mark item as in-flight so overlapping worker
  // ticks don't double-process it. Any crash or failure below still
  // leaves the item flipped away from 'pending' so it won't be retried
  // until it's explicitly reset.
  try {
    await updateQueueItemStatus(item.id, 'processing', undefined, queuePath);
  } catch (err) {
    logger.warn(`[plumb:wiki-queue] Could not mark item ${item.id} processing: ${err}`);
    return;
  }

  // --- Step 1: Search for relevant wiki pages ---
  let relevantPages: Array<{ path: string; title: string; type: string; score: number }> = [];
  try {
    const search = await WikiSearch.create({
      wikiRoot,
      dbPath: wikiDbPath,
      preCheck: false, // Skip stale check for speed — we re-embed after writing
    });
    const results = await search.search(item.fact, 5);
    search.close();
    relevantPages = results
      .filter((r) => r.score >= MIN_RELEVANCE_SCORE)
      .slice(0, MAX_PAGES_PER_ITEM);
  } catch (err) {
    logger.warn(`[plumb:wiki-queue] Search failed for item ${item.id}: ${err}`);
    // Fall through — if search fails, we can't determine affected pages
    await updateQueueItemStatus(item.id, 'failed', `search failed: ${err}`, queuePath);
    return;
  }

  if (relevantPages.length === 0) {
    logger.info(`[plumb:wiki-queue] No relevant pages found for fact: "${item.fact.slice(0, 60)}…"`);
    // Mark done — no pages to update
    await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
    return;
  }

  // --- Step 2: Update each relevant page via Sonnet ---
  const modifiedPaths: string[] = [];
  const summaryParts: string[] = [];

  for (const page of relevantPages) {
    const absPath = join(wikiRoot, page.path);
    if (!existsSync(absPath)) {
      logger.warn(`[plumb:wiki-queue] Page not found on disk: ${page.path}`);
      continue;
    }

    let existingContent: string;
    try {
      existingContent = await readFile(absPath, 'utf8');
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Could not read ${page.path}: ${err}`);
      continue;
    }

    const userMessage = `Today's date: ${today}

## Existing page:
${existingContent}

## New fact to incorporate:
${item.fact}`;

    let updatedContent: string;
    try {
      updatedContent = await callSonnet(UPDATE_SYSTEM_PROMPT, userMessage);
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Sonnet failed for ${page.path}: ${err}`);
      continue;
    }

    try {
      await writeFile(absPath, updatedContent + '\n', 'utf8');
      modifiedPaths.push(page.path);
      summaryParts.push(page.title || page.path);
      logger.info(`[plumb:wiki-queue] Updated ${page.path}`);
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Could not write ${page.path}: ${err}`);
    }
  }

  if (modifiedPaths.length === 0) {
    // All page writes failed
    await updateQueueItemStatus(item.id, 'failed', 'all page writes failed', queuePath);
    return;
  }

  // --- Step 3: Git commit ---
  const factSummary = item.fact.slice(0, 60) + (item.fact.length > 60 ? '…' : '');
  const commitMsg = `wiki: ${factSummary}`;
  gitCommitWiki(wikiRoot, commitMsg);
  logger.debug?.(`[plumb:wiki-queue] Committed: ${commitMsg}`);

  // --- Step 4: Re-embed modified pages ---
  try {
    await runWikiEmbed({ wikiRoot, dbPath: wikiDbPath, verbose: false });
    logger.debug?.(`[plumb:wiki-queue] Re-embedded ${modifiedPaths.length} page(s)`);
  } catch (err) {
    logger.warn(`[plumb:wiki-queue] Re-embed failed: ${err}`);
    // Non-fatal — the page is updated on disk; embedding will catch up next run
  }

  // --- Step 5: Mark item done ---
  await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
  logger.info(
    `[plumb:wiki-queue] Done item ${item.id}: updated ${summaryParts.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

/**
 * Re-entrancy guard. Because Sonnet calls can take 5-30s per page and we
 * process items sequentially, a full tick can easily run longer than the
 * 60s worker interval. Without this guard, setInterval fires a second tick
 * that re-reads still-'pending' items and re-processes them in parallel,
 * producing duplicate commits (seen in production 2026-04-24: 21 queue
 * items produced 218 wiki commits).
 *
 * Module-scoped so it survives across ticks from a single setInterval.
 */
let workerTickInFlight = false;

async function runWorkerTick(
  wikiRoot: string,
  wikiDbPath: string,
  queuePath: string,
  logger: NonNullable<WikiQueueWorkerOptions['logger']>,
): Promise<void> {
  if (workerTickInFlight) {
    logger.debug?.(`[plumb:wiki-queue] Previous tick still running; skipping`);
    return;
  }
  workerTickInFlight = true;
  try {
    let items: Awaited<ReturnType<typeof readQueue>>;
    try {
      items = await readQueue(queuePath);
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Could not read queue: ${err}`);
      return;
    }

    const pending = items.filter((i) => i.status === 'pending');

    if (pending.length === 0) return;

    logger.info(`[plumb:wiki-queue] Processing ${pending.length} pending item(s)…`);

    // Process sequentially to avoid git lock conflicts
    for (const item of pending) {
      try {
        await processQueueItem(item, wikiRoot, wikiDbPath, queuePath, logger);
      } catch (err) {
        logger.error(`[plumb:wiki-queue] Unexpected error on item ${item.id}: ${err}`);
        try {
          await updateQueueItemStatus(item.id, 'failed', String(err), queuePath);
        } catch {
          // If we can't even mark it failed, move on
        }
      }
    }
  } finally {
    workerTickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the wiki queue background worker.
 *
 * Drains pending items from the queue every intervalMs (default: 60s).
 * Processes items sequentially to avoid git lock conflicts.
 *
 * @returns The interval handle — pass to clearInterval() to stop the worker.
 */
export function startWikiQueueWorker(options: WikiQueueWorkerOptions = {}): ReturnType<typeof setInterval> {
  const wikiRoot = options.wikiRoot ?? DEFAULT_WIKI_ROOT;
  const wikiDbPath = options.wikiDbPath ?? DEFAULT_WIKI_DB_PATH;
  const queuePath = options.queuePath ?? defaultQueuePath();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = options.logger ?? {
    info: (s: string) => console.log(s),
    warn: (s: string) => console.warn(s),
    error: (s: string) => console.error(s),
    debug: (s: string) => console.debug(s),
  };

  logger.info(`[plumb:wiki-queue] Worker started (interval: ${intervalMs}ms)`);

  return setInterval(() => {
    void runWorkerTick(wikiRoot, wikiDbPath, queuePath, logger).catch((err) => {
      logger.error(`[plumb:wiki-queue] Worker tick error: ${err}`);
    });
  }, intervalMs);
}
