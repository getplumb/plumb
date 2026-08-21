/**
 * wiki-seed-extract.ts — Entity extraction from Plumb V1 memory facts.
 *
 * Reads all memory_facts from the Plumb database, batches them, and uses
 * Claude Haiku to extract named entities (people, companies, projects, concepts).
 * Outputs a deduplicated JSON registry of entities with their type and source fact IDs.
 *
 * Phase 1 of the big bang wiki seed. Entity prose generation is T-206.
 *
 * Usage:
 *   plumb wiki-seed-extract [--db <path>] [--out <path>] [--batch-size <n>] [--dry-run]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '@getplumb/core';
import { getDefaultDbPath } from '../utils/db-path.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = 'person' | 'company' | 'project' | 'concept';

export interface ExtractedEntity {
  /** Canonical name, e.g. "Jordan Lee" or "OpenAI" */
  name: string;
  /** Entity category */
  type: EntityType;
  /** IDs of facts that mention this entity */
  source_fact_ids: string[];
}

export interface EntityRegistry {
  /** ISO 8601 timestamp when this registry was generated */
  generated_at: string;
  /** Total facts processed */
  facts_processed: number;
  /** Total unique entities found */
  entity_count: number;
  /** Deduplicated entity list, sorted by type then name */
  entities: ExtractedEntity[];
}

interface RawFact {
  id: string;
  content: string;
}

