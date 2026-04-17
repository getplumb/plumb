/**
 * wiki-seed-generate.ts — Page generation from entity registry (Phase 2).
 *
 * Reads the entity registry JSON produced by wiki-seed-extract, gathers
 * related Plumb V1 facts from memory.db and excerpts from memory/ log files,
 * then calls Sonnet to generate a full wiki page (YAML frontmatter + markdown
 * body) per entity. Writes pages to ~/.plumb/wiki/<type>/ directories.
 *
 * Concurrency: max 5 Sonnet calls in flight. Skips entities that already
 * have a page on disk.
 *
 * Usage:
 *   plumb wiki-seed-generate [--registry <path>] [--wiki <path>] [--db <path>]
 *                            [--concurrency <n>] [--dry-run]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb, parseFrontmatter } from '@getplumb/core';
import { WikiService, WikiValidationError } from '@getplumb/wiki';
import { getDefaultDbPath } from '../utils/db-path.js';
import type { EntityRegistry, ExtractedEntity, EntityType } from './wiki-seed-extract.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

/** Map entity type → wiki subdirectory */
const TYPE_DIR: Record<EntityType, string> = {
  person: 'people',
  company: 'companies',
  project: 'projects',
  concept: 'concepts',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiSeedGenerateOptions {
  /** Path to the entity registry JSON from wiki-seed-extract. Defaults to ~/.plumb/wiki/entity-registry.json */
  registry?: string;
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wiki?: string;
  /** Path to Plumb memory database. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Max concurrent Sonnet calls. Defaults to 5 */
  concurrency?: number;
  /** If true, skip Sonnet calls and print what would be generated */
  dryRun?: boolean;
  /** User ID to query facts for. Defaults to 'default' */
  userId?: string;
}

interface RawFact {
  id: string;
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Filename / path helpers
// ---------------------------------------------------------------------------

/**
 * Convert an entity name to a kebab-case filename.
 * "Dylan Sellberg" → "dylan-sellberg"
 * "OpenAI" → "openai"
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build the relative path for an entity's wiki page.
 * e.g. person "Dylan Sellberg" → "people/dylan-sellberg.md"
 */
function entityRelPath(entity: ExtractedEntity): string {
  const dir = TYPE_DIR[entity.type];
  const slug = toSlug(entity.name);
  return `${dir}/${slug}.md`;
}

// ---------------------------------------------------------------------------
// Rate-limit helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a Sonnet call with exponential back-off on 429/529 errors.
 */
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

      if (!isRateLimit || attempt >= maxAttempts) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(
        `  Rate-limited (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms…`,
      );
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

/**
 * Run an array of task factories with a bounded concurrency limit.
 * Returns results in the same order as tasks; errors are captured, not thrown.
 */
async function runConcurrently<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<Array<T | Error>> {
  const results: Array<T | Error> = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await tasks[idx]!();
      } catch (err) {
        results[idx] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  if (workerCount === 0) return results;

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Fact retrieval from memory.db
// ---------------------------------------------------------------------------

/**
 * Look up a set of facts by ID from memory.db.
 * Returns facts in the order they appear in the database.
 */
async function fetchFacts(
  dbPath: string,
  factIds: string[],
  userId: string,
): Promise<RawFact[]> {
  if (factIds.length === 0) return [];

  const db = await openDb(dbPath);
  const facts: RawFact[] = [];
  try {
    // SQLite WASM doesn't support array binding; query individually
    for (const id of factIds) {
      const stmt = db.prepare(
        `SELECT id, content, created_at FROM memory_facts
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      );
      stmt.bind([id, userId]);
      if (stmt.step()) {
        const row = stmt.get({}) as { id: string; content: string; created_at: string };
        facts.push(row);
      }
      stmt.finalize();
    }
  } finally {
    db.close();
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Memory log file search
// ---------------------------------------------------------------------------

/**
 * Search all YYYY-MM-DD.md files in memoryDir for lines mentioning entityName.
 * Returns an array of { file: relative path, excerpt: matched line } objects.
 * Gracefully returns [] if the directory does not exist.
 */
interface LogExcerpt {
  file: string;   // e.g. "memory/2026-03-10.md"
  excerpt: string;
}

async function searchMemoryLogs(
  memoryDir: string,
  entityName: string,
): Promise<LogExcerpt[]> {
  if (!existsSync(memoryDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  } catch {
    return [];
  }

  const results: LogExcerpt[] = [];
  const nameLower = entityName.toLowerCase();

  for (const entry of entries) {
    const absPath = join(memoryDir, entry);
    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes(nameLower)) {
        results.push({
          file: `memory/${entry}`,
          excerpt: line.trim(),
        });
        // Cap excerpts per file to avoid enormous prompts
        if (results.filter((r) => r.file === `memory/${entry}`).length >= 5) break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Sonnet page generation prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wiki page author for a personal knowledge base called Plumb.
Your job is to write a single wiki page in Markdown format for a named entity, using only the provided memory facts and log excerpts as your source material.

You must output a complete wiki page file with:
1. YAML frontmatter block (between --- delimiters)
2. Markdown body starting with an H1 title

CRITICAL: Never wrap the YAML frontmatter in a code fence (\`\`\`yaml, \`\`\`markdown, \`\`\`, or any variant). The very first line of your output must be --- on its own. Any code fence will break the indexer.

## Frontmatter fields (all required):
  type: <type>           # person | company | tool | project | concept | interview | story | life
  created: YYYY-MM-DD    # today's date
  updated: YYYY-MM-DD    # today's date
  source_refs:           # block list of plumb:<fact-id> and/or memory/YYYY-MM-DD.md
    - plumb:<id>
  tags: []               # lowercase, hyphenated tags relevant to the entity (or [])
  confidence: high       # high | medium | low  (high = many facts; low = sparse)

## Body structure by type:

### person
# Full Name
One-line summary (role + relationship to Clay).
## Role
## Background
## Relationship to Clay
## Key Quotes  (include only if there are direct quotes)
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
- Use [[Wikilink]] style for references to other entities by name
- Keep total page under ~800 words
- Set confidence to: high (5+ facts), medium (2-4 facts), low (1 fact or excerpts only)
- source_refs must list only the plumb:<id> and memory/YYYY-MM-DD.md refs you were given
- Output ONLY the wiki page (frontmatter + body), no preamble or explanation`;

/**
 * Build the user message for a Sonnet page generation call.
 */
function buildUserMessage(
  entity: ExtractedEntity,
  facts: RawFact[],
  logExcerpts: LogExcerpt[],
  today: string,
): string {
  const lines: string[] = [
    `Generate a wiki page for the following ${entity.type}: "${entity.name}"`,
    `Today's date: ${today}`,
    '',
  ];

  if (facts.length > 0) {
    lines.push(`## Memory Facts (${facts.length})`);
    for (const f of facts) {
      const dateStr = f.created_at ? f.created_at.slice(0, 10) : 'unknown';
      lines.push(`[plumb:${f.id}] (${dateStr}): ${f.content}`);
    }
    lines.push('');
  }

  if (logExcerpts.length > 0) {
    lines.push(`## Memory Log Excerpts`);
    for (const ex of logExcerpts) {
      lines.push(`[${ex.file}]: ${ex.excerpt}`);
    }
    lines.push('');
  }

  if (facts.length === 0 && logExcerpts.length === 0) {
    lines.push(`(No memory facts or log excerpts found for this entity.)`);
    lines.push('');
  }

  lines.push(`## Source refs available for frontmatter:`);
  for (const id of entity.source_fact_ids.slice(0, 20)) {
    lines.push(`  - plumb:${id}`);
  }
  for (const ex of logExcerpts) {
    const ref = ex.file;
    lines.push(`  - ${ref}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Page generation
// ---------------------------------------------------------------------------

interface GenerateResult {
  entity: ExtractedEntity;
  relPath: string;
  skipped: boolean;
  skipReason?: string;
  written?: boolean;
}

/**
 * Generate and write a wiki page for a single entity.
 * Returns a result descriptor; never throws.
 */
async function generatePage(
  entity: ExtractedEntity,
  wikiRoot: string,
  dbPath: string,
  memoryDir: string,
  userId: string,
  client: import('@anthropic-ai/sdk').default,
  dryRun: boolean,
): Promise<GenerateResult> {
  const relPath = entityRelPath(entity);
  const absPath = join(wikiRoot, relPath);

  // Skip if page already exists
  if (existsSync(absPath)) {
    return { entity, relPath, skipped: true, skipReason: 'already exists' };
  }

  if (dryRun) {
    return { entity, relPath, skipped: true, skipReason: 'dry-run' };
  }

  // Gather facts and log excerpts
  const [facts, logExcerpts] = await Promise.all([
    fetchFacts(dbPath, entity.source_fact_ids, userId),
    searchMemoryLogs(memoryDir, entity.name),
  ]);

  // Skip if there is no real source material — don't write stub pages
  if (facts.length === 0 && logExcerpts.length === 0) {
    return { entity, relPath, skipped: true, skipReason: 'no source material' };
  }
  if (facts.length < 2 && logExcerpts.length === 0) {
    return { entity, relPath, skipped: true, skipReason: `insufficient source material (${facts.length} fact, 0 excerpts)` };
  }

  // Call Sonnet
  const userMessage = buildUserMessage(entity, facts, logExcerpts, TODAY);

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  );

  const pageContent =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

  if (!pageContent) {
    throw new Error('Sonnet returned empty response');
  }

  // Parse frontmatter from LLM output, then write via the WaaS gate.
  // This enforces frontmatter validation and auto-updates wiki.db.
  const wiki = WikiService.createFilesystemOnly(wikiRoot);
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(pageContent);
  } catch (parseErr) {
    throw new Error(
      `Sonnet output has malformed frontmatter for ${relPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }

  try {
    await wiki.write({
      path: relPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      sourceRef: 'seed',
    });
  } catch (err) {
    if (err instanceof WikiValidationError) {
      const fieldList = err.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Frontmatter validation failed for ${relPath} — ${fieldList}`);
    }
    throw err;
  }

  return { entity, relPath, skipped: false, written: true };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function wikiSeedGenerateCommand(
  options: WikiSeedGenerateOptions = {},
): Promise<void> {
  const registryPath =
    options.registry ?? join(homedir(), '.plumb', 'wiki', 'entity-registry.json');
  const wikiRoot = options.wiki ?? join(homedir(), '.plumb', 'wiki');
  const dbPath = options.db ?? getDefaultDbPath();
  const memoryDir = join(homedir(), '.plumb', 'memory');
  const concurrency = options.concurrency ?? 5;
  const userId = options.userId ?? 'default';
  const dryRun = options.dryRun ?? false;

  // --- Validate inputs ---
  if (!existsSync(registryPath)) {
    console.error(`Error: Entity registry not found at ${registryPath}`);
    console.error('Run "plumb wiki-seed-extract" first to generate the registry.');
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // --- Load registry ---
  let registry: EntityRegistry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8')) as EntityRegistry;
  } catch (err) {
    console.error(`Error: Failed to parse entity registry: ${err}`);
    process.exit(1);
  }

  const { entities } = registry;
  console.log(`Entity registry: ${entities.length} entities (generated ${registry.generated_at})`);

  // --- Load Anthropic SDK ---
  let Anthropic: typeof import('@anthropic-ai/sdk').default | null = null;
  if (!dryRun) {
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    } catch {
      console.error('Error: @anthropic-ai/sdk is required for page generation.');
      process.exit(1);
    }

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
      process.exit(1);
    }
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const client = dryRun ? null : new Anthropic!({ apiKey });

  // --- Count skippable pages up front ---
  const toProcess = entities.filter((e) => {
    const absPath = join(wikiRoot, entityRelPath(e));
    return !existsSync(absPath);
  });
  const alreadyExists = entities.length - toProcess.length;

  if (alreadyExists > 0) {
    console.log(`Skipping ${alreadyExists} entities that already have pages on disk.`);
  }

  if (toProcess.length === 0) {
    console.log('All entities already have pages. Nothing to generate.');
    return;
  }

  if (dryRun) {
    console.log(`[Dry run] Would generate ${toProcess.length} pages (concurrency=${concurrency}):`);
    for (const e of toProcess) {
      console.log(`  ${entityRelPath(e)}  (${e.source_fact_ids.length} facts)`);
    }
    return;
  }

  console.log(
    `Generating ${toProcess.length} pages with Sonnet (concurrency=${concurrency})…`,
  );

  // --- Build and run task array ---
  let completed = 0;
  const tasks = toProcess.map((entity) => async (): Promise<GenerateResult> => {
    process.stdout.write(
      `  [${++completed}/${toProcess.length}] ${entity.name} (${entity.type})… `,
    );

    const result = await generatePage(
      entity,
      wikiRoot,
      dbPath,
      memoryDir,
      userId,
      client!,
      false,
    );

    if (result.written) {
      console.log(`written → ${result.relPath}`);
    } else if (result.skipped) {
      console.log(`skipped (${result.skipReason})`);
    }

    return result;
  });

  const results = await runConcurrently(tasks, concurrency);

  // --- Summary ---
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of results) {
    if (r instanceof Error) {
      failed++;
    } else if (r.written) {
      written++;
    } else {
      skipped++;
    }
  }

  console.log('');
  console.log(`Done.`);
  console.log(`  Written: ${written}`);
  if (skipped > 0) console.log(`  Skipped: ${skipped}`);
  if (failed > 0) console.log(`  Failed:  ${failed}`);
  console.log(`  Wiki root: ${wikiRoot}`);
}
