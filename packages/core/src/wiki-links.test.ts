/**
 * Unit tests for wiki-links.ts
 *
 * Tests cover:
 *   - extractWikilinks: parses [[Link]] and [[Link|Display]] patterns
 *   - syncWikiLinks: populates and cleans up wiki_links table
 *   - resolveLinksToPage: re-resolves dangling links through the canonical resolver
 *   - getOutboundLinks / getInboundLinks: query helpers
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type WasmDb } from './wasm-db.js';
import { applyWikiSchema } from './wiki-schema.js';
import {
  extractWikilinks,
  syncWikiLinks,
  resolveLinksToPage,
  getOutboundLinks,
  getInboundLinks,
} from './wiki-links.js';

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

describe('extractWikilinks', () => {
  test('returns empty array for text with no wikilinks', () => {
    assert.deepEqual(extractWikilinks('No links here.'), []);
  });

  test('extracts a single [[Link]]', () => {
    assert.deepEqual(extractWikilinks('See [[Jordan Lee]] for details.'), ['Jordan Lee']);
  });

  test('extracts multiple [[Link]] targets', () => {
    const text = 'Mentions [[Northwind]] and [[Jordan Lee]] as well as [[AI Frameworks]].';
    assert.deepEqual(extractWikilinks(text), ['AI Frameworks', 'Jordan Lee', 'Northwind']);
  });

  test('extracts target from piped [[Target|Display Text]]', () => {
    assert.deepEqual(extractWikilinks('See [[Jordan Lee|Jordan]] for more.'), ['Jordan Lee']);
  });

  test('deduplicates repeated links to the same target', () => {
    const text = 'Mentioned [[Northwind]] twice. Also [[Northwind]] again.';
    assert.deepEqual(extractWikilinks(text), ['Northwind']);
  });

  test('returns sorted array', () => {
    const text = '[[Zebra]] and [[Alpha]] and [[Mango]].';
    assert.deepEqual(extractWikilinks(text), ['Alpha', 'Mango', 'Zebra']);
  });

  test('trims whitespace from targets', () => {
    assert.deepEqual(extractWikilinks('[[ Padded Link ]]'), ['Padded Link']);
  });

  test('ignores [[]] empty brackets', () => {
    assert.deepEqual(extractWikilinks('Empty [[]] brackets.'), []);
  });

  test('handles wikilinks in mixed markdown content', () => {
    const text = `
# My Page

This page is about [[Northwind]] and its relationship to [[AI Frameworks]].

## Section

See also [[Jordan Lee|the person]] for context.
    `.trim();
    assert.deepEqual(extractWikilinks(text), ['AI Frameworks', 'Jordan Lee', 'Northwind']);
  });

  test('does not extract from fenced code blocks content (regex limitation — documents behavior)', () => {
    // The regex intentionally does not skip code blocks for simplicity.
    // This test documents the current behavior.
    const text = '```\n[[CodeBlock]]\n```';
    assert.deepEqual(extractWikilinks(text), ['CodeBlock']);
  });
});

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

let db: WasmDb;

async function makeTestDb(): Promise<WasmDb> {
  const path = join(
    tmpdir(),
    `plumb-wiki-links-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const testDb = await openDb(path);
  testDb.exec('PRAGMA foreign_keys = OFF'); // Easier for tests without full page rows
  applyWikiSchema(testDb);
  return testDb;
}

/** Insert a minimal wiki_pages row so wiki_links FK constraints work (when ON). */
function insertPage(testDb: WasmDb, id: string, title: string): void {
  testDb.exec(
    `INSERT OR IGNORE INTO wiki_pages (id, path, type, title, created, updated, confidence)
     VALUES ('${id}', '${id}.md', 'concept', '${title.replace(/'/g, "''")}', '2026-01-01', '2026-01-01', 'medium')`,
  );
}

// ---------------------------------------------------------------------------
// syncWikiLinks
// ---------------------------------------------------------------------------

/**
 * Insert a page at its real wiki path, so path-style link resolution can be
 * exercised. `insertPage` puts every page at the wiki root, which cannot.
 */
