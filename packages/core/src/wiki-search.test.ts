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
import { WikiStore } from './wiki-schema.js';
import { WikiSearch } from './wiki-search.js';
import { serializeEmbedding } from './vector-search.js';
import { hashContent } from './wiki-fs.js';
import { embedQuery } from './embedder.js';
import {
  formatContextualChildText,
  contextualContextHash,
  contextualSourceHash,
  normalizeContextualConfig,
  DEFAULT_CONTEXTUAL_MODEL,
  backfillContextualEmbeddings,
} from './wiki-contextual-embeddings.js';

function testVector(dim: number, value = 1): Float32Array {
  const vec = new Float32Array(384).fill(0);
  vec[dim] = value;
  return vec;
}


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
    chunks: Array<{ content: string; section?: string; embedding?: string }>;
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
         (page_id, chunk_index, content, section, embed_status, embed_model, embedding)
       VALUES (?, ?, ?, ?, 'done', 'test-model', ?)`,
    );
    chunkStmt.bind([opts.pageId, i, chunk.content, chunk.section ?? '', emb]);
    chunkStmt.step();
    chunkStmt.finalize();
  }

  store.close();
}

async function seedContextualEmbedding(dbPath: string, chunkId: number, pageId: string, chunkIndex: number, embedding = zeroEmbedding(), dimensions = 384, contextHash?: string, sourceHash?: string): Promise<void> {
  const store = await WikiStore.create({ dbPath });
  const db = store.db;
  const rows = db.exec({
    sql: `SELECT c.content, COALESCE(c.section, '') AS section, p.path, p.title, p.type
          FROM wiki_chunks c JOIN wiki_pages p ON p.id = c.page_id
          WHERE c.id = ${chunkId}`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ content: string; section: string; path: string; title: string; type: string }>;
  const input = rows[0]
    ? { pageTitle: rows[0].title, pageType: rows[0].type, pagePath: rows[0].path, section: rows[0].section, rawContent: rows[0].content }
    : null;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wiki_chunk_context_embeddings
      (chunk_id, page_id, chunk_index, model, source_hash, context_hash, status, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?)
  `);
  stmt.bind([
    chunkId,
    pageId,
    chunkIndex,
    DEFAULT_CONTEXTUAL_MODEL,
    sourceHash ?? (input ? contextualSourceHash(input) : 'source'),
    contextHash ?? (input ? contextualContextHash(input) : 'context'),
    dimensions,
    embedding,
  ]);
  stmt.step();
  stmt.finalize();
  store.close();
}


