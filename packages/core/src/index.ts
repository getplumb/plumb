export type { StoreStatus, MemoryFact, IngestMemoryFactInput } from './types.js';
export type { MemoryStore } from './store.js';
export { scoreMemoryFact, computeDecay } from './scorer.js';
export { LocalStore } from './local-store.js';
export type { LocalStoreOptions, MemoryFactSearchResult } from './local-store.js';
export { embed, embedQuery, rerankScores, EMBED_DIM } from './embedder.js';
export { Bm25, tokenize } from './bm25.js';
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
  CREATE_WIKI_LINKS_TABLE,
  CREATE_WIKI_CHANGELOG_TABLE,
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
} from './wiki-fs.js';
export type { WikiFrontmatter, WikiPage } from './wiki-fs.js';
export { runWikiEmbed, chunkText } from './wiki-embedder.js';
export type { WikiEmbedderOptions, WikiEmbedStats } from './wiki-embedder.js';
export { WikiSearch } from './wiki-search.js';
export type { WikiSearchResult, WikiSearchOptions } from './wiki-search.js';
