/**
 * wiki-search.ts — Hybrid vector + BM25 search over wiki_chunks.
 *
 * Pipeline (spec §7.1):
 *   1. Pre-check: scan wiki_pages for content_hash mismatches against disk;
 *      re-embed any stale pages before searching.
 *   2. Embed the query with embedQuery() (BGE "query: " prefix).
 *   3. Vector search: cosine similarity across all wiki_chunks.embedding.
 *   4. BM25 search: keyword relevance across wiki_chunks.content.
 *   5. RRF (Reciprocal Rank Fusion): merge lists with score = Σ 1/(k + rank_i), k=60.
 *   6. Deduplicate by page; keep the best-scoring chunk per page as the snippet.
 *   7. Return top-K results: [{path, title, type, snippet, score}].
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { WikiStore } from './wiki-schema.js';
import { embedQuery } from './embedder.js';
import { Bm25 } from './bm25.js';
import { deserializeEmbedding, cosineDistance } from './vector-search.js';
import { runWikiEmbed } from './wiki-embedder.js';
import { hashContent } from './wiki-fs.js';
import type { WasmDb } from './wasm-db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiSearchResult {
  /** Relative filesystem path, e.g. "people/dylan-sellberg.md" */
  path: string;
  /** H1 title of the page */
  title: string;
  /** Page type from frontmatter (person, company, concept, …) */
  type: string;
  /** Best-matching chunk text for this page */
  snippet: string;
  /** RRF fusion score (higher = more relevant) */
  score: number;
}

export interface WikiSearchOptions {
  /** Wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Path to wiki.db. Defaults to ~/.plumb/wiki.db */
  dbPath?: string;
  /**
   * Run the stale-page pre-check before each search.
   * Set to false in tests to skip re-embedding. Defaults to true.
   */
  preCheck?: boolean;
}

// ---------------------------------------------------------------------------
// RRF constant
// ---------------------------------------------------------------------------

/** RRF smoothing constant. Score = Σ 1/(RRF_K + rank_i). */
const RRF_K = 60;

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: number;
  page_id: string;
  content: string;
  embedding: string | null;
}