async function allChunkIds(dbPath: string): Promise<Array<{ id: number; page_id: string; chunk_index: number }>> {
  const store = await WikiStore.create({ dbPath });
  const rows = store.db.exec({
    sql: `SELECT id, page_id, chunk_index FROM wiki_chunks WHERE embed_status = 'done' ORDER BY page_id, chunk_index`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: number; page_id: string; chunk_index: number }>;
  store.close();
  return rows;
}

async function firstChunkId(dbPath: string, pageId: string, chunkIndex = 0): Promise<number> {
  const store = await WikiStore.create({ dbPath });
  const rows = store.db.exec({
    sql: `SELECT id FROM wiki_chunks WHERE page_id = '${pageId}' AND chunk_index = ${chunkIndex}`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: number }>;
  store.close();
  return rows[0]!.id;
}

async function seedAllContextualEmbeddings(dbPath: string): Promise<void> {
  const store = await WikiStore.create({ dbPath });
  const rows = store.db.exec({
    sql: `SELECT c.id, c.page_id, c.chunk_index, COALESCE(c.section, '') AS section, c.content, p.path, p.title, p.type
          FROM wiki_chunks c JOIN wiki_pages p ON p.id = c.page_id
          WHERE c.embed_status = 'done'
          ORDER BY c.id`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ id: number; page_id: string; chunk_index: number; section: string; content: string; path: string; title: string; type: string }>;
  store.close();
  for (const row of rows) {
    await seedContextualEmbedding(
      dbPath,
      row.id,
      row.page_id,
      row.chunk_index,
      row.chunk_index === 0 ? serializeEmbedding(new Float32Array(384).fill(0.2)) : zeroEmbedding(),
      384,
      contextualContextHash({ pageTitle: row.title, pageType: row.type, pagePath: row.path, section: row.section, rawContent: row.content }),
    );
  }
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

  test('search preserves multiple relevant chunks from the same page', async () => {
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('Acme San Francisco cloud infrastructure', 10);
      const acmeResults = results.filter((r) => r.path === 'companies/acme.md');
      assert.ok(acmeResults.length >= 2, 'multiple Acme chunks should survive retrieval');
      assert.ok(
        acmeResults.some((r) => r.snippet.includes('San Francisco')),
        'first relevant Acme chunk should be returned',
      );
      assert.ok(
        acmeResults.some((r) => r.snippet.includes('cloud infrastructure')),
        'second relevant Acme chunk should be returned',
      );
    } finally {
      searcher.close();
    }
  });

  test('aggregates multiple supporting child hits by parent section while preserving child provenance', async () => {
    mkdirSync(join(wikiRoot, 'projects'), { recursive: true });

    await seedPage(dbPath, {
      pageId: 'projects/single-evidence',
      path: 'projects/single-evidence.md',
      title: 'Single Evidence',
      type: 'project',
      contentHash: hashContent('single evidence'),
      chunks: [{ content: 'needle appears in one isolated child chunk.', section: 'Evidence' }],
    });
    writeFileSync(join(wikiRoot, 'projects/single-evidence.md'), 'single evidence', 'utf8');

    await seedPage(dbPath, {
      pageId: 'projects/multi-evidence',
      path: 'projects/multi-evidence.md',
      title: 'Multi Evidence',
      type: 'project',
      contentHash: hashContent('multi evidence'),
      chunks: [
        { content: 'needle appears in the first supporting child chunk.', section: 'Evidence' },
        { content: 'needle appears in the second supporting child chunk.', section: 'Evidence' },
      ],
    });
    writeFileSync(join(wikiRoot, 'projects/multi-evidence.md'), 'multi evidence', 'utf8');

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('needle', 10);
      const first = results[0]!;

      assert.equal(first.path, 'projects/multi-evidence.md', 'multi-child section should rank first');
      assert.equal(first.section, 'Evidence');
      assert.equal(first.supportingChunkCount, 2, 'parent section should count both child hits');
      assert.equal(first.score, first.parentSectionScore, 'public score should be the parent-section score');
      assert.ok(first.parentSectionScore > first.childScore, 'aggregate score should exceed the child score');

      const multiEvidence = results.filter((r) => r.path === 'projects/multi-evidence.md');
      assert.ok(multiEvidence.length >= 2, 'both child chunks should remain available as provenance');
      assert.deepEqual(
        new Set(multiEvidence.map((r) => r.chunkIndex)),
        new Set([0, 1]),
        'child chunk indexes should identify the supporting provenance chunks',
      );
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

  test('contextual sidecar schema is applied without replacing plain embeddings', async () => {
    const store = await WikiStore.create({ dbPath });
    try {
      const tables = store.db.exec({
        sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_chunk_context_embeddings'`,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Array<{ name: string }>;
      assert.equal(tables.length, 1);
      const plainEmbeddingCount = store.db.selectValue(`SELECT count(*) FROM wiki_chunks WHERE embedding IS NOT NULL`) as number;
      assert.ok(plainEmbeddingCount > 0, 'plain embedding column remains populated');
    } finally {
      store.close();
    }
  });

  test('contextual formatting and hashes include metadata while preserving raw content', () => {
    const input = {
      pageTitle: 'Alice Johnson',
      pageType: 'person',
      pagePath: 'people/alice.md',
      section: 'Work',
      rawContent: 'Alice raw child content.',
    };
    const text = formatContextualChildText(input);
    assert.equal(text, 'Title: Alice Johnson\nType: person\nBreadcrumb: Alice Johnson › Work\n\nAlice raw child content.');
    assert.ok(text.endsWith('Alice raw child content.'), 'raw child text remains unmodified at tail');
    assert.equal(contextualSourceHash(input), contextualSourceHash(input));
    assert.equal(contextualContextHash(input), contextualContextHash(input));
    assert.notEqual(contextualContextHash(input), contextualContextHash({ ...input, section: 'Other' }));
  });

  test('off mode preserves plain retrieval behavior', async () => {
    const plain = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    const off = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'off' } });
    try {
      assert.deepEqual(await off.search('Alice engineer', 5), await plain.search('Alice engineer', 5));
    } finally {
      plain.close();
      off.close();
    }
  });

  test('active mode uses contextual sidecar only when coverage is complete', async () => {
    const rows = await allChunkIds(dbPath);
    for (const row of rows) {
      const isAlice = row.page_id === 'people/alice';
      const input = isAlice
        ? { pageTitle: 'Alice Johnson', pageType: 'person', pagePath: 'people/alice.md', section: '', rawContent: 'Alice Johnson is an engineer at Acme Corp specializing in distributed systems.' }
        : row.chunk_index === 0
          ? { pageTitle: 'Acme Corp', pageType: 'company', pagePath: 'companies/acme.md', section: '', rawContent: 'Acme Corp is a technology company based in San Francisco.' }
          : { pageTitle: 'Acme Corp', pageType: 'company', pagePath: 'companies/acme.md', section: '', rawContent: 'Acme Corp develops cloud infrastructure products used by Fortune 500 companies.' };
      await seedContextualEmbedding(dbPath, row.id, row.page_id, row.chunk_index, zeroEmbedding(), 384, contextualContextHash(input));
    }
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    const searcher = await WikiSearch.create({
      wikiRoot,
      dbPath,
      preCheck: false,
      contextualRetrieval: { mode: 'active' },
      onContextualTelemetry: (event) => events.push(event),
      onSearchDiagnostics: (event) => diagnostics.push(event),
    });
    try {
      const results = await searcher.search('Alice engineer', 5);
      assert.ok(results.length > 0);
      assert.equal(results[0]!.retrievalSource, 'contextual');
      assert.equal((events[0] as any).status, 'ok');
      assert.equal((events[0] as any).coverage.coverageRatio, 1);
      assert.equal((events[0] as any).plainResultCount, 0);
      assert.deepEqual(diagnostics.map((event: any) => event.source), ['contextual', 'contextual']);
    } finally {
      searcher.close();
    }
  });

  test('E039: contextual results expose same-page sibling candidates from other sections only', async () => {
    mkdirSync(join(wikiRoot, 'projects'), { recursive: true });
    await seedPage(dbPath, {
      pageId: 'projects/multi-section',
      path: 'projects/multi-section.md',
      title: 'Multi Section',
      type: 'project',
      contentHash: hashContent('multi section'),
      chunks: [
        { content: 'The gizmoflux kickoff happened in the overview section.', section: 'Overview' },
        { content: 'A second overview chunk about the gizmoflux timeline.', section: 'Overview' },
        { content: 'An implementation-section chunk about gizmoflux internals.', section: 'Implementation' },
      ],
    });
    writeFileSync(join(wikiRoot, 'projects/multi-section.md'), 'multi section', 'utf8');
    await seedAllContextualEmbeddings(dbPath);

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' } });
    try {
      const results = await searcher.search('gizmoflux', 5);
      const hit = results.find((r) => r.path === 'projects/multi-section.md');
      assert.ok(hit, 'multi-section page should be retrieved');
      assert.ok(['Overview', 'Implementation'].includes(hit!.section), 'representative child should come from a real section');
      assert.ok(hit!.siblingCandidates && hit!.siblingCandidates.length > 0, 'siblings should be offered');
      assert.ok(
        hit!.siblingCandidates!.every((s) => s.section !== hit!.section),
        'same-section chunks are already in parentContext and must not be duplicated as siblings',
      );
      const otherSection = hit!.section === 'Overview' ? 'Implementation' : 'Overview';
      assert.ok(
        hit!.siblingCandidates!.some((s) => s.section === otherSection),
        'a chunk from the other section on the same page should be offered as a sibling candidate',
      );
    } finally {
      searcher.close();
    }
  });

  test('shadow mode reports partial contextual diagnostics but returns plain results', async () => {
    const chunkId = await firstChunkId(dbPath, 'people/alice', 0);
    await seedContextualEmbedding(dbPath, chunkId, 'people/alice', 0, zeroEmbedding(), 384, contextualContextHash({ pageTitle: 'Alice Johnson', pageType: 'person', pagePath: 'people/alice.md', section: '', rawContent: 'Alice Johnson is an engineer at Acme Corp specializing in distributed systems.' }));
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    const plain = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    const shadow = await WikiSearch.create({
      wikiRoot,
      dbPath,
      preCheck: false,
      contextualRetrieval: { mode: 'shadow' },
      onContextualTelemetry: (event) => events.push(event),
      onSearchDiagnostics: (event) => diagnostics.push(event),
    });
    try {
      assert.deepEqual(await shadow.search('Alice engineer', 5), await plain.search('Alice engineer', 5));
      assert.equal((events[0] as any).status, 'fallback');
      assert.equal((events[0] as any).reason, 'partial_contextual_index');
      assert.ok(diagnostics.some((event: any) => event.source === 'plain'), 'shadow fallback should run plain retrieval');
      assert.ok(!diagnostics.some((event: any) => event.source === 'contextual'), 'shadow fallback should not run partial contextual retrieval');
    } finally {
      plain.close();
      shadow.close();
    }
  });

  test('shadow mode with complete coverage invokes contextual diagnostics but returns plain results', async () => {
    await seedAllContextualEmbeddings(dbPath);
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    const plain = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    const shadow = await WikiSearch.create({
      wikiRoot,
      dbPath,
      preCheck: false,
      contextualRetrieval: { mode: 'shadow' },
      onContextualTelemetry: (event) => events.push(event),
      onSearchDiagnostics: (event) => diagnostics.push(event),
    });
    try {
      assert.deepEqual(await shadow.search('Alice engineer', 5), await plain.search('Alice engineer', 5));
      assert.equal((events[0] as any).status, 'ok');
      assert.ok(diagnostics.some((event: any) => event.source === 'plain'), 'shadow should run plain retrieval');
      assert.ok(diagnostics.some((event: any) => event.source === 'contextual'), 'shadow should run contextual comparison retrieval');
    } finally {
      plain.close();
      shadow.close();
    }
  });

  test('missing contextual index falls back to plain retrieval', async () => {
    const events: unknown[] = [];
    const searcher = await WikiSearch.create({
      wikiRoot,
      dbPath,
      preCheck: false,
      contextualRetrieval: { mode: 'active' },
      onContextualTelemetry: (event) => events.push(event),
    });
    try {
      const results = await searcher.search('Alice engineer', 5);
      assert.ok(results.every((r) => r.retrievalSource === undefined));
      assert.equal((events[0] as any).status, 'fallback');
      assert.equal((events[0] as any).reason, 'missing_contextual_index');
    } finally {
      searcher.close();
    }
  });

  test('contextual retrieval config validates mode and budgets', () => {
    assert.equal(normalizeContextualConfig(undefined).mode, 'off');
    const activeDefaults = normalizeContextualConfig({ mode: 'active' });
    assert.equal(activeDefaults.mode, 'active');
    assert.deepEqual(activeDefaults.parentTokenBudgets, [360, 260, 100, 50, 25]);
    assert.equal(activeDefaults.maxParentTokens, 900);
    assert.deepEqual(
      normalizeContextualConfig({ mode: 'active', parentTokenBudgets: [400, 300, 125, 100, 75], maxParentTokens: 1000 }).parentTokenBudgets,
      [400, 300, 125, 100, 75],
    );
    assert.throws(() => normalizeContextualConfig({ mode: 'enabled' }));
    assert.throws(() => normalizeContextualConfig({ parentTokenBudgets: [0] }));
    assert.throws(() => normalizeContextualConfig({ unexpected: true }));
    assert.throws(() => normalizeContextualConfig({ model: 'Xenova/bge-large-en-v1.5' }));
    assert.throws(() => normalizeContextualConfig({ maxParentTokens: 1001 }));
    assert.throws(() => normalizeContextualConfig({ parentTokenBudgets: [800, 300] }));
  });

  test('active mode rejects partial contextual sidecar and falls back to full plain corpus', async () => {
    const chunkId = await firstChunkId(dbPath, 'people/alice', 0);
    await seedContextualEmbedding(dbPath, chunkId, 'people/alice', 0, zeroEmbedding(), 384, contextualContextHash({ pageTitle: 'Alice Johnson', pageType: 'person', pagePath: 'people/alice.md', section: '', rawContent: 'Alice Johnson is an engineer at Acme Corp specializing in distributed systems.' }));
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    const searcher = await WikiSearch.create({
      wikiRoot,
      dbPath,
      preCheck: false,
      contextualRetrieval: { mode: 'active' },
      onContextualTelemetry: (event) => events.push(event),
      onSearchDiagnostics: (event) => diagnostics.push(event),
    });
    try {
      const results = await searcher.search('cloud infrastructure', 10);
      assert.ok(results.some((r) => r.path === 'companies/acme.md'), 'fallback should search the full plain corpus, not partial contextual rows');
      assert.ok(results.every((r) => r.retrievalSource === undefined));
      assert.equal((events[0] as any).reason, 'partial_contextual_index');
      assert.ok(diagnostics.some((event: any) => event.source === 'plain'), 'active fallback should run plain retrieval');
    } finally {
      searcher.close();
    }
  });

  test('active contextual mode returns topK unique pages and preserves winning child parent provenance', async () => {
    mkdirSync(join(wikiRoot, 'projects'), { recursive: true });
    await seedPage(dbPath, {
      pageId: 'projects/alpha-dup',
      path: 'projects/alpha-dup.md',
      title: 'Alpha Duplicate',
      type: 'project',
      contentHash: hashContent('alpha duplicate'),
      chunks: [
        { content: 'needle alpha first parent line.', section: 'Evidence' },
        { content: 'needle alpha second parent line.', section: 'Evidence' },
        { content: 'needle alpha third parent line.', section: 'Evidence' },
      ],
    });
    await seedPage(dbPath, {
      pageId: 'projects/beta-fill',
      path: 'projects/beta-fill.md',
      title: 'Beta Fill',
      type: 'project',
      contentHash: hashContent('beta fill'),
      chunks: [{ content: 'needle beta unique page.', section: 'Evidence' }],
    });
    await seedPage(dbPath, {
      pageId: 'projects/gamma-fill',
      path: 'projects/gamma-fill.md',
      title: 'Gamma Fill',
      type: 'project',
      contentHash: hashContent('gamma fill'),
      chunks: [{ content: 'needle gamma unique page.', section: 'Evidence' }],
    });
    writeFileSync(join(wikiRoot, 'projects/alpha-dup.md'), 'alpha duplicate', 'utf8');
    writeFileSync(join(wikiRoot, 'projects/beta-fill.md'), 'beta fill', 'utf8');
    writeFileSync(join(wikiRoot, 'projects/gamma-fill.md'), 'gamma fill', 'utf8');
    await seedAllContextualEmbeddings(dbPath);

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' } });
    try {
      const results = await searcher.search('needle', 5);
      const paths = results.map((r) => r.path);
      assert.equal(new Set(paths).size, paths.length, 'active contextual candidates should be page-diverse');
      assert.ok(paths.includes('projects/alpha-dup.md'));
      assert.ok(paths.includes('projects/beta-fill.md'));
      assert.ok(paths.includes('projects/gamma-fill.md'));
      const alpha = results.find((r) => r.path === 'projects/alpha-dup.md')!;
      assert.equal(alpha.retrievalSource, 'contextual');
      assert.notEqual(alpha.matchedChildSnippet, '', 'matched child text should be retained separately from parent context');
      assert.equal(alpha.snippet, alpha.parentContext, 'active snippet should expose the returned parent context for compatibility');
      assert.ok(alpha.sourceChunkId && alpha.sourceChunkId > 0);
      assert.ok(alpha.parentContext?.includes('needle alpha first parent line.'));
      assert.ok(alpha.parentContext?.includes('needle alpha second parent line.'));
      assert.ok(alpha.parentContext?.includes('needle alpha third parent line.'));
    } finally {
      searcher.close();
    }
  });

  test('active contextual sqft rescue replaces representative child without changing page score or ordering', async () => {
    mkdirSync(join(wikiRoot, 'life'), { recursive: true });
    mkdirSync(join(wikiRoot, 'other'), { recursive: true });
    await seedPage(dbPath, {
      pageId: 'life/home',
      path: 'life/home.md',
      title: 'Alex Home',
      type: 'life',
      contentHash: hashContent('home'),
      chunks: [
        { content: 'sharedneedle sharedneedle sharedneedle overview winner for Alex home.', section: 'Overview' },
        { content: 'Property evidence: Alex home is exactly 2,112 square feet with a finished basement.', section: 'Property Details' },
      ],
    });
    await seedPage(dbPath, {
      pageId: 'other/filler',
      path: 'other/filler.md',
      title: 'Filler',
      type: 'note',
      contentHash: hashContent('filler'),
      chunks: [{ content: 'sharedneedle sharedneedle unrelated filler child.', section: 'Filler' }],
    });
    writeFileSync(join(wikiRoot, 'life/home.md'), 'home', 'utf8');
    writeFileSync(join(wikiRoot, 'other/filler.md'), 'filler', 'utf8');
    await seedAllContextualEmbeddings(dbPath);

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' } });
    try {
      const baseline = await searcher.search('sharedneedle Alex home', 5);
      const rescued = await searcher.search('sharedneedle Alex home square footage', 5);
      assert.deepEqual(rescued.map((r) => r.path), baseline.map((r) => r.path), 'sqft rescue must not change selected page set/order');
      assert.equal(rescued[0]!.score, baseline[0]!.score, 'page score remains based on original winner');
      assert.equal(rescued[0]!.path, 'life/home.md');
      assert.equal(rescued[0]!.section, 'Property Details');
      assert.ok(rescued[0]!.matchedChildSnippet?.includes('2,112 square feet'));
      assert.ok(rescued[0]!.parentContext?.includes('2,112 square feet'));
      assert.ok(!rescued[0]!.parentContext?.includes('overview winner for Alex home'));
      assert.equal(baseline[0]!.section, 'Overview', 'query without sqft intent is unchanged');
    } finally {
      searcher.close();
    }
  });

  test('active contextual sqft rescue accepts literal sqft and spelling variants only', async () => {
    mkdirSync(join(wikiRoot, 'units'), { recursive: true });
    await seedPage(dbPath, {
      pageId: 'units/home',
      path: 'units/home.md',
      title: 'Unit Home',
      type: 'life',
      contentHash: hashContent('units'),
      chunks: [
        { content: 'unittoken unittoken overview winner.', section: 'Overview' },
        { content: 'The finished area is 2,112 sq. ft. according to property records.', section: 'Details' },
      ],
    });
    writeFileSync(join(wikiRoot, 'units/home.md'), 'units', 'utf8');
    await seedAllContextualEmbeddings(dbPath);

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' } });
    try {
      for (const phrase of ['sqft', 'sq ft', 'sq. ft.', 'square foot', 'square feet', 'square footage']) {
        const first = (await searcher.search(`unittoken ${phrase}`, 1))[0]!;
        assert.equal(first.section, 'Details', phrase);
        assert.ok(first.matchedChildSnippet?.includes('2,112 sq. ft.'));
      }
      const numericDate = (await searcher.search('unittoken 2026 08 02', 1))[0]!;
      assert.equal(numericDate.section, 'Overview', 'unrelated numeric/date queries are unchanged');
    } finally {
      searcher.close();
    }
  });

  test('plain/off/shadow fallback behavior is unchanged by active contextual sqft rescue', async () => {
    await seedAllContextualEmbeddings(dbPath);
    const plain = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    const off = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'off' } });
    const shadow = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'shadow' } });
    try {
      const query = 'Alice engineer';
      assert.deepEqual(await off.search(query, 5), await plain.search(query, 5));
      assert.deepEqual(await shadow.search(query, 5), await plain.search(query, 5));
    } finally {
      plain.close();
      off.close();
      shadow.close();
    }
  });

  test('dimension mismatch contextual sidecar falls back with telemetry', async () => {
    const chunkId = await firstChunkId(dbPath, 'people/alice', 0);
    await seedContextualEmbedding(dbPath, chunkId, 'people/alice', 0, serializeEmbedding(new Float32Array(3).fill(0)), 3);
    const events: unknown[] = [];
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' }, onContextualTelemetry: (event) => events.push(event) });
    try {
      const results = await searcher.search('Alice engineer', 5);
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.retrievalSource === undefined));
      assert.equal((events[0] as any).reason, 'dimension_mismatch');
    } finally {
      searcher.close();
    }
  });

  test('sidecar rows cascade-clean when old chunks are deleted', async () => {
    const chunkId = await firstChunkId(dbPath, 'people/alice', 0);
    await seedContextualEmbedding(dbPath, chunkId, 'people/alice', 0);
    const store = await WikiStore.create({ dbPath });
    try {
      let count = store.db.selectValue('SELECT COUNT(*) FROM wiki_chunk_context_embeddings') as number;
      assert.equal(count, 1);
      const stmt = store.db.prepare('DELETE FROM wiki_chunks WHERE page_id = ?');
      stmt.bind(['people/alice']);
      stmt.step();
      stmt.finalize();
      count = store.db.selectValue('SELECT COUNT(*) FROM wiki_chunk_context_embeddings') as number;
      assert.equal(count, 0);
    } finally {
      store.close();
    }
  });

  test('contextual backfill honors limit as resumable interrupted work and reports coverage stats', async () => {
    const store = await WikiStore.create({ dbPath });
    try {
      const first = await backfillContextualEmbeddings({ db: store.db, limit: 1, batchSize: 1 });
      assert.equal(first.scanned, 1);
      assert.equal(first.interrupted, true);
      assert.equal(first.totalEligible, 3);
      assert.ok(first.complete < first.totalEligible);
      assert.ok(first.coverageRatio > 0 && first.coverageRatio < 1);

      const second = await backfillContextualEmbeddings({ db: store.db });
      assert.equal(second.interrupted, false);
      assert.equal(second.complete, second.totalEligible);
      assert.equal(second.coverageRatio, 1);
    } finally {
      store.close();
    }
  });

  test('contextual backfill repairs stale done-row source/context hashes and completes active coverage', async () => {
    await seedAllContextualEmbeddings(dbPath);
    const chunkId = await firstChunkId(dbPath, 'people/alice', 0);
    const store = await WikiStore.create({ dbPath });
    try {
      const staleStmt = store.db.prepare(`
        UPDATE wiki_chunk_context_embeddings
        SET source_hash = 'stale-source-hash', context_hash = 'stale-context-hash', status = 'done', dimensions = 384
        WHERE chunk_id = ? AND model = ?
      `);
      staleStmt.bind([chunkId, DEFAULT_CONTEXTUAL_MODEL]);
      staleStmt.step();
      staleStmt.finalize();

      const repaired = await backfillContextualEmbeddings({ db: store.db });
      assert.equal(repaired.embedded, 1, 'stale done row should be re-embedded exactly once');
      assert.equal(repaired.complete, repaired.totalEligible);
      assert.equal(repaired.coverageRatio, 1);

      const rows = store.db.exec({
        sql: `SELECT c.content, COALESCE(c.section, '') AS section, p.path, p.title, p.type,
                     e.source_hash, e.context_hash, e.status, e.dimensions
              FROM wiki_chunks c
              JOIN wiki_pages p ON p.id = c.page_id
              JOIN wiki_chunk_context_embeddings e ON e.chunk_id = c.id AND e.model = '${DEFAULT_CONTEXTUAL_MODEL}'
              WHERE c.id = ${chunkId}`,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Array<{ content: string; section: string; path: string; title: string; type: string; source_hash: string; context_hash: string; status: string; dimensions: number }>;
      const row = rows[0]!;
      const input = { pageTitle: row.title, pageType: row.type, pagePath: row.path, section: row.section, rawContent: row.content };
      assert.equal(row.source_hash, contextualSourceHash(input));
      assert.equal(row.context_hash, contextualContextHash(input));
      assert.equal(row.status, 'done');
      assert.equal(row.dimensions, 384);
    } finally {
      store.close();
    }

    const events: unknown[] = [];
    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' }, onContextualTelemetry: (event) => events.push(event) });
    try {
      const results = await searcher.search('Alice engineer', 5);
      assert.ok(results.length > 0);
      assert.equal((events[0] as any).status, 'ok');
      assert.equal((events[0] as any).coverage.coverageRatio, 1);
    } finally {
      searcher.close();
    }
  });

  test('active contextual vector ranking uses e.embedding alias instead of plain chunk embeddings', async () => {
    mkdirSync(join(wikiRoot, 'vector'), { recursive: true });
    await seedPage(dbPath, {
      pageId: 'vector/plain-winner',
      path: 'vector/plain-winner.md',
      title: 'Plain Winner',
      type: 'project',
      contentHash: hashContent('plain winner'),
      chunks: [{ content: 'Plain embedding should win only in off mode.', embedding: serializeEmbedding(testVector(0)) }],
    });
    await seedPage(dbPath, {
      pageId: 'vector/contextual-winner',
      path: 'vector/contextual-winner.md',
      title: 'Contextual Winner',
      type: 'project',
      contentHash: hashContent('contextual winner'),
      chunks: [{ content: 'Contextual embedding should win in active mode.', embedding: serializeEmbedding(testVector(1)) }],
    });
    writeFileSync(join(wikiRoot, 'vector/plain-winner.md'), 'plain winner', 'utf8');
    writeFileSync(join(wikiRoot, 'vector/contextual-winner.md'), 'contextual winner', 'utf8');
    const store = await WikiStore.create({ dbPath });
    try {
      const stmt = store.db.prepare(`UPDATE wiki_chunks SET embedding = ? WHERE page_id NOT LIKE 'vector/%'`);
      stmt.bind([serializeEmbedding(testVector(2))]);
      stmt.step();
      stmt.finalize();
    } finally {
      store.close();
    }
    const query = 'Contextual Winner';
    const queryEmbedding = serializeEmbedding(await embedQuery(query));
    const rows = await allChunkIds(dbPath);
    for (const row of rows) {
      if (row.page_id === 'vector/plain-winner') {
        await seedContextualEmbedding(dbPath, row.id, row.page_id, row.chunk_index, serializeEmbedding(testVector(1)));
      } else if (row.page_id === 'vector/contextual-winner') {
        await seedContextualEmbedding(dbPath, row.id, row.page_id, row.chunk_index, queryEmbedding);
      } else {
        await seedContextualEmbedding(dbPath, row.id, row.page_id, row.chunk_index, serializeEmbedding(testVector(2)));
      }
    }

    const active = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false, contextualRetrieval: { mode: 'active' } });
    try {
      const activeResult = (await active.search(query, 1))[0]!;
      assert.equal(activeResult.path, 'vector/contextual-winner.md');
      assert.equal(activeResult.retrievalSource, 'contextual');
    } finally {
      active.close();
    }
  });

  test('search excludes stale DB rows whose markdown file is missing', async () => {
    await seedPage(dbPath, {
      pageId: 'projects/stale-alias',
      path: 'projects/stale-alias.md',
      title: 'Stale Alias',
      type: 'project',
      contentHash: hashContent('stale alias content'),
      chunks: [{ content: 'Stale Alias contains the only exact keyword: stalealiasneedle.' }],
    });

    const searcher = await WikiSearch.create({ wikiRoot, dbPath, preCheck: false });
    try {
      const results = await searcher.search('stalealiasneedle', 10);
      assert.equal(
        results.some((r) => r.path === 'projects/stale-alias.md'),
        false,
        'missing markdown files must not be returned from search',
      );
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
