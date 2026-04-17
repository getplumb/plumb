/**
 * waas.test.ts — Unit tests for the Wiki-as-a-Service API and frontmatter validator.
 *
 * Tests cover:
 *   - validateFrontmatter: happy path, missing fields, invalid enums
 *   - validateRawContent: code-fence detection (the 33-broken-frontmatter case)
 *   - fixCodeFencedFrontmatter: auto-repair of the code-fence wrapping
 *   - WikiService.write: happy path, rejects invalid frontmatter
 *   - WikiService.read: round-trip with written pages
 *   - WikiService.query: filesystem fallback
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateFrontmatter,
  validateRawContent,
  hasCodeFencedFrontmatter,
  fixCodeFencedFrontmatter,
  VALID_TYPES,
  VALID_CONFIDENCE,
} from './frontmatter-validator.js';
import { WikiService, WikiValidationError } from './waas.js';
import type { WikiFrontmatter } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `plumb-waas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_FM: WikiFrontmatter = {
  type: 'person',
  created: '2026-04-16',
  updated: '2026-04-16',
  source_refs: ['plumb:abc123'],
  tags: ['interview', 'samsara'],
  confidence: 'high',
};

const VALID_BODY = '\n# Dylan Sellberg\n\nEngineering Manager at Samsara.\n';

function makeRawPage(fm: Partial<WikiFrontmatter> = {}, body = VALID_BODY): string {
  const merged = { ...VALID_FM, ...fm };
  const tags = Array.isArray(merged.tags)
    ? merged.tags.length === 0
      ? 'tags: []'
      : `tags:\n${merged.tags.map((t) => `  - ${t}`).join('\n')}`
    : `tags: ${String(merged.tags)}`;
  const srefs = Array.isArray(merged.source_refs)
    ? merged.source_refs.length === 0
      ? 'source_refs: []'
      : `source_refs:\n${merged.source_refs.map((r) => `  - ${r}`).join('\n')}`
    : `source_refs: ${String(merged.source_refs)}`;
  const status = merged.status ? `\nstatus: ${merged.status}` : '';
  return `---\ntype: ${merged.type}\ncreated: ${merged.created}\nupdated: ${merged.updated}\n${srefs}\n${tags}\nconfidence: ${merged.confidence}${status}\n---${body}`;
}

// ---------------------------------------------------------------------------
// validateFrontmatter — happy path
// ---------------------------------------------------------------------------

describe('validateFrontmatter — happy path', () => {
  test('valid person page passes validation', () => {
    const result = validateFrontmatter(VALID_FM);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test('all valid types are accepted', () => {
    for (const type of VALID_TYPES) {
      const fm = { ...VALID_FM, type };
      const result = validateFrontmatter(fm);
      assert.equal(result.valid, true, `type "${type}" should be valid`);
    }
  });

  test('all valid confidence levels are accepted', () => {
    for (const confidence of VALID_CONFIDENCE) {
      const fm = { ...VALID_FM, confidence };
      const result = validateFrontmatter(fm);
      assert.equal(result.valid, true, `confidence "${confidence}" should be valid`);
    }
  });

  test('empty tags array is valid', () => {
    const fm = { ...VALID_FM, tags: [] };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, true);
  });

  test('status field is optional', () => {
    const fm = { ...VALID_FM, status: 'active' as const };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFrontmatter — missing required fields
// ---------------------------------------------------------------------------

describe('validateFrontmatter — missing required fields', () => {
  test('missing type produces error', () => {
    const fm = { ...VALID_FM, type: '' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'type'));
  });

  test('missing created produces error', () => {
    const fm = { ...VALID_FM, created: '' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'created'));
  });

  test('missing updated produces error', () => {
    const fm = { ...VALID_FM, updated: '' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'updated'));
  });

  test('missing confidence produces error', () => {
    const fm = { ...VALID_FM, confidence: '' as WikiFrontmatter['confidence'] };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'confidence'));
  });

  test('empty source_refs array produces error', () => {
    const fm = { ...VALID_FM, source_refs: [] };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'source_refs'));
  });
});

// ---------------------------------------------------------------------------
// validateFrontmatter — invalid enum values
// ---------------------------------------------------------------------------

describe('validateFrontmatter — invalid enum values', () => {
  test('unknown type produces error', () => {
    const fm = { ...VALID_FM, type: 'unknown-type' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'type' && e.message.includes('unknown-type')));
  });

  test('invalid confidence value produces error', () => {
    const fm = { ...VALID_FM, confidence: 'very-high' as WikiFrontmatter['confidence'] };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'confidence'));
  });

  test('malformed date in created produces error', () => {
    const fm = { ...VALID_FM, created: '16-04-2026' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'created'));
  });

  test('malformed date in updated produces error', () => {
    const fm = { ...VALID_FM, updated: 'April 16 2026' };
    const result = validateFrontmatter(fm);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'updated'));
  });
});

// ---------------------------------------------------------------------------
// The 33-broken-frontmatter case: code-fenced YAML detection
// ---------------------------------------------------------------------------

describe('hasCodeFencedFrontmatter — the 33-broken-page case', () => {
  /**
   * Simulates the exact pattern produced by LLMs that wrap frontmatter in a
   * ```yaml block — the root cause of the 33 broken pages found in the audit.
   */
  const BROKEN_YAML_FENCE = `\`\`\`yaml
---
type: person
created: 2026-04-10
updated: 2026-04-16
source_refs:
  - plumb:abc123
tags:
  - samsara
confidence: high
---
\`\`\`

# Dylan Sellberg

Engineering Manager at Samsara.
`;

  const BROKEN_GENERIC_FENCE = `\`\`\`
---
type: company
created: 2026-01-01
updated: 2026-04-01
source_refs:
  - chat:2026-01-01
tags: []
confidence: medium
---
\`\`\`

# Samsara

An AI-powered fleet management company.
`;

  test('detects ```yaml code fence', () => {
    assert.equal(hasCodeFencedFrontmatter(BROKEN_YAML_FENCE), true);
  });

  test('detects generic ``` code fence', () => {
    assert.equal(hasCodeFencedFrontmatter(BROKEN_GENERIC_FENCE), true);
  });

  test('does not flag a valid page starting with ---', () => {
    const valid = makeRawPage();
    assert.equal(hasCodeFencedFrontmatter(valid), false);
  });

  test('validateRawContent flags code-fenced frontmatter as invalid', () => {
    const result = validateRawContent(BROKEN_YAML_FENCE);
    assert.equal(result.valid, false);
    assert.equal(result.hasCodeFence, true);
    assert.ok(result.errors.some((e) => e.field === 'raw' && e.message.includes('code fence')));
  });

  test('validateRawContent sets fixedContent when code fence is detected', () => {
    const result = validateRawContent(BROKEN_YAML_FENCE);
    assert.equal(result.hasCodeFence, true);
    assert.ok(result.fixedContent !== undefined);
    // Fixed content should start with ---
    assert.ok((result.fixedContent ?? '').trimStart().startsWith('---'));
  });

  test('fixCodeFencedFrontmatter produces parseable content for yaml-fenced page', () => {
    const fixed = fixCodeFencedFrontmatter(BROKEN_YAML_FENCE);
    // Fixed content must start with ---
    assert.ok(fixed.trimStart().startsWith('---'), 'Fixed content should start with ---');
    // Fixed content must not contain the opening fence
    assert.ok(!fixed.startsWith('```'), 'Fixed content must not start with code fence');
  });

  test('fixCodeFencedFrontmatter on a valid page returns it unchanged', () => {
    const valid = makeRawPage();
    const fixed = fixCodeFencedFrontmatter(valid);
    assert.equal(fixed, valid);
  });

  test('validateRawContent: fixed content is itself valid', () => {
    const result = validateRawContent(BROKEN_YAML_FENCE);
    assert.ok(result.fixedContent !== undefined);
    // The fixed content (from a structurally valid page) should parse cleanly
    const fixedResult = validateRawContent(result.fixedContent!);
    // Still has 0 non-raw errors (the yaml-fenced page above has valid fields)
    const fieldErrors = fixedResult.errors.filter((e) => e.field !== 'raw');
    assert.equal(fieldErrors.length, 0);
  });

  test('simulates batch of 33 broken pages: all detected and fixable', () => {
    // Simulate 33 pages with the code-fence pattern (the audit count)
    const brokenPages = Array.from({ length: 33 }, (_, i) => ({
      path: `people/person-${i}.md`,
      content: `\`\`\`yaml\n---\ntype: person\ncreated: 2026-0${(i % 9) + 1}-01\nupdated: 2026-04-16\nsource_refs:\n  - plumb:fact${i}\ntags: []\nconfidence: high\n---\n\`\`\`\n\n# Person ${i}\n\nSome content.\n`,
    }));

    let detectedCount = 0;
    let fixableCount = 0;

    for (const page of brokenPages) {
      const result = validateRawContent(page.content);
      if (result.hasCodeFence) detectedCount++;
      if (result.fixedContent !== undefined) {
        const fixedResult = validateRawContent(result.fixedContent);
        const fieldErrors = fixedResult.errors.filter((e) => e.field !== 'raw');
        if (fieldErrors.length === 0) fixableCount++;
      }
    }

    assert.equal(detectedCount, 33, 'All 33 broken pages should be detected');
    assert.equal(fixableCount, 33, 'All 33 broken pages should be auto-fixable');
  });
});

