/**
 * wiki-dream-scan.ts — Haiku scan phase of the nightly dream cron (spec §5.2, steps 1-2).
 *
 * Reads today's Plumb V1 facts from memory.db and today's OpenClaw chat logs,
 * feeds them to Claude Haiku in batches, and outputs a JSON changeset to
 * /tmp/wiki-dream-changeset-YYYY-MM-DD.json for the Sonnet write phase (T-210).
 *
 * Changeset schema:
 *   {
 *     date: "YYYY-MM-DD",
 *     entities_to_create: [{ name, type, facts }],
 *     pages_to_update:    [{ path, changes }],
 *     contradictions:     [{ path, field, old, new }]
 *   }
 *
 * Usage:
 *   plumb wiki dream-scan [--db <path>] [--wiki <path>] [--sessions <path>]
 *                         [--out <path>] [--batch-size <n>] [--date <YYYY-MM-DD>]
 *                         [--dry-run]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityToCreate {
  /** Canonical entity name */
  name: string;
  /** Entity type */
  type: 'person' | 'company' | 'project' | 'concept';
  /** Relevant fact snippets that establish this entity */
  facts: string[];
}

export interface PageUpdate {
  /** Wiki-relative path, e.g. "people/alice-johnson.md" */
  path: string;
  /** Human-readable description of what changed */
  changes: string[];
}

export interface Contradiction {
  /** Wiki-relative path */
  path: string;
  /** Which field / attribute contradicts */
  field: string;
  /** What the wiki currently says */
  old: string;
  /** What today's facts say instead */
  new: string;
}

