/**
 * refactor.test.ts — Unit tests for the wiki page refactor / H2-boundary split module.
 *
 * Verify command: pnpm -F @getplumb/wiki test -- --grep 'refactor|split'
 *
 * Tests cover:
 *   - slugify: basic cases, special chars, hyphens
 *   - childPageSlug: deterministic naming convention
 *   - countWords: accuracy
 *   - countOutboundLinks: wikilink detection
 *   - parseH2Sections: section parsing, pre-H2 content excluded
 *   - pickSectionDeterministically: word count sort, link tie-break, alphabetical tie-break
 *   - splitPageContent: parent stub, child body, link preservation
 *   - wikiRefactorPhase (integration): threshold gating, cooldown, dry-run, actual split
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  slugify,
  childPageSlug,
  countWords,
  countOutboundLinks,
  parseH2Sections,
  pickSectionDeterministically,
  splitPageContent,
  wikiRefactorPhase,
  SPLIT_THRESHOLD_WORDS,
  MERGE_THRESHOLD_WORDS,
  COOLDOWN_DAYS,
} from './refactor.js';
import { openDb, applyWikiSchema, parseFrontmatter } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = join(
    tmpdir(),
    `plumb-refactor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a body with `nWords` filler words under `nSections` H2 headings. */
function bigBody(nSections: number, wordsPerSection: number): string {
  const filler = 'word '.repeat(wordsPerSection).trim();
  const sections = Array.from({ length: nSections }, (_, i) =>
    `## Section ${String.fromCharCode(65 + i)}\n\n${filler}\n`,
  );
  return `\n# Big Page\n\nIntroduction paragraph.\n\n${sections.join('\n')}`;
}

const VALID_FM_YAML = `---
type: concept
created: 2026-01-01
updated: 2026-04-20
source_refs:
  - test:001
tags:
  - test
confidence: medium
---`;

