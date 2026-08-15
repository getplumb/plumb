/**
 * wiki-search.ts — Hybrid vector + FTS5 BM25 search over wiki_chunks.
 *
 * Pipeline (spec §7.1):
 *   1. Pre-check: scan wiki_pages for content_hash mismatches against disk;
 *      re-embed any stale pages before searching.
 *   2. Embed the query with embedQuery() (BGE "query: " prefix).
 *   3. Vector search: cosine similarity across all wiki_chunks.embedding.
 *   4. FTS5 BM25 search: native SQLite full-text search via wiki_fts virtual table.
 *   5. RRF (Reciprocal Rank Fusion): merge lists with score = Σ 1/(k + rank_i), k=60.
 *   6. Aggregate child chunk scores by parent page + H2 section so multi-evidence
 *      sections outrank isolated single hits.
 *   7. Return top-K child chunks with parent-section scores and per-child provenance.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { WikiStore } from './wiki-schema.js';
import { embedQuery } from './embedder.js';
import { deserializeEmbedding, cosineDistance } from './vector-search.js';
import { runWikiEmbed } from './wiki-embedder.js';
import { hashContent } from './wiki-fs.js';
import { compileSafeFts5Query } from './fts5-query.js';
import {
  DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG,
  type ContextualRetrievalConfig,
  normalizeContextualConfig,
  DEFAULT_CONTEXTUAL_DIMENSIONS,
  DEFAULT_CONTEXTUAL_MODEL,
  contextualContextHash,
  contextualSourceHash,
  formatContextualChildText,
} from './wiki-contextual-embeddings.js';
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
  /** Matching chunk text for this result. Multiple results may share a page. */
  snippet: string;
  /** H2 section that the snippet belongs to (empty string if before first H2) */
  section: string;
  /** Chunk index within the source page. */
  chunkIndex: number;
  /** Aggregated parent page + H2 section score (higher = more relevant) */
  score: number;
  /** Original RRF score for this child chunk before parent-section aggregation. */
  childScore: number;
  /** Aggregated score for the parent page + H2 section that contains this child chunk. */
  parentSectionScore: number;
  /** Number of scored child chunks supporting this parent page + H2 section. */
  supportingChunkCount: number;
  /** Sidecar retrieval source. Off mode returns plain; active may return contextual. */
  retrievalSource?: 'plain' | 'contextual';
  /** Raw matched child text. Present for contextual active candidates; equals snippet for compatibility. */
  matchedChildSnippet?: string;
  /** Reconstructed raw parent H2 section assembled from ordered chunks on the same page + section. */
  parentContext?: string;
  /** Source chunk id for the matched child, when available. */
  sourceChunkId?: number;
  /**
   * E039: other same-page chunks (any OTHER section — same-section chunks are
   * already folded into parentContext) that the retriever's own RRF ranking
   * scored, ordered by descending score. The injector may append a few of
   * these within the page's own token budget when parentContext leaves room.
   * Present only for contextual active/shadow candidates.
   */
  siblingCandidates?: Array<{ chunkIndex: number; section: string; content: string; score: number }>;
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
  /** E017 opt-in contextual retrieval config. Defaults to mode=off. */
  contextualRetrieval?: Partial<ContextualRetrievalConfig> | ContextualRetrievalConfig;
  /** Local diagnostics sink used by shadow mode. */
  onContextualTelemetry?: (event: WikiContextualSearchTelemetry) => void;
  /** @internal Test diagnostics for proving which retrieval paths ran. */
  onSearchDiagnostics?: (event: WikiSearchDiagnostics) => void;
}

export interface WikiSearchDiagnostics {
  event: 'plumb.wiki_search_diagnostics';
  source: 'plain' | 'contextual';
  stage: 'start' | 'done';
  query: string;
  chunkCount: number;
  resultCount?: number;
}