export interface DreamChangeset {
  /** Scan date, YYYY-MM-DD */
  date: string;
  /** New wiki pages to create */
  entities_to_create: EntityToCreate[];
  /** Existing pages that need content updates */
  pages_to_update: PageUpdate[];
  /** Facts that contradict existing wiki content */
  contradictions: Contradiction[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WikiDreamScanOptions {
  /** Path to Plumb memory database. Defaults to getDefaultDbPath() */
  db?: string;
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** OpenClaw sessions directory. Defaults to ~/.openclaw/agents/main/sessions */
  sessions?: string;
  /** Output changeset path. Defaults to /tmp/wiki-dream-changeset-<date>.json */
  out?: string;
  /** Facts per Haiku request. Defaults to 50 */
  batchSize?: number;
  /** Date to scan (YYYY-MM-DD). Defaults to today */
  date?: string;
  /** Skip Haiku calls, print what would be sent */
  dryRun?: boolean;
  /** User ID to filter facts by. Defaults to 'default' */
  userId?: string;
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
      console.error(
        `  Rate-limited (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms…`,
      );
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

/**
 * Load today's facts from memory.db, filtered by created_at date prefix.
 */
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

interface ChatExcerpt {
  sessionId: string;
  timestamp: string;
  role: string;
  text: string;
}

/**
 * Read today's chat log excerpts from OpenClaw session JSONL files.
 * Gracefully skips if the directory doesn't exist or files can't be parsed.
 *
 * Returns up to maxChars of text across all sessions, as a compact string.
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

  // Filter to files modified today
  const todayFiles = files.filter((f) => {
    try {
      const filePath = join(sessionsDir, f);
      const mtime = statSync(filePath).mtime;
      return mtime.toISOString().startsWith(datePrefix);
    } catch {
      return false;
    }
  });

  if (todayFiles.length === 0) {
    console.log(`  No session files modified today in ${sessionsDir}.`);
    return '';
  }

  console.log(`  Found ${todayFiles.length} session file(s) from today.`);

  const excerpts: ChatExcerpt[] = [];

  for (const f of todayFiles) {
    const filePath = join(sessionsDir, f);
    try {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      // Extract first event for session ID
      let sessionId = f.replace('.jsonl', '');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj['type'] === 'session') {
            sessionId = String(obj['id'] ?? sessionId);
          }
          if (obj['type'] === 'message') {
            const msg = obj['message'] as Record<string, unknown> | undefined;
            if (!msg) continue;
            const role = String(msg['role'] ?? '');
            // Only include user messages (assistant messages tend to be very long)
            if (role !== 'user') continue;
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
            // Skip PLUMB MEMORY injections (not human-authored chat)
            if (text.includes('[PLUMB MEMORY]')) continue;
            if (!text.trim()) continue;

            const ts = String(obj['timestamp'] ?? '');
            // Only include events that occurred on the target date
            if (ts && !ts.startsWith(datePrefix)) continue;

            excerpts.push({
              sessionId,
              timestamp: ts,
              role,
              text: text.slice(0, 400),
            });
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  if (excerpts.length === 0) {
    return '';
  }

  // Build compact text, up to maxChars
  let combined = '';
  for (const e of excerpts) {
    const line = `[${e.timestamp.slice(0, 16)}] ${e.role}: ${e.text.trim()}\n`;
    if (combined.length + line.length > maxChars) break;
    combined += line;
  }

  return combined.trim();
}

/**
 * Enumerate existing wiki page paths (relative to wiki root), excluding index files.
 * Used to give Haiku context about what already exists so it can distinguish
 * "update existing page" from "create new entity".
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
          pages.push(relative(wikiRoot, fullPath));
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  walkDir(wikiRoot);
  return pages.sort();
}

// ---------------------------------------------------------------------------
// Haiku scan
// ---------------------------------------------------------------------------

const SCAN_SYSTEM_PROMPT = `You are a knowledge-base update scanner for a personal wiki.

You will receive:
1. A list of existing wiki pages (relative paths)
2. Today's memory facts (new information learned today)
3. Optionally, excerpts from today's chat logs

Your job is to produce a JSON changeset with THREE sections:

entities_to_create: New entities (people, companies, projects, concepts) mentioned in today's facts
that do NOT yet have a wiki page. Each entry must have:
  - name: canonical display name
  - type: one of "person", "company", "project", "concept"
  - facts: array of 1-3 relevant fact snippets (verbatim or paraphrased)

pages_to_update: Existing wiki pages that need new information added, based on today's facts.
Each entry must have:
  - path: exact path from the existing pages list
  - changes: array of strings describing what new information should be added

contradictions: Facts that directly contradict what an existing page likely says.
Each entry must have:
  - path: exact path from the existing pages list
  - field: what attribute/field is contradicted (e.g. "role", "location", "project status")
  - old: what the page likely says (infer from context)
  - new: what today's facts say instead

Rules:
- Only include items with clear evidence from today's facts
- Skip vague or generic facts that don't relate to a named entity
- If no new entities, updates, or contradictions exist, return empty arrays
- Respond ONLY with valid JSON matching:
  {
    "entities_to_create": [...],
    "pages_to_update": [...],
    "contradictions": [...]
  }`;

interface HaikuBatchResult {
  entities_to_create: EntityToCreate[];
  pages_to_update: PageUpdate[];
  contradictions: Contradiction[];
}

async function scanBatchWithHaiku(
  client: import('@anthropic-ai/sdk').default,
  facts: MemoryFact[],
  existingPages: string[],
  chatContext: string,
  batchNum: number,
  totalBatches: number,
): Promise<HaikuBatchResult> {
  const factsText = facts
    .map((f, i) => `[${i + 1}] (${f.created_at.slice(0, 16)}) ${f.content}`)
    .join('\n\n');

  const pagesText =
    existingPages.length > 0
      ? `Existing wiki pages (${existingPages.length} total):\n${existingPages.slice(0, 200).join('\n')}`
      : 'No existing wiki pages yet.';

  const chatSection =
    chatContext.trim()
      ? `\n\n=== TODAY'S CHAT EXCERPTS ===\n${chatContext.slice(0, 3000)}`
      : '';

  const userPrompt = `${pagesText}

=== TODAY'S MEMORY FACTS (batch ${batchNum}/${totalBatches}) ===
${factsText}${chatSection}

Produce the changeset JSON.`;

  const message = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SCAN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  );

  const text =
    message.content[0]?.type === 'text' ? message.content[0].text : '';

  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as HaikuBatchResult;
    return {
      entities_to_create: Array.isArray(parsed.entities_to_create)
        ? parsed.entities_to_create
        : [],
      pages_to_update: Array.isArray(parsed.pages_to_update)
        ? parsed.pages_to_update
        : [],
      contradictions: Array.isArray(parsed.contradictions)
        ? parsed.contradictions
        : [],
    };
  } catch {
    console.error(`  Warning: Could not parse Haiku response. Preview: ${text.slice(0, 200)}`);
    return { entities_to_create: [], pages_to_update: [], contradictions: [] };
  }
}

// ---------------------------------------------------------------------------
// Changeset merging
// ---------------------------------------------------------------------------

/**
 * Merge batch results into the accumulator changeset, deduplicating by entity name
 * and page path.
 */
function mergeIntoChangeset(
  acc: DreamChangeset,
  batch: HaikuBatchResult,
): void {
  // entities_to_create: deduplicate by lower(name)+type
  const entityKeys = new Set(
    acc.entities_to_create.map((e) => `${e.type}:${e.name.toLowerCase()}`),
  );
  for (const e of batch.entities_to_create) {
    const key = `${e.type ?? 'concept'}:${(e.name ?? '').toLowerCase()}`;
    if (!key.includes(':') || !e.name) continue;
    if (!entityKeys.has(key)) {
      entityKeys.add(key);
      acc.entities_to_create.push({
        name: e.name,
        type: e.type ?? 'concept',
        facts: Array.isArray(e.facts) ? e.facts : [],
      });
    }
  }

  // pages_to_update: merge changes for same path
  const updateMap = new Map<string, PageUpdate>();
  for (const u of acc.pages_to_update) {
    updateMap.set(u.path, u);
  }
  for (const u of batch.pages_to_update) {
    if (!u.path) continue;
    const existing = updateMap.get(u.path);
    const changes = Array.isArray(u.changes) ? u.changes : [];
    if (existing) {
      existing.changes.push(...changes);
    } else {
      updateMap.set(u.path, { path: u.path, changes });
    }
  }
  acc.pages_to_update = Array.from(updateMap.values());

  // contradictions: append all (duplicates are acceptable; Sonnet write phase can dedupe)
  for (const c of batch.contradictions) {
    if (c.path && c.field) {
      acc.contradictions.push({
        path: c.path,
        field: c.field,
        old: c.old ?? '',
        new: c.new ?? '',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function wikiDreamScanCommand(
  options: WikiDreamScanOptions = {},
): Promise<void> {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const dbPath = options.db ?? getDefaultDbPath();
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const sessionsDir =
    options.sessions ??
    join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
  const outPath =
    options.out ?? `/tmp/wiki-dream-changeset-${today}.json`;
  const batchSize = options.batchSize ?? 50;
  const userId = options.userId ?? 'default';
  const dryRun = options.dryRun ?? false;

  console.log(`Wiki dream scan — ${today}`);
  console.log(`  db:       ${dbPath}`);
  console.log(`  wiki:     ${wikiRoot}`);
  console.log(`  sessions: ${sessionsDir}`);
  console.log(`  out:      ${outPath}`);

  // --- Validate DB ---
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // --- Load today's facts ---
  console.log(`\nLoading today's facts (${today})…`);
  const facts = await loadTodaysFacts(dbPath, userId, today);
  console.log(`  Found ${facts.length} fact(s) created today.`);

  if (facts.length === 0) {
    console.log('\nNo facts for today — writing empty changeset.');
    const empty: DreamChangeset = {
      date: today,
      entities_to_create: [],
      pages_to_update: [],
      contradictions: [],
    };
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(outPath, JSON.stringify(empty, null, 2), 'utf8');
    console.log(`Empty changeset written to: ${outPath}`);
    return;
  }

  // --- Load today's chat logs ---
  console.log(`\nLoading today's chat logs…`);
  const chatContext = loadTodaysChatLogs(sessionsDir, today);
  if (chatContext) {
    console.log(`  Loaded ${chatContext.length} chars of chat context.`);
  }

  // --- List existing wiki pages ---
  const existingPages = listExistingWikiPages(wikiRoot);
  console.log(`  Found ${existingPages.length} existing wiki page(s).`);

  // --- Dry run mode ---
  if (dryRun) {
    const totalBatches = Math.ceil(facts.length / batchSize);
    console.log(`\n[Dry run] Would send ${totalBatches} batch(es) of up to ${batchSize} facts to Haiku.`);
    console.log(`[Dry run] First batch preview (${Math.min(batchSize, facts.length)} facts):`);
    for (const f of facts.slice(0, Math.min(5, facts.length))) {
      console.log(`  [${f.id.slice(0, 8)}] ${f.content.slice(0, 100)}`);
    }
    console.log(`[Dry run] Would write changeset to: ${outPath}`);
    return;
  }

  // --- Load Anthropic SDK ---
  let Anthropic: typeof import('@anthropic-ai/sdk').default | null = null;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    console.error('Error: @anthropic-ai/sdk is required. Install with: npm install -g @anthropic-ai/sdk');
    process.exit(1);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const client = new Anthropic!({ apiKey });

  // --- Process in batches ---
  const changeset: DreamChangeset = {
    date: today,
    entities_to_create: [],
    pages_to_update: [],
    contradictions: [],
  };

  const totalBatches = Math.ceil(facts.length / batchSize);
  console.log(`\nScanning ${facts.length} fact(s) in ${totalBatches} batch(es) of ${batchSize}…`);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * batchSize;
    const batch = facts.slice(start, start + batchSize);

    process.stdout.write(
      `  Batch ${batchIdx + 1}/${totalBatches} (${batch.length} facts)… `,
    );

    try {
      const result = await scanBatchWithHaiku(
        client,
        batch,
        existingPages,
        chatContext,
        batchIdx + 1,
        totalBatches,
      );
      mergeIntoChangeset(changeset, result);
      console.log(
        `done (+${result.entities_to_create.length} new, ` +
          `${result.pages_to_update.length} updates, ` +
          `${result.contradictions.length} contradictions)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      console.error(`  Skipping batch ${batchIdx + 1} due to error.`);
    }

    if (batchIdx < totalBatches - 1) {
      await sleep(200);
    }
  }

  // --- Write output ---
  mkdirSync('/tmp', { recursive: true });
  writeFileSync(outPath, JSON.stringify(changeset, null, 2), 'utf8');

  console.log(`\nScan complete.`);
  console.log(`  New entities:   ${changeset.entities_to_create.length}`);
  console.log(`  Page updates:   ${changeset.pages_to_update.length}`);
  console.log(`  Contradictions: ${changeset.contradictions.length}`);
  console.log(`  Changeset:      ${outPath}`);
}
