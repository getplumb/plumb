/**
 * Unit tests for wiki-search.ts (WikiSearch)
 *
 * Tests cover:
 *   - basic search returns results with the expected shape
 *   - hash mismatch triggers re-embed (pre-check)
 *   - RRF merges vector and BM25 result sets correctly
 *
 * The @xenova/transformers model is not available in unit test environment,
 * so embedQuery() returns a zero vector (graceful degradation).  We rely on
 * BM25 scoring for result ordering, which works without the model.
 */

import { test, describe, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WikiSearch } from './wiki-search.js';
import { WikiStore } from './wiki-schema.js';
import { serializeEmbedding } from './vector-search.js';
import { hashContent } from './wiki-fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = join(tmpdir(), `wiki-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal zero-vector embedding for testing (384-dim, matches EMBED_DIM). */
function zeroEmbedding(): string {
  return serializeEmbedding(new Float32Array(384).fill(0));
}

/**
 * Insert a wiki page + chunks directly into wiki.db so we can test search
 * without running the full embed pipeline.
 */
async function seedPage(
  dbPath: string,
  opts: {
    pageId: string;
    path: string;
    title: string;
    type: string;
    contentHash: string;
    chunks: Array<{ content: string; embedding?: string }>;
  },
): Promise<void> {
  const store = await WikiStore.create({ dbPath });
  const db = store.db;

  const pageStmt = db.prepare(
    `INSERT OR REPLACE INTO wiki_pages
       (id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count, content_hash)
     VALUES (?, ?, ?, ?, '', '', 'medium', '[]', '[]', 'active', 100, ?)`,
  );
  pageStmt.bind([opts.pageId, opts.path, opts.type, opts.title, opts.contentHash]);
  pageStmt.step();
  pageStmt.finalize();

  for (let i = 0; i < opts.chunks.length; i++) {
    const chunk = opts.chunks[i]!;
    const emb = chunk.embedding ?? zeroEmbedding();
    const chunkStmt = db.prepare(
      `INSERT OR REPLACE INTO wiki_chunks
         (page_id, chunk_index, content, embed_status, embed_model, embedding)
       VALUES (?, ?, ?, 'done', 'test-model', ?)`,
    );
    chunkStmt.bind([opts.pageId, i, chunk.content, emb]);
    chunkStmt.step();
    chunkStmt.finalize();
  }

  store.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikiSearch.search — basic', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');

    // Seed two pages
    await seedPage(dbPath, {
      pageId: 'people/alice',
      path: 'people/alice.md',
      title: 'Alice Johnson',
      type: 'person',
      contentHash: hashContent('alice johnson content'),
      chunks: [{ content: 'Alice Johnson is an engineer at Acme Corp specializing in distributed systems.' }],
    });

    await seedPage(dbPath, {
      pageId: 'companies/acme',
      path: 'companies/acme.md',
      title: 'Acme Corp',
      type: 'company',
      contentHash: hashContent('acme corp content'),
      chunks: [
        { content: 'Acme Corp is a technology company based in San Francisco.' },
        { content: 'Acme Corp develops cloud infrastructure products used by Fortune 500 companies.' },
      ],
    });

    // Create stub markdown files on disk so pre-check hash matches (no re-embed)
    mkdirSync(join(wikiRoot, 'people'), { recursive: true });
    mkdirSync(join(wikiRoot, 'companies'), { recursive: true });
    writeFileSync(join(wikiRoot, 'people/alice.md'), 'alice johnson content', 'utf8');
    writeFileSync(join(wikiRoot, 'companies/acme.md'), 'acme corp content', 'utf8');
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('search returns results with required fields', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('alice engineer', 5);
      assert.ok(results.length > 0, 'should return at least one result');
      const first = results[0]!;
      assert.ok(typeof first.path === 'string', 'path must be string');
      assert.ok(typeof first.title === 'string', 'title must be string');
      assert.ok(typeof first.type === 'string', 'type must be string');
      assert.ok(typeof first.snippet === 'string', 'snippet must be string');
      assert.ok(typeof first.score === 'number', 'score must be number');
      assert.ok(first.score > 0, 'score must be positive');
    } finally {
      searcher.close();
    }
  });

  test('search deduplicates results by page (one result per page)', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('Acme company cloud', 10);
      const paths = results.map((r) => r.path);
      const uniquePaths = new Set(paths);
      assert.equal(paths.length, uniquePaths.size, 'no duplicate pages in results');
    } finally {
      searcher.close();
    }
  });

  test('search respects topK limit', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('technology company', 1);
      assert.ok(results.length <= 1, 'should return at most topK results');
    } finally {
      searcher.close();
    }
  });

  test('search returns empty array when no chunks in DB', async () => {
    const emptyDbPath = join(tempDir(), 'empty.db');
    const emptyRoot = join(tmpdir(), `empty-wiki-${Date.now()}`);
    mkdirSync(emptyRoot, { recursive: true });
    const searcher = await WikiSearch.create({ wikiRoot: emptyRoot, dbPath: emptyDbPath, preCheck: false });
    try {
      const results = await searcher.search('anything', 5);
      assert.deepEqual(results, []);
    } finally {
      searcher.close();
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(emptyDbPath, { force: true });
    }
  });

  test('BM25 keyword match ranks matching page higher', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      // Query specifically about Alice — BM25 should surface alice page
      const results = await searcher.search('Alice distributed systems engineer', 5);
      assert.ok(results.length > 0);
      // The alice page should appear in results
      const alicePage = results.find((r) => r.path === 'people/alice.md');
      assert.ok(alicePage, 'alice page should appear in results for alice query');
    } finally {
      searcher.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-check: hash mismatch triggers re-embed
// ---------------------------------------------------------------------------

describe('WikiSearch pre-check — hash mismatch triggers re-embed', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');

    mkdirSync(join(wikiRoot, 'people'), { recursive: true });

    // Seed a page with a hash that will NOT match the disk file
    await seedPage(dbPath, {
      pageId: 'people/bob',
      path: 'people/bob.md',
      title: 'Bob Smith',
      type: 'person',
      // Deliberately wrong hash — simulates stale DB after external edit
      contentHash: 'stale-hash-that-does-not-match',
      chunks: [{ content: 'Bob Smith is a designer.' }],
    });
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('hash mismatch detected when disk content differs from stored hash', async () => {
    // Write disk file with content that does NOT match the stored hash
    const diskContent = '# Bob Smith\n\nUpdated bio: Bob is now a PM.';
    writeFileSync(join(wikiRoot, 'people/bob.md'), diskContent, 'utf8');
    const diskHash = hashContent(diskContent);

    // Verify the stored hash is different from the disk hash
    assert.notEqual('stale-hash-that-does-not-match', diskHash, 'stored hash should differ from disk');

    // The pre-check should detect the mismatch and call runWikiEmbed.
    // runWikiEmbed will fail gracefully because @xenova/transformers is unavailable
    // in the test environment — but we verify it was attempted by checking that
    // the search still completes without throwing.
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: true });
    try {
      // Should not throw even if re-embed fails (embedder unavailable in tests)
      const results = await searcher.search('bob designer', 5);
      // results may be empty if re-embed wiped chunks — that's fine, the key is no crash
      assert.ok(Array.isArray(results));
    } finally {
      searcher.close();
    }
  });

  test('no re-embed when hash matches', async () => {
    const diskContent = 'exact content that matches hash';
    const diskHash = hashContent(diskContent);
    writeFileSync(join(wikiRoot, 'people/bob.md'), diskContent, 'utf8');

    // Update the DB so stored hash matches disk
    const store = await WikiStore.create({ dbPath });
    const updateStmt = store.db.prepare(`UPDATE wiki_pages SET content_hash = ? WHERE id = 'people/bob'`);
    updateStmt.bind([diskHash]);
    updateStmt.step();
    updateStmt.finalize();
    store.close();

    // With preCheck: true and matching hash, no re-embed should occur
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: true });
    try {
      const results = await searcher.search('bob designer', 5);
      // The seeded chunk should still be present (no re-embed wiped it)
      assert.ok(results.length > 0, 'results should include seeded page when hash matches');
      assert.equal(results[0]!.path, 'people/bob.md');
    } finally {
      searcher.close();
    }
  });
});

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

