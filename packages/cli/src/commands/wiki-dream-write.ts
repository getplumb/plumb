/**
 * wiki-dream-write.ts — Sonnet write phase of the nightly dream cron (spec §5.2, steps 3-4).
 *
 * Reads the changeset JSON produced by wiki-dream-scan (T-209) and:
 *   1. Creates new wiki pages for each entity_to_create using Sonnet.
 *   2. Updates existing pages for each page_to_update using Sonnet.
 *   3. Auto-resolves contradictions (update immediately; flag high-sensitivity to REVIEW.md).
 *   4. Splits pages exceeding 1000 words (§7 chunking procedure).
 *   5. Appends a session summary to log.md.
 *   6. Rebuilds index.md and _index.md via wiki-build-index.
 *
 * Usage:
 *   plumb wiki dream-write [--changeset <path>] [--wiki <path>] [--date <YYYY-MM-DD>]
 *                          [--concurrency <n>] [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { DreamChangeset, EntityToCreate, PageUpdate, Contradiction } from './wiki-dream-scan.js';
import { wikiBuildIndexCommand } from './wiki-build-index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Entity type → wiki subdirectory mapping */
const TYPE_DIR: Record<string, string> = {
  person: 'people',
  company: 'companies',
  project: 'projects',
  concept: 'concepts',
  interview: 'interviews',
  story: 'stories',
  life: 'life',
};

