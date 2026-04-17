/**
 * writer.ts — Sonnet-based structured patch writer.
 *
 * Given an existing wiki page and one or more facts to incorporate, calls
 * claude-sonnet-4-6 to produce a WikiPatch (structured ops) rather than a full
 * page rewrite.
 *
 * Key constraints:
 *   - NEVER calls fs.writeFile or any file I/O — only emits WikiPatch objects.
 *   - Checks tombstones before emitting any op that would add text matching a
 *     manually-deleted sentence.
 *   - Tombstone-blocked content is silently dropped from the patch.
 */

import type { WasmDb } from '@getplumb/core';
import { type WikiPatch, type PatchOp, parsePatchOp } from './patch-schema.js';
import { isTombstoned } from './tombstone.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WriterInput {
  /** Relative path of the page being patched, e.g. "people/dylan-sellberg.md" */
  path: string;
  /** Full raw content of the existing page (frontmatter + body) */
  existingContent: string;
  /** One or more facts to incorporate into this page */
  facts: string[];
  /** Source reference for the changelog (typically queue item id or coalesced id) */
  sourceRef: string;
}

export type WriterFn = (
  input: WriterInput,
  db: WasmDb | null,
) => Promise<WikiPatch>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const WRITER_SYSTEM = `You are a wiki page patch writer for a personal knowledge base called Plumb.
You will receive an existing wiki page and one or more new facts to incorporate.

Output a JSON object with this exact structure:
{
  "path": "<the page path you received>",
  "source_ref": "<the source_ref you received>",
  "ops": [ /* array of patch operations */ ]
}

Patch operation types (use only these):

1. append_section — add content under an existing or new section heading
   {"op":"append_section","section":"<heading text without #>","content":"<markdown>"}

2. replace_paragraph — replace a paragraph identified by a unique anchor substring
   {"op":"replace_paragraph","anchor":"<unique substring>","replacement":"<new text>"}

3. update_line — replace a single line identified by a unique anchor substring
   {"op":"update_line","anchor":"<unique substring>","replacement":"<new line>"}

4. set_frontmatter — update a single frontmatter field
   {"op":"set_frontmatter","key":"<field>","value":"<value>"}

Rules:
- ALWAYS include a set_frontmatter op for "updated" with today's date (YYYY-MM-DD).
- Prefer replace_paragraph over append_section when updating existing information.
- Prefer update_line for single-line facts (job titles, dates, locations).
- Use append_section when adding entirely new information with no existing section.
- The anchor must be a substring that uniquely identifies the target — avoid generic words.
- Never duplicate existing content — only patch what changes.
- Keep patches minimal: 1-4 ops per fact is typical.
- Output ONLY the JSON object — no markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Sonnet API call
// ---------------------------------------------------------------------------

async function callSonnet(system: string, userContent: string): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const AnthropicModule = await import('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default;
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const text =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) throw new Error('Sonnet returned empty response');
  return text;
}

// ---------------------------------------------------------------------------
// Tombstone filtering
// ---------------------------------------------------------------------------

/**
 * Filter ops that would add tombstoned content.
 * An op is dropped if its added text (content/replacement) fully matches an
 * active tombstone sentence.
 */
function filterTombstonedOps(ops: PatchOp[], db: WasmDb): PatchOp[] {
  return ops.filter((op) => {
    let addedText: string | null = null;

    if (op.op === 'append_section') addedText = op.content;
    else if (op.op === 'replace_paragraph') addedText = op.replacement;
    else if (op.op === 'update_line') addedText = op.replacement;
    // set_frontmatter ops are never tombstoned

    if (addedText === null || addedText.trim() === '') return true;
    return !isTombstoned(db, addedText);
  });
}

// ---------------------------------------------------------------------------
// Public writer
// ---------------------------------------------------------------------------

/**
 * Generate a structured WikiPatch for a page given facts to incorporate.
 *
 * Never writes to the filesystem — only returns a patch object.
 * Tombstone-blocked ops are silently dropped.
 *
 * @param input  Page path, existing content, facts, and source reference
 * @param db     Open wiki.db with tombstone table (or null to skip tombstone check)
 * @returns      A WikiPatch ready for the applier
 */
export async function writePatch(
  input: WriterInput,
  db: WasmDb | null,
): Promise<WikiPatch> {
  const today = new Date().toISOString().slice(0, 10);

  const factsBlock = input.facts
    .map((f, i) => `${i + 1}. ${f}`)
    .join('\n');

  const userContent = `Today's date: ${today}
Path: ${input.path}
source_ref: ${input.sourceRef}

## Existing page content
\`\`\`markdown
${input.existingContent}
\`\`\`

## Facts to incorporate
${factsBlock}`;

  const raw = await callSonnet(WRITER_SYSTEM, userContent);

  // Strip optional markdown code fence
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Writer returned invalid JSON: ${raw.slice(0, 300)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Writer returned non-object JSON');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj['ops'])) {
    throw new Error('Writer response missing ops array');
  }

  const ops = (obj['ops'] as unknown[]).map(parsePatchOp);

  // Ensure updated frontmatter op is present
  const hasUpdatedOp = ops.some(
    (op) => op.op === 'set_frontmatter' && op.key === 'updated',
  );
  const finalOps: PatchOp[] = hasUpdatedOp
    ? ops
    : [...ops, { op: 'set_frontmatter', key: 'updated', value: today }];

  // Apply tombstone filtering
  const filteredOps = db !== null ? filterTombstonedOps(finalOps, db) : finalOps;

  return {
    path: input.path,
    source_ref: input.sourceRef,
    ops: filteredOps,
  };
}