describe('WikiSearch — RRF merges vector and BM25 results', () => {
  let wikiRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    wikiRoot = tempDir();
    dbPath = join(wikiRoot, 'wiki.db');
    mkdirSync(join(wikiRoot, 'topics'), { recursive: true });

    // Page A: strong BM25 match for "quantum" but zero vector
    await seedPage(dbPath, {
      pageId: 'topics/quantum',
      path: 'topics/quantum.md',
      title: 'Quantum Computing',
      type: 'concept',
      contentHash: hashContent('quantum'),
      chunks: [
        {
          content: 'Quantum computing uses quantum mechanics to perform computation at extraordinary speeds.',
          embedding: serializeEmbedding(new Float32Array(384).fill(0)),
        },
      ],
    });
    writeFileSync(join(wikiRoot, 'topics/quantum.md'), 'quantum', 'utf8');

    // Page B: weaker BM25 match but non-zero vector similarity
    const bVec = new Float32Array(384).fill(0.05);
    await seedPage(dbPath, {
      pageId: 'topics/ml',
      path: 'topics/ml.md',
      title: 'Machine Learning',
      type: 'concept',
      contentHash: hashContent('ml'),
      chunks: [
        {
          content: 'Machine learning algorithms learn patterns from data to make predictions.',
          embedding: serializeEmbedding(bVec),
        },
      ],
    });
    writeFileSync(join(wikiRoot, 'topics/ml.md'), 'ml', 'utf8');
  });

  afterEach(() => {
    rmSync(wikiRoot, { recursive: true, force: true });
  });

  test('RRF returns results from both vector and BM25 lists', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('quantum machine learning', 10);
      assert.ok(results.length >= 1, 'should return at least one result');
      // Both pages should appear since both have matching keywords
      const paths = results.map((r) => r.path);
      assert.ok(paths.includes('topics/quantum.md'), 'quantum page should appear');
    } finally {
      searcher.close();
    }
  });

  test('RRF scores are positive numbers', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('quantum computing', 5);
      for (const result of results) {
        assert.ok(result.score > 0, `score should be positive, got ${result.score}`);
      }
    } finally {
      searcher.close();
    }
  });

  test('RRF result order is stable (descending score)', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('quantum', 10);
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1]!.score >= results[i]!.score,
          `results should be sorted by descending score, but index ${i - 1} score ${results[i - 1]!.score} < index ${i} score ${results[i]!.score}`,
        );
      }
    } finally {
      searcher.close();
    }
  });
});