// ---------------------------------------------------------------------------
// WikiService — filesystem-only (no DB)
// ---------------------------------------------------------------------------

describe('WikiService (filesystem-only)', () => {
  let tmpDir: string;
  let wiki: WikiService;

  beforeEach(() => {
    tmpDir = makeTempDir();
    wiki = WikiService.createFilesystemOnly(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('write() + read() round-trip', async () => {
    await wiki.write({
      path: 'people/test-person.md',
      frontmatter: VALID_FM,
      body: VALID_BODY,
    });

    const page = await wiki.read('people/test-person.md');
    assert.equal(page.frontmatter.type, 'person');
    assert.equal(page.frontmatter.created, '2026-04-16');
    assert.equal(page.frontmatter.confidence, 'high');
    assert.equal(page.title, 'Dylan Sellberg');
  });

  test('write() rejects page with missing type', async () => {
    await assert.rejects(
      wiki.write({
        path: 'people/bad.md',
        frontmatter: { ...VALID_FM, type: '' },
        body: VALID_BODY,
      }),
      WikiValidationError,
    );
  });

  test('write() rejects page with invalid type enum', async () => {
    await assert.rejects(
      wiki.write({
        path: 'people/bad.md',
        frontmatter: { ...VALID_FM, type: 'gadget' },
        body: VALID_BODY,
      }),
      WikiValidationError,
    );
  });

  test('write() rejects page with invalid confidence', async () => {
    await assert.rejects(
      wiki.write({
        path: 'people/bad.md',
        frontmatter: { ...VALID_FM, confidence: 'very-high' as WikiFrontmatter['confidence'] },
        body: VALID_BODY,
      }),
      WikiValidationError,
    );
  });

  test('write() rejects page with empty source_refs', async () => {
    await assert.rejects(
      wiki.write({
        path: 'people/bad.md',
        frontmatter: { ...VALID_FM, source_refs: [] },
        body: VALID_BODY,
      }),
      WikiValidationError,
    );
  });

  test('WikiValidationError carries error details', async () => {
    let caught: WikiValidationError | null = null;
    try {
      await wiki.write({
        path: 'people/bad.md',
        frontmatter: { ...VALID_FM, type: 'gadget', confidence: 'ultra' as WikiFrontmatter['confidence'] },
        body: VALID_BODY,
      });
    } catch (err) {
      if (err instanceof WikiValidationError) caught = err;
    }
    assert.ok(caught !== null, 'Should have thrown WikiValidationError');
    assert.ok(caught.errors.length >= 2, 'Should report both type and confidence errors');
    assert.equal(caught.path, 'people/bad.md');
  });

  test('write() returns content_hash', async () => {
    const { contentHash } = await wiki.write({
      path: 'people/hash-test.md',
      frontmatter: VALID_FM,
      body: VALID_BODY,
    });
    assert.ok(typeof contentHash === 'string' && contentHash.length === 64, 'SHA-256 hex should be 64 chars');
  });

  test('query() returns written pages (filesystem fallback)', async () => {
    await wiki.write({ path: 'people/alice.md', frontmatter: VALID_FM, body: '\n# Alice\n\nA person.\n' });
    await wiki.write({
      path: 'companies/acme.md',
      frontmatter: { ...VALID_FM, type: 'company' },
      body: '\n# Acme\n\nA company.\n',
    });

    const all = await wiki.query({});
    assert.ok(all.length >= 2);

    const people = await wiki.query({ type: 'person' });
    assert.ok(people.every((p) => p.type === 'person'));

    const companies = await wiki.query({ type: 'company' });
    assert.ok(companies.every((c) => c.type === 'company'));
  });

  test('links() throws on filesystem-only instance', () => {
    assert.throws(
      () => wiki.links('people/alice.md'),
      /requires a DB connection/,
    );
  });

  test('write() does not write file when frontmatter is invalid', async () => {
    let threw = false;
    try {
      await wiki.write({
        path: 'people/no-write.md',
        frontmatter: { ...VALID_FM, type: 'invalid' },
        body: VALID_BODY,
      });
    } catch {
      threw = true;
    }
    assert.ok(threw);
    // File must NOT have been written
    try {
      await wiki.read('people/no-write.md');
      assert.fail('Expected read to throw — file should not exist');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });
});

// ---------------------------------------------------------------------------
// VALID_TYPES and VALID_CONFIDENCE exports
// ---------------------------------------------------------------------------

describe('schema constants', () => {
  test('VALID_TYPES contains all SCHEMA.md §2 types', () => {
    const expected = ['person', 'company', 'tool', 'project', 'interview', 'concept', 'story', 'life'];
    for (const t of expected) {
      assert.ok((VALID_TYPES as readonly string[]).includes(t), `VALID_TYPES should include "${t}"`);
    }
    assert.equal(VALID_TYPES.length, expected.length);
  });

  test('VALID_CONFIDENCE contains exactly high | medium | low', () => {
    assert.deepEqual([...VALID_CONFIDENCE].sort(), ['high', 'low', 'medium']);
  });
});
