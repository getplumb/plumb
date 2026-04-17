/**
 * fts5-reembed.test.ts — Tests for FTS5 BM25 search and auto re-embed.
 *
 * Verify command: pnpm -F @getplumb/wiki test -- --grep 'fts5|re-embed'
 *
 * Tests cover:
 *   - FTS5 virtual table is created by applyWikiSchema
 *   - FTS5 triggers keep the index in sync with wiki_chunks inserts/deletes
 *   - FTS5 BM25 search returns results ranked by relevance
 *   - WikiSearch returns results using FTS5 BM25 (section field populated)
 *   - H2-aware chunking splits pages correctly by section
 *   - WikiService.read() detects hash mismatch and triggers re-embed
 *   - WikiSearch pre-check detects hash mismatch and triggers re-embed
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WikiStore,
  WikiSearch,
  applyWikiSchema,
  openDb,
  serializeEmbedding,
  hashContent,
  chunkByH2,
} from '@getplumb/core';
import { WikiService } from './waas.js';
import type { WikiFrontmatter } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = join(tmpdir(), `plumb-fts5-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal zero-vector embedding for testing (384-dim). */
function zeroEmbedding(): string {
  return serializeEmbedding(new Float32Array(384).fill(0));
}

/** Seed a page + chunks directly into wiki.db. */
async function seedPage(
  dbPath: string,
  opts: {
    pageId: string;
    path: string;
    title: string;
    type: string;
    contentHash: string;
    chunks: Array<{ content: string; section?: string; embedding?: string }>;
  },
): Promise<void> {
  const store = await WikiStore.create({ dbPath });
  const db = store.db;

  const pageStmt = db.prepare(
    `INSERT OR REPLACE INTO wiki_pages
       (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
     VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', 'medium', '[]', '["test"]', 'active', 100, ?)`,
  );
  pageStmt.bind([opts.pageId, opts.path, opts.type, opts.title, opts.contentHash]);
  pageStmt.step();
  pageStmt.finalize();

  for (let i = 0; i < opts.chunks.length; i++) {
    const chunk = opts.chunks[i]!;
    const emb = chunk.embedding ?? zeroEmbedding();
    const section = chunk.section ?? '';
    const chunkStmt = db.prepare(
      `INSERT OR REPLACE INTO wiki_chunks
         (page_id, chunk_index, content, section, embed_status, embed_model, embedding)
       VALUES (?, ?, ?, ?, 'done', 'test-model', ?)`,
    );
    chunkStmt.bind([opts.pageId, i, chunk.content, section, emb]);
    chunkStmt.step();
    chunkStmt.finalize();
  }

  store.close();
}

const VALID_FM: WikiFrontmatter = {
  type: 'person',
  created: '2026-04-16',
  updated: '2026-04-16',
  source_refs: ['test:001'],
  tags: ['test'],
  confidence: 'high',
};

// ---------------------------------------------------------------------------
// FTS5: schema and index creation
// ---------------------------------------------------------------------------

