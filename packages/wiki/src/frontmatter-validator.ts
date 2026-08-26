/**
 * frontmatter-validator.ts — Strict frontmatter schema validation for Plumb wiki pages.
 *
 * Enforces SCHEMA.md §3 invariants on every wiki page:
 *   - All required fields present (type, created, updated, source_refs, tags, confidence)
 *   - type is one of the valid values from SCHEMA.md §2
 *   - confidence is one of: high | medium | low
 *   - created / updated match YYYY-MM-DD format
 *   - source_refs is a non-empty array
 *   - tags is an array (may be empty)
 *
 * Also detects and optionally repairs the #1 root cause of broken pages:
 * LLM output that wraps the YAML frontmatter in a ```yaml code fence.
 *
 * The 2026-04-16 audit found 33 pages with this exact broken pattern.
 */

import { parseFrontmatter } from '@getplumb/core';
import type { WikiFrontmatter } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Valid enum values (from SCHEMA.md §2 and §3)
// ---------------------------------------------------------------------------

/**
 * SCHEMA.md §2. This is the WRITE gate: a type not listed here is rejected by
 * WaaS, so a type the schema allows and this list omits is a page the wiki
 * cannot create.
 *
 * The last four were added 2026-08-15, when the schema caught up with the four
 * directories the wiki had already grown. SCHEMA.md §2.1 enumerates the four
 * lists that have to move together; this is one of them.
 *
 * `conversation` (2026-08-21) is the indexed summary of one recorded exchange:
 * a call, interview, meeting or coaching session. It is deliberately NOT
 * `transcript`, which names the raw verbatim record under `transcripts/` that
 * `.plumbignore` keeps out of retrieval. The two used to share that directory,
 * which meant the summary inherited the transcript's exclusion and could never
 * be searched or linked — see SCHEMA.md §2 and `transcripts/README.md`.
 */
export const VALID_TYPES = [
  'person',
  'company',
  'tool',
  'project',
  'interview',
  'concept',
  'story',
  'life',
  'education',
  'preference',
  'source',
  'transcript',
  'conversation',
] as const;

export type ValidWikiType = (typeof VALID_TYPES)[number];

export const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type ValidConfidence = (typeof VALID_CONFIDENCE)[number];

// YYYY-MM-DD date pattern
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Code fence opener: ``` optionally followed by a language tag (yaml, markdown, md, etc.)
const CODE_FENCE_OPENER = /^```[\w-]*$/;

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** Frontmatter field name, or 'raw' for structural / file-level issues */
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Raw-content code-fence detection and repair
// ---------------------------------------------------------------------------

/**
 * Return true if the raw file content has an LLM-generated code fence wrapping
 * the YAML frontmatter block. The canonical broken pattern is:
 *
 *   ```yaml
 *   ---
 *   type: person
 *   ...
 *   ---
 *   ```
 *   # Page Title
 *
 * Detection: any file whose first non-empty line matches ``` + optional lang tag.
 */
export function hasCodeFencedFrontmatter(rawContent: string): boolean {
  const firstLine = (rawContent.split('\n')[0] ?? '').trim();
  return CODE_FENCE_OPENER.test(firstLine);
}

/**
 * Auto-repair a code-fenced frontmatter block by stripping the opening and
 * matching closing ``` lines that surround the YAML block.
 *
 * Only repairs the fence immediately around the frontmatter section. Body code
 * blocks are left untouched.
 *
 * Returns the original string unchanged if no code fence is detected or if the
 * structure is too broken to safely repair (e.g., no closing fence before H1).
 */
export function fixCodeFencedFrontmatter(rawContent: string): string {
  const lines = rawContent.split('\n');
  const first = (lines[0] ?? '').trim();

  if (!CODE_FENCE_OPENER.test(first)) return rawContent;

  // Find the closing ``` that ends the code fence wrapping the YAML block.
  // Stop searching once we pass the YAML frontmatter area (before H1 title).
  for (let i = 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();

    if (trimmed === '```') {
      // Strip opening fence (line 0) and this closing fence (line i).
      const inner = lines.slice(1, i);
      const rest = lines.slice(i + 1);
      return [...inner, ...rest].join('\n');
    }

    // If we hit an H1 title without finding a closing fence, the structure is
    // too broken to auto-repair safely — leave it alone.
    if (trimmed.startsWith('# ')) break;
  }

  return rawContent;
}

// ---------------------------------------------------------------------------
// Frontmatter field validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed WikiFrontmatter object against the strict SCHEMA.md §3 rules.
 *
 * Does NOT inspect raw file content — call hasCodeFencedFrontmatter() first to
 * detect structural issues before parsing.
 */