/** High-sensitivity field keywords per SCHEMA.md §10 */
const HIGH_SENSITIVITY_KEYWORDS = [
  'home address',
  'address',
  'job',
  'employment',
  'employment status',
  'relationship status',
  'relationship',
  'financial',
  'finances',
  'finance',
  'salary',
  'income',
  'health',
  'medical',
  'insurance',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiDreamWriteOptions {
  /** Path to changeset JSON. Defaults to /tmp/wiki-dream-changeset-<date>.json */
  changeset?: string;
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Date string YYYY-MM-DD. Defaults to today */
  date?: string;
  /** Max concurrent Sonnet calls. Defaults to 3 */
  concurrency?: number;
  /** If true, skip writes and print what would happen */
  dryRun?: boolean;
}

interface SessionStats {
  created: Array<{ path: string; reason: string }>;
  updated: Array<{ path: string; what: string }>;
  contradictionsResolved: Array<{ path: string; field: string; oldVal: string; newVal: string }>;
  splitPages: Array<{ parent: string; child: string }>;
  errors: Array<{ path: string; error: string }>;
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

/** Convert a name to kebab-case slug for filenames. */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Determine whether a contradiction field is high-sensitivity. */
function isHighSensitivity(field: string): boolean {
  const lower = field.toLowerCase();
  return HIGH_SENSITIVITY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Count words in a string (split on whitespace). */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Get current time in HH:MM format. */
function nowHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

// ---------------------------------------------------------------------------
// Sonnet prompts
// ---------------------------------------------------------------------------

const CREATE_SYSTEM_PROMPT = `You are a wiki page author for a personal knowledge base called Plumb.
Your job is to write a single wiki page in Markdown format for a named entity.

You must output a complete wiki page with:
1. YAML frontmatter block (between --- delimiters)
2. Markdown body starting with an H1 title

## Frontmatter fields (all required):
  type: <type>           # person | company | project | concept | interview | story | life
  created: YYYY-MM-DD    # today's date
  updated: YYYY-MM-DD    # today's date
  source_refs:           # block list of sources
    - chat:YYYY-MM-DD
  tags: []               # lowercase, hyphenated tags (or [])
  confidence: high       # high | medium | low (high = many facts; low = sparse)

## Body structure by type:

### person
# Full Name
One-line summary (role + relationship to Clay).
## Role
## Background
## Relationship to Clay
## Key Quotes  (only if there are direct quotes)
## Related

### company
# Company Name
One-line summary.
## Overview
## Key People
## Clay's History
## Related

### project
# Project Name
One-line summary.
## Status
## Goal
## Architecture / Approach
## Milestones
## Related

### concept
# Concept Name
One-line summary / definition.
## Core Idea
## Applications
## Related

## Rules:
- Only include sections you have content for; omit empty sections
- Use [[Wikilink]] style for cross-references to other entities
- Keep total page under ~800 words
- Set confidence to: high (5+ facts), medium (2-4 facts), low (1 fact)
- Output ONLY the wiki page (frontmatter + body), no preamble or explanation`;

const UPDATE_SYSTEM_PROMPT = `You are a wiki page editor for a personal knowledge base called Plumb.
You will receive an existing wiki page and a list of changes to incorporate.

Your job:
1. Integrate all new information into the appropriate sections
2. Update the "updated" date in frontmatter to today's date
3. Preserve all existing content that is not contradicted
4. Keep the page under ~800 words; condense if necessary
5. Maintain correct frontmatter structure and YAML validity
6. Use [[Wikilink]] style for references to other pages

Output ONLY the updated wiki page (frontmatter + body), no preamble or explanation.`;

const CONTRADICTION_SYSTEM_PROMPT = `You are a wiki page editor for a personal knowledge base called Plumb.
You will receive an existing wiki page and a contradiction — a field where today's facts differ from what the page says.

Your job:
1. Update the contradicted field/section to reflect the NEW value (newest context wins)
2. Update the "updated" date in frontmatter to today's date
3. Preserve all other content unchanged
4. Keep the page under ~800 words

Output ONLY the updated wiki page (frontmatter + body), no preamble or explanation.`;

const SPLIT_SYSTEM_PROMPT = `You are a wiki page editor for a personal knowledge base called Plumb.
This page is too long (over 1000 words). You must split it into a parent page and one child page.

Rules:
1. Identify the largest or most distinct H2 section — that becomes the child page
2. The parent page replaces the extracted section with a brief (2-3 sentence) summary and a [[wikilink]] to the child
3. The child page gets its own frontmatter (same type/created/source_refs; updated = today; tags/confidence copied from parent)
4. The child page title = parent title + " — " + section name (e.g. "Dylan Sellberg — Background")
5. Both pages stay under ~800 words

Output exactly this format (no extra text):
===PARENT===
<full parent page content>
===CHILD_TITLE===
<child page title (H1, no # prefix)>
===CHILD===
<full child page content>`;

// ---------------------------------------------------------------------------
// Sonnet API calls
// ---------------------------------------------------------------------------

async function callSonnet(
  client: import('@anthropic-ai/sdk').default,
  system: string,
  userContent: string,
  maxTokens = 3000,
): Promise<string> {
  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  );
  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) throw new Error('Sonnet returned empty response');
  return text;
}

// ---------------------------------------------------------------------------
// Create phase
// ---------------------------------------------------------------------------

/**
 * Generate a new wiki page for an entity using Sonnet.
 * Returns the relative path written, or null on skip/error.
 */
async function createPage(
  entity: EntityToCreate,
  wikiRoot: string,
  today: string,
  client: import('@anthropic-ai/sdk').default,
  dryRun: boolean,
  stats: SessionStats,
): Promise<string | null> {
  const dir = TYPE_DIR[entity.type] ?? 'concepts';
  const slug = toSlug(entity.name);
  const relPath = `${dir}/${slug}.md`;
  const absPath = join(wikiRoot, relPath);

  // Skip if page already exists
  if (existsSync(absPath)) {
    console.log(`  [skip] ${relPath} — already exists`);
    return null;
  }

  const factsText = entity.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const userMessage = `Generate a wiki page for the following ${entity.type}: "${entity.name}"
Today's date: ${today}

## Known facts:
${factsText}

## Source refs for frontmatter:
  - chat:${today}`;

  if (dryRun) {
    console.log(`  [dry-run] Would create: ${relPath}`);
    return relPath;
  }

  try {
    const pageContent = await callSonnet(client, CREATE_SYSTEM_PROMPT, userMessage);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, pageContent + '\n', 'utf8');
    console.log(`  Created: ${relPath}`);
    stats.created.push({ path: relPath, reason: `${entity.facts.length} fact(s) from dream scan` });
    return relPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Error creating ${relPath}: ${msg}`);
    stats.errors.push({ path: relPath, error: msg });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update phase
// ---------------------------------------------------------------------------

/**
 * Update an existing page to incorporate new changes and/or resolve contradictions.
 * Combines updates + contradictions for the same page into one Sonnet call.
 */
async function updatePage(
  relPath: string,
  wikiRoot: string,
  updates: PageUpdate | null,
  contradictions: Contradiction[],
  today: string,
  client: import('@anthropic-ai/sdk').default,
  dryRun: boolean,
  stats: SessionStats,
): Promise<boolean> {
  const absPath = join(wikiRoot, relPath);

  if (!existsSync(absPath)) {
    console.log(`  [skip] ${relPath} — file not found on disk`);
    return false;
  }

  let existingContent: string;
  try {
    existingContent = await readFile(absPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Error reading ${relPath}: ${msg}`);
    stats.errors.push({ path: relPath, error: `read failed: ${msg}` });
    return false;
  }

  const hasUpdates = updates && updates.changes.length > 0;
  const hasContradictions = contradictions.length > 0;

  if (!hasUpdates && !hasContradictions) return false;

  // Determine if any contradiction is high-sensitivity
  const highSensContradictions = contradictions.filter((c) => isHighSensitivity(c.field));

  if (dryRun) {
    if (hasUpdates) {
      console.log(`  [dry-run] Would update: ${relPath} (${updates!.changes.length} change(s))`);
    }
    for (const c of contradictions) {
      const flag = isHighSensitivity(c.field) ? ' [HIGH-SENSITIVITY]' : '';
      console.log(`  [dry-run] Would resolve contradiction in ${relPath}: ${c.field}${flag}`);
    }
    return true;
  }

  try {
    let userMessage: string;
    let systemPrompt: string;

    if (hasContradictions && !hasUpdates) {
      // Contradiction-only: use contradiction prompt
      systemPrompt = CONTRADICTION_SYSTEM_PROMPT;
      const contLines = contradictions.map(
        (c) => `Field: ${c.field}\nOld value: ${c.old}\nNew value: ${c.new}`,
      ).join('\n\n');
      userMessage = `Today's date: ${today}

## Existing page:
${existingContent}

## Contradictions to resolve:
${contLines}`;
    } else {
      // Updates (possibly with contradictions): use update prompt
      systemPrompt = UPDATE_SYSTEM_PROMPT;
      const changeLines = hasUpdates
        ? updates!.changes.map((ch, i) => `${i + 1}. ${ch}`).join('\n')
        : '';
      const contLines = hasContradictions
        ? contradictions
            .map((c) => `- Field "${c.field}": was "${c.old}", now "${c.new}"`)
            .join('\n')
        : '';

      userMessage = `Today's date: ${today}

## Existing page:
${existingContent}

${hasUpdates ? `## New information to incorporate:\n${changeLines}` : ''}
${hasContradictions ? `\n## Contradictions to resolve:\n${contLines}` : ''}`;
    }

    const updatedContent = await callSonnet(client, systemPrompt, userMessage);
    await writeFile(absPath, updatedContent + '\n', 'utf8');

    // Log updates
    if (hasUpdates) {
      const summary = updates!.changes.slice(0, 2).join('; ');
      console.log(`  Updated: ${relPath} — ${summary}`);
      stats.updated.push({ path: relPath, what: summary });
    }

    // Log contradictions
    for (const c of contradictions) {
      const label = isHighSensitivity(c.field) ? ' [high-sensitivity]' : '';
      console.log(`  Resolved contradiction in ${relPath}: ${c.field}${label}`);
      stats.contradictionsResolved.push({
        path: relPath,
        field: c.field,
        oldVal: c.old,
        newVal: c.new,
      });
    }

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Error updating ${relPath}: ${msg}`);
    stats.errors.push({ path: relPath, error: msg });
    return false;
  }
}