// Response shape we expect from Haiku
interface HaikuEntityBatch {
  entities: Array<{
    name: string;
    type: EntityType;
  }>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WikiSeedExtractOptions {
  /** Path to Plumb memory database. Defaults to ~/.plumb/memory.db */
  db?: string;
  /** Output file path for the entity registry JSON. Defaults to ~/.plumb/wiki/entity-registry.json */
  out?: string;
  /** Facts per Haiku request. Defaults to 20 */
  batchSize?: number;
  /** If true, skip Haiku calls and print what would be sent */
  dryRun?: boolean;
  /** User ID to query facts for. Defaults to 'default' */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Rate-limit helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a Haiku call with exponential back-off on rate-limit (429) errors.
 * Gives up after maxAttempts.
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
      // Check for Anthropic SDK rate-limit errors (status 429) or overload (529)
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
// Haiku extraction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an entity extractor for a personal knowledge base belonging to Clay Waters.
Your job is to identify entities that DESERVE a dedicated wiki page — meaning Clay has a meaningful,
ongoing relationship with them. Do NOT extract entities that are merely mentioned in passing.

An entity QUALIFIES if ONE OR MORE of these is true:
- person: Someone Clay knows personally, has worked with, is interviewing with, or has a real ongoing relationship with
- company: A company Clay works at, has worked at, is actively interviewing at, has built something for, or uses as a core daily tool
- project: A project, codebase, or product Clay built, maintains, actively uses, or is currently developing
- concept: A framework, methodology, or technology Clay actively applies in his work — not just mentioned once as context

An entity does NOT qualify if:
- Clay merely mentioned it as background context, an example, or a passing reference
- It's a well-known brand with no specific Clay connection (e.g. Instagram, Disney, AMC, Netflix)
- It appeared only as a comparison point or industry example
- It's a generic tool Clay has no meaningful history with

For each qualifying entity, output:
- name: Canonical proper name (correct casing)
- type: One of: person, company, project, concept

Rules:
- When in doubt, leave it out — a small high-quality wiki beats a large generic one
- Deduplicate: output each unique entity once
- Respond ONLY with valid JSON matching the schema: {"entities": [{"name": string, "type": string}]}`;

/**
 * Call Haiku with a batch of facts and return extracted entities.
 */
async function extractEntitiesFromBatch(
  client: import('@anthropic-ai/sdk').default,
  facts: RawFact[],
): Promise<HaikuEntityBatch> {
  const factsText = facts
    .map((f, i) => `[${i + 1}] ${f.content}`)
    .join('\n\n');

  const userPrompt = `Extract entities from these ${facts.length} memory facts:\n\n${factsText}`;

  const message = await withRetry(() =>
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  );

  const text =
    message.content[0]?.type === 'text' ? message.content[0].text : '';

  // Parse JSON response
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned) as HaikuEntityBatch;
    if (!Array.isArray(parsed.entities)) {
      throw new Error('Response missing "entities" array');
    }
    return parsed;
  } catch (parseErr) {
    console.error(`  Warning: Failed to parse Haiku response: ${text.slice(0, 200)}`);
    return { entities: [] };
  }
}

// ---------------------------------------------------------------------------
// Deduplication and merging
// ---------------------------------------------------------------------------

/**
 * Merge new entities from a batch into the accumulator map.
 * Key: "<type>:<lower(name)>" for deduplication.
 * When same entity appears in multiple batches, merge source_fact_ids.
 */
function mergeEntities(
  acc: Map<string, ExtractedEntity>,
  batchEntities: HaikuEntityBatch['entities'],
  factIds: string[],
): void {
  const validTypes = new Set<string>(['person', 'company', 'project', 'concept']);

  for (const raw of batchEntities) {
    const name = (raw.name ?? '').trim();
    const type = (raw.type ?? '').trim() as EntityType;

    if (!name || !validTypes.has(type)) continue;

    const key = `${type}:${name.toLowerCase()}`;
    const existing = acc.get(key);

    if (existing) {
      // Merge fact IDs, preserving uniqueness
      for (const id of factIds) {
        if (!existing.source_fact_ids.includes(id)) {
          existing.source_fact_ids.push(id);
        }
      }
    } else {
      acc.set(key, {
        name,
        type,
        source_fact_ids: [...factIds],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entity extraction command handler.
 * Reads all memory facts, batches them through Haiku, and writes a JSON registry.
 */
export async function wikiSeedExtractCommand(
  options: WikiSeedExtractOptions = {},
): Promise<void> {
  const dbPath = options.db ?? getDefaultDbPath();
  const outPath =
    options.out ?? join(homedir(), '.plumb', 'wiki', 'entity-registry.json');
  const batchSize = options.batchSize ?? 20;
  const userId = options.userId ?? 'default';
  const dryRun = options.dryRun ?? false;

  // --- Validate DB exists ---
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    process.exit(1);
  }

  // --- Load Anthropic SDK (optional dependency) ---
  let Anthropic: typeof import('@anthropic-ai/sdk').default | null = null;
  if (!dryRun) {
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    } catch {
      console.error('Error: @anthropic-ai/sdk is required for entity extraction.');
      console.error('Install with: npm install -g @anthropic-ai/sdk');
      process.exit(1);
    }

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
      process.exit(1);
    }
  }

  // --- Read all memory facts ---
  const db = await openDb(dbPath);
  let facts: RawFact[] = [];
  try {
    const stmt = db.prepare(
      `SELECT id, content FROM memory_facts WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    );
    stmt.bind([userId]);
    while (stmt.step()) {
      const row = stmt.get({}) as { id: string; content: string };
      facts.push({ id: row.id, content: row.content });
    }
    stmt.finalize();
  } finally {
    db.close();
  }

  if (facts.length === 0) {
    console.log('No memory facts found. Nothing to extract.');
    process.exit(0);
  }

  console.log(`Found ${facts.length} memory facts. Processing in batches of ${batchSize}…`);

  // --- Dry run mode ---
  if (dryRun) {
    const batches = Math.ceil(facts.length / batchSize);
    console.log(`[Dry run] Would send ${batches} batch(es) to Haiku.`);
    console.log(`[Dry run] First batch preview:`);
    const preview = facts.slice(0, batchSize);
    for (const f of preview) {
      console.log(`  [${f.id.slice(0, 8)}…] ${f.content.slice(0, 100)}`);
    }
    return;
  }

  // --- Initialize Haiku client ---
  const apiKey = process.env['ANTHROPIC_API_KEY']!;
  const client = new Anthropic!({ apiKey });

  // --- Process in batches ---
  const entityMap = new Map<string, ExtractedEntity>();
  const totalBatches = Math.ceil(facts.length / batchSize);
  let processedFacts = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * batchSize;
    const batch = facts.slice(start, start + batchSize);
    const factIds = batch.map((f) => f.id);

    process.stdout.write(
      `  Batch ${batchIdx + 1}/${totalBatches} (${batch.length} facts)… `,
    );

    try {
      const result = await extractEntitiesFromBatch(client, batch);
      mergeEntities(entityMap, result.entities, factIds);
      processedFacts += batch.length;
      console.log(`done (${result.entities.length} entities found)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      console.error(`  Skipping batch ${batchIdx + 1} due to error.`);
    }

    // Small inter-batch delay to avoid hammering the API
    if (batchIdx < totalBatches - 1) {
      await sleep(200);
    }
  }

  // --- Build and sort registry ---
  const entities = Array.from(entityMap.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  const registry: EntityRegistry = {
    generated_at: new Date().toISOString(),
    facts_processed: processedFacts,
    entity_count: entities.length,
    entities,
  };

  // --- Write output ---
  writeFileSync(outPath, JSON.stringify(registry, null, 2), 'utf8');

  console.log(`\nExtracted ${entities.length} unique entities from ${processedFacts} facts.`);
  console.log(`Registry written to: ${outPath}`);

  // Summary by type
  const byType = new Map<EntityType, number>();
  for (const e of entities) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  for (const [type, count] of [...byType.entries()].sort()) {
    console.log(`  ${type}: ${count}`);
  }
}