function makePage(body: string): string {
  return `${VALID_FM_YAML}\n${body}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('refactor — constants', () => {
  test('refactor — SPLIT_THRESHOLD_WORDS is 1200', () => {
    assert.equal(SPLIT_THRESHOLD_WORDS, 1200);
  });

  test('refactor — MERGE_THRESHOLD_WORDS is 600', () => {
    assert.equal(MERGE_THRESHOLD_WORDS, 600);
  });

  test('refactor — COOLDOWN_DAYS is 7', () => {
    assert.equal(COOLDOWN_DAYS, 7);
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('refactor — slugify', () => {
  test('split — slugify lowercases text', () => {
    assert.equal(slugify('Work History'), 'work-history');
  });

  test('split — slugify replaces spaces with hyphens', () => {
    assert.equal(slugify('My Section Title'), 'my-section-title');
  });

  test('split — slugify strips special chars', () => {
    assert.equal(slugify('Q&A and FAQs!'), 'q-a-and-faqs');
  });

  test('split — slugify collapses multiple hyphens', () => {
    assert.equal(slugify('foo---bar'), 'foo-bar');
  });

  test('split — slugify trims leading/trailing hyphens', () => {
    assert.equal(slugify(' Hello '), 'hello');
  });

  test('split — slugify handles already-slug input', () => {
    assert.equal(slugify('already-fine'), 'already-fine');
  });
});

// ---------------------------------------------------------------------------
// childPageSlug
// ---------------------------------------------------------------------------

describe('refactor — childPageSlug', () => {
  test('split — childPageSlug produces {parent}-{section-slug}', () => {
    const result = childPageSlug('people/jordan-lee', 'Work History');
    assert.equal(result, 'people/jordan-lee-work-history');
  });

  test('split — childPageSlug preserves directory prefix', () => {
    const result = childPageSlug('concepts/machine-learning', 'Core Algorithms');
    assert.equal(result, 'concepts/machine-learning-core-algorithms');
  });

  test('split — childPageSlug handles root-level pages', () => {
    const result = childPageSlug('index', 'Overview');
    assert.equal(result, 'index-overview');
  });
});

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------

describe('refactor — countWords', () => {
  test('split — countWords counts whitespace-delimited tokens', () => {
    assert.equal(countWords('one two three'), 3);
  });

  test('split — countWords handles leading/trailing whitespace', () => {
    assert.equal(countWords('  hello world  '), 2);
  });

  test('split — countWords returns 0 for empty string', () => {
    assert.equal(countWords(''), 0);
  });

  test('split — countWords handles newlines', () => {
    assert.equal(countWords('line one\nline two\nline three'), 6);
  });
});

// ---------------------------------------------------------------------------
// countOutboundLinks
// ---------------------------------------------------------------------------

describe('refactor — countOutboundLinks', () => {
  test('split — countOutboundLinks detects [[wikilinks]]', () => {
    const text = 'See [[Jordan Lee]] and [[Samsara]] for more.';
    assert.equal(countOutboundLinks(text), 2);
  });

  test('split — countOutboundLinks returns 0 when no links', () => {
    assert.equal(countOutboundLinks('No links here at all.'), 0);
  });

  test('split — countOutboundLinks counts links in multiline text', () => {
    const text = '[[A]]\n[[B]]\n[[C]]';
    assert.equal(countOutboundLinks(text), 3);
  });
});

// ---------------------------------------------------------------------------
// parseH2Sections
// ---------------------------------------------------------------------------

describe('refactor — parseH2Sections', () => {
  test('split — parseH2Sections returns empty array for no H2 headings', () => {
    const body = '# Title\n\nJust a paragraph.';
    const sections = parseH2Sections(body);
    assert.equal(sections.length, 0);
  });

  test('split — parseH2Sections finds two H2 sections', () => {
    const body = `# Title\n\nIntro.\n\n## Section One\n\nContent A.\n\n## Section Two\n\nContent B.\n`;
    const sections = parseH2Sections(body);
    assert.equal(sections.length, 2);
    assert.equal(sections[0]!.title, 'Section One');
    assert.equal(sections[1]!.title, 'Section Two');
  });

  test('split — parseH2Sections excludes pre-H2 content', () => {
    const body = `# Title\n\nPre-content that should NOT become a section.\n\n## Real Section\n\nActual content.\n`;
    const sections = parseH2Sections(body);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.title, 'Real Section');
  });

  test('split — parseH2Sections populates slug correctly', () => {
    const body = `## Work History\n\nDetails here.\n`;
    const sections = parseH2Sections(body);
    assert.equal(sections[0]!.slug, 'work-history');
  });

  test('split — parseH2Sections counts words in section', () => {
    const body = `## Background\n\none two three four five\n`;
    const sections = parseH2Sections(body);
    // fullContent includes "## Background" heading line
    assert.ok(sections[0]!.wordCount >= 5, 'word count should include section body words');
  });

  test('split — parseH2Sections counts outbound links', () => {
    const body = `## Links\n\nSee [[Alpha]], [[Beta]], and [[Gamma]] for details.\n`;
    const sections = parseH2Sections(body);
    assert.equal(sections[0]!.outboundLinkCount, 3);
  });
});

// ---------------------------------------------------------------------------
// pickSectionDeterministically
// ---------------------------------------------------------------------------

describe('refactor — pickSectionDeterministically', () => {
  function makeSection(
    title: string,
    wordCount: number,
    outboundLinkCount: number,
  ) {
    return {
      title,
      slug: slugify(title),
      body: '',
      fullContent: '',
      wordCount,
      outboundLinkCount,
    };
  }

  test('split — picks section with highest word count', () => {
    const sections = [
      makeSection('Small', 100, 0),
      makeSection('Large', 500, 0),
      makeSection('Medium', 300, 0),
    ];
    const picked = pickSectionDeterministically(sections);
    assert.equal(picked.title, 'Large');
  });

  test('split — ties on word count: picks section with more outbound links', () => {
    const sections = [
      makeSection('Alpha', 300, 1),
      makeSection('Beta', 300, 5),
    ];
    const picked = pickSectionDeterministically(sections);
    assert.equal(picked.title, 'Beta');
  });

  test('split — ties on word count AND links: picks alphabetically first', () => {
    const sections = [
      makeSection('Zebra', 300, 3),
      makeSection('Apple', 300, 3),
    ];
    const picked = pickSectionDeterministically(sections);
    assert.equal(picked.title, 'Apple');
  });

  test('split — handles single section (returns it)', () => {
    const sections = [makeSection('Only', 200, 0)];
    const picked = pickSectionDeterministically(sections);
    assert.equal(picked.title, 'Only');
  });
});

// ---------------------------------------------------------------------------
// splitPageContent
// ---------------------------------------------------------------------------

