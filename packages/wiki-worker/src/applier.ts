/**
 * applier.ts — Deterministic patch applier.
 *
 * Takes a WikiPatch and applies its ops to the current page content, then
 * calls wiki.write() (the WaaS gate) — never calls fs.writeFile directly.
 *
 * Op application order:
 *   1. set_frontmatter ops first (update YAML fields in the frontmatter block)
 *   2. replace_paragraph / update_line / append_section ops on the body
 *
 * If an anchor cannot be found in the page content, the op is skipped and
 * a warning is logged (not a fatal error — partial patch is still written).
 */

import type { WikiFrontmatter } from '@getplumb/core';
import type { WikiService } from '@getplumb/wiki';
import type { WikiPatch, PatchOp } from './patch-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplierOptions {
  /** Called on skipped ops so the worker can surface warnings. */
  onWarning?: (msg: string) => void;
}

export interface ApplierResult {
  /** Relative path that was written */
  path: string;
  /** SHA-256 content hash returned by wiki.write() */
  contentHash: string;
  /** Number of ops that were successfully applied */
  appliedOps: number;
  /** Number of ops that were skipped (anchor not found) */
  skippedOps: number;
}

// ---------------------------------------------------------------------------
// Frontmatter ops
// ---------------------------------------------------------------------------

/**
 * Apply set_frontmatter ops to a WikiFrontmatter object.
 * Returns a new frontmatter object with the fields updated.
 */
function applyFrontmatterOps(
  fm: WikiFrontmatter,
  ops: PatchOp[],
): { updated: WikiFrontmatter; appliedCount: number } {
  let applied = 0;
  let result: WikiFrontmatter = { ...fm };

  for (const op of ops) {
    if (op.op !== 'set_frontmatter') continue;

    const key = op.key as keyof WikiFrontmatter;
    const value = op.value;

    // Type-aware coercion for known fields
    if (key === 'tags' || key === 'source_refs') {
      result = {
        ...result,
        [key]: Array.isArray(value) ? value : [value as string],
      } as WikiFrontmatter;
    } else {
      result = { ...result, [key]: value as string } as WikiFrontmatter;
    }
    applied++;
  }

  return { updated: result, appliedCount: applied };
}

// ---------------------------------------------------------------------------
// Body ops
// ---------------------------------------------------------------------------

/**
 * Apply body ops (replace_paragraph, update_line, append_section) to the
 * markdown body string. Returns the modified body and counts.
 */
function applyBodyOps(
  body: string,
  ops: PatchOp[],
  onWarning: (msg: string) => void,
): { updatedBody: string; appliedCount: number; skippedCount: number } {
  let current = body;
  let appliedCount = 0;
  let skippedCount = 0;

  for (const op of ops) {
    if (op.op === 'set_frontmatter') continue; // Handled separately

    if (op.op === 'replace_paragraph') {
      const result = replaceParagraph(current, op.anchor, op.replacement);
      if (result === null) {
        onWarning(`replace_paragraph: anchor not found: "${op.anchor.slice(0, 60)}"`);
        skippedCount++;
      } else {
        current = result;
        appliedCount++;
      }
      continue;
    }

    if (op.op === 'update_line') {
      const result = updateLine(current, op.anchor, op.replacement);
      if (result === null) {
        onWarning(`update_line: anchor not found: "${op.anchor.slice(0, 60)}"`);
        skippedCount++;
      } else {
        current = result;
        appliedCount++;
      }
      continue;
    }

    if (op.op === 'append_section') {
      current = appendSection(current, op.section, op.content);
      appliedCount++;
      continue;
    }
  }

  return { updatedBody: current, appliedCount, skippedCount };
}

// ---------------------------------------------------------------------------
// Op implementations
// ---------------------------------------------------------------------------

/**
 * Find the paragraph containing `anchor` and replace it with `replacement`.
 * A paragraph is a run of non-empty lines separated by blank lines.
 * Returns null if anchor not found.
 */
function replaceParagraph(body: string, anchor: string, replacement: string): string | null {
  if (!body.includes(anchor)) return null;

  const paragraphs = body.split(/\n\n+/);
  let matched = false;

  const updated = paragraphs.map((para) => {
    if (!matched && para.includes(anchor)) {
      matched = true;
      return replacement;
    }
    return para;
  });

  if (!matched) return null;

  // Reconstruct with double newlines, filtering empty replacement
  return updated.filter((p) => p !== '').join('\n\n');
}