export interface WikiContextualSearchTelemetry {
  event: 'plumb.wiki_contextual_search';
  mode: 'shadow' | 'active';
  status: 'ok' | 'fallback' | 'error';
  reason?: 'missing_contextual_index' | 'partial_contextual_index' | 'dimension_mismatch' | 'contextual_search_error' | string;
  coverage?: { totalEligible: number; contextualDone: number; mismatchedDimensions: number; coverageRatio: number };
  query: string;
  plainResultCount: number;
  contextualResultCount: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// RRF constant
// ---------------------------------------------------------------------------

/** RRF smoothing constant. Score = Σ 1/(RRF_K + rank_i). */
const RRF_K = 60;

function normalizeSqftUnits(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bsq\.\s*ft\.?/g, 'sqft')
    .replace(/\bsq\s+ft\b/g, 'sqft')
    .replace(/\bsquare\s+(?:foot|feet|footage)\b/g, 'sqft');
}

function containsNormalizedSqft(text: string): boolean {
  return /\bsqft\b/.test(normalizeSqftUnits(text));
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: number;
  page_id: string;
  content: string;
  section: string;
  chunk_index: number;
  embedding: string | null;
}

interface PageRow {
  id: string;
  path: string;
  type: string;
  title: string;
  content_hash: string | null;
  status: string;
}

interface ScoredChildChunk {
  chunkId: number;
  chunk: ChunkRow;
  page: PageRow;
  childScore: number;
  parentSectionScore: number;
  supportingChunkCount: number;
}

