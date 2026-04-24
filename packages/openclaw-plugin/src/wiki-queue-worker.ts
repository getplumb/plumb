/**
 * wiki-queue-worker.ts — Background worker that drains the wiki edit queue.
 *
 * Implements spec §5.1 worker:
 *   - Runs every 60s inside the OpenClaw plugin via setInterval.
 *   - Reads pending items from ~/.plumb/wiki-queue.jsonl.
 *   - Determines which wiki pages are affected (WikiSearch → LLM routing).
 *   - Generates updated page prose via Sonnet.
 *   - Saves to disk and git-commits: "wiki: <summary>".
 *   - Re-embeds changed pages via WikiEmbedder.
 *   - Marks items done/failed (never deletes them).
 *   - Processes items sequentially to avoid git lock conflicts.
 *
 * Two-step target selection (added 2026-04-24):
 *   Step 1:   Semantic search → up to 10 candidate pages.
 *   Step 1.5: Haiku routing LLM → picks primary_target + secondary_mentions.
 *             Prevents facts from leaking into audit/eval/meta pages that
 *             merely MENTION the entity (incident: pronouns written to
 *             AUDIT_2026-04-16.md and EVAL_2026-04-16.md instead of
 *             people/clay-waters.md on 2026-04-24).
 *   Step 2:   Sonnet updates ONLY the routed pages with a tight minimal-change
 *             prompt (no word-limit condensation, no deletions).
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

/** Minimum RRF score for a page to be considered a candidate. */
const MIN_RELEVANCE_SCORE = 0.005;

/** Max candidates to pass to the routing LLM. */
const MAX_SEARCH_CANDIDATES = 10;

// ---------------------------------------------------------------------------
// Sonnet prompts
// ---------------------------------------------------------------------------

const UPDATE_SYSTEM_PROMPT = `You are editing one wiki page to incorporate ONE specific new fact. Make the MINIMAL change needed.

RULES:
1. Do NOT rewrite, reword, or compress content that is not directly affected by the fact.
2. Do NOT delete sections, tables, lists, or appendices.
3. Do NOT reorganize sections or change heading structure.
4. If the fact updates a field that already exists (e.g. replace "Pronouns: not specified" with "Pronouns: He / Him"), replace that field's value in place. Do not rewrite the surrounding section.
5. If the fact adds new information, append it to the most topically appropriate existing section. If no section fits, add a new short section.
6. If the fact is already reflected in the page (or contradicted by recent-and-specific content), leave the page unchanged.
7. Update \`updated:\` in the frontmatter to today's date. Preserve all other frontmatter fields exactly.
8. Preserve YAML validity and markdown structure.

Do NOT enforce any word limit. Do NOT "tidy up" or "improve" the page. If you find yourself rewriting more than 2-3 lines for a simple fact, you are doing it wrong.

Output ONLY the full updated page (frontmatter + body). No preamble, no explanation, no code fences.`;

// ---------------------------------------------------------------------------
// Routing LLM prompt (Haiku — cheaper, fast)
// ---------------------------------------------------------------------------

const ROUTING_SYSTEM_PROMPT = `You are a routing agent for a personal wiki. Given a FACT and a list of CANDIDATE PAGES (with path, type, summary, tags, aliases), decide where the fact belongs.

STRICT RULES:
1. Prefer the canonical entity page. If the fact is about a person, company, project, concept, or tool and there is a candidate page whose \`type\` matches and whose title/aliases match the entity name, that is the primary_target.
2. Pages that MENTION or DISCUSS an entity are NOT the primary target — only pages that ARE the entity.
3. Audit, eval, review, or meta pages (paths like AUDIT_*.md, EVAL_*.md, glossary.md, SCHEMA.md) are NEVER targets for facts about entities. Skip them unless the fact is explicitly about the audit/eval itself.
4. Return secondary_mentions only if the fact would meaningfully update OTHER pages too (e.g. "Clay got promoted" might update both clay-waters.md AND his employer's page). Most facts have no secondary mentions.
5. If no candidate page is a good fit, return {"primary_target": null, "create_new": {"path": "...", "type": "..."}, "reason": "..."}.
6. If the fact doesn't warrant a wiki edit (too trivial, duplicate of existing content, unclear), return {"primary_target": null, "skip": true, "reason": "..."}.

Output ONLY valid JSON matching this schema:
{"primary_target": string | null, "secondary_mentions": string[], "create_new": {"path": string, "type": string} | null, "skip": boolean, "reason": string}
No preamble, no markdown fences, just the JSON object.`;

