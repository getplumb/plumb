/**
 * patch-schema.ts — Structured patch format for wiki page edits.
 *
 * Instead of rewriting entire pages, the writer emits a sequence of
 * targeted operations (PatchOp) that the applier applies deterministically.
 *
 * Op types:
 *   append_section      Add content under a heading (creates heading if absent)
 *   replace_paragraph   Replace the paragraph containing the anchor text
 *   update_line         Replace the first line containing the anchor text
 *   set_frontmatter     Update a single frontmatter field value
 *
 * All ops use text anchors, not line numbers, so they are stable across
 * concurrent edits.
 */

// ---------------------------------------------------------------------------
// Op types
// ---------------------------------------------------------------------------

/** Add `content` under `section` heading. Creates the heading if absent. */
export interface AppendSectionOp {
  op: 'append_section';
  /** Exact heading text (without `#` prefix), e.g. "Background" */
  section: string;
  /** Markdown content to append under that heading */
  content: string;
}

/**
 * Find the paragraph that contains `anchor` text (case-sensitive substring)
 * and replace the whole paragraph with `replacement`.
 */
export interface ReplaceParagraphOp {
  op: 'replace_paragraph';
  /** Substring uniquely identifying the paragraph to replace */
  anchor: string;
  /** New paragraph content (may be empty string to delete the paragraph) */
  replacement: string;
}

/**
 * Find the first line containing `anchor` and replace that line with
 * `replacement`. Useful for updating frontmatter-adjacent lines or single-
 * line facts.
 */
export interface UpdateLineOp {
  op: 'update_line';
  /** Substring uniquely identifying the line to update */
  anchor: string;
  /** New line content (newline not required) */
  replacement: string;
}

/**
 * Update a frontmatter field. The value is serialised as YAML inline:
 *   string → quoted if needed
 *   string[] → inline sequence
 */
export interface SetFrontmatterOp {
  op: 'set_frontmatter';
  /** Frontmatter key, e.g. "updated" */
  key: string;
  /** New value */
  value: string | string[];
}

/** Union of all patch operation types. */
export type PatchOp =
  | AppendSectionOp
  | ReplaceParagraphOp
  | UpdateLineOp
  | SetFrontmatterOp;

// ---------------------------------------------------------------------------
// Patch envelope
// ---------------------------------------------------------------------------

/**
 * A WikiPatch describes all changes to a single wiki page.
 * The applier applies ops in order and then calls wiki.write once.
 */
export interface WikiPatch {
  /** Relative path from wikiRoot, e.g. "people/dylan-sellberg.md" */
  path: string;
  /** Queue item id that triggered this patch, for the changelog sourceRef */
  source_ref: string;
  /** Ordered list of operations to apply */
  ops: PatchOp[];
}

// ---------------------------------------------------------------------------
// JSON Schema (for LLM structured output validation)
// ---------------------------------------------------------------------------

/** JSON Schema for a single PatchOp — used in writer prompts. */
export const PATCH_OP_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['op', 'section', 'content'],
      properties: {
        op: { type: 'string', enum: ['append_section'] },
        section: { type: 'string', description: 'Heading text without # prefix' },
        content: { type: 'string', description: 'Markdown content to append' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'anchor', 'replacement'],
      properties: {
        op: { type: 'string', enum: ['replace_paragraph'] },
        anchor: { type: 'string', description: 'Substring uniquely identifying the paragraph' },
        replacement: { type: 'string', description: 'New paragraph text (empty to delete)' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'anchor', 'replacement'],
      properties: {
        op: { type: 'string', enum: ['update_line'] },
        anchor: { type: 'string', description: 'Substring uniquely identifying the line' },
        replacement: { type: 'string', description: 'New line content' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['op', 'key', 'value'],
      properties: {
        op: { type: 'string', enum: ['set_frontmatter'] },
        key: { type: 'string', description: 'Frontmatter field name' },
        value: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'New field value',
        },
      },
      additionalProperties: false,
    },
  ],
} as const;

export const WIKI_PATCH_JSON_SCHEMA = {
  type: 'object',
  required: ['path', 'source_ref', 'ops'],
  properties: {
    path: { type: 'string', description: 'Relative path to the wiki page' },
    source_ref: { type: 'string', description: 'Queue item id' },
    ops: {
      type: 'array',
      items: PATCH_OP_JSON_SCHEMA,
      description: 'Ordered patch operations',
    },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Narrow a raw object to PatchOp, throwing if it doesn't match. */
export function parsePatchOp(raw: unknown): PatchOp {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('PatchOp must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const op = obj['op'];

  if (op === 'append_section') {
    if (typeof obj['section'] !== 'string' || typeof obj['content'] !== 'string') {
      throw new Error('append_section requires string section and content');
    }
    return { op: 'append_section', section: obj['section'], content: obj['content'] };
  }

  if (op === 'replace_paragraph') {
    if (typeof obj['anchor'] !== 'string' || typeof obj['replacement'] !== 'string') {
      throw new Error('replace_paragraph requires string anchor and replacement');
    }
    return { op: 'replace_paragraph', anchor: obj['anchor'], replacement: obj['replacement'] };
  }

  if (op === 'update_line') {
    if (typeof obj['anchor'] !== 'string' || typeof obj['replacement'] !== 'string') {
      throw new Error('update_line requires string anchor and replacement');
    }
    return { op: 'update_line', anchor: obj['anchor'], replacement: obj['replacement'] };
  }

  if (op === 'set_frontmatter') {
    if (typeof obj['key'] !== 'string') {
      throw new Error('set_frontmatter requires string key');
    }
    const val = obj['value'];
    if (
      typeof val !== 'string' &&
      !(Array.isArray(val) && val.every((v) => typeof v === 'string'))
    ) {
      throw new Error('set_frontmatter value must be string or string[]');
    }
    return { op: 'set_frontmatter', key: obj['key'], value: val as string | string[] };
  }

  throw new Error(`Unknown patch op: ${String(op)}`);
}

/** Parse a raw WikiPatch object, throwing if it doesn't match the schema. */
export function parseWikiPatch(raw: unknown): WikiPatch {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('WikiPatch must be an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['path'] !== 'string') throw new Error('WikiPatch.path must be a string');
  if (typeof obj['source_ref'] !== 'string') throw new Error('WikiPatch.source_ref must be a string');
  if (!Array.isArray(obj['ops'])) throw new Error('WikiPatch.ops must be an array');

  const ops = (obj['ops'] as unknown[]).map(parsePatchOp);

  return { path: obj['path'], source_ref: obj['source_ref'], ops };
}
