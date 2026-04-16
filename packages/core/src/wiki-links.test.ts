/**
 * Unit tests for wiki-links.ts
 *
 * Tests cover:
 *   - extractWikilinks: parses [[Link]] and [[Link|Display]] patterns
 *   - syncWikiLinks: populates and cleans up wiki_links table
 *   - resolveLinksToPage: marks dangling links as resolved
 *   - getOutboundLinks / getInboundLinks: query helpers
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
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
    assert.deepEqual(extractWikilinks('See [[Dylan Sellberg]] for details.'), ['Dylan Sellberg']);
  });

  test('extracts multiple [[Link]] targets', () => {
    const text = 'Mentions [[Samsara]] and [[Dylan Sellberg]] as well as [[AI Frameworks]].';
    assert.deepEqual(extractWikilinks(text), ['AI Frameworks', 'Dylan Sellberg', 'Samsara']);
  });

  test('extracts target from piped [[Target|Display Text]]', () => {
    assert.deepEqual(extractWikilinks('See [[Dylan Sellberg|Dylan]] for more.'), ['Dylan Sellberg']);
  });

  test('deduplicates repeated links to the same target', () => {
    const text = 'Mentioned [[Samsara]] twice. Also [[Samsara]] again.';
    assert.deepEqual(extractWikilinks(text), ['Samsara']);
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

This page is about [[Samsara]] and its relationship to [[AI Frameworks]].

## Section

See also [[Dylan Sellberg|the person]] for context.
    `.trim();
    assert.deepEqual(extractWikilinks(text), ['AI Frameworks', 'Dylan Sellberg', 'Samsara']);
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

describe('syncWikiLinks', () => {
  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('inserts links for all extracted targets', () => {
    insertPage(db, 'page-a', 'Page A');
    const body = '# Page A\n\nLinks to [[Samsara]] and [[Dylan Sellberg]].';
    syncWikiLinks(db, 'page-a', body);

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 2);
    const titles = rows.map(r => r.target_title).sort();
    assert.deepEqual(titles, ['Dylan Sellberg', 'Samsara']);
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
    insertPage(db, 'samsara', 'Samsara');
    syncWikiLinks(db, 'page-a', '[[Samsara]]');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'samsara');
  });

  test('resolution is case-insensitive', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'samsara', 'Samsara');
    syncWikiLinks(db, 'page-a', '[[samsara]]');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'samsara');
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

describe('resolveLinksToPage', () => {
  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('marks dangling links as resolved when target page is created', () => {
    insertPage(db, 'page-a', 'Page A');
    // Insert a dangling link manually
    db.exec(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES ('page-a', 'New Page', NULL, 0)`,
    );

    insertPage(db, 'new-page', 'New Page');
    resolveLinksToPage(db, 'New Page', 'new-page');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'new-page');
  });

  test('resolves case-insensitively', () => {
    insertPage(db, 'page-a', 'Page A');
    db.exec(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES ('page-a', 'new page', NULL, 0)`,
    );

    insertPage(db, 'new-page', 'New Page');
    resolveLinksToPage(db, 'New Page', 'new-page');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows[0]?.resolved, 1);
  });

  test('does not change already-resolved links', () => {
    insertPage(db, 'page-a', 'Page A');
    insertPage(db, 'existing', 'Existing');
    db.exec(
      `INSERT INTO wiki_links (source_page_id, target_title, target_page_id, resolved)
       VALUES ('page-a', 'Existing', 'existing', 1)`,
    );

    // Should be a no-op since WHERE resolved = 0
    resolveLinksToPage(db, 'Existing', 'existing');

    const rows = getOutboundLinks(db, 'page-a');
    assert.equal(rows[0]?.resolved, 1);
    assert.equal(rows[0]?.target_page_id, 'existing');
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