export function validateFrontmatter(fm: WikiFrontmatter): ValidationResult {
  const errors: ValidationError[] = [];

  // --- type ---
  if (!fm.type || typeof fm.type !== 'string') {
    errors.push({ field: 'type', message: 'Missing required field: type' });
  } else if (!(VALID_TYPES as readonly string[]).includes(fm.type)) {
    errors.push({
      field: 'type',
      message: `Invalid type "${fm.type}". Must be one of: ${VALID_TYPES.join(', ')}`,
    });
  }

  // --- created ---
  if (!fm.created || typeof fm.created !== 'string') {
    errors.push({ field: 'created', message: 'Missing required field: created' });
  } else if (!DATE_PATTERN.test(fm.created)) {
    errors.push({
      field: 'created',
      message: `Invalid created date "${fm.created}". Must be YYYY-MM-DD`,
    });
  }

  // --- updated ---
  if (!fm.updated || typeof fm.updated !== 'string') {
    errors.push({ field: 'updated', message: 'Missing required field: updated' });
  } else if (!DATE_PATTERN.test(fm.updated)) {
    errors.push({
      field: 'updated',
      message: `Invalid updated date "${fm.updated}". Must be YYYY-MM-DD`,
    });
  }

  // --- source_refs ---
  if (!Array.isArray(fm.source_refs)) {
    errors.push({
      field: 'source_refs',
      message: 'Missing required field: source_refs (must be an array)',
    });
  } else if (fm.source_refs.length === 0) {
    errors.push({ field: 'source_refs', message: 'source_refs must contain at least one entry' });
  }

  // --- tags ---
  if (!Array.isArray(fm.tags)) {
    errors.push({ field: 'tags', message: 'Missing required field: tags (must be an array)' });
  }

  // --- confidence ---
  if (!fm.confidence || typeof fm.confidence !== 'string') {
    errors.push({ field: 'confidence', message: 'Missing required field: confidence' });
  } else if (!(VALID_CONFIDENCE as readonly string[]).includes(fm.confidence)) {
    errors.push({
      field: 'confidence',
      message: `Invalid confidence "${fm.confidence}". Must be one of: ${VALID_CONFIDENCE.join(', ')}`,
    });
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Raw-content validation (structural + field checks in one call)
// ---------------------------------------------------------------------------

export interface RawValidationResult extends ValidationResult {
  /** True when the raw content has a code-fence-wrapped frontmatter block */
  hasCodeFence: boolean;
  /**
   * Auto-repaired content with the code fence stripped, when hasCodeFence is true.
   * Undefined when hasCodeFence is false or repair was not possible.
   */
  fixedContent: string | undefined;
}

/**
 * Validate a raw wiki page file (full string content including frontmatter delimiters).
 *
 * Performs three passes in order:
 *   1. Code-fence detection → populates hasCodeFence / fixedContent
 *   2. Frontmatter structural parse → catches missing --- or unclosed block
 *   3. Field validation → enum checks, date format, required fields
 *
 * If the content has a code fence, pass 2 and 3 operate on the fence-stripped
 * version so field errors are accurate.
 *
 * @param rawContent  Full file content as read from disk
 */
export function validateRawContent(rawContent: string): RawValidationResult {
  const hasCodeFence = hasCodeFencedFrontmatter(rawContent);
  const fixedContent = hasCodeFence ? fixCodeFencedFrontmatter(rawContent) : undefined;

  // Use fixed content for parsing when a code fence was detected, so that
  // field-level errors are meaningful rather than just "missing ---".
  const contentToParse = fixedContent ?? rawContent;

  const errors: ValidationError[] = [];

  if (hasCodeFence) {
    errors.push({
      field: 'raw',
      message:
        'Frontmatter is wrapped in a code fence (```yaml / ```). ' +
        'File must start with --- directly on line 1. Run with --fix to auto-repair.',
    });
  }

  // Structural parse
  let fm: WikiFrontmatter | null = null;
  try {
    const parsed = parseFrontmatter(contentToParse);
    fm = parsed.frontmatter;
  } catch (err) {
    errors.push({
      field: 'raw',
      message: `Cannot parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, errors, hasCodeFence, fixedContent };
  }

  // Field validation
  const fieldResult = validateFrontmatter(fm);
  errors.push(...fieldResult.errors);

  return {
    valid: errors.length === 0,
    errors,
    hasCodeFence,
    fixedContent,
  };
}
