/**
 * wiki-dream-scan.ts — OpenClaw GPT 5.5 catch-up scan phase of the nightly dream cron (T-239).
 *
 * Reads today's Plumb V1 facts from memory.db and today's OpenClaw chat logs,
 * compares against what is already reflected in the wiki and the in-band queue,
 * and uses OpenClaw GPT 5.5 to identify facts that have NOT been incorporated yet.
 *
 * Missed facts are ENQUEUED to wiki-queue.jsonl — they are NOT written directly.
 * The normal wiki-worker pipeline picks them up on its next hourly tick.
 *
 * This keeps dream "detection-only": it finds gaps, the worker fills them.
 *
 * Usage:
 *   plumb wiki dream-scan [--db <path>] [--wiki <path>] [--sessions <path>]
 *                         [--queue <path>] [--batch-size <n>] [--date <YYYY-MM-DD>]
 *                         [--dry-run]
 *
 * Returns usage stats (tokens_in, tokens_out) so the orchestrator can log cost.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, appendToQueue, readQueue, defaultQueuePath } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';
import { callOpenClawChat } from '../utils/openclaw-chat.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiDreamScanOptions {
  /** Path to Plumb memory database. Defaults to getDefaultDbPath() */
  db?: string;
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
  /** Path to wiki-queue.jsonl. Defaults to defaultQueuePath() */
  queue?: string;
  /** Facts per model request. Defaults to 50 */
  batchSize?: number;
  /** Date to scan (YYYY-MM-DD). Defaults to today */
  date?: string;
  /** Skip model calls, print what would be sent */
  dryRun?: boolean;
  /** User ID to filter facts by. Defaults to 'default' */
  userId?: string;
}

export interface WikiDreamScanResult {
  /** How many facts were examined */
  factsExamined: number;
  /** How many items were enqueued for the worker to process */
  enqueuedCount: number;
  /** Total input tokens consumed by the model */
  tokensIn: number;
  /** Total output tokens consumed by the model */
  tokensOut: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
  baseDelayMs = 2000,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      const status =
        (err as { status?: number })?.status ??
        (err as { error?: { status?: number } })?.error?.status;
      const isRateLimit = status === 429 || status === 529;
      if (!isRateLimit || attempt >= maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`  Rate-limited (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface MemoryFact {
  id: string;
  content: string;
  created_at: string;
}

async function loadTodaysFacts(
  dbPath: string,
  userId: string,
  datePrefix: string,
): Promise<MemoryFact[]> {
  const db = await openDb(dbPath);
  const facts: MemoryFact[] = [];
  try {
    const stmt = db.prepare(
      `SELECT id, content, created_at
       FROM memory_facts
       WHERE user_id = ?
         AND deleted_at IS NULL
         AND created_at LIKE ?
       ORDER BY created_at ASC`,
    );
    stmt.bind([userId, `${datePrefix}%`]);
    while (stmt.step()) {
      const row = stmt.get({}) as { id: string; content: string; created_at: string };
      facts.push({ id: row.id, content: row.content, created_at: row.created_at });
    }
    stmt.finalize();
  } finally {
    db.close();
  }
  return facts;
}

/**
 * Read today's chat log excerpts from OpenClaw session JSONL files.
 * Returns up to maxChars of text (user messages only).
 */
function loadTodaysChatLogs(
  sessionsDir: string,
  datePrefix: string,
  maxChars = 8000,
): string {
  if (!existsSync(sessionsDir)) {
    console.log(`  Sessions dir not found (${sessionsDir}), skipping chat logs.`);
    return '';
  }

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    console.log(`  Could not read sessions dir, skipping chat logs.`);
    return '';
  }

  const todayFiles = files.filter((f) => {
    try {
      const mtime = statSync(join(sessionsDir, f)).mtime;
      return mtime.toISOString().startsWith(datePrefix);
    } catch {
      return false;
    }
  });

  if (todayFiles.length === 0) {
    console.log(`  No session files modified today in ${sessionsDir}.`);
    return '';
  }

  let combined = '';
  for (const f of todayFiles) {
    const filePath = join(sessionsDir, f);
    try {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['type'] === 'message') {
            const msg = obj['message'] as Record<string, unknown> | undefined;
            if (!msg || msg['role'] !== 'user') continue;
            const content = msg['content'];
            let text = '';
            if (Array.isArray(content)) {
              text = content
                .filter((c: unknown) => (c as Record<string, unknown>)['type'] === 'text')
                .map((c: unknown) => String((c as Record<string, unknown>)['text'] ?? ''))
                .join(' ');
            } else if (typeof content === 'string') {
              text = content;
            }
            if (text.includes('[PLUMB MEMORY]') || !text.trim()) continue;
            const ts = String(obj['timestamp'] ?? '');
            if (ts && !ts.startsWith(datePrefix)) continue;
            const excerpt = text.slice(0, 400).trim();
            combined += excerpt + '\n';
            if (combined.length >= maxChars) {
              return combined.slice(0, maxChars);
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return combined.trim();
}

/**
 * Read today's entries from the wiki activity log.md to understand what's already been committed.
 */
function loadRecentLogEntries(wikiRoot: string, datePrefix: string, maxChars = 3000): string {
  const logPath = join(wikiRoot, 'log.md');
  if (!existsSync(logPath)) return '';
  try {
    const raw = readFileSync(logPath, 'utf8');
    // Find the section for today's date
    const dateIdx = raw.indexOf(`## ${datePrefix}`);
    if (dateIdx === -1) return '';
    // Return up to maxChars from that section
    return raw.slice(dateIdx, dateIdx + maxChars);
  } catch {
    return '';
  }
}