// ---------------------------------------------------------------------------
// Routing result type
// ---------------------------------------------------------------------------

interface RoutingResult {
  primary_target: string | null;
  secondary_mentions: string[];
  create_new: { path: string; type: string } | null;
  skip: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// LLM API calls
// ---------------------------------------------------------------------------

async function callLLM(
  model: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  // Use bracket notation to avoid esbuild define replacement.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot call LLM');
  }

  // Dynamic import keeps @anthropic-ai/sdk external in the esbuild bundle.
  const AnthropicModule = await import('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) throw new Error(`LLM (${model}) returned empty response`);
  return text;
}

async function callSonnet(system: string, userContent: string): Promise<string> {
  return callLLM('claude-sonnet-4-6', system, userContent, 3000);
}

async function callHaiku(system: string, userContent: string): Promise<string> {
  return callLLM('claude-haiku-4-5', system, userContent, 512);
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal — extracts scalar fields and arrays)
// ---------------------------------------------------------------------------

interface PageMeta {
  type: string;
  summary: string;
  aliases: string[];
  tags: string[];
  firstParagraph: string;
}

function extractPageMeta(content: string, fallbackTitle: string): PageMeta {
  const result: PageMeta = {
    type: '',
    summary: '',
    aliases: [],
    tags: [],
    firstParagraph: '',
  };

  // Parse frontmatter block
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];

    const typeMatch = fm.match(/^type:\s*(.+)$/m);
    if (typeMatch) result.type = typeMatch[1].trim();

    const summaryMatch = fm.match(/^summary:\s*(.+)$/m);
    if (summaryMatch) result.summary = summaryMatch[1].trim();

