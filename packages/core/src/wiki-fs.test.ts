/**
 * Unit tests for wiki-fs.ts
 *
 * Tests cover:
 *   - parseFrontmatter: parses YAML frontmatter + body correctly
 *   - serializeFrontmatter: round-trips cleanly
 *   - formatPage / parseFrontmatter round-trip
 *   - extractTitle: finds H1 heading
 *   - readWikiPage / writeWikiPage: file I/O
 *   - listWikiPages: directory traversal
 *   - hashContent: produces stable SHA-256 hex
 *   - isModifiedExternally: detects external edits
 *   - archivePage: soft-delete with status: archived
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  serializeFrontmatter,
  formatPage,
  extractTitle,
  parseSimpleYaml,
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  hashContent,
  isModifiedExternally,
  archivePage,
  type WikiFrontmatter,
} from './wiki-fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempWiki(): string {
  const dir = join(tmpdir(), `plumb-wiki-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_FRONTMATTER: WikiFrontmatter = {
  type: 'person',
  created: '2026-04-10',
  updated: '2026-04-15',
  source_refs: ['plumb:abc123', 'chat:2026-04-15'],
  tags: ['interview', 'samsara'],
  confidence: 'high',
};

const SAMPLE_BODY = `\n# Jordan Lee\n\nEngineering Manager at Samsara.\n`;

// ---------------------------------------------------------------------------
// parseSimpleYaml
// ---------------------------------------------------------------------------

describe('parseSimpleYaml', () => {
  test('parses scalar fields', () => {
    const result = parseSimpleYaml('type: person\ncreated: 2026-04-10');
    assert.equal(result.type, 'person');
    assert.equal(result.created, '2026-04-10');
  });

  test('parses block arrays', () => {
    const yaml = 'tags:\n  - interview\n  - samsara';
    const result = parseSimpleYaml(yaml);
    assert.deepEqual(result.tags, ['interview', 'samsara']);
  });

  test('parses inline arrays', () => {
    const result = parseSimpleYaml('tags: [interview, samsara]');
    assert.deepEqual(result.tags, ['interview', 'samsara']);
  });

  test('parses empty inline array', () => {
    const result = parseSimpleYaml('tags: []');
    assert.deepEqual(result.tags, []);
  });

  test('parses empty block array (no items follow)', () => {
    const result = parseSimpleYaml('tags:\nconfidence: high');
    assert.deepEqual(result.tags, []);
    assert.equal(result.confidence, 'high');
  });

  test('ignores comment lines', () => {
    const result = parseSimpleYaml('# this is a comment\ntype: person');
    assert.equal(result.type, 'person');
    assert.equal(result['# this is a comment'], undefined);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('parses block-array frontmatter', () => {
    const raw = `---
type: person
created: 2026-04-10
updated: 2026-04-15
source_refs:
  - plumb:abc123
  - chat:2026-04-15
tags:
  - interview
  - samsara
confidence: high
---

# Jordan Lee

Some content here.
`;
    const { frontmatter, body } = parseFrontmatter(raw);
    assert.equal(frontmatter.type, 'person');
    assert.equal(frontmatter.created, '2026-04-10');
    assert.equal(frontmatter.updated, '2026-04-15');
    assert.deepEqual(frontmatter.source_refs, ['plumb:abc123', 'chat:2026-04-15']);
    assert.deepEqual(frontmatter.tags, ['interview', 'samsara']);
    assert.equal(frontmatter.confidence, 'high');
    assert.ok(body.includes('# Jordan Lee'));
    assert.ok(body.includes('Some content here.'));
  });

  test('parses inline-array tags', () => {
    const raw = `---
type: concept
created: 2026-01-01
updated: 2026-01-01
source_refs: []
tags: [ai, frameworks]
confidence: medium
---
# AI Concept
`;
    const { frontmatter } = parseFrontmatter(raw);
    assert.deepEqual(frontmatter.tags, ['ai', 'frameworks']);
    assert.deepEqual(frontmatter.source_refs, []);
  });

  test('parses status field when present', () => {
    const raw = `---
type: person
created: 2026-01-01
updated: 2026-01-01
source_refs: []
tags: []
confidence: low
status: archived
---
# Someone
`;
    const { frontmatter } = parseFrontmatter(raw);
    assert.equal(frontmatter.status, 'archived');
  });

  test('throws on missing frontmatter delimiter', () => {
    assert.throws(
      () => parseFrontmatter('# No frontmatter here\n\nContent.'),
      /Missing YAML frontmatter/,
    );
  });

  test('throws on unclosed frontmatter', () => {
    assert.throws(
      () => parseFrontmatter('---\ntype: person\n'),
      /Unclosed YAML frontmatter/,
    );
  });
});

// ---------------------------------------------------------------------------
// serializeFrontmatter
// ---------------------------------------------------------------------------

describe('serializeFrontmatter', () => {
  test('outputs canonical field order', () => {
    const yaml = serializeFrontmatter(SAMPLE_FRONTMATTER);
    const lines = yaml.split('\n');
    const keys = lines
      .filter(l => l.match(/^\w/) && l.includes(':'))
      .map(l => l.split(':')[0]);
    const expected = ['type', 'created', 'updated', 'source_refs', 'tags', 'confidence'];
    assert.deepEqual(keys, expected);
  });

  test('writes block arrays for non-empty arrays', () => {
    const yaml = serializeFrontmatter(SAMPLE_FRONTMATTER);
    assert.ok(yaml.includes('source_refs:'), 'source_refs header');
    assert.ok(yaml.includes('  - plumb:abc123'), 'source_refs item');
  });

  test('writes [] for empty arrays', () => {
    const fm: WikiFrontmatter = { ...SAMPLE_FRONTMATTER, tags: [] };
    const yaml = serializeFrontmatter(fm);
    assert.ok(yaml.includes('tags: []'));
  });

  test('omits status when undefined', () => {
    const yaml = serializeFrontmatter(SAMPLE_FRONTMATTER);
    assert.ok(!yaml.includes('status:'));
  });

  test('includes status when set', () => {
    const fm: WikiFrontmatter = { ...SAMPLE_FRONTMATTER, status: 'archived' };
    const yaml = serializeFrontmatter(fm);
    assert.ok(yaml.includes('status: archived'));
  });
});

// ---------------------------------------------------------------------------
// formatPage + parseFrontmatter round-trip
// ---------------------------------------------------------------------------

describe('formatPage round-trip', () => {
  test('round-trips frontmatter and body correctly', () => {
    const formatted = formatPage(SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const { frontmatter, body } = parseFrontmatter(formatted);

    assert.equal(frontmatter.type, SAMPLE_FRONTMATTER.type);
    assert.equal(frontmatter.created, SAMPLE_FRONTMATTER.created);
    assert.equal(frontmatter.updated, SAMPLE_FRONTMATTER.updated);
    assert.deepEqual(frontmatter.source_refs, SAMPLE_FRONTMATTER.source_refs);
    assert.deepEqual(frontmatter.tags, SAMPLE_FRONTMATTER.tags);
    assert.equal(frontmatter.confidence, SAMPLE_FRONTMATTER.confidence);
    assert.ok(body.includes('# Jordan Lee'));
  });

  test('formatted output starts with ---', () => {
    const formatted = formatPage(SAMPLE_FRONTMATTER, SAMPLE_BODY);
    assert.ok(formatted.startsWith('---\n'));
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe('extractTitle', () => {
  test('extracts H1 title from body', () => {
    assert.equal(extractTitle('\n# Jordan Lee\n\nContent.'), 'Jordan Lee');
  });

  test('returns undefined when no H1 present', () => {
    assert.equal(extractTitle('\n## Section\n\nContent.'), undefined);
  });

  test('trims whitespace around title', () => {
    assert.equal(extractTitle('#   Padded Title  \n'), 'Padded Title');
  });
});

// ---------------------------------------------------------------------------
// readWikiPage / writeWikiPage
// ---------------------------------------------------------------------------

describe('readWikiPage / writeWikiPage', () => {
  let wikiRoot: string;

  beforeEach(() => {
    wikiRoot = makeTempWiki();
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('writes and reads back a page correctly', async () => {
    await writeWikiPage(wikiRoot, 'people/jordan-lee.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const page = await readWikiPage(wikiRoot, 'people/jordan-lee.md');

    assert.equal(page.path, 'people/jordan-lee.md');
    assert.equal(page.frontmatter.type, 'person');
    assert.equal(page.frontmatter.created, '2026-04-10');
    assert.deepEqual(page.frontmatter.tags, ['interview', 'samsara']);
    assert.equal(page.title, 'Jordan Lee');
    assert.ok(page.body.includes('Jordan Lee'));
  });

  test('creates parent directories automatically', async () => {
    await writeWikiPage(wikiRoot, 'deep/nested/dir/page.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const page = await readWikiPage(wikiRoot, 'deep/nested/dir/page.md');
    assert.equal(page.frontmatter.type, 'person');
  });

  test('write preserves all frontmatter fields on round-trip', async () => {
    const fm: WikiFrontmatter = {
      ...SAMPLE_FRONTMATTER,
      status: 'active',
    };
    await writeWikiPage(wikiRoot, 'people/test.md', fm, SAMPLE_BODY);
    const page = await readWikiPage(wikiRoot, 'people/test.md');
    assert.equal(page.frontmatter.status, 'active');
  });
});

// ---------------------------------------------------------------------------
// listWikiPages
// ---------------------------------------------------------------------------

describe('listWikiPages', () => {
  let wikiRoot: string;

  beforeEach(() => {
    wikiRoot = makeTempWiki();
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  function touch(relPath: string): void {
    const abs = join(wikiRoot, relPath);
    mkdirSync(join(wikiRoot, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(abs, '');
  }

  test('returns relative paths for .md pages', async () => {
    touch('people/jordan-lee.md');
    touch('companies/samsara.md');
    const pages = await listWikiPages(wikiRoot);
    assert.ok(pages.includes('people/jordan-lee.md'));
    assert.ok(pages.includes('companies/samsara.md'));
  });

  test('excludes metadata files', async () => {
    touch('SCHEMA.md');
    touch('index.md');
    touch('log.md');
    touch('REVIEW.md');
    touch('people/_index.md');
    touch('people/jordan-lee.md');
    const pages = await listWikiPages(wikiRoot);
    assert.ok(!pages.includes('SCHEMA.md'));
    assert.ok(!pages.includes('index.md'));
    assert.ok(!pages.includes('log.md'));
    assert.ok(!pages.includes('REVIEW.md'));
    assert.ok(!pages.includes('people/_index.md'));
    assert.ok(pages.includes('people/jordan-lee.md'));
  });

  test('excludes archive/ by default', async () => {
    touch('archive/people/old-page.md');
    touch('people/active.md');
    const pages = await listWikiPages(wikiRoot);
    assert.ok(!pages.some(p => p.startsWith('archive/')));
    assert.ok(pages.includes('people/active.md'));
  });

  test('includes archive/ when includeArchive: true', async () => {
    touch('archive/people/old-page.md');
    const pages = await listWikiPages(wikiRoot, { includeArchive: true });
    assert.ok(pages.some(p => p.startsWith('archive/')));
  });

  test('returns sorted results', async () => {
    touch('people/zebra.md');
    touch('people/alpha.md');
    touch('companies/samsara.md');
    const pages = await listWikiPages(wikiRoot);
    const sorted = [...pages].sort();
    assert.deepEqual(pages, sorted);
  });
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe('hashContent', () => {
  test('returns 64-char hex string (SHA-256)', () => {
    const h = hashContent('hello world');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test('same content produces same hash', () => {
    assert.equal(hashContent('test'), hashContent('test'));
  });

  test('different content produces different hash', () => {
    assert.notEqual(hashContent('content A'), hashContent('content B'));
  });

  test('empty string hashes consistently', () => {
    const h1 = hashContent('');
    const h2 = hashContent('');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// isModifiedExternally
// ---------------------------------------------------------------------------

describe('isModifiedExternally', () => {
  let wikiRoot: string;

  beforeEach(() => {
    wikiRoot = makeTempWiki();
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('returns false when file matches expected hash', async () => {
    await writeWikiPage(wikiRoot, 'people/test.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const content = formatPage(SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const hash = hashContent(content);
    const modified = await isModifiedExternally(wikiRoot, 'people/test.md', hash);
    assert.equal(modified, false);
  });

  test('returns true when file differs from expected hash', async () => {
    await writeWikiPage(wikiRoot, 'people/test.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    // Use a hash of different content — simulates a stale hash from before an external edit
    const staleHash = hashContent('this is different content that was written before');
    const modified = await isModifiedExternally(wikiRoot, 'people/test.md', staleHash);
    assert.equal(modified, true);
  });

  test('detects external edit after file is overwritten directly', async () => {
    const absPath = join(wikiRoot, 'people/test.md');
    await writeWikiPage(wikiRoot, 'people/test.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const original = formatPage(SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const originalHash = hashContent(original);

    // Simulate Obsidian editing the file externally
    writeFileSync(absPath, original + '\n\nAdded by Obsidian.\n', 'utf8');

    const modified = await isModifiedExternally(wikiRoot, 'people/test.md', originalHash);
    assert.equal(modified, true);
  });
});

// ---------------------------------------------------------------------------
// archivePage
// ---------------------------------------------------------------------------

describe('archivePage', () => {
  let wikiRoot: string;

  beforeEach(() => {
    wikiRoot = makeTempWiki();
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('moves page to archive/ subdirectory', async () => {
    await writeWikiPage(wikiRoot, 'people/old-person.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const archivePath = await archivePage(wikiRoot, 'people/old-person.md');
    assert.equal(archivePath, 'archive/people/old-person.md');

    // Archived file exists
    const archived = await readWikiPage(wikiRoot, archivePath);
    assert.equal(archived.frontmatter.status, 'archived');
  });

  test('sets status: archived in frontmatter', async () => {
    await writeWikiPage(wikiRoot, 'people/someone.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const archivePath = await archivePage(wikiRoot, 'people/someone.md');
    const archived = await readWikiPage(wikiRoot, archivePath);
    assert.equal(archived.frontmatter.status, 'archived');
  });

  test('preserves body content after archiving', async () => {
    await writeWikiPage(wikiRoot, 'people/someone.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    const archivePath = await archivePage(wikiRoot, 'people/someone.md');
    const archived = await readWikiPage(wikiRoot, archivePath);
    assert.ok(archived.body.includes('Jordan Lee'));
  });

  test('original file no longer exists after archiving', async () => {
    await writeWikiPage(wikiRoot, 'people/someone.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    await archivePage(wikiRoot, 'people/someone.md');
    await assert.rejects(
      () => readWikiPage(wikiRoot, 'people/someone.md'),
      /ENOENT/,
    );
  });

  test('archived page excluded from listWikiPages by default', async () => {
    await writeWikiPage(wikiRoot, 'people/someone.md', SAMPLE_FRONTMATTER, SAMPLE_BODY);
    await archivePage(wikiRoot, 'people/someone.md');
    const pages = await listWikiPages(wikiRoot);
    assert.ok(!pages.includes('people/someone.md'));
    assert.ok(!pages.some(p => p.startsWith('archive/')));
  });
});
