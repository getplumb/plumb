export type { StoreStatus, MemoryFact, IngestMemoryFactInput } from './types.js';
export type { MemoryStore } from './store.js';
export { scoreMemoryFact, computeDecay } from './scorer.js';
export { LocalStore } from './local-store.js';
export type { LocalStoreOptions, MemoryFactSearchResult } from './local-store.js';
export { embed, embedQuery, rerankScores, EMBED_DIM } from './embedder.js';
export { Bm25, tokenize } from './bm25.js';
export { compileSafeFts5Query, type SafeFts5Query } from './fts5-query.js';
export type { MemoryFactChunk, MemoryContext, ReadPathOptions, ReadPathStore } from './read-path.js';
export { buildMemoryContext } from './read-path.js';
export { formatContextBlock, formatAge } from './context-builder.js';
export { openDb } from './wasm-db.js';
export type { WasmDb } from './wasm-db.js';
export { serializeEmbedding, deserializeEmbedding } from './vector-search.js';
export {
  applyWikiSchema,
  WikiStore,
  CREATE_WIKI_PAGES_TABLE,
  CREATE_WIKI_CHUNKS_TABLE,
  CREATE_WIKI_CHUNK_CONTEXT_EMBEDDINGS_TABLE,
  CREATE_WIKI_CHUNK_CONTEXT_EMBEDDINGS_INDEXES,
  CREATE_WIKI_LINKS_TABLE,
  CREATE_WIKI_CHANGELOG_TABLE,
  CREATE_WIKI_CHANGELOG_COST_INDEXES,
  CREATE_WIKI_FTS_TABLE,
  CREATE_WIKI_FTS_TRIGGERS,
} from './wiki-schema.js';
export type { WikiStoreOptions } from './wiki-schema.js';
export {
  parseFrontmatter,
  serializeFrontmatter,
  parseSimpleYaml,
  formatPage,
  extractTitle,
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  hashContent,
  hashWikiPage,
  isModifiedExternally,
  archivePage,
  loadPlumbIgnore,
  parsePlumbIgnore,
  PLUMBIGNORE_FILENAME,
} from './wiki-fs.js';
export type { WikiFrontmatter, WikiPage, PlumbIgnore } from './wiki-fs.js';
export { runWikiEmbed, chunkText, chunkByH2 } from './wiki-embedder.js';
export type { WikiEmbedderOptions, WikiEmbedStats, WikiChunk } from './wiki-embedder.js';
export {
  DEFAULT_CONTEXTUAL_MODEL,
  DEFAULT_CONTEXTUAL_DIMENSIONS,
  DEFAULT_CONTEXTUAL_RETRIEVAL_CONFIG,
  MAX_CONTEXTUAL_ESTIMATED_TOKENS,
  normalizeContextualConfig,
  estimateContextualTokens,
  truncateToEstimatedTokens,
  formatContextualChildText,
  contextualSourceHash,
  contextualContextHash,
  backfillContextualEmbeddings,
} from './wiki-contextual-embeddings.js';
export type {
  ContextualRetrievalMode,
  ContextualRetrievalConfig,
  ContextualChunkInput,
  ContextualBackfillOptions,
  ContextualBackfillStats,
} from './wiki-contextual-embeddings.js';
export { WikiSearch } from './wiki-search.js';
export type { WikiSearchResult, WikiSearchOptions, WikiContextualSearchTelemetry } from './wiki-search.js';
export { startWikiWatcher } from './wiki-watcher.js';
export type { WikiWatcherOptions, WikiWatcher } from './wiki-watcher.js';
export { installWikiGitHook } from './wiki-git-hook.js';
export type { WikiGitHookOptions } from './wiki-git-hook.js';
export {
  extractWikilinks,
  syncWikiLinks,
  resolveLinksToPage,
  getOutboundLinks,
  getInboundLinks,
} from './wiki-links.js';
export {
  appendToQueue,
  readQueue,
  updateQueueItemStatus,
  defaultQueuePath,
} from './wiki-queue.js';
export type { WikiQueueItem, WikiQueueItemStatus } from './wiki-queue.js';
export {
  computeCost,
  readPlumbConfig,
  readDailyBudget,
  ensureDefaultConfig,
  recordLlmCost,
  getDailySpend,
  isOverDailyBudget,
  nextMidnightMT,
  nextMidnightMTMs,
  getWeeklyCostBySource,
  HAIKU_PRICE_IN,
  HAIKU_PRICE_OUT,
  SONNET_PRICE_IN,
  SONNET_PRICE_OUT,
} from './cost-tracker.js';
export type { PlumbConfig, LlmCostRecord, WeeklyCostRow } from './cost-tracker.js';
export {
  checkWikiCoverage,
  remediateWikiCoverage,
  pruneWikiGhosts,
  MAX_PRUNE_FRACTION,
} from './wiki-coverage.js';
export type {
  WikiCoverageOptions,
  WikiCoverageReport,
  WikiCoverageRemediation,
  PruneOptions,
  PruneResult,
} from './wiki-coverage.js';