    // Parse inline arrays like [foo, bar] or flow-style
    const aliasesMatch = fm.match(/^aliases:\s*\[([^\]]*)\]/m);
    if (aliasesMatch) {
      result.aliases = aliasesMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      // Block list style
      const aliasBlock = fm.match(/^aliases:\s*\n((?:\s*-[^\n]*\n?)*)/m);
      if (aliasBlock) {
        result.aliases = aliasBlock[1]
          .split('\n')
          .map((l) => l.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean);
      }
    }

    const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
    if (tagsMatch) {
      result.tags = tagsMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      const tagBlock = fm.match(/^tags:\s*\n((?:\s*-[^\n]*\n?)*)/m);
      if (tagBlock) {
        result.tags = tagBlock[1]
          .split('\n')
          .map((l) => l.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean);
      }
    }
  }

  // Extract first non-empty paragraph after frontmatter
  const bodyStart = content.indexOf('\n---\n', 3);
  if (bodyStart !== -1) {
    const body = content.slice(bodyStart + 5);
    const paras = body.split(/\n{2,}/);
    for (const p of paras) {
      const trimmed = p.trim().replace(/^#+\s+/, ''); // strip headings
      if (trimmed && !trimmed.startsWith('---')) {
        result.firstParagraph = trimmed.slice(0, 200);
        break;
      }
    }
  }

  return result;
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

  // --- Step 1: Search for candidate wiki pages (up to 10) ---
  let candidates: Array<{ path: string; title: string; type: string; score: number; snippet: string }> = [];
  try {
    const search = await WikiSearch.create({
      wikiRoot,
      dbPath: wikiDbPath,
      preCheck: false,
    });
    const results = await search.search(item.fact, MAX_SEARCH_CANDIDATES);
    search.close();
    candidates = results.filter((r) => r.score >= MIN_RELEVANCE_SCORE);
  } catch (err) {
    logger.warn(`[plumb:wiki-queue] Search failed for item ${item.id}: ${err}`);
    await updateQueueItemStatus(item.id, 'failed', `search failed: ${err}`, queuePath);
    return;
  }

  if (candidates.length === 0) {
    logger.info(`[plumb:wiki-queue] No relevant pages found for fact: "${item.fact.slice(0, 60)}…"`);
    await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
    return;
  }

  // --- Step 1.5: LLM routing — pick the right target page(s) ---
  // Build candidate summaries (frontmatter only — no full content to keep tokens low)
  const candidateLines: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const absPath = join(wikiRoot, c.path);
    let meta: PageMeta = { type: c.type, summary: '', aliases: [], tags: [], firstParagraph: c.snippet };

    if (existsSync(absPath)) {
      try {
        const raw = await readFile(absPath, 'utf8');
        meta = extractPageMeta(raw, c.title);
        // Fall back to search type/snippet if frontmatter missing
        if (!meta.type) meta.type = c.type;
        if (!meta.firstParagraph) meta.firstParagraph = c.snippet;
      } catch {
        // Use defaults from search result
      }
    }

    const summary = meta.summary || meta.firstParagraph.slice(0, 200);

    candidateLines.push(
      `${i + 1}. path: ${c.path}\n` +
      `   type: ${meta.type || '(unknown)'}\n` +
      `   title: ${c.title || c.path}\n` +
      `   aliases: ${meta.aliases.length > 0 ? meta.aliases.join(', ') : '(none)'}\n` +
      `   tags: ${meta.tags.length > 0 ? meta.tags.join(', ') : '(none)'}\n` +
      `   summary: ${summary || '(no summary)'}`,
    );
  }

  const routingUserMsg = `FACT: ${item.fact}\n\nCANDIDATE PAGES:\n${candidateLines.join('\n\n')}`;

  let routing: RoutingResult;
  try {
    const rawJson = await callHaiku(ROUTING_SYSTEM_PROMPT, routingUserMsg);
    routing = JSON.parse(rawJson) as RoutingResult;
  } catch (err) {
    logger.error(`[plumb:wiki-queue] Routing LLM failed for item ${item.id}: ${err}`);
    await updateQueueItemStatus(item.id, 'failed', `routing LLM failed: ${err}`, queuePath);
    return;
  }

  logger.info(`[plumb:wiki-queue] Routing decision for ${item.id}: primary=${routing.primary_target ?? 'null'}, skip=${routing.skip}, reason=${routing.reason}`);

  if (routing.skip) {
    logger.info(`[plumb:wiki-queue] Skipping item ${item.id} (router said skip): ${routing.reason}`);
    await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
    return;
  }

  if (routing.create_new) {
    logger.warn(`[plumb:wiki-queue] Router requested new page ${routing.create_new.path} for item ${item.id} — auto-creation not yet implemented; marking done`);
    await updateQueueItemStatus(item.id, 'done', undefined, queuePath);
    return;
  }

  if (!routing.primary_target) {
    logger.warn(`[plumb:wiki-queue] Router returned null primary_target with no skip/create_new for item ${item.id}: ${routing.reason} — marking failed`);
    await updateQueueItemStatus(item.id, 'failed', `router returned null primary_target: ${routing.reason}`, queuePath);
    return;
  }

  // Collect pages to update: primary + any secondary_mentions
  const secondaryMentions: string[] = Array.isArray(routing.secondary_mentions) ? routing.secondary_mentions : [];
  const pagesToUpdate = [routing.primary_target, ...secondaryMentions];

  logger.info(`[plumb:wiki-queue] Will update ${pagesToUpdate.length} page(s): ${pagesToUpdate.join(', ')}`);

  // --- Step 2: Update each routed page via Sonnet ---
  const modifiedPaths: string[] = [];
  const summaryParts: string[] = [];

  for (const pagePath of pagesToUpdate) {
    const absPath = join(wikiRoot, pagePath);
    if (!existsSync(absPath)) {
      logger.warn(`[plumb:wiki-queue] Page not found on disk: ${pagePath}`);
      continue;
    }

    let existingContent: string;
    try {
      existingContent = await readFile(absPath, 'utf8');
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Could not read ${pagePath}: ${err}`);
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
      logger.warn(`[plumb:wiki-queue] Sonnet failed for ${pagePath}: ${err}`);
      continue;
    }

    try {
      await writeFile(absPath, updatedContent + '\n', 'utf8');
      modifiedPaths.push(pagePath);
      // Use title from candidate if available, else path
      const candidate = candidates.find((c) => c.path === pagePath);
      summaryParts.push(candidate?.title || pagePath);
      logger.info(`[plumb:wiki-queue] Updated ${pagePath}`);
    } catch (err) {
      logger.warn(`[plumb:wiki-queue] Could not write ${pagePath}: ${err}`);
    }
  }

  if (modifiedPaths.length === 0) {
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