/**
 * Enumerate existing wiki page paths (relative to wiki root).
 */
function listExistingWikiPages(wikiRoot: string): string[] {
  if (!existsSync(wikiRoot)) return [];
  const pages: string[] = [];

  function walkDir(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !entry.name.startsWith('_') &&
          entry.name !== 'index.md'
        ) {
          const rel = fullPath.slice(wikiRoot.length + 1);
          pages.push(rel);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  walkDir(wikiRoot);
  return pages.sort();
}

/**
 * Read today's already-enqueued facts from the wiki queue to avoid duplicates.
 */
async function loadTodaysQueuedFacts(queuePath: string, datePrefix: string): Promise<string[]> {
  const items = await readQueue(queuePath);
  return items
    .filter((item) => item.queued_at?.startsWith(datePrefix) && item.status === 'pending')
    .map((item) => item.fact);
}

// ---------------------------------------------------------------------------
// Catch-up prompt
// ---------------------------------------------------------------------------

const CATCH_UP_SYSTEM_PROMPT = `You are a knowledge-base catch-up scanner for a personal wiki.

You will receive:
1. A list of existing wiki pages (relative paths)
2. Today's memory facts (new information)
3. Excerpts from today's chat logs
4. Today's wiki activity log (what was already written/updated today)
5. Facts already queued for processing today (to avoid duplicates)

Your job is to identify facts that:
- Mention a named entity (person, company, project, concept, tool)
- Are NOT yet reflected in an existing wiki page
- Have NOT already been queued today

For each such fact, produce a single self-contained sentence that includes the entity name and the key information. These sentences will be enqueued for the wiki worker to incorporate.

Rules:
- Only return facts with a clear named entity
- Only return facts that have a clear relationship to the user, Terra, OpenClaw/Plumb, or an existing wiki page. If the fact is about a disconnected person/company/concept and the connection is unclear, skip it.
- Skip generic observations, process descriptions, or facts with no wiki-worthy entity
- If a fact updates an existing page, include the entity name so the worker can find the page
- Prefer updating existing connected pages over creating standalone low-confidence pages.
- Max 20 items — prioritize the most significant new information
- Return ONLY a JSON array of strings:
  ["Fact about Entity 1", "Fact about Entity 2", ...]
- Return [] if nothing new needs enqueuing`;

interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

async function runCatchUpBatch(
  facts: MemoryFact[],
  existingPages: string[],
  chatContext: string,
  logContext: string,
  alreadyQueued: string[],
  batchNum: number,
  totalBatches: number,
): Promise<{ facts: string[]; usage: ModelUsage }> {
  const factsText = facts
    .map((f, i) => `[${i + 1}] (${f.created_at.slice(0, 16)}) ${f.content}`)
    .join('\n\n');

  const pagesText =
    existingPages.length > 0
      ? `Existing wiki pages (${existingPages.length} total):\n${existingPages.slice(0, 200).join('\n')}`
      : 'No existing wiki pages yet.';

  const chatSection = chatContext.trim()
    ? `\n\n=== TODAY'S CHAT EXCERPTS ===\n${chatContext.slice(0, 2000)}`
    : '';

  const logSection = logContext.trim()
    ? `\n\n=== TODAY'S WIKI LOG (already written) ===\n${logContext.slice(0, 1500)}`
    : '';

  const queueSection =
    alreadyQueued.length > 0
      ? `\n\n=== ALREADY QUEUED TODAY (skip these) ===\n${alreadyQueued.slice(0, 30).join('\n')}`
      : '';

  const userPrompt = `${pagesText}${chatSection}${logSection}${queueSection}

=== TODAY'S MEMORY FACTS (batch ${batchNum}/${totalBatches}) ===
${factsText}

Return the JSON array of facts to enqueue.`;

  const message = await withRetry(() =>
    callOpenClawChat(CATCH_UP_SYSTEM_PROMPT, userPrompt, 1024),
  );

  const usage: ModelUsage = {
    input_tokens: message.usage.inputTokens,
    output_tokens: message.usage.outputTokens,
  };

  const text = message.text;

  try {
    // Strip code fences and any leading reasoning/commentary before the JSON array
    let cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    // If there's a JSON array embedded after reasoning text, extract it
    const arrayMatch = cleaned.match(/(\[.*\])/s);
    if (arrayMatch?.[1]) cleaned = arrayMatch[1].trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return {
        facts: parsed.filter((f): f is string => typeof f === 'string' && f.trim().length > 0),
        usage,
      };
    }
    return { facts: [], usage };
  } catch {
    console.error(`  Warning: Could not parse OpenClaw model response. Preview: ${text.slice(0, 200)}`);
    return { facts: [], usage };
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function wikiDreamScanCommand(
  options: WikiDreamScanOptions = {},
): Promise<WikiDreamScanResult> {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const dbPath = options.db ?? getDefaultDbPath();
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const sessionsDir =
    options.sessions ?? join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
  const queuePath = options.queue ?? defaultQueuePath();
  const batchSize = options.batchSize ?? 50;
  const userId = options.userId ?? 'default';
  const dryRun = options.dryRun ?? false;

  console.log(`Wiki dream catch-up scan — ${today}`);
  console.log(`  db:       ${dbPath}`);
  console.log(`  wiki:     ${wikiRoot}`);
  console.log(`  sessions: ${sessionsDir}`);
  console.log(`  queue:    ${queuePath}`);

  const result: WikiDreamScanResult = {
    factsExamined: 0,
    enqueuedCount: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  // --- Validate DB ---
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // --- Load today's facts ---
  console.log(`\nLoading today's facts (${today})…`);
  const facts = await loadTodaysFacts(dbPath, userId, today);
  console.log(`  Found ${facts.length} fact(s) created today.`);
  result.factsExamined = facts.length;

  // --- Load today's chat logs (always — even if no V1 facts, chat may have wiki-worthy content) ---
  console.log(`\nLoading today's chat logs…`);
  const chatContext = loadTodaysChatLogs(sessionsDir, today);
  if (chatContext) {
    console.log(`  Loaded ${chatContext.length} chars of chat context.`);
  }

  if (facts.length === 0 && !chatContext.trim()) {
    console.log('\nNo facts and no chat activity today — nothing to catch up.');
    return result;
  }

  if (facts.length === 0) {
    console.log('\nNo V1 facts today — scanning chat logs only.');
  }

  // --- Load today's wiki log (what's already been committed) ---
  const logContext = loadRecentLogEntries(wikiRoot, today);
  if (logContext) {
    console.log(`  Loaded ${logContext.length} chars of today's wiki log.`);
  }

  // --- List existing wiki pages ---
  const existingPages = listExistingWikiPages(wikiRoot);
  console.log(`  Found ${existingPages.length} existing wiki page(s).`);

  // --- Load today's already-queued facts ---
  const alreadyQueued = await loadTodaysQueuedFacts(queuePath, today);
  console.log(`  Already queued today: ${alreadyQueued.length} item(s).`);

  // --- Dry run mode ---
  if (dryRun) {
    const totalBatches = Math.max(1, Math.ceil(facts.length / batchSize));
    console.log(`\n[dry-run] Would send ${totalBatches} batch(es) to OpenClaw GPT 5.5 (${facts.length} facts + chat context).`);
    if (facts.length > 0) {
      console.log(`[dry-run] First facts preview (up to 5):`);
      for (const f of facts.slice(0, 5)) {
        console.log(`  [${f.id.slice(0, 8)}] ${f.content.slice(0, 100)}`);
      }
    }
    console.log(`[dry-run] Would enqueue missed facts to: ${queuePath}`);
    return result;
  }

  // --- Process in batches (at least 1 batch even if facts=0 so chat logs are scanned) ---
  const totalBatches = Math.max(1, Math.ceil(facts.length / batchSize));
  console.log(`\nCatch-up scanning ${facts.length} fact(s) + chat context in ${totalBatches} batch(es)…`);

  const allMissedFacts: string[] = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * batchSize;
    const batch = facts.slice(start, start + batchSize);

    process.stdout.write(`  Batch ${batchIdx + 1}/${totalBatches} (${batch.length} facts)… `);

    try {
      const { facts: missedFacts, usage } = await runCatchUpBatch(
        batch,
        existingPages,
        chatContext,
        logContext,
        alreadyQueued,
        batchIdx + 1,
        totalBatches,
      );

      result.tokensIn += usage.input_tokens;
      result.tokensOut += usage.output_tokens;
      allMissedFacts.push(...missedFacts);

      console.log(`done — ${missedFacts.length} missed fact(s) found`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      console.error(`  Skipping batch ${batchIdx + 1} due to error.`);
    }

    if (batchIdx < totalBatches - 1) {
      await sleep(200);
    }
  }

  // --- Deduplicate missed facts before enqueuing ---
  const uniqueFacts = Array.from(new Set(allMissedFacts));

  // --- Enqueue missed facts ---
  if (uniqueFacts.length > 0) {
    console.log(`\nEnqueuing ${uniqueFacts.length} missed fact(s) to wiki queue…`);
    for (const fact of uniqueFacts) {
      await appendToQueue(fact, queuePath);
      result.enqueuedCount++;
      console.log(`  Enqueued: ${fact.slice(0, 80)}${fact.length > 80 ? '…' : ''}`);
    }
  } else {
    console.log('\nNo missed facts — wiki is up to date.');
  }

  console.log(`\nCatch-up scan complete.`);
  console.log(`  Facts examined:  ${result.factsExamined}`);
  console.log(`  Items enqueued:  ${result.enqueuedCount}`);
  console.log(`  Tokens in:       ${result.tokensIn}`);
  console.log(`  Tokens out:      ${result.tokensOut}`);

  return result;
}