interface PageRow {
  id: string;
  path: string;
  type: string;
  title: string;
  content_hash: string | null;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Load all embedded chunks from wiki_chunks. */
function loadAllChunks(db: WasmDb): ChunkRow[] {
  return db.exec({
    sql: `SELECT id, page_id, content, embedding FROM wiki_chunks WHERE embed_status = 'done' AND embedding IS NOT NULL`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as ChunkRow[];
}

/** Load all pages (id, path, type, title, content_hash). */
function loadAllPages(db: WasmDb): PageRow[] {
  return db.exec({
    sql: `SELECT id, path, type, title, content_hash FROM wiki_pages`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as PageRow[];
}

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion over multiple ranked lists.
 *
 * Each list is an array of chunk IDs in descending relevance order (rank 0 = best).
 * Returns a map from chunk ID → RRF score.
 */
function rrf(rankedLists: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Stale-page pre-check
// ---------------------------------------------------------------------------

/**
 * Check all wiki pages for content_hash mismatches against disk.
 * Re-embeds any stale pages via runWikiEmbed.
 *
 * This implements spec §7.1: "before searching, check all pages for
 * content_hash mismatches against wiki_pages table and auto-re-embed changed files."
 */
async function preCheckAndReEmbed(wikiRoot: string, dbPath: string, db: WasmDb): Promise<void> {
  const pages = loadAllPages(db);
  const stale: string[] = [];

  for (const page of pages) {
    const absPath = join(wikiRoot, page.path);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      // File missing from disk — skip (not our job to remove DB rows here)
      continue;
    }
    const currentHash = hashContent(raw);
    if (page.content_hash === null || page.content_hash !== currentHash) {
      stale.push(page.path);
    }
  }

  if (stale.length > 0) {
    // Close the current DB connection before re-embedding opens its own.
    // runWikiEmbed opens wiki.db independently, so we just need to flush.
    // The WikiStore holding `db` must not be closed here (caller owns it).
    // Instead we run embed with its own store lifecycle.
    await runWikiEmbed({ wikiRoot, dbPath, verbose: false });
  }
}

// ---------------------------------------------------------------------------
// WikiSearch class
// ---------------------------------------------------------------------------

/**
 * WikiSearch — hybrid search over embedded wiki pages.
 *
 * Usage:
 *   const search = await WikiSearch.create({ dbPath: '~/.plumb/wiki.db' });
 *   const results = await search.search('Dylan Sellberg Samsara', 5);
 *   search.close();
 */
export class WikiSearch {
  readonly #store: WikiStore;
  readonly #wikiRoot: string;
  readonly #dbPath: string;
  readonly #preCheck: boolean;

  private constructor(store: WikiStore, wikiRoot: string, dbPath: string, preCheck: boolean) {
    this.#store = store;
    this.#wikiRoot = wikiRoot;
    this.#dbPath = dbPath;
    this.#preCheck = preCheck;
  }

  /** Open wiki.db and prepare for search. */
  static async create(options: WikiSearchOptions = {}): Promise<WikiSearch> {
    const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
    const preCheck = options.preCheck ?? true;

    const store = await WikiStore.create({ dbPath });
    return new WikiSearch(store, wikiRoot, dbPath, preCheck);
  }

  /** Close the underlying database. */
  close(): void {
    this.#store.close();
  }

  /**
   * Search the wiki for pages matching the query.
   *
   * Steps:
   *   1. Optionally pre-check for stale pages and re-embed them.
   *   2. Embed the query.
   *   3. Vector search (cosine similarity) over all chunks.
   *   4. BM25 keyword search over all chunks.
   *   5. RRF fusion.
   *   6. Deduplicate by page (keep best chunk per page).
   *   7. Return top-K WikiSearchResult items.
   *
   * @param query  Natural language search query.
   * @param topK   Maximum number of results to return (default: 10).
   */
  async search(query: string, topK = 10): Promise<WikiSearchResult[]> {
    const db = this.#store.db;

    // 1. Pre-check stale pages
    if (this.#preCheck) {
      await preCheckAndReEmbed(this.#wikiRoot, this.#dbPath, db);
    }

    // 2. Load all chunks (reload after potential re-embed)
    const chunks = loadAllChunks(db);
    if (chunks.length === 0) return [];

    // 3. Embed the query
    const queryVec = await embedQuery(query);

    // 4a. Vector search — sort by cosine distance (ascending = more similar)
    const vectorRanked: Array<{ id: number; distance: number }> = [];
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;
      try {
        const vec = deserializeEmbedding(chunk.embedding);
        const distance = cosineDistance(queryVec, vec);
        vectorRanked.push({ id: chunk.id, distance });
      } catch {
        // Skip malformed embeddings
      }
    }
    vectorRanked.sort((a, b) => a.distance - b.distance);
    const vectorList = vectorRanked.map((r) => r.id);

    // 4b. BM25 search — build index over chunk texts
    const corpus = chunks.map((c) => c.content);
    const bm25 = new Bm25(corpus);
    const bm25Scores = bm25.scores(query);

    // Rank by BM25 score (descending)
    const bm25Ranked = chunks
      .map((c, i) => ({ id: c.id, score: bm25Scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.id);

    // 5. RRF fusion
    const rrfScores = rrf([vectorList, bm25Ranked]);

    // 6. Deduplicate by page — keep the best-scoring chunk per page
    //    Build a lookup from chunk id → chunk row
    const chunkById = new Map<number, ChunkRow>();
    for (const chunk of chunks) {
      chunkById.set(chunk.id, chunk);
    }

    // Load page metadata
    const pages = loadAllPages(db);
    const pageById = new Map<string, PageRow>();
    for (const page of pages) {
      pageById.set(page.id, page);
    }

    // Collect all scored chunk IDs, sorted by RRF score descending
    const sortedChunkIds = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const seenPages = new Set<string>();
    const results: WikiSearchResult[] = [];

    for (const chunkId of sortedChunkIds) {
      if (results.length >= topK) break;

      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;

      const pageId = chunk.page_id;
      if (seenPages.has(pageId)) continue;
      seenPages.add(pageId);

      const page = pageById.get(pageId);
      if (!page) continue;

      const score = rrfScores.get(chunkId) ?? 0;

      results.push({
        path: page.path,
        title: page.title,
        type: page.type,
        snippet: chunk.content,
        score,
      });
    }

    return results;
  }
}
