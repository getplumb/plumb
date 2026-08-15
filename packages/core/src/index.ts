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
export type { DanglingLinkResolution } from './wiki-links.js';
// The canonical wikilink resolver. Anything asking "does this link resolve?"
// must go through here so there is one answer; see the header of wiki-resolve.ts
// for the three disagreeing detectors this replaces.
export {
  analyzeLinks,
  buildResolveIndex,
  buildResolveIndexFromMeta,
  extractAliases,
  extractHeadings,
  extractTitleFromBody,
  maskNonProse,
  normalizeHeading,
  normalizePath,
  parseWikilinks,
  resolveWikilink,
  slugify,
} from './wiki-resolve.js';
export type {
  LinkFinding,
  LinkGraphResult,
  ParsedWikilink,
  Resolution,
  ResolutionStatus,
  ResolveIndex,
  WikiPageInput,
  WikiPageMeta,
} from './wiki-resolve.js';
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
// The single source of truth for wiki structural health. Anything reporting
// "is the wiki healthy?" must come from here; see the header of
// wiki-integrity.ts for why three partial answers were worse than one.
export {
  collectWikiIntegrity,
  collectWikiCorpus,
  evaluateIntegrity,
  isGeneratedWikiPage,
  frontmatterKeysPresent,
  writeIntegrityReport,
  readIntegrityReport,
  defaultIntegrityPath,
  INTEGRITY_THRESHOLDS,
  REQUIRED_FRONTMATTER_FIELDS,
} from './wiki-integrity.js';
export type {
  WikiIntegrityOptions,
  WikiIntegrityReport,
  IntegrityBreach,
  WikiCorpus,
  WikiCorpusPage,
} from './wiki-integrity.js';
// Before/after structural readings, so an automated writer can be held to a
// post-condition instead of a prompt instruction. See wiki-verify.ts.
export {
  snapshotWikiStructure,
  newStructureFindings,
  structureFindingKeyParts,
  verifyWikiStructure,
} from './wiki-verify.js';
export type {
  WikiStructureSnapshot,
  StructureFinding,
  StructureFindingKind,
  WikiVerifyResult,
} from './wiki-verify.js';
