import { createHash } from 'node:crypto';
import { embed } from './embedder.js';
import { serializeWikiEmbeddingBlob } from './vector-search.js';
import type { WasmDb } from './wasm-db.js';

export const DEFAULT_CONTEXTUAL_MODEL = 'Xenova/bge-small-en-v1.5';
export const SUPPORTED_CONTEXTUAL_MODELS = [DEFAULT_CONTEXTUAL_MODEL] as const;
export const DEFAULT_CONTEXTUAL_DIMENSIONS = 384;
export const MAX_CONTEXTUAL_ESTIMATED_TOKENS = 1000;

export type ContextualRetrievalMode = 'off' | 'shadow' | 'active';

export interface ContextualRetrievalConfig {
  mode: ContextualRetrievalMode;
  model: string;
  parentTokenBudgets: number[];
  maxParentTokens: number;
}

export const DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG: ContextualRetrievalConfig = {
  mode: 'off',
  model: DEFAULT_CONTEXTUAL_MODEL,
  // E026 Candidate G active injection schedule.
  // This preserves E017 contextual page ranking/provenance while tightening the
  // parent-context assembly budget measured by the no-sibling budget ablation.
  parentTokenBudgets: [360, 260, 100, 50, 25],
  maxParentTokens: 900,
};

export interface ContextualChunkInput {
  pageTitle: string;
  pageType: string;
  pagePath: string;
  section?: string | null;
  headingBreadcrumb?: string | null;
  rawContent: string;
}

export interface ContextualBackfillOptions {
  db: WasmDb;
  model?: string;
  limit?: number;
  batchSize?: number;
  pageIds?: string[];
  verbose?: boolean;
}

export interface ContextualBackfillStats {
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  interrupted: boolean;
  totalEligible: number;
  complete: number;
  pending: number;
  failedRows: number;
  mismatchedDimensions: number;
  coverageRatio: number;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeContextualConfig(input: unknown): ContextualRetrievalConfig {
  if (input === undefined || input === null) return { ...DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('contextualRetrieval must be an object');
  }
  const raw = input as Record<string, unknown>;
  const allowedKeys = new Set(['mode', 'model', 'parentTokenBudgets', 'maxParentTokens']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) throw new Error(`contextualRetrieval.${key} is not supported`);
  }
  const mode = raw.mode ?? DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.mode;
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'active') {
    throw new Error('contextualRetrieval.mode must be one of off, shadow, active');
  }
  const model = raw.model ?? DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.model;
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('contextualRetrieval.model must be a non-empty string');
  }
  const trimmedModel = model.trim();
  if (trimmedModel !== DEFAULT_CONTEXTUAL_MODEL) {
    throw new Error(`contextualRetrieval.model unsupported: ${trimmedModel}. Supported model: ${DEFAULT_CONTEXTUAL_MODEL}`);
  }
  const parentTokenBudgets = raw.parentTokenBudgets ?? DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.parentTokenBudgets;
  if (!Array.isArray(parentTokenBudgets) || parentTokenBudgets.length === 0 || parentTokenBudgets.length > 20) {
    throw new Error('contextualRetrieval.parentTokenBudgets must be a non-empty array');
  }
  const budgets = parentTokenBudgets.map((value) => {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_CONTEXTUAL_ESTIMATED_TOKENS) {
      throw new Error('contextualRetrieval.parentTokenBudgets values must be positive integers no greater than 1000 estimated tokens');
    }
    return value as number;
  });
  const maxParentTokens = raw.maxParentTokens ?? DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG.maxParentTokens;
  if (!Number.isInteger(maxParentTokens) || (maxParentTokens as number) < 1 || (maxParentTokens as number) > MAX_CONTEXTUAL_ESTIMATED_TOKENS) {
    throw new Error('contextualRetrieval.maxParentTokens must be a positive integer no greater than 1000 estimated tokens');
  }
  if (budgets.reduce((sum, value) => sum + value, 0) > (maxParentTokens as number)) {
    throw new Error('contextualRetrieval.parentTokenBudgets sum must not exceed maxParentTokens');
  }
  return { mode, model: trimmedModel, parentTokenBudgets: budgets, maxParentTokens: maxParentTokens as number };
}