function insertPageAt(testDb: WasmDb, id: string, path: string, title: string): void {
  testDb.exec(
    `INSERT OR IGNORE INTO wiki_pages (id, path, type, title, created, updated, confidence)
     VALUES ('${id}', '${path}', 'concept', '${title.replace(/'/g, "''")}', '2026-01-01', '2026-01-01', 'medium')`,
  );
}

/**
 * Link shapes taken verbatim from Alex's wiki on 2026-08-14, every one of which
 * the previous exact-title-match resolver dropped from `wiki_links`.
 *
 * These are the edges `plumb_wiki_links` is supposed to return and did not,
 * which matters because the wikilink graph is the propagation index the wiki
 * pipeline uses to find the OTHER pages a changed fact must update.
 */
describe('syncWikiLinks — real link shapes the title-only resolver dropped', () => {
  beforeEach(async () => {
    db = await makeTestDb();
    insertPageAt(db, 'src', 'companies/northwind.md', 'Northwind');
    insertPageAt(db, 'taylor', 'people/morgan-ellis.md', 'Northwind Principal PM – Maintenance');
    insertPageAt(db, 'loop', 'interviews/northwind-loop.md', 'Northwind Interview Loop — Principal PM, Agent Platform');
    insertPageAt(db, 'kei', 'interviews/northwind-sdk-sam.md', 'Latchkey SDK Interview — Sam Okafor');
  });

  afterEach(() => {
    db.close();
  });

  test('companies/northwind.md:69 — [[Morgan Ellis]] resolves to the kebab-case file', () => {
    // 23 live occurrences. The H1 is a role, not the person's name, so neither
    // the old title match nor a stem match could reach it.
    syncWikiLinks(db, 'src', 'Met with [[Morgan Ellis]] about the loop.');
    const rows = getOutboundLinks(db, 'src');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'taylor');
  });

  test('people/morgan-ellis.md — a page naming itself is not an edge', () => {
    // Found live on 2026-08-14: the page carries [[Morgan Ellis]], which
    // resolves to itself, and the first rebuild recorded it in BOTH directions.
    // A self-link inflates inbound counts and lets a page rescue itself from
    // the orphan list.
    syncWikiLinks(db, 'taylor', 'See [[Morgan Ellis]] and [[interviews/northwind-loop]].');
    const rows = getOutboundLinks(db, 'taylor');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.target_page_id, 'loop');
  });

  test('companies/northwind.md:85 — a path-style link resolves', () => {
    syncWikiLinks(db, 'src', 'See [[interviews/northwind-loop]].');
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'loop');
  });

  test('glossary.md:24 — a path written with an explicit .md suffix resolves', () => {
    syncWikiLinks(db, 'src', 'See [[interviews/northwind-loop.md]].');
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'loop');
  });

  test('interviews/locusview-head-of-product.md:87 — a piped alias resolves', () => {
    syncWikiLinks(db, 'src', 'Ran the [[interviews/northwind-loop|Northwind Loop]].');
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'loop');
  });

  test('companies/augury.md:16 — [[Alex]] resolves only when the wiki root is given', () => {
    // `wiki_pages` has no aliases column, so without the root the DB-backed
    // graph cannot see that people/alex-rivera.md answers to "Alex" — and the
    // file-based lint and `wiki_links` would then disagree about the same link.
    const root = mkdtempSync(join(tmpdir(), 'plumb-links-'));
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(
      join(root, 'people', 'alex-rivera.md'),
      ['---', 'aliases:', '  - Alex', '  - Alex R', '---', '', '# Alex Rivera'].join('\n'),
    );
    insertPageAt(db, 'alex', 'people/alex-rivera.md', 'Alex Rivera');

    syncWikiLinks(db, 'src', 'Met with [[Alex]].');
    assert.equal(getOutboundLinks(db, 'src')[0]?.resolved, 0, 'no root: alias invisible');

    syncWikiLinks(db, 'src', 'Met with [[Alex]].', root);
    const rows = getOutboundLinks(db, 'src');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'alex');

    rmSync(root, { recursive: true, force: true });
  });

  test('projects/plumb-benchmark-milestones.md:214 — a backticked link is not an edge', () => {
    // Prose ABOUT wikilinks previously created real wiki_links rows.
    syncWikiLinks(db, 'src', "follow the wiki's existing `[[interviews/northwind-loop]]` graph one hop out");
    assert.deepEqual(getOutboundLinks(db, 'src'), []);
  });

  test('interviews/northwind-sdk-sam.md:105 — a same-page anchor is not an edge', () => {
    syncWikiLinks(db, 'src', 'See [[#What Alex demoed (the AI-fluency half)]] above.');
    assert.deepEqual(getOutboundLinks(db, 'src'), []);
  });

  test('a cross-page anchor resolves to the page', () => {
    syncWikiLinks(db, 'src', 'See [[interviews/northwind-loop#Round 2]].');
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'loop');
  });
});