/**
 * Find the first line containing `anchor` and replace that line with `replacement`.
 * Returns null if anchor not found.
 */
function updateLine(body: string, anchor: string, replacement: string): string | null {
  const lines = body.split('\n');
  let matched = false;

  const updated = lines.map((line) => {
    if (!matched && line.includes(anchor)) {
      matched = true;
      return replacement;
    }
    return line;
  });

  if (!matched) return null;
  return updated.join('\n');
}

/**
 * Append `content` under the section heading `section`.
 * If the section heading doesn't exist, appends a new heading + content at end.
 * If the section exists, appends content at the end of that section (before the
 * next same-or-higher-level heading or EOF).
 */
function appendSection(body: string, section: string, content: string): string {
  const headingPattern = new RegExp(`^(#{1,6})\\s+${escapeRegex(section)}\\s*$`, 'm');
  const match = headingPattern.exec(body);

  if (!match) {
    // Section not found — append a new ## heading at end
    const separator = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return `${body}${separator}## ${section}\n\n${content.trim()}\n`;
  }

  const headingLevel = match[1]?.length ?? 2;
  const headingEnd = (match.index ?? 0) + match[0].length;

  // Find the end of this section (next heading at same or higher level, or EOF)
  const afterHeading = body.slice(headingEnd);
  const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
  const nextMatch = nextHeadingPattern.exec(afterHeading);

  let insertPos: number;
  if (nextMatch) {
    // Insert before the next heading
    insertPos = headingEnd + (nextMatch.index ?? 0);
  } else {
    // Insert at end of document
    insertPos = body.length;
  }

  const before = body.slice(0, insertPos).trimEnd();
  const after = body.slice(insertPos);
  return `${before}\n\n${content.trim()}\n${after ? '\n' + after : ''}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a WikiPatch to a wiki page and write the result via wiki.write().
 *
 * Reads the current page content, applies all ops in order, and writes via
 * the WikiService. Never calls fs.writeFile directly.
 *
 * @param patch    The patch produced by the writer
 * @param wiki     WikiService instance (the WaaS gate)
 * @param options  Optional warning handler
 * @returns        Result including path, content hash, and op counts
 */
export async function applyPatch(
  patch: WikiPatch,
  wiki: WikiService,
  options: ApplierOptions = {},
): Promise<ApplierResult> {
  const warn = options.onWarning ?? (() => undefined);

  // Read existing content (or use empty template if page doesn't exist)
  let frontmatter: WikiFrontmatter;
  let body: string;

  try {
    const page = await wiki.read(patch.path);
    frontmatter = page.frontmatter;
    body = page.body;
  } catch {
    // Page doesn't exist yet — create minimal frontmatter
    const today = new Date().toISOString().slice(0, 10);
    frontmatter = {
      type: inferTypeFromPath(patch.path),
      created: today,
      updated: today,
      confidence: 'medium',
      tags: [],
      source_refs: [patch.source_ref],
    };
    body = '';
  }

  // Separate ops by kind
  const fmOps = patch.ops.filter((op) => op.op === 'set_frontmatter');
  const bodyOps = patch.ops.filter((op) => op.op !== 'set_frontmatter');

  // 1. Apply frontmatter ops
  const { updated: updatedFm, appliedCount: fmApplied } = applyFrontmatterOps(
    frontmatter,
    fmOps,
  );

  // 2. Apply body ops
  const { updatedBody, appliedCount: bodyApplied, skippedCount } = applyBodyOps(
    body,
    bodyOps,
    warn,
  );

  const appliedOps = fmApplied + bodyApplied;

  // 3. Write via wiki.write (the WaaS gate — no direct fs.writeFile)
  const { contentHash } = await wiki.write({
    path: patch.path,
    frontmatter: updatedFm,
    body: updatedBody,
    sourceRef: patch.source_ref,
  });

  return {
    path: patch.path,
    contentHash,
    appliedOps,
    skippedOps: skippedCount,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Infer the wiki page type from its path prefix. */
function inferTypeFromPath(path: string): WikiFrontmatter['type'] {
  if (path.startsWith('people/')) return 'person';
  if (path.startsWith('companies/')) return 'company';
  if (path.startsWith('concepts/')) return 'concept';
  if (path.startsWith('places/')) return 'place';
  if (path.startsWith('events/')) return 'event';
  return 'note';
}