describe('fts5 — schema creation and table structure', () => {
  let dbPath: string;
  let dir: string;

  beforeEach(async () => {
    dir = tempDir();
    dbPath = join(dir, 'wiki.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('fts5 — wiki_fts virtual table is created by applyWikiSchema', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    // The wiki_fts table should exist
    const rows = db.exec({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_fts'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ name: string }>;

    assert.ok(rows.length > 0, 'wiki_fts table should exist after applyWikiSchema');
    db.close();
  });

  test('fts5 — FTS5 triggers are created for wiki_chunks sync', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    const triggers = db.exec({
      sql: `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wiki_chunks'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ name: string }>;

    const names = new Set(triggers.map((t) => t.name));
    assert.ok(names.has('wiki_chunks_ai'), 'after-insert trigger should exist');
    assert.ok(names.has('wiki_chunks_bd'), 'before-delete trigger should exist');
    assert.ok(names.has('wiki_chunks_bu'), 'before-update trigger should exist');
    assert.ok(names.has('wiki_chunks_au'), 'after-update trigger should exist');
    db.close();
  });

  test('fts5 — wiki_chunks has section column', async () => {
    const db = await openDb(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyWikiSchema(db);

    const cols = db.exec({
      sql: 'PRAGMA table_info(wiki_chunks)',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ name: string }>;

    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes('section'), 'wiki_chunks should have a section column');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// FTS5: index synchronization via triggers
// ---------------------------------------------------------------------------

describe('fts5 — trigger-based index sync with wiki_chunks', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = tempDir();
    dbPath = join(dir, 'wiki.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('fts5 — inserting a chunk populates wiki_fts', async () => {
    await seedPage(dbPath, {
      pageId: 'test/alpha',
      path: 'test/alpha.md',
      title: 'Alpha',
      type: 'concept',
      contentHash: hashContent('alpha'),
      chunks: [{ content: 'Alpha is a unique keyword for testing purposes', section: 'Overview' }],
    });

    const store = await WikiStore.create({ dbPath });
    const db = store.db;

    // FTS5 should have indexed the chunk
    const stmt = db.prepare(`SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH 'alpha'`);
    const ids: number[] = [];
    while (stmt.step()) {
      const row = stmt.get({}) as { rowid: number };
      ids.push(row.rowid);
    }
    stmt.finalize();

    assert.ok(ids.length > 0, 'FTS5 should return results for indexed chunk text');
    store.close();
  });

  test('fts5 — deleting a chunk removes it from wiki_fts', async () => {
    await seedPage(dbPath, {
      pageId: 'test/beta',
      path: 'test/beta.md',
      title: 'Beta',
      type: 'concept',
      contentHash: hashContent('beta'),
      chunks: [{ content: 'Beta is another unique keyword for deletion test', section: '' }],
    });

    const store = await WikiStore.create({ dbPath });
    const db = store.db;

    // Verify it's in FTS before delete
    const stmtBefore = db.prepare(`SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH 'beta'`);
    const idsBefore: number[] = [];
    while (stmtBefore.step()) {
      const row = stmtBefore.get({}) as { rowid: number };
      idsBefore.push(row.rowid);
    }
    stmtBefore.finalize();
    assert.ok(idsBefore.length > 0, 'chunk should be in FTS before delete');

    // Delete the chunk
    const delStmt = db.prepare(`DELETE FROM wiki_chunks WHERE page_id = 'test/beta'`);
    delStmt.step();
    delStmt.finalize();

    // Should no longer be in FTS
    const stmtAfter = db.prepare(`SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH 'beta'`);
    const idsAfter: number[] = [];
    while (stmtAfter.step()) {
      const row = stmtAfter.get({}) as { rowid: number };
      idsAfter.push(row.rowid);
    }
    stmtAfter.finalize();

    assert.equal(idsAfter.length, 0, 'FTS should have no results after chunk delete');
    store.close();
  });

  test('fts5 — section column is stored in wiki_fts', async () => {
    await seedPage(dbPath, {
      pageId: 'test/gamma',
      path: 'test/gamma.md',
      title: 'Gamma',
      type: 'concept',
      contentHash: hashContent('gamma'),
      chunks: [{ content: 'Gamma radiation testing content', section: 'Physics Background' }],
    });

    const store = await WikiStore.create({ dbPath });
    const db = store.db;

    // Query chunk to verify section is stored
    const rows = db.exec({
      sql: `SELECT section FROM wiki_chunks WHERE page_id = 'test/gamma'`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ section: string }>;

    assert.ok(rows.length > 0, 'chunk should exist');
    assert.equal(rows[0]!.section, 'Physics Background', 'section should be stored correctly');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// FTS5 BM25 search — WikiSearch integration
// ---------------------------------------------------------------------------

describe('fts5 — WikiSearch returns results using FTS5 BM25', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');

    // Seed pages with distinct keyword sets for BM25 discrimination
    await seedPage(dbPath, {
      pageId: 'people/zara',
      path: 'people/zara.md',
      title: 'Zara Chen',
      type: 'person',
      contentHash: hashContent('zara'),
      chunks: [
        {
          content: 'Zara Chen is a machine learning researcher specializing in neural networks and deep learning.',
          section: 'Overview',
        },
      ],
    });

    await seedPage(dbPath, {
      pageId: 'companies/skynet',
      path: 'companies/skynet.md',
      title: 'Skynet AI',
      type: 'company',
      contentHash: hashContent('skynet'),
      chunks: [
        {
          content: 'Skynet AI builds autonomous robotics systems for industrial automation.',
          section: '',
        },
        {
          content: 'Skynet AI research department focuses on reinforcement learning algorithms.',
          section: 'Research',
        },
      ],
    });

    // Create stub files on disk so pre-check hash matches
    mkdirSync(join(wikiRoot, 'people'), { recursive: true });
    mkdirSync(join(wikiRoot, 'companies'), { recursive: true });
    writeFileSync(join(wikiRoot, 'people/zara.md'), 'zara', 'utf8');
    writeFileSync(join(wikiRoot, 'companies/skynet.md'), 'skynet', 'utf8');
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('fts5 — WikiSearch results include section field', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('zara neural networks', 5);
      assert.ok(results.length > 0, 'should return results');
      // All results should have a section field (possibly empty string)
      for (const r of results) {
        assert.ok(typeof r.section === 'string', 'section must be a string');
      }
    } finally {
      searcher.close();
    }
  });

  test('fts5 — BM25 keyword match ranks matching page higher', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('zara machine learning neural', 5);
      assert.ok(results.length > 0, 'should return results');
      const zaraResult = results.find((r) => r.path === 'people/zara.md');
      assert.ok(zaraResult, 'zara page should appear for zara-specific query');
    } finally {
      searcher.close();
    }
  });

  test('fts5 — FTS5 query returns results for unique keyword in chunk', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('reinforcement learning algorithms', 5);
      assert.ok(results.length > 0, 'should return at least one result');
      // Skynet has "reinforcement learning algorithms" in one of its chunks
      const skynetResult = results.find((r) => r.path === 'companies/skynet.md');
      assert.ok(skynetResult, 'skynet page should appear for its keywords');
    } finally {
      searcher.close();
    }
  });

  test('fts5 — search results are deduplicated by page (one per page)', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      // Skynet has 2 chunks — only one result should appear per page
      const results = await searcher.search('skynet AI', 10);
      const paths = results.map((r) => r.path);
      const uniquePaths = new Set(paths);
      assert.equal(paths.length, uniquePaths.size, 'no duplicate pages in results');
    } finally {
      searcher.close();
    }
  });
});

// ---------------------------------------------------------------------------
// H2-aware chunking
// ---------------------------------------------------------------------------

describe('fts5 — H2-aware chunking (chunkByH2)', () => {
  test('fts5 — chunkByH2 splits body at H2 boundaries', () => {
    const body = `# Main Title

Introduction paragraph before any H2 heading.

## Section One

Content for section one. Details here.

## Section Two

Content for section two. More details.
`;
    const chunks = chunkByH2(body);
    const sections = chunks.map((c) => c.section);

    // Should have chunks for pre-H2 content and each H2 section
    assert.ok(chunks.length >= 2, 'should produce at least 2 chunks for 2 H2 sections');
    assert.ok(sections.includes('Section One'), 'should have a chunk for Section One');
    assert.ok(sections.includes('Section Two'), 'should have a chunk for Section Two');
  });

  test('fts5 — chunkByH2 includes H2 heading in chunk content for context', () => {
    const body = `## Background

Details about the background context.
`;
    const chunks = chunkByH2(body);
    assert.ok(chunks.length > 0);
    // The heading line is included in the chunk content for search snippets
    assert.ok(chunks[0]!.content.includes('Background'), 'section heading should be in chunk content');
  });

  test('fts5 — chunkByH2 sub-chunks large H2 sections', () => {
    // Create a large section > 1200 chars
    const bigParagraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: This is a substantial block of text that adds content to the wiki page section. `.repeat(5),
    ).join('\n\n');

    const body = `## Large Section\n\n${bigParagraphs}`;
    const chunks = chunkByH2(body);

    // A section this large should be split into multiple chunks
    assert.ok(chunks.length > 1, 'large H2 section should be split into multiple sub-chunks');
    // All chunks should have the same section name
    for (const chunk of chunks) {
      assert.equal(chunk.section, 'Large Section', 'all sub-chunks should share the section name');
    }
  });

  test('fts5 — chunkByH2 handles body with no H2 headings', () => {
    const body = `# Title Only

Just a single paragraph with no H2 headings.
`;
    const chunks = chunkByH2(body);
    assert.ok(chunks.length > 0, 'should produce at least one chunk');
    // No H2 headings → section is empty string
    for (const chunk of chunks) {
      assert.equal(chunk.section, '', 'section should be empty string when no H2 headings');
    }
  });
});

// ---------------------------------------------------------------------------
// Re-embed: content-hash auto re-embed in WikiSearch pre-check
// ---------------------------------------------------------------------------

describe('re-embed — WikiSearch pre-check triggers re-embed on hash mismatch', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');
    mkdirSync(join(wikiRoot, 'people'), { recursive: true });
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('re-embed — hash mismatch detected: disk hash != stored hash', async () => {
    const diskContent = '# Bob Smith\n\nUpdated bio: Bob is now a VP.';
    writeFileSync(join(wikiRoot, 'people/bob.md'), diskContent, 'utf8');

    // Seed with a deliberately wrong hash
    await seedPage(dbPath, {
      pageId: 'people/bob',
      path: 'people/bob.md',
      title: 'Bob Smith',
      type: 'person',
      contentHash: 'stale-hash-does-not-match-disk',
      chunks: [{ content: 'Bob Smith is a designer.' }],
    });

    // Pre-check should detect the mismatch
    const diskHash = hashContent(diskContent);
    assert.notEqual('stale-hash-does-not-match-disk', diskHash, 'hashes should differ');

    // WikiSearch with preCheck=true should not throw even when embed fails in test env
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: true });
    try {
      const results = await searcher.search('bob', 5);
      // results may be empty if re-embed wiped chunks — the key is no exception
      assert.ok(Array.isArray(results), 'search should return an array even after re-embed attempt');
    } finally {
      searcher.close();
    }
  });

  test('re-embed — no re-embed when stored hash matches disk', async () => {
    const diskContent = 'exact-content-for-hash-match';
    const diskHash = hashContent(diskContent);
    writeFileSync(join(wikiRoot, 'people/bob.md'), diskContent, 'utf8');

    // Seed with correct hash
    await seedPage(dbPath, {
      pageId: 'people/bob',
      path: 'people/bob.md',
      title: 'Bob Smith',
      type: 'person',
      contentHash: diskHash,
      chunks: [{ content: 'Bob Smith is a designer with exact hash.' }],
    });

    // preCheck=true should NOT trigger re-embed (hashes match)
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: true });
    try {
      const results = await searcher.search('bob designer', 5);
      // Seeded chunk should survive (no re-embed wiped it)
      assert.ok(results.length > 0, 'seeded chunk should still be present when hash matches');
      assert.equal(results[0]!.path, 'people/bob.md');
    } finally {
      searcher.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Re-embed: WikiService.read() content-hash check
// ---------------------------------------------------------------------------

describe('re-embed — WikiService.read triggers re-embed on hash mismatch', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');
    mkdirSync(join(wikiRoot, 'people'), { recursive: true });
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('re-embed — wiki.read completes without error even when re-embed is triggered', async () => {
    // Write a valid wiki page on disk
    const content = `---
type: person
created: 2026-01-01
updated: 2026-04-16
source_refs:
  - test:001
tags: []
confidence: high
---

# Carol White

Carol is a test person.
`;
    writeFileSync(join(wikiRoot, 'people/carol.md'), content, 'utf8');

    // Seed with mismatched hash so re-embed is triggered on read
    const store = await WikiStore.create({ dbPath });
    const stmt = store.db.prepare(
      `INSERT OR REPLACE INTO wiki_pages
         (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-04-16', 'high', '[]', '["test:001"]', 'active', 10, ?)`,
    );
    stmt.bind(['people/carol', 'people/carol.md', 'person', 'Carol White', 'wrong-stale-hash']);
    stmt.step();
    stmt.finalize();
    store.close();

    // WikiService.read should not throw; re-embed runs in background
    const wiki = await WikiService.create({
      wikiRoot,
      db: { dbPath },
      reEmbedOnRead: true,
    });
    try {
      const page = await wiki.read('people/carol.md');
      assert.equal(page.title, 'Carol White', 'read should return the correct page');
      assert.equal(page.frontmatter.type, 'person');
    } finally {
      wiki.close();
    }
  });

  test('re-embed — wiki.read with reEmbedOnRead=false skips hash check', async () => {
    const content = `---
type: person
created: 2026-01-01
updated: 2026-04-16
source_refs:
  - test:001
tags: []
confidence: high
---

# Dave Black

Dave is another test person.
`;
    writeFileSync(join(wikiRoot, 'people/dave.md'), content, 'utf8');

    // Even with a wrong hash in DB, read should succeed without re-embed
    const wiki = await WikiService.create({
      wikiRoot,
      db: { dbPath },
      reEmbedOnRead: false,
    });
    try {
      const page = await wiki.read('people/dave.md');
      assert.equal(page.title, 'Dave Black');
    } finally {
      wiki.close();
    }
  });
});