export function estimateContextualTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

export function truncateToEstimatedTokens(text: string, maxEstimatedTokens = MAX_CONTEXTUAL_ESTIMATED_TOKENS): string {
  if (!Number.isInteger(maxEstimatedTokens) || maxEstimatedTokens < 1 || maxEstimatedTokens > MAX_CONTEXTUAL_ESTIMATED_TOKENS) {
    throw new Error('maxEstimatedTokens must be a positive integer no greater than 1000');
  }
  if (estimateContextualTokens(text) <= maxEstimatedTokens) return text;
  return text.slice(0, maxEstimatedTokens * 4).trimEnd();
}

function selectContextualCoverage(db: WasmDb, model: string, pageIds?: string[]): ContextualBackfillStats {
  let wherePage = '';
  if (pageIds && pageIds.length > 0) {
    wherePage = ` AND c.page_id IN (${pageIds.map(() => '?').join(', ')})`;
  }
  const stmt = db.prepare(`
    SELECT c.content, COALESCE(c.section, '') AS section,
           p.path, p.title, p.type,
           e.status, e.embedding AS contextual_embedding, e.dimensions, e.source_hash, e.context_hash
    FROM wiki_chunks c
    JOIN wiki_pages p ON p.id = c.page_id
    LEFT JOIN wiki_chunk_context_embeddings e ON e.chunk_id = c.id AND e.model = ?
    WHERE c.embed_status = 'done'${wherePage}
  `);
  stmt.bind([model, ...(pageIds ?? [])]);
  let totalEligible = 0;
  let complete = 0;
  let pending = 0;
  let failedRows = 0;
  let mismatchedDimensions = 0;
  while (stmt.step()) {
    const row = stmt.get({}) as {
      content: string;
      section: string;
      path: string;
      title: string;
      type: string;
      status: string | null;
      contextual_embedding: string | null;
      dimensions: number | null;
      source_hash: string | null;
      context_hash: string | null;
    };
    totalEligible++;
    if (row.status === 'pending') pending++;
    if (row.status === 'failed') failedRows++;
    if (row.status === 'done' && row.dimensions !== null && row.dimensions !== DEFAULT_CONTEXTUAL_DIMENSIONS) {
      mismatchedDimensions++;
    }
    const input = {
      pageTitle: row.title,
      pageType: row.type,
      pagePath: row.path,
      section: row.section,
      rawContent: row.content,
    };
    const expectedSourceHash = contextualSourceHash(input);
    const expectedContextHash = contextualContextHash(input, model);
    if (
      row.status === 'done'
      && row.contextual_embedding !== null
      && row.dimensions === DEFAULT_CONTEXTUAL_DIMENSIONS
      && row.source_hash === expectedSourceHash
      && row.context_hash === expectedContextHash
    ) {
      complete++;
    }
  }
  stmt.finalize();
  return {
    scanned: 0,
    embedded: 0,
    skipped: 0,
    failed: 0,
    interrupted: false,
    totalEligible,
    complete,
    pending,
    failedRows,
    mismatchedDimensions,
    coverageRatio: totalEligible === 0 ? 1 : complete / totalEligible,
  };
}

export function formatContextualChildText(input: ContextualChunkInput): string {
  const breadcrumbParts = [
    input.pageTitle,
    ...String(input.headingBreadcrumb ?? input.section ?? '')
      .split(/\s*[>›/]\s*/)
      .map((part) => part.trim())
      .filter(Boolean),
  ];
  const breadcrumb = [...new Set(breadcrumbParts)].join(' › ');
  const lines = [
    `Title: ${input.pageTitle}`,
    `Type: ${input.pageType || 'page'}`,
    `Breadcrumb: ${breadcrumb}`,
  ];
  lines.push('', input.rawContent);
  return lines.join('\n');
}