describe('syncWikiLinks', () => {
  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('inserts links for all extracted targets', () => {
    insertPage(db, 'page-a', 'Page A');
    const body = '# Page A\n\nLinks to [[Northwind]] and [[Jordan Lee]].';
    syncWikiLinks(db, 'page-a', body);

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 2);
    const titles = rows.map(r => r.target_title).sort();
    assert.deepEqual(titles, ['Jordan Lee', 'Northwind']);
  });

  test('all inserted links are unresolved when targets not in wiki_pages', () => {
    insertPage(db, 'page-a', 'Page A');
    syncWikiLinks(db, 'page-a', '[[Missing Page]]');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.resolved, 0);
    assert.equal(rows[0]?.target_page_id, null);
  });

  test('resolves links when target page exists in wiki_pages', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'northwind', 'Northwind');
    syncWikiLinks(db, 'page-a', '[[Northwind]]');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'northwind');
  });

  test('resolution is case-insensitive', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'northwind', 'Northwind');
    syncWikiLinks(db, 'page-a', '[[northwind]]');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'northwind');
  });

  test('cleans up old links when called again with new body', () => {
    insertPage(db, 'page-a', 'Page A');
    syncWikiLinks(db, 'page-a', '[[Old Link]] and [[Another Old Link]]');

    // First sync — two links
    let rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 2);

    // Update: body now has only one link
    syncWikiLinks(db, 'page-a', '[[New Link Only]]');

    rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.target_title, 'New Link Only');
  });

  test('removes all links when body has no wikilinks', () => {
    insertPage(db, 'page-a', 'Page A');
    syncWikiLinks(db, 'page-a', '[[Link One]] and [[Link Two]]');
    assert.equal(getOutboundLinks(db, 'page-a').length, 2);

    syncWikiLinks(db, 'page-a', 'No links in this version.');
    assert.equal(getOutboundLinks(db, 'page-a').length, 0);
  });

  test('does not affect links from other source pages', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'page-b', 'Page B');
    syncWikiLinks(db, 'page-a', '[[Shared Target]]');
    syncWikiLinks(db, 'page-b', '[[Shared Target]]');

    // Update only page-a
    syncWikiLinks(db, 'page-a', 'No more links.');

    assert.equal(getOutboundLinks(db, 'page-a').length, 0);
    assert.equal(getOutboundLinks(db, 'page-b').length, 1);
  });
});

// ---------------------------------------------------------------------------
// resolveLinksToPage
// ---------------------------------------------------------------------------

/**
 * REWRITTEN 2026-08-14 along with the function.
 *
 * The old tests exercised a title-only `UPDATE ... WHERE LOWER(target_title) =
 * LOWER(pageTitle)` and passed, which is precisely why they were not evidence:
 * they only ever asked the one tier that SQL could answer. Every case below is
 * a link shape observed on Alex's live wiki, and each one is a shape that
 * comparison would have silently declined to repair.
 */