describe('refactor — splitPageContent', () => {
  const body = `\n# My Page\n\nIntroduction text here.\n\n## Background\n\nBackground details.\n\n## Work History\n\nLong work history with [[Company A]] and [[Company B]].\n`;

  test('split — child body starts with H1 derived from section title', () => {
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { childBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    assert.ok(childBody.includes('# Work History'), 'child body should have H1 heading');
  });

  test('split — child body contains section content', () => {
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { childBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    assert.ok(childBody.includes('Company A'), 'child body should include section content');
  });

  test('split — parent body replaces section with a stub containing a wikilink', () => {
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { parentBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    assert.ok(parentBody.includes('## Work History'), 'parent should still have H2 heading');
    assert.ok(parentBody.includes('[[my-page-work-history]]'), 'parent stub must link to child');
  });

  test('split — parent body retains other sections', () => {
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { parentBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    assert.ok(parentBody.includes('## Background'), 'other sections should remain in parent');
    assert.ok(parentBody.includes('Background details'), 'other section content should remain');
  });

  test('split — parent body no longer contains the externalized section content', () => {
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { parentBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    assert.ok(!parentBody.includes('Long work history'), 'externalized content should not be in parent');
  });

  test('split — inbound wikilinks to original page still resolve (parent keeps H2 heading)', () => {
    // The original page path doesn't change — it still exists with the same H2 heading,
    // so any [[My Page#Work History]] anchors would still resolve to the parent.
    // More importantly: the parent still has ## Work History as a stub.
    const sections = parseH2Sections(body);
    const section = sections.find((s) => s.title === 'Work History')!;
    const { parentBody } = splitPageContent(body, section, 'pages/my-page-work-history');
    const workHistoryH2Count = (parentBody.match(/^## Work History/m) ?? []).length;
    assert.equal(workHistoryH2Count, 1, 'parent should still have ## Work History stub');
  });
});

// ---------------------------------------------------------------------------
// wikiRefactorPhase (integration)
// ---------------------------------------------------------------------------

describe('refactor — wikiRefactorPhase integration', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  function seedPageInDb(
    db: Awaited<ReturnType<typeof openDb>>,
    pageId: string,
    relPath: string,
    wordCount: number,
    lastSplitAt?: string,
  ): void {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO wiki_pages
         (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, last_split_at)
       VALUES (?, ?, 'concept', ?, '2026-01-01', '2026-04-20', 'medium', '[]', '[]', 'active', ?, ?)`,
    );
    stmt.bind([pageId, relPath, pageId, wordCount, lastSplitAt ?? null]);
    stmt.step();
    stmt.finalize();
  }

  test('refactor — skips pages below the split threshold', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // A page with 500 words (below 1200 threshold)
    seedPageInDb(db, 'concepts/small', 'concepts/small.md', 500);
    db.close();

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: true,
    });

    assert.equal(result.pagesExamined, 0, 'page below threshold should not be examined');
    assert.equal(result.splits.length, 0, 'no splits should occur');
  });

  test('refactor — skips page within cooldown window', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // Page above threshold but split 3 days ago (within 7-day cooldown)
    seedPageInDb(db, 'concepts/recent', 'concepts/recent.md', 1500, '2026-04-17T10:00:00.000Z');
    db.close();

    // Create the actual file
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/recent.md'), makePage(bigBody(3, 200)), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: false,
    });

    assert.equal(result.splits.length, 0, 'page within cooldown should not be split');
  });

  test('refactor — skips page if cooldown just expired (exactly 7 days)', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // Split exactly 7 days ago — should be eligible (cooldown is strictly < 7 days)
    seedPageInDb(db, 'concepts/edge', 'concepts/edge.md', 1500, '2026-04-13T00:00:00.000Z');
    db.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/edge.md'), makePage(bigBody(3, 200)), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: true,
    });

    // 7 days exactly → diffDays = 7 → NOT on cooldown → should be examined
    assert.ok(result.pagesExamined >= 1, 'page with expired cooldown should be examined');
  });

  test('refactor — skips pages with fewer than 2 H2 sections', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    seedPageInDb(db, 'concepts/flat', 'concepts/flat.md', 1500);
    db.close();

    // Page with only one H2 section — not splittable
    const body = '\n# Flat Page\n\nIntroduction.\n\n## Only Section\n\n' + 'word '.repeat(400);
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/flat.md'), makePage(body), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: false,
    });

    assert.equal(result.splits.length, 0, 'page with only 1 H2 section should not be split');
  });

  test('refactor — dry-run reports splits without writing files', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    seedPageInDb(db, 'concepts/big', 'concepts/big.md', 1500);
    db.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    const originalContent = makePage(bigBody(3, 250));
    writeFileSync(join(wikiRoot, 'concepts/big.md'), originalContent, 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: true,
    });

    // Should report a split
    assert.ok(result.splits.length > 0, 'dry-run should report planned splits');

    // But the original file should be unchanged
    const afterContent = readFileSync(join(wikiRoot, 'concepts/big.md'), 'utf8');
    assert.equal(afterContent, originalContent, 'dry-run should not write files');

    // Child page should NOT exist
    const split = result.splits[0]!;
    assert.ok(!existsSync(join(wikiRoot, split.childPath)), 'dry-run should not create child file');
  });

  test('refactor — actual split creates child file and updates parent', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    seedPageInDb(db, 'concepts/big', 'concepts/big.md', 1500);
    db.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/big.md'), makePage(bigBody(3, 250)), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: false,
    });

    assert.ok(result.splits.length > 0, 'should perform at least one split');

    const split = result.splits[0]!;

    // Child file exists
    assert.ok(existsSync(join(wikiRoot, split.childPath)), 'child file should be created');

    // Child file has valid frontmatter
    const childRaw = readFileSync(join(wikiRoot, split.childPath), 'utf8');
    const { frontmatter: childFm, body: childBody } = parseFrontmatter(childRaw);
    assert.equal(childFm.type, 'concept');
    assert.ok(childBody.includes(`# ${split.sectionTitle}`), 'child body should have H1 heading');

    // Parent file still exists
    assert.ok(existsSync(join(wikiRoot, split.parentPath)), 'parent file should still exist');

    // Parent has stub linking to child
    const parentRaw = readFileSync(join(wikiRoot, split.parentPath), 'utf8');
    const childSlug = split.childPath.replace(/\.md$/, '').split('/').pop()!;
    assert.ok(parentRaw.includes(`[[${childSlug}]]`), 'parent should link to child');
  });

  test('refactor — split records wordsBefore, wordsAfter, childWords', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    seedPageInDb(db, 'concepts/big', 'concepts/big.md', 1500);
    db.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/big.md'), makePage(bigBody(3, 250)), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: false,
    });

    const split = result.splits[0]!;
    assert.ok(split.wordsBefore > 0, 'wordsBefore should be positive');
    assert.ok(split.wordsAfter > 0, 'wordsAfter should be positive');
    assert.ok(split.childWords > 0, 'childWords should be positive');
    assert.ok(
      split.wordsAfter < split.wordsBefore,
      'parent should have fewer words after split',
    );
  });

  test('refactor — split updates last_split_at in wiki.db', async () => {
    const db1 = await openDb(dbPath);
    db1.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db1);
    seedPageInDb(db1, 'concepts/big', 'concepts/big.md', 1500);
    db1.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    writeFileSync(join(wikiRoot, 'concepts/big.md'), makePage(bigBody(3, 250)), 'utf8');

    await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: false,
    });

    // Verify last_split_at is set
    const db2 = await openDb(dbPath);
    const rows = db2.exec({
      sql: `SELECT last_split_at FROM wiki_pages WHERE id = 'concepts/big'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ last_split_at: string | null }>;
    db2.close();

    assert.ok(rows.length > 0, 'page should exist in DB');
    assert.ok(rows[0]!.last_split_at !== null, 'last_split_at should be set after split');
  });

  test('refactor — child-page naming follows {parent-slug}-{section-slug} convention', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);
    seedPageInDb(db, 'concepts/machine-learning', 'concepts/machine-learning.md', 1500);
    db.close();

    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true });
    const body = bigBody(2, 300).replace('Section A', 'Core Algorithms').replace('Section B', 'History');
    writeFileSync(join(wikiRoot, 'concepts/machine-learning.md'), makePage(body), 'utf8');

    const result = await wikiRefactorPhase({
      wikiRoot,
      wikiDbPath: dbPath,
      today: '2026-04-20',
      dryRun: true,
    });

    assert.ok(result.splits.length > 0, 'should plan a split');
    const childPath = result.splits[0]!.childPath;
    // Should match concepts/machine-learning-{section-slug}.md
    assert.ok(
      childPath.startsWith('concepts/machine-learning-'),
      `child path "${childPath}" should start with "concepts/machine-learning-"`,
    );
    assert.ok(childPath.endsWith('.md'), 'child path should end with .md');
  });
});