export function contextualSourceHash(input: ContextualChunkInput): string {
  return sha256(JSON.stringify({
    title: input.pageTitle,
    type: input.pageType,
    path: input.pagePath,
    section: input.section ?? '',
    headingBreadcrumb: input.headingBreadcrumb ?? '',
    rawContent: input.rawContent,
  }));
}

export function contextualContextHash(input: ContextualChunkInput, model = DEFAULT_CONTEXTUAL_MODEL): string {
  return sha256(`${model}\n${formatContextualChildText(input)}`);
}

export function upsertContextualPending(db: WasmDb, chunkId: number, pageId: string, chunkIndex: number, model: string, sourceHash: string, contextHash: string): void {
  const stmt = db.prepare(`
    INSERT INTO wiki_chunk_context_embeddings
      (chunk_id, page_id, chunk_index, model, source_hash, context_hash, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    ON CONFLICT(chunk_id, model) DO UPDATE SET
      page_id = excluded.page_id,
      chunk_index = excluded.chunk_index,
      source_hash = excluded.source_hash,
      context_hash = excluded.context_hash,
      status = CASE
        WHEN wiki_chunk_context_embeddings.context_hash = excluded.context_hash
         AND wiki_chunk_context_embeddings.source_hash = excluded.source_hash
        THEN wiki_chunk_context_embeddings.status
        ELSE 'pending'
      END,
      embed_error = CASE
        WHEN wiki_chunk_context_embeddings.context_hash = excluded.context_hash
         AND wiki_chunk_context_embeddings.source_hash = excluded.source_hash
        THEN wiki_chunk_context_embeddings.embed_error
        ELSE NULL
      END,
      updated_at = datetime('now')
  `);
  stmt.bind([chunkId, pageId, chunkIndex, model, sourceHash, contextHash]);
  stmt.step();
  stmt.finalize();
}