describe('resolveLinksToPage', () => {
  let wikiRoot: string;

  beforeEach(async () => {
    db = await makeTestDb();
    wikiRoot = mkdtempSync(join(tmpdir(), 'plumb-dangling-'));
  });

  afterEach(() => {
    db.close();
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  /** Insert a dangling row exactly as syncWikiLinks would have written it. */
  function insertDangling(sourceId: string, targetTitle: string): void {
    db.exec(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES ('${sourceId}', '${targetTitle.replace(/'/g, "''")}', NULL, 0)`,
    );
  }

  function writePage(path: string, body: string): void {
    const abs = join(wikiRoot, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }

  test('the real Halcyon case: creating a page resolves an existing inbound link', () => {
    // people/robin-vance.md:13 — "Director of Global Talent Acquisition at
    // [[Halcyon]]." On 2026-08-14 companies/halcyon.md was created and this row
    // stayed resolved = 0, because syncWikiLinks only rewrites rows whose
    // SOURCE page changed and robin-vance.md had not changed.
    insertPageAt(db, 'lauren', 'people/robin-vance.md', 'Robin Vance');
    insertDangling('lauren', 'Halcyon');

    let swept = resolveLinksToPage(db);
    assert.equal(swept.resolved, 0, 'nothing to resolve to yet');
    assert.equal(getOutboundLinks(db, 'lauren')[0]?.resolved, 0);

    insertPageAt(db, 'halcyon', 'companies/halcyon.md', 'Halcyon');
    swept = resolveLinksToPage(db);

    assert.equal(swept.checked, 1);
    assert.equal(swept.resolved, 1);
    assert.deepEqual(swept.repaired, [
      { sourcePath: 'people/robin-vance.md', targetTitle: 'Halcyon', targetPath: 'companies/halcyon.md' },
    ]);
    const rows = getOutboundLinks(db, 'lauren');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'halcyon');
  });

  test('resolves a path-style target, which a title comparison never could', () => {
    // `[[people/priya]]` — path links are the largest single shape on this
    // wiki and are not equal to any page TITLE, so the old SQL skipped them.
    insertPageAt(db, 'src', 'companies/meridian-grid.md', 'Meridian Grid');
    insertDangling('src', 'people/priya');

    insertPageAt(db, 'priya', 'people/priya.md', 'Priya Raman');
    const swept = resolveLinksToPage(db);

    assert.equal(swept.resolved, 1);
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'priya');
  });

  test('resolves a display name against a kebab-case filename', () => {
    // `[[Morgan Ellis]]` -> people/morgan-ellis.md, whose H1 is the role
    // "Northwind Principal PM – Maintenance". Neither the title nor the stem
    // matches the link text; only the slug tier does. 23 live occurrences.
    insertPageAt(db, 'src', 'companies/northwind.md', 'Northwind');
    insertDangling('src', 'Morgan Ellis');

    insertPageAt(db, 'taylor', 'people/morgan-ellis.md', 'Northwind Principal PM – Maintenance');
    const swept = resolveLinksToPage(db);

    assert.equal(swept.resolved, 1);
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'taylor');
  });

  test('resolves a frontmatter alias when the wiki root is supplied', () => {
    // `[[Alex]]` -> people/alex-rivera.md via `aliases:`. wiki_pages has no
    // aliases column, so this tier only exists when the root is passed.
    insertPageAt(db, 'src', 'companies/latchkey.md', 'Latchkey');
    insertDangling('src', 'Alex');

    insertPageAt(db, 'alex', 'people/alex-rivera.md', 'Alex Rivera');
    writePage('people/alex-rivera.md', '---\naliases: [Alex, Alex R]\n---\n\n# Alex Rivera\n');
    writePage('companies/latchkey.md', '# Latchkey\n');

    assert.equal(resolveLinksToPage(db).resolved, 0, 'no alias tier without the root');
    assert.equal(resolveLinksToPage(db, wikiRoot).resolved, 1);
    assert.equal(getOutboundLinks(db, 'src')[0]?.target_page_id, 'alex');
  });

  test('a still-missing target stays unresolved', () => {
    // `[[Plumb Wiki Integrity]]` — a deliberate forward reference on
    // projects/plumb-wiki-pipeline-redesign.md to a job that does not exist.
    // The sweep must not invent a target for it.
    insertPageAt(db, 'src', 'projects/plumb-wiki-pipeline-redesign.md', 'Plumb Wiki Pipeline Redesign');
    insertDangling('src', 'Plumb Wiki Integrity');

    const swept = resolveLinksToPage(db);
    assert.equal(swept.checked, 1);
    assert.equal(swept.resolved, 0);
    assert.equal(getOutboundLinks(db, 'src')[0]?.resolved, 0);
  });

  test('an ambiguous target stays unresolved rather than picking a winner', () => {
    // The rule the whole resolver rests on: two pages answering to one name
    // resolve to neither, and a human names the winner. Silently binding to
    // the first is what permanently orphaned the loser before Phase 0.
    insertPageAt(db, 'src', 'people/alex-rivera.md', 'Alex Rivera');
    insertDangling('src', 'ChromaDB');
    insertPageAt(db, 'a', 'concepts/chromadb.md', 'ChromaDB');
    insertPageAt(db, 'b', 'tools/chromadb.md', 'ChromaDB');

    const swept = resolveLinksToPage(db);
    assert.equal(swept.resolved, 0);
    assert.equal(getOutboundLinks(db, 'src')[0]?.resolved, 0);
  });

  test('already-resolved rows are never touched', () => {
    insertPageAt(db, 'src', 'people/alex-rivera.md', 'Alex Rivera');
    insertPageAt(db, 'existing', 'tools/plumb.md', 'Plumb');
    db.exec(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES ('src', 'Plumb', 'existing', 1)`,
    );

    const swept = resolveLinksToPage(db);
    assert.equal(swept.checked, 0, 'the sweep only ever reads resolved = 0');
    const rows = getOutboundLinks(db, 'src');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'existing');
  });

  test('a page naming itself is not recorded as an edge', () => {
    // people/morgan-ellis.md contains [[Morgan Ellis]]. A self-link
    // inflates inbound counts and lets a page rescue itself from the orphan list.
    insertPageAt(db, 'taylor', 'people/morgan-ellis.md', 'Northwind Principal PM – Maintenance');
    insertDangling('taylor', 'Morgan Ellis');

    const swept = resolveLinksToPage(db);
    assert.equal(swept.resolved, 0);
  });

  test('an empty graph is a no-op', () => {
    const swept = resolveLinksToPage(db);
    assert.deepEqual(swept, { checked: 0, resolved: 0, repaired: [] });
  });
});

// ---------------------------------------------------------------------------
// getOutboundLinks / getInboundLinks
// ---------------------------------------------------------------------------

describe('getOutboundLinks', () => {
  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('returns empty array for page with no links', () => {
    insertPage(db, 'page-a', 'Page A');
    assert.deepEqual(getOutboundLinks(db, 'page-a'), []);
  });

  test('returns links sorted by target_title', () => {
    insertPage(db, 'page-a', 'Page A');
    syncWikiLinks(db, 'page-a', '[[Zebra]] and [[Alpha]] and [[Mango]].');

    const rows = getOutboundLinks(db, 'page-a');
    assert.deepEqual(
      rows.map(r => r.target_title),
      ['Alpha', 'Mango', 'Zebra'],
    );
  });
});

describe('getInboundLinks', () => {
  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('returns empty array for page with no inbound links', () => {
    insertPage(db, 'page-a', 'Page A');
    assert.deepEqual(getInboundLinks(db, 'page-a'), []);
  });

  test('returns all pages that link to the given page', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'page-b', 'Page B');
    insertPage(db, 'page-c', 'Page C');
    insertPage(db, 'target', 'Target');

    syncWikiLinks(db, 'page-a', '[[Target]]');
    syncWikiLinks(db, 'page-b', '[[Target]]');
    syncWikiLinks(db, 'page-c', '[[Other Thing]]'); // does not link to target

    const inbound = getInboundLinks(db, 'target');
    assert.equal(inbound.length, 2);
    const sources = inbound.map(r => r.source_page_id).sort();
    assert.deepEqual(sources, ['page-a', 'page-b']);
  });
});