interface RankedChildChunk {
  chunkId: number;
  chunk: ChunkRow;
  page: PageRow;
  childScore: number;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Load all embedded chunks from wiki_chunks. */
function loadAllChunks(db: WasmDb): ChunkRow[] {
  return db.exec({
    sql: `SELECT id, page_id, content, COALESCE(section, '') AS section, chunk_index, embedding FROM wiki_chunks WHERE embed_status = 'done' AND embedding IS NOT NULL`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as ChunkRow[];
}



interface ContextualCoverage {
  chunks: ChunkRow[];
  totalEligible: number;
  contextualDone: number;
  mismatchedDimensions: number;
  coverageRatio: number;
  complete: boolean;
}

interface ContextualCandidateRow extends ChunkRow {
  path: string;
  title: string;
  type: string;
  model: string | null;
  source_hash: string | null;
  context_hash: string | null;
  status: string | null;
  dimensions: number | null;
  contextual_embedding: string | null;
}

function loadContextualCoverage(db: WasmDb, model: string): ContextualCoverage {
  if (model !== DEFAULT_CONTEXTUAL_MODEL) {
    throw new Error(`Unsupported contextual retrieval model: ${model}. Supported model: ${DEFAULT_CONTEXTUAL_MODEL}`);
  }
  const stmt = db.prepare(`
    SELECT c.id, c.page_id, c.content, COALESCE(c.section, '') AS section, c.chunk_index,
           p.path, p.title, p.type,
           e.model, e.source_hash, e.context_hash, e.status, e.dimensions, e.embedding AS contextual_embedding
    FROM wiki_chunks c
    JOIN wiki_pages p ON p.id = c.page_id
    LEFT JOIN wiki_chunk_context_embeddings e ON e.chunk_id = c.id AND e.model = ?
    WHERE c.embed_status = 'done' AND c.embedding IS NOT NULL
    ORDER BY p.path, c.chunk_index
  `);
  stmt.bind([model]);
  const chunks: ChunkRow[] = [];
  let totalEligible = 0;
  let contextualDone = 0;
  let mismatchedDimensions = 0;
  while (stmt.step()) {
    const row = stmt.get({}) as ContextualCandidateRow;
    totalEligible++;
    if (row.status === 'done' && row.dimensions !== null && row.dimensions !== DEFAULT_CONTEXTUAL_DIMENSIONS) {
      mismatchedDimensions++;
    }
    const expectedContextHash = contextualContextHash({
      pageTitle: row.title,
      pageType: row.type,
      pagePath: row.path,
      section: row.section,
      rawContent: row.content,
    }, model);
    const expectedSourceHash = contextualSourceHash({
      pageTitle: row.title,
      pageType: row.type,
      pagePath: row.path,
      section: row.section,
      rawContent: row.content,
    });
    if (
      row.status === 'done'
      && row.contextual_embedding !== null
      && row.dimensions === DEFAULT_CONTEXTUAL_DIMENSIONS
      && row.source_hash === expectedSourceHash
      && row.context_hash === expectedContextHash
    ) {
      contextualDone++;
      chunks.push({
        id: row.id,
        page_id: row.page_id,
        content: row.content,
        section: row.section,
        chunk_index: row.chunk_index,
        embedding: row.contextual_embedding,
      });
    }
  }
  stmt.finalize();
  return {
    chunks,
    totalEligible,
    contextualDone,
    mismatchedDimensions,
    coverageRatio: totalEligible === 0 ? 1 : contextualDone / totalEligible,
    complete: totalEligible > 0 && contextualDone === totalEligible && mismatchedDimensions === 0,
  };
}

/** Load all pages (id, path, type, title, content_hash). */
function loadAllPages(db: WasmDb): PageRow[] {
  return db.exec({
    sql: `SELECT id, path, type, title, content_hash, COALESCE(status, 'active') AS status FROM wiki_pages`,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as PageRow[];
}

/** Return true when a wiki_pages row still points at a readable current file. */
function isReadableActivePage(wikiRoot: string, page: PageRow): boolean {
  if (page.status !== 'active') return false;
  return existsSync(join(wikiRoot, page.path));
}

// ---------------------------------------------------------------------------
// FTS5 BM25 search
// ---------------------------------------------------------------------------

/**
 * Run FTS5 BM25 search against wiki_fts.
 *
 * Returns chunk rowids in descending BM25 relevance order (best match first).
 * FTS5 rank column is negative — more negative = better match.
 *
 * Falls back to an empty array if the FTS table is empty or the query contains
 * only stop words / punctuation.
 */
function fts5Search(db: WasmDb, query: string): number[] {
  const compiled = compileSafeFts5Query(query);
  if (!compiled.match) return [];

  let stmt: ReturnType<WasmDb['prepare']> | null = null;
  try {
    stmt = db.prepare(
      `SELECT rowid FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY rank`,
    );
    stmt.bind([compiled.match]);

    const ids: number[] = [];
    while (stmt.step()) {
      const row = stmt.get({}) as { rowid: number };
      if (row.rowid != null) ids.push(row.rowid as number);
    }
    return ids;
  } catch {
    // A compiled query should not throw, but return no keyword hits if SQLite
    // rejects it for any tokenizer-specific reason. Vector search still runs.
    return [];
  } finally {
    stmt?.finalize();
  }
}

function tokenizeForContextualBm25(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
}

function contextualBm25Search(query: string, docs: Array<{ id: number; text: string }>, top = 1000): number[] {
  const queryTerms = [...new Set(tokenizeForContextualBm25(query))];
  if (queryTerms.length === 0 || docs.length === 0) return [];

  const n = docs.length;
  const avgdl = docs.reduce((sum, doc) => sum + tokenizeForContextualBm25(doc.text).length, 0) / (n || 1);
  const df = new Map<string, number>();
  const tfs = new Map<number, Map<string, number>>();
  const dls = new Map<number, number>();

  for (const doc of docs) {
    const tokens = tokenizeForContextualBm25(doc.text);
    dls.set(doc.id, tokens.length);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    tfs.set(doc.id, tf);
    for (const token of new Set(tokens)) {
      if (queryTerms.includes(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  const scored: Array<{ id: number; score: number }> = [];
  for (const doc of docs) {
    const tf = tfs.get(doc.id)!;
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const termDf = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - termDf + 0.5) / (termDf + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * ((dls.get(doc.id) ?? 0) / (avgdl || 1))));
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top).map((item) => item.id);
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
 * Uses FTS5 BM25 for keyword ranking and cosine similarity for vector ranking,
 * fused via Reciprocal Rank Fusion (RRF).
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
  readonly #contextualRetrieval: ContextualRetrievalConfig;
  readonly #onContextualTelemetry?: (event: WikiContextualSearchTelemetry) => void;
  readonly #onSearchDiagnostics?: (event: WikiSearchDiagnostics) => void;

  private constructor(
    store: WikiStore,
    wikiRoot: string,
    dbPath: string,
    preCheck: boolean,
    contextualRetrieval: ContextualRetrievalConfig,
    onContextualTelemetry?: (event: WikiContextualSearchTelemetry) => void,
    onSearchDiagnostics?: (event: WikiSearchDiagnostics) => void,
  ) {
    this.#store = store;
    this.#wikiRoot = wikiRoot;
    this.#dbPath = dbPath;
    this.#preCheck = preCheck;
    this.#contextualRetrieval = contextualRetrieval;
    if (onContextualTelemetry) this.#onContextualTelemetry = onContextualTelemetry;
    if (onSearchDiagnostics) this.#onSearchDiagnostics = onSearchDiagnostics;
  }

  /** Open wiki.db and prepare for search. */
  static async create(options: WikiSearchOptions = {}): Promise<WikiSearch> {
    const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
    const dbPath = options.dbPath ?? join(homedir(), '.plumb', 'wiki.db');
    const preCheck = options.preCheck ?? true;
    const contextualRetrieval = normalizeContextualConfig({
      ...DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG,
      ...(options.contextualRetrieval ?? {}),
    });

    const store = await WikiStore.create({ dbPath });
    return new WikiSearch(
      store,
      wikiRoot,
      dbPath,
      preCheck,
      contextualRetrieval,
      options.onContextualTelemetry,
      options.onSearchDiagnostics,
    );
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
   *   4. FTS5 BM25 keyword search over all chunks.
   *   5. RRF fusion.
   *   6. Aggregate child chunk scores by parent page + H2 section, allowing
   *      multiple supporting child hits to lift a section together.
   *   7. Return top-K WikiSearchResult child items with child and section scores.
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

    if (this.#contextualRetrieval.mode === 'off') {
      return this.#searchWithChunks(query, topK, loadAllChunks(db), 'plain');
    }

    const startedAt = Date.now();
    let coverage: ContextualCoverage;
    try {
      coverage = loadContextualCoverage(db, this.#contextualRetrieval.model);
    } catch (err) {
      const plainResults = await this.#searchWithChunks(query, topK, loadAllChunks(db), 'plain');
      this.#emitContextualTelemetry({
        event: 'plumb.wiki_contextual_search',
        mode: this.#contextualRetrieval.mode,
        status: 'error',
        reason: err instanceof Error ? `contextual_search_error: ${err.message}` : `contextual_search_error: ${String(err)}`,
        query,
        plainResultCount: plainResults.length,
        contextualResultCount: 0,
        elapsedMs: Date.now() - startedAt,
      });
      return plainResults;
    }

    const telemetryCoverage = {
      totalEligible: coverage.totalEligible,
      contextualDone: coverage.contextualDone,
      mismatchedDimensions: coverage.mismatchedDimensions,
      coverageRatio: coverage.coverageRatio,
    };

    if (!coverage.complete) {
      const plainResults = await this.#searchWithChunks(query, topK, loadAllChunks(db), 'plain');
      this.#emitContextualTelemetry({
        event: 'plumb.wiki_contextual_search',
        mode: this.#contextualRetrieval.mode,
        status: 'fallback',
        reason: this.#contextualFallbackReason(coverage),
        coverage: telemetryCoverage,
        query,
        plainResultCount: plainResults.length,
        contextualResultCount: 0,
        elapsedMs: Date.now() - startedAt,
      });
      return plainResults;
    }

    if (this.#contextualRetrieval.mode === 'shadow') {
      const plainResults = await this.#searchWithChunks(query, topK, loadAllChunks(db), 'plain');
      try {
        const contextualResults = await this.#searchWithChunks(query, topK, coverage.chunks, 'contextual');
        this.#emitContextualTelemetry({
          event: 'plumb.wiki_contextual_search',
          mode: 'shadow',
          status: 'ok',
          coverage: telemetryCoverage,
          query,
          plainResultCount: plainResults.length,
          contextualResultCount: contextualResults.length,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (err) {
        this.#emitContextualTelemetry({
          event: 'plumb.wiki_contextual_search',
          mode: 'shadow',
          status: 'error',
          reason: err instanceof Error ? `contextual_search_error: ${err.message}` : `contextual_search_error: ${String(err)}`,
          coverage: telemetryCoverage,
          query,
          plainResultCount: plainResults.length,
          contextualResultCount: 0,
          elapsedMs: Date.now() - startedAt,
        });
      }
      return plainResults;
    }

    try {
      const contextualResults = await this.#searchWithChunks(query, topK, coverage.chunks, 'contextual');
      this.#emitContextualTelemetry({
        event: 'plumb.wiki_contextual_search',
        mode: 'active',
        status: 'ok',
        coverage: telemetryCoverage,
        query,
        plainResultCount: 0,
        contextualResultCount: contextualResults.length,
        elapsedMs: Date.now() - startedAt,
      });
      return contextualResults;
    } catch (err) {
      const plainResults = await this.#searchWithChunks(query, topK, loadAllChunks(db), 'plain');
      this.#emitContextualTelemetry({
        event: 'plumb.wiki_contextual_search',
        mode: 'active',
        status: 'error',
        reason: err instanceof Error ? `contextual_search_error: ${err.message}` : `contextual_search_error: ${String(err)}`,
        coverage: telemetryCoverage,
        query,
        plainResultCount: plainResults.length,
        contextualResultCount: 0,
        elapsedMs: Date.now() - startedAt,
      });
      return plainResults;
    }
  }

  #contextualFallbackReason(coverage: ContextualCoverage): string {
    if (coverage.mismatchedDimensions > 0) return 'dimension_mismatch';
    if (coverage.contextualDone === 0) return 'missing_contextual_index';
    return 'partial_contextual_index';
  }

  #emitContextualTelemetry(event: WikiContextualSearchTelemetry): void {
    this.#onContextualTelemetry?.(event);
  }

  async #searchWithChunks(query: string, topK: number, chunks: ChunkRow[], source: 'plain' | 'contextual'): Promise<WikiSearchResult[]> {
    const db = this.#store.db;
    this.#onSearchDiagnostics?.({ event: 'plumb.wiki_search_diagnostics', source, stage: 'start', query, chunkCount: chunks.length });
    if (chunks.length === 0) {
      this.#onSearchDiagnostics?.({ event: 'plumb.wiki_search_diagnostics', source, stage: 'done', query, chunkCount: chunks.length, resultCount: 0 });
      return [];
    }

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

    // Load page metadata before BM25 so contextual mode can lexically rank the
    // same compact title/type/breadcrumb child representation that was embedded.
    const pages = loadAllPages(db);
    const pageById = new Map<string, PageRow>();
    for (const page of pages) {
      if (!isReadableActivePage(this.#wikiRoot, page)) continue;
      pageById.set(page.id, page);
    }

    // 4b. Keyword search. Plain mode preserves native SQLite FTS5 over raw
    // chunk text. Contextual mode mirrors the measured E017 artifact: in-memory
    // BM25 over compact contextual child text, rather than raw wiki_fts rows.
    const fts5List = source === 'contextual'
      ? contextualBm25Search(query, chunks.map((chunk) => {
        const page = pageById.get(chunk.page_id);
        return {
          id: chunk.id,
          text: page
            ? formatContextualChildText({
              pageTitle: page.title,
              pageType: page.type,
              pagePath: page.path,
              section: chunk.section,
              rawContent: chunk.content,
            })
            : chunk.content,
        };
      }))
      : fts5Search(db, query);

    // 5. RRF fusion
    const rrfScores = rrf([vectorList, fts5List]);

    // 6. Build a lookup from chunk id → chunk row. Do not deduplicate by page here.
    //    Multiple sections from the same page may be independently relevant; context assembly
    //    owns final budget-stage de-duplication.
    const chunkById = new Map<number, ChunkRow>();
    for (const chunk of chunks) {
      chunkById.set(chunk.id, chunk);
    }

    const rankedChildChunks: RankedChildChunk[] = [];
    for (const [chunkId, childScore] of rrfScores.entries()) {
      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;

      const page = pageById.get(chunk.page_id);
      if (!page) continue;

      rankedChildChunks.push({ chunkId, chunk, page, childScore });
    }

    if (source === 'contextual') {
      const parentContextByKey = this.#loadParentContexts();
      const sortedByChildRank = rankedChildChunks.sort((a, b) => {
        if (b.childScore !== a.childScore) return b.childScore - a.childScore;
        if (a.page.path !== b.page.path) return a.page.path.localeCompare(b.page.path);
        if (a.chunk.section !== b.chunk.section) return a.chunk.section.localeCompare(b.chunk.section);
        return a.chunk.chunk_index - b.chunk.chunk_index;
      });

      const selectedByPage = new Set<string>();
      const results: WikiSearchResult[] = [];
      for (const scored of sortedByChildRank) {
        if (results.length >= topK) break;
        if (selectedByPage.has(scored.page.path)) continue;
        selectedByPage.add(scored.page.path);
        const representative = this.#selectContextualRepresentativeChild({
          query,
          winner: scored,
          sortedByChildRank,
          parentContextByKey,
        });
        const parentContext = this.#buildContextualParentContext(representative, parentContextByKey);
        const siblingCandidates = this.#collectSiblingCandidates(representative, sortedByChildRank);
        results.push({
          path: representative.page.path,
          title: representative.page.title,
          type: representative.page.type,
          snippet: parentContext,
          section: representative.chunk.section,
          chunkIndex: representative.chunk.chunk_index,
          score: scored.childScore,
          childScore: scored.childScore,
          parentSectionScore: scored.childScore,
          supportingChunkCount: 1,
          retrievalSource: source,
          matchedChildSnippet: representative.chunk.content,
          parentContext,
          sourceChunkId: representative.chunkId,
          siblingCandidates,
        });
      }
      this.#onSearchDiagnostics?.({ event: 'plumb.wiki_search_diagnostics', source, stage: 'done', query, chunkCount: chunks.length, resultCount: results.length });
      return results;
    }

    // Aggregate child RRF scores by parent page + H2 section. This replaces
    // max-only parent ranking: a section with several supporting child chunks
    // should outrank a section with one equally strong isolated child hit.
    const sectionScores = new Map<string, { score: number; chunkIds: number[] }>();
    for (const { chunkId, chunk, page, childScore } of rankedChildChunks) {
      const sectionKey = `${page.id}\u0000${chunk.section}`;
      const sectionScore = sectionScores.get(sectionKey) ?? { score: 0, chunkIds: [] };
      sectionScore.score += childScore;
      sectionScore.chunkIds.push(chunkId);
      sectionScores.set(sectionKey, sectionScore);
    }

    const scoredChildChunks: Array<Omit<ScoredChildChunk, 'parentSectionScore' | 'supportingChunkCount'>> = rankedChildChunks;

    const sortedChildChunks: ScoredChildChunk[] = scoredChildChunks
      .map((item) => {
        const sectionScore = sectionScores.get(`${item.page.id}\u0000${item.chunk.section}`);
        return {
          ...item,
          parentSectionScore: sectionScore?.score ?? item.childScore,
          supportingChunkCount: sectionScore?.chunkIds.length ?? 1,
        };
      })
      .sort((a, b) => {
        if (b.parentSectionScore !== a.parentSectionScore) return b.parentSectionScore - a.parentSectionScore;
        if (b.childScore !== a.childScore) return b.childScore - a.childScore;
        if (a.page.path !== b.page.path) return a.page.path.localeCompare(b.page.path);
        if (a.chunk.section !== b.chunk.section) return a.chunk.section.localeCompare(b.chunk.section);
        return a.chunk.chunk_index - b.chunk.chunk_index;
      });

    const results: WikiSearchResult[] = [];

    for (const scored of sortedChildChunks) {
      if (results.length >= topK) break;

      results.push({
        path: scored.page.path,
        title: scored.page.title,
        type: scored.page.type,
        snippet: scored.chunk.content,
        section: scored.chunk.section,
        chunkIndex: scored.chunk.chunk_index,
        score: scored.parentSectionScore,
        childScore: scored.childScore,
        parentSectionScore: scored.parentSectionScore,
        supportingChunkCount: scored.supportingChunkCount,
      });
    }

    this.#onSearchDiagnostics?.({ event: 'plumb.wiki_search_diagnostics', source, stage: 'done', query, chunkCount: chunks.length, resultCount: results.length });
    return results;
  }

  #selectContextualRepresentativeChild({
    query,
    winner,
    sortedByChildRank,
    parentContextByKey,
  }: {
    query: string;
    winner: RankedChildChunk;
    sortedByChildRank: RankedChildChunk[];
    parentContextByKey: Map<string, { firstChunkIndex: number; text: string }>;
  }): RankedChildChunk {
    if (!containsNormalizedSqft(query)) return winner;

    const winnerKey = `${winner.page.id}\u0000${winner.chunk.section}`;
    const winnerText = parentContextByKey.get(winnerKey)?.text ?? winner.chunk.content;
    if (containsNormalizedSqft(winnerText)) return winner;

    const rescueCandidates = sortedByChildRank
      .filter((candidate) => {
        if (candidate.chunkId === winner.chunkId) return false;
        if (candidate.page.id !== winner.page.id) return false;
        const candidateKey = `${candidate.page.id}\u0000${candidate.chunk.section}`;
        if (candidateKey === winnerKey) return false;
        const candidateText = parentContextByKey.get(candidateKey)?.text ?? candidate.chunk.content;
        return containsNormalizedSqft(candidateText);
      })
      .sort((a, b) => {
        if (b.childScore !== a.childScore) return b.childScore - a.childScore;
        return a.chunk.chunk_index - b.chunk.chunk_index;
      });

    return rescueCandidates[0] ?? winner;
  }

  /**
   * E039: same-page chunks from OTHER sections that the retriever's own RRF
   * ranking scored, for the injector to optionally append when a page's parent
   * section leaves budget room. Same-section chunks are excluded because
   * #buildContextualParentContext already includes the full matched section.
   * Capped to 6 candidates (the injector only ever wants the top 2, taken
   * highest-score-first) to keep the result payload bounded.
   */
  #collectSiblingCandidates(
    winner: RankedChildChunk,
    sortedByChildRank: RankedChildChunk[],
  ): Array<{ chunkIndex: number; section: string; content: string; score: number }> {
    return sortedByChildRank
      .filter((c) => c.page.path === winner.page.path && c.chunk.section !== winner.chunk.section)
      .sort((a, b) => {
        if (b.childScore !== a.childScore) return b.childScore - a.childScore;
        return a.chunk.chunk_index - b.chunk.chunk_index;
      })
      .slice(0, 6)
      .map((c) => ({ chunkIndex: c.chunk.chunk_index, section: c.chunk.section, content: c.chunk.content, score: c.childScore }));
  }

  #buildContextualParentContext(
    winner: RankedChildChunk,
    parentContextByKey: Map<string, { firstChunkIndex: number; text: string }>,
  ): string {
    const winnerKey = `${winner.page.id}\u0000${winner.chunk.section}`;
    const context = parentContextByKey.get(winnerKey) ?? { firstChunkIndex: winner.chunk.chunk_index, text: winner.chunk.content };
    const seenText = new Set<string>();
    return [context]
      .map((item) => item.text.trim())
      .filter((text) => {
        if (!text || seenText.has(text)) return false;
        seenText.add(text);
        return true;
      })
      .join('\n\n');
  }

  #loadParentContexts(): Map<string, { firstChunkIndex: number; text: string }> {
    const rows = this.#store.db.exec({
      sql: `SELECT page_id, COALESCE(section, '') AS section, chunk_index, content
            FROM wiki_chunks
            WHERE embed_status = 'done'
            ORDER BY page_id, COALESCE(section, ''), chunk_index`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ page_id: string; section: string; chunk_index: number; content: string }>;
    const grouped = new Map<string, Array<{ chunk_index: number; content: string }>>();
    for (const row of rows) {
      const key = `${row.page_id}\u0000${row.section}`;
      const list = grouped.get(key) ?? [];
      list.push({ chunk_index: row.chunk_index, content: row.content });
      grouped.set(key, list);
    }
    const contexts = new Map<string, { firstChunkIndex: number; text: string }>();
    for (const [key, list] of grouped.entries()) {
      const sorted = list.sort((a, b) => a.chunk_index - b.chunk_index);
      contexts.set(
        key,
        {
          firstChunkIndex: sorted[0]?.chunk_index ?? 0,
          text: sorted
            .map((item) => item.content.trim())
            .filter(Boolean)
            .join('\n\n'),
        },
      );
    }
    return contexts;
  }
}