export async function backfillContextualEmbeddings(options: ContextualBackfillOptions): Promise<ContextualBackfillStats> {
  const model = options.model ?? DEFAULT_CONTEXTUAL_MODEL;
  if (model !== DEFAULT_CONTEXTUAL_MODEL) {
    throw new Error(`Unsupported contextual embedding model: ${model}. Supported model: ${DEFAULT_CONTEXTUAL_MODEL}`);
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('contextual backfill limit must be a positive integer');
  }
  const batchSize = options.batchSize ?? limit;
  if (batchSize !== Number.POSITIVE_INFINITY && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new Error('contextual backfill batchSize must be a positive integer');
  }
  const maxToProcess = Math.min(limit, batchSize);
  const stats = selectContextualCoverage(options.db, model, options.pageIds);

  let wherePage = '';
  if (options.pageIds && options.pageIds.length > 0) {
    wherePage = ` AND c.page_id IN (${options.pageIds.map(() => '?').join(', ')})`;
  }
  const stmt = options.db.prepare(`
      SELECT c.id AS chunk_id, c.page_id, c.chunk_index, c.content, COALESCE(c.section, '') AS section,
             p.path, p.title, p.type,
             e.status, e.source_hash, e.context_hash, e.dimensions, e.embedding AS contextual_embedding
      FROM wiki_chunks c
      JOIN wiki_pages p ON p.id = c.page_id
      LEFT JOIN wiki_chunk_context_embeddings e ON e.chunk_id = c.id AND e.model = ?
      WHERE c.embed_status = 'done'
        ${wherePage}
      ORDER BY p.path, c.chunk_index
    `);
  stmt.bind([model, ...(options.pageIds ?? [])]);

  const rows: Array<{ chunk_id: number; page_id: string; chunk_index: number; content: string; section: string; path: string; title: string; type: string; sourceHash: string; contextHash: string }> = [];
  let hasMoreWork = false;
  while (stmt.step()) {
    const row = stmt.get({}) as {
      chunk_id: number;
      page_id: string;
      chunk_index: number;
      content: string;
      section: string;
      path: string;
      title: string;
      type: string;
      status: string | null;
      source_hash: string | null;
      context_hash: string | null;
      dimensions: number | null;
      contextual_embedding: string | null;
    };
    const input = {
      pageTitle: row.title,
      pageType: row.type,
      pagePath: row.path,
      section: row.section,
      rawContent: row.content,
    };
    const sourceHash = contextualSourceHash(input);
    const contextHash = contextualContextHash(input, model);
    const needsWork = row.status !== 'done'
      || row.contextual_embedding === null
      || row.dimensions !== DEFAULT_CONTEXTUAL_DIMENSIONS
      || row.source_hash !== sourceHash
      || row.context_hash !== contextHash;
    if (!needsWork) {
      stats.skipped++;
      continue;
    }
    if (rows.length >= maxToProcess) {
      hasMoreWork = true;
      break;
    }
    rows.push({ ...row, sourceHash, contextHash });
  }
  stmt.finalize();
  stats.interrupted = Boolean(hasMoreWork || (limit !== Number.POSITIVE_INFINITY && rows.length >= limit));

  for (const row of rows) {
    stats.scanned++;
    const input = {
      pageTitle: row.title,
      pageType: row.type,
      pagePath: row.path,
      section: row.section,
      rawContent: row.content,
    };
    const sourceHash = row.sourceHash;
    const contextHash = row.contextHash;
    upsertContextualPending(options.db, row.chunk_id, row.page_id, row.chunk_index, model, sourceHash, contextHash);

    const existingStmt = options.db.prepare('SELECT status, source_hash, context_hash, dimensions FROM wiki_chunk_context_embeddings WHERE chunk_id = ? AND model = ?');
    existingStmt.bind([row.chunk_id, model]);
    const existing = existingStmt.step() ? existingStmt.get({}) as { status: string; source_hash: string | null; context_hash: string | null; dimensions: number | null } : null;
    existingStmt.finalize();
    if (existing?.status === 'done' && existing.source_hash === sourceHash && existing.context_hash === contextHash && existing.dimensions === DEFAULT_CONTEXTUAL_DIMENSIONS) {
      stats.skipped++;
      continue;
    }

    try {
      const contextualText = truncateToEstimatedTokens(formatContextualChildText(input), MAX_CONTEXTUAL_ESTIMATED_TOKENS);
      const vector = await embed(contextualText);
      if (vector.length !== DEFAULT_CONTEXTUAL_DIMENSIONS) {
        throw new Error(`contextual embedding dimension mismatch: expected ${DEFAULT_CONTEXTUAL_DIMENSIONS}, got ${vector.length}`);
      }
      const embeddingBlob = serializeWikiEmbeddingBlob(vector);
      const updateStmt = options.db.prepare(`
        UPDATE wiki_chunk_context_embeddings
        SET status = 'done', dimensions = ?, embedding = ?, embed_error = NULL, updated_at = datetime('now')
        WHERE chunk_id = ? AND model = ?
      `);
      updateStmt.bind([vector.length, embeddingBlob, row.chunk_id, model]);
      updateStmt.step();
      updateStmt.finalize();
      stats.embedded++;
      if (options.verbose) console.log(`contextual embed ${row.path}#${row.chunk_index}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updateStmt = options.db.prepare(`
        UPDATE wiki_chunk_context_embeddings
        SET status = 'failed', embed_error = ?, updated_at = datetime('now')
        WHERE chunk_id = ? AND model = ?
      `);
      updateStmt.bind([msg, row.chunk_id, model]);
      updateStmt.step();
      updateStmt.finalize();
      stats.failed++;
    }
  }

  const after = selectContextualCoverage(options.db, model, options.pageIds);
  return { ...stats, totalEligible: after.totalEligible, complete: after.complete, pending: after.pending, failedRows: after.failedRows, mismatchedDimensions: after.mismatchedDimensions, coverageRatio: after.coverageRatio };
}