// ---------------------------------------------------------------------------
// REVIEW.md logging
// ---------------------------------------------------------------------------

async function appendToReview(
  wikiRoot: string,
  contradictions: Contradiction[],
  today: string,
  timeStr: string,
  dryRun: boolean,
): Promise<void> {
  const highSens = contradictions.filter((c) => isHighSensitivity(c.field));
  if (highSens.length === 0) return;

  const reviewPath = join(wikiRoot, 'REVIEW.md');

  for (const c of highSens) {
    const entry = `\n## ${today} ${timeStr} MT — ${c.path}\n\n**Field:** ${c.field}\n**Old value:** ${c.old}\n**New value:** ${c.new}\n**Source:** chat:${today}\n**Resolution:** auto-resolved (newest context wins)\n\n---\n`;

    if (dryRun) {
      console.log(`  [dry-run] Would append to REVIEW.md for: ${c.path} / ${c.field}`);
      continue;
    }

    try {
      // If the file has the placeholder "(no entries yet)" text, we need to replace it
      let content = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '';
      if (content.includes('*(no entries yet)*')) {
        content = content.replace('\n*(no entries yet)*', '');
        writeFileSync(reviewPath, content, 'utf8');
      }
      await appendFile(reviewPath, entry, 'utf8');
    } catch (err) {
      console.error(`  Warning: could not append to REVIEW.md: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Chunking / split phase
// ---------------------------------------------------------------------------

/**
 * Check if a page exceeds 1000 words, and if so split it into parent + child.
 * Returns the child path if a split occurred, or null.
 */
async function maybeSplitPage(
  relPath: string,
  wikiRoot: string,
  today: string,
  client: import('@anthropic-ai/sdk').default,
  dryRun: boolean,
  stats: SessionStats,
): Promise<string | null> {
  const absPath = join(wikiRoot, relPath);
  if (!existsSync(absPath)) return null;

  let content: string;
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    return null;
  }

  const wordCount = countWords(content);
  if (wordCount <= 1000) return null;

  console.log(`  Page too long (${wordCount} words): ${relPath} — splitting…`);

  if (dryRun) {
    console.log(`  [dry-run] Would split: ${relPath}`);
    return null;
  }

  const userMessage = `Today's date: ${today}

## Page to split (${wordCount} words):
${content}

Split this page into parent + child as instructed.`;

  try {
    const raw = await callSonnet(client, SPLIT_SYSTEM_PROMPT, userMessage, 4000);

    // Parse the structured response
    const parentMatch = raw.match(/===PARENT===\s*([\s\S]*?)(?====CHILD_TITLE===)/);
    const childTitleMatch = raw.match(/===CHILD_TITLE===\s*([\s\S]*?)(?====CHILD===)/);
    const childMatch = raw.match(/===CHILD===\s*([\s\S]*?)$/);

    if (!parentMatch || !childTitleMatch || !childMatch) {
      console.error(`  Warning: could not parse split response for ${relPath}. Skipping split.`);
      return null;
    }

    const parentContent = (parentMatch[1] ?? '').trim();
    const childTitle = (childTitleMatch[1] ?? '').trim();
    const childContent = (childMatch[1] ?? '').trim();

    // Derive child path from child title
    const childSlug = toSlug(childTitle);
    const dir = relPath.includes('/') ? relPath.split('/')[0] : 'concepts';
    const childRelPath = `${dir}/${childSlug}.md`;
    const childAbsPath = join(wikiRoot, childRelPath);

    // Write parent (updated)
    await writeFile(absPath, parentContent + '\n', 'utf8');

    // Write child (new)
    if (existsSync(childAbsPath)) {
      // Avoid overwriting; append a suffix
      const altSlug = `${childSlug}-detail`;
      const altRelPath = `${dir}/${altSlug}.md`;
      await writeFile(join(wikiRoot, altRelPath), childContent + '\n', 'utf8');
      console.log(`  Split: ${relPath} → child: ${altRelPath}`);
      stats.splitPages.push({ parent: relPath, child: altRelPath });
      return altRelPath;
    }

    await writeFile(childAbsPath, childContent + '\n', 'utf8');
    console.log(`  Split: ${relPath} → child: ${childRelPath}`);
    stats.splitPages.push({ parent: relPath, child: childRelPath });
    return childRelPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Error splitting ${relPath}: ${msg}`);
    stats.errors.push({ path: relPath, error: `split failed: ${msg}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// log.md appending
// ---------------------------------------------------------------------------

async function appendToLog(
  wikiRoot: string,
  today: string,
  timeStr: string,
  stats: SessionStats,
  dryRun: boolean,
): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');

  const lines: string[] = [`\n## ${today}\n`, `### Dream Session (${timeStr} MT)`];

  for (const c of stats.created) {
    lines.push(`- Created: ${c.path} — ${c.reason}`);
  }
  for (const u of stats.updated) {
    lines.push(`- Updated: ${u.path} — ${u.what}`);
  }
  for (const c of stats.contradictionsResolved) {
    lines.push(
      `- Contradiction resolved: ${c.path} — ${c.field}: "${c.oldVal}" → "${c.newVal}"`,
    );
  }
  for (const s of stats.splitPages) {
    lines.push(`- Split: ${s.parent} → ${s.child} (page exceeded 1000 words)`);
  }
  for (const e of stats.errors) {
    lines.push(`- Error: ${e.path} — ${e.error}`);
  }

  if (
    stats.created.length === 0 &&
    stats.updated.length === 0 &&
    stats.contradictionsResolved.length === 0 &&
    stats.splitPages.length === 0 &&
    stats.errors.length === 0
  ) {
    lines.push('- No changes made.');
  }

  const entry = lines.join('\n') + '\n';

  if (dryRun) {
    console.log('\n[dry-run] Would append to log.md:');
    console.log(entry);
    return;
  }

  if (!existsSync(logPath)) {
    // Create a minimal log.md if it doesn't exist
    writeFileSync(
      logPath,
      '# Wiki Activity Log\n\nAppend-only. New entries go at the top (newest first). Never edit or delete past entries.\n\n---\n',
      'utf8',
    );
  }

  // Insert new entry after the "---" separator near the top (newest-first)
  try {
    const existing = readFileSync(logPath, 'utf8');
    const separatorIdx = existing.indexOf('\n---\n');
    if (separatorIdx !== -1) {
      const before = existing.slice(0, separatorIdx + 5); // include \n---\n
      const after = existing.slice(separatorIdx + 5);
      await writeFile(logPath, before + entry + after, 'utf8');
    } else {
      await appendFile(logPath, entry, 'utf8');
    }
  } catch {
    await appendFile(logPath, entry, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Run async tasks with limited concurrency.
 */
async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const myIdx = idx++;
      results[myIdx] = await tasks[myIdx]!();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function wikiDreamWriteCommand(
  options: WikiDreamWriteOptions = {},
): Promise<void> {
  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const changesetPath =
    options.changeset ?? `/tmp/wiki-dream-changeset-${today}.json`;
  const concurrency = options.concurrency ?? 3;
  const dryRun = options.dryRun ?? false;
  const timeStr = nowHHMM();

  console.log(`Wiki dream write — ${today}`);
  console.log(`  changeset: ${changesetPath}`);
  console.log(`  wiki:      ${wikiRoot}`);
  if (dryRun) console.log(`  [dry-run mode]`);

  // --- Load changeset ---
  if (!existsSync(changesetPath)) {
    console.error(`Error: Changeset not found at ${changesetPath}`);
    console.error('Run "plumb wiki dream-scan" first.');
    process.exit(1);
  }

  let changeset: DreamChangeset;
  try {
    const raw = readFileSync(changesetPath, 'utf8');
    changeset = JSON.parse(raw) as DreamChangeset;
  } catch (err) {
    console.error(`Error: Could not parse changeset JSON: ${err}`);
    process.exit(1);
  }

  console.log(`\nChangeset summary:`);
  console.log(`  Entities to create:   ${changeset.entities_to_create.length}`);
  console.log(`  Pages to update:      ${changeset.pages_to_update.length}`);
  console.log(`  Contradictions:       ${changeset.contradictions.length}`);

  const hasWork =
    changeset.entities_to_create.length > 0 ||
    changeset.pages_to_update.length > 0 ||
    changeset.contradictions.length > 0;

  if (!hasWork) {
    console.log('\nNothing to do — changeset is empty.');
    // Still rebuild index and append to log
    await appendToLog(wikiRoot, today, timeStr, {
      created: [],
      updated: [],
      contradictionsResolved: [],
      splitPages: [],
      errors: [],
    }, dryRun);
    if (!dryRun) {
      console.log('\nRebuilding index…');
      await wikiBuildIndexCommand({ wiki: wikiRoot });
    }
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

  const stats: SessionStats = {
    created: [],
    updated: [],
    contradictionsResolved: [],
    splitPages: [],
    errors: [],
  };

  // Track all paths that were modified (for chunking phase)
  const modifiedPaths = new Set<string>();

  // --- Phase 1: Create new pages ---
  if (changeset.entities_to_create.length > 0) {
    console.log(`\nPhase 1: Creating ${changeset.entities_to_create.length} new page(s)…`);
    const createTasks = changeset.entities_to_create.map((entity) => () =>
      createPage(entity, wikiRoot, today, client, dryRun, stats),
    );
    const createdPaths = await runConcurrent(createTasks, concurrency);
    for (const p of createdPaths) {
      if (p) modifiedPaths.add(p);
    }
  }

  // --- Phase 2: Update existing pages + resolve contradictions ---
  // Group contradictions by path
  const contrByPath = new Map<string, Contradiction[]>();
  for (const c of changeset.contradictions) {
    if (!contrByPath.has(c.path)) contrByPath.set(c.path, []);
    contrByPath.get(c.path)!.push(c);
  }

  // Collect all paths that need updating (from updates + contradictions)
  const updatePaths = new Set<string>([
    ...changeset.pages_to_update.map((u) => u.path),
    ...changeset.contradictions.map((c) => c.path),
  ]);

  if (updatePaths.size > 0) {
    console.log(`\nPhase 2: Updating ${updatePaths.size} existing page(s)…`);

    // Build index of page_to_update by path for quick lookup
    const updatesByPath = new Map<string, PageUpdate>();
    for (const u of changeset.pages_to_update) {
      updatesByPath.set(u.path, u);
    }

    const updateTasks = Array.from(updatePaths).map((relPath) => async () => {
      const updates = updatesByPath.get(relPath) ?? null;
      const contradictions = contrByPath.get(relPath) ?? [];
      const modified = await updatePage(
        relPath,
        wikiRoot,
        updates,
        contradictions,
        today,
        client,
        dryRun,
        stats,
      );
      if (modified) modifiedPaths.add(relPath);
    });

    await runConcurrent(updateTasks, concurrency);
  }

  // --- REVIEW.md logging for high-sensitivity contradictions ---
  if (changeset.contradictions.length > 0) {
    await appendToReview(wikiRoot, changeset.contradictions, today, timeStr, dryRun);
  }

  // --- Phase 3: Chunking — split oversized pages ---
  if (modifiedPaths.size > 0) {
    console.log(`\nPhase 3: Checking ${modifiedPaths.size} modified page(s) for size limit…`);
    const splitTasks = Array.from(modifiedPaths).map((relPath) => async () => {
      const childPath = await maybeSplitPage(relPath, wikiRoot, today, client, dryRun, stats);
      if (childPath) modifiedPaths.add(childPath);
    });
    // Run splits sequentially to avoid racing on same files
    for (const task of splitTasks) {
      await task();
    }
  }

  // --- Phase 4: Append session summary to log.md ---
  console.log('\nAppending session summary to log.md…');
  await appendToLog(wikiRoot, today, timeStr, stats, dryRun);

  // --- Phase 5: Rebuild index ---
  if (!dryRun) {
    console.log('\nRebuilding wiki index…');
    await wikiBuildIndexCommand({ wiki: wikiRoot });
  } else {
    console.log('\n[dry-run] Would rebuild wiki index.');
  }

  // --- Summary ---
  console.log('\nDream write complete.');
  console.log(`  Created:               ${stats.created.length}`);
  console.log(`  Updated:               ${stats.updated.length}`);
  console.log(`  Contradictions resolved: ${stats.contradictionsResolved.length}`);
  console.log(`  Pages split:           ${stats.splitPages.length}`);
  if (stats.errors.length > 0) {
    console.log(`  Errors:                ${stats.errors.length}`);
  }
}
