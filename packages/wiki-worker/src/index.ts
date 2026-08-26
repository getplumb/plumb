/**
 * @getplumb/wiki-worker — resolver→patch→applier pipeline for wiki queue edits.
 *
 * Public API surface:
 *   - startWikiWorker()       Start the background worker (setInterval-based)
 *   - runWorkerTick()         Run one tick manually (useful for tests)
 *   - applyPatch()            Apply a WikiPatch via wiki.write()
 *   - writePatch()            Generate a WikiPatch from facts (Sonnet)
 *   - resolveAffectedPages()  Find affected pages for a fact (Haiku)
 *   - appendDeadLetter()      Move a failed item to the dead-letter queue
 *   - readDeadLetters()       Read all dead-letter entries
 *   - addTombstone()          Record a manually-deleted sentence
 *   - isTombstoned()          Check if text matches an active tombstone
 *   - ensureTombstoneTable()  Initialize wiki_tombstones in wiki.db
 *   - scanGitDiffForDeletions() Collect tombstones from git diff
 */

// Patch schema
export type {
  PatchOp,
  AppendSectionOp,
  ReplaceParagraphOp,
  UpdateLineOp,
  SetFrontmatterOp,
  WikiPatch,
} from './patch-schema.js';
export {
  parsePatchOp,
  parseWikiPatch,
  PATCH_OP_JSON_SCHEMA,
  WIKI_PATCH_JSON_SCHEMA,
} from './patch-schema.js';

// Resolver
export type { PageIndexEntry, ResolverFn } from './resolver.js';
export { resolveAffectedPages, recordsToPageIndex } from './resolver.js';

// Writer
export type { WriterInput, WriterFn } from './writer.js';
export { writePatch } from './writer.js';

// Applier
export type { ApplierOptions, ApplierResult } from './applier.js';
export { applyPatch } from './applier.js';

// Dead letter queue
export type { DeadLetterEntry } from './dead-letter.js';
export {
  appendDeadLetter,
  readDeadLetters,
  defaultDeadLetterPath,
} from './dead-letter.js';

// Tombstone
export {
  ensureTombstoneTable,
  addTombstone,
  isTombstoned,
  getTombstonedSentences,
  pruneExpiredTombstones,
  scanGitDiffForDeletions,
  normalizeSentence,
  hashSentence,
} from './tombstone.js';

// Worker
export type { WikiWorkerOptions, WorkerQueueItem } from './worker.js';
export { startWikiWorker, runWorkerTick } from './worker.js';
