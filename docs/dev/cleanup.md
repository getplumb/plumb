# Plumb Cleanup Plan

Dead code and simplifications identified during the memory architecture redesign (2026-03-07).
Everything here can be deleted or simplified without changing any user-visible behavior.

---

## Files to delete entirely

### `packages/openclaw-plugin/src/mcp-client.ts`
`PlumbMcpClient` wraps the MCP SDK to talk to the plumb MCP server over stdio. It was used
in an earlier architecture where the OpenClaw plugin communicated with the memory store via
the MCP server rather than calling `LocalStore` directly. Today the plugin imports `LocalStore`
from `@getplumb/core` and uses the HTTP query server for `plumb_search`. `PlumbMcpClient` is
never imported anywhere. Safe to delete.

### `packages/openclaw-plugin/src/nudge.ts`
`NudgeManager` fires one-time upgrade nudges toward a hosted Plumb tier. The two nudge types
(`second_integration`, `mcp_downtime`) both hardcode a dead URL (`getplumb.dev/upgrade`).
There is no hosted tier being pursued. The class is instantiated in `plugin-module.ts` and
wired into `pre-response.ts` but the actual nudge strings will never be seen by a user on a
working install. Delete the file and remove all references.

---

## Functions / types to delete

### `scoreFact()` in `packages/core/src/scorer.ts`
Computes `confidence × e^(-lambda × ageInDays)` for a domain `Fact` triple. Nothing in the
call graph reaches it — not the plugin, not the MCP server tools, not any active test path.
`scoreRawLog`, `scoreMemoryFact`, and `computeDecay` are all actively used; leave those.
Also remove `DECAY_LAMBDA` (only used by `scoreFact`).

### `Fact`, `SearchResult`, `DecayRate` in `packages/core/src/types.ts`
`Fact` is the structured subject/predicate/object triple type. `SearchResult` pairs a `Fact`
with a score and age. `DecayRate` is the enum used by `Fact`. None of these are populated or
read in the actual data flow. `ingestMemoryFact()` uses `IngestMemoryFactInput` (a flat
`content` string) and `searchMemoryFacts()` returns `MemoryFactSearchResult` — neither touches
the triple structure. The columns (`subject`, `predicate`, `object`) exist in the DB schema
migration but are never written. Delete the types; leave `IngestMemoryFactInput`, `MemoryFact`,
`MessageExchange`, `IngestResult`, `StoreStatus`.

### `store()` and `search()` methods on `LocalStore`
`store(fact: Fact)` writes a domain Fact triple into `memory_facts`. `search(query)` returns
`SearchResult[]` with full reconstructed `Fact` objects. Both methods exist only to support the
old MCP `memory_store` tool, which no longer exists (the MCP server's `memory-search.ts` now
calls `searchRawLog` directly). Neither method is called by the plugin or any live code path.
Delete both; `ingestMemoryFact()` and `searchMemoryFacts()` are the correct API going forward.

### `chunkExchange()`, `CHUNK_WORDS`, `OVERLAP_WORDS` in `packages/core/src/chunker.ts`
The old word-based chunker split an exchange into overlapping word windows. It was replaced by
`splitIntoChildren()` in `local-store.ts` (T-108 parent-child chunking). `chunkExchange` is
exported from `index.ts` but nothing calls it. `formatExchange()` is still used by
`local-store.ts` — keep that. The rest of `chunker.ts` can go; if `formatExchange` is the
only survivor, inline it into `local-store.ts` and delete the file.

---

## Files that shrink significantly

### `packages/openclaw-plugin/src/hooks/pre-response.ts`
Remove the entire nudge block (~30 lines): the `nudgeText` variable, the `NudgeManager` param,
the `checkSecondIntegration` call, the `recordNudge` call, and the block-assembly logic that
appends nudge text. The function signature becomes:

```ts
export function createPreResponseHook(
  store: LocalStore | null,
  shadowMode = false,
  pendingPrompts?: Map<string, string>
)
```

The return path simplifies to: retrieve memory context, format it, return `{ prependContext }`.

### `packages/openclaw-plugin/src/plugin-module.ts`
- Remove `import { NudgeManager }` and `const nudgeManager = new NudgeManager()`
- Remove `nudgeManager` argument from `createPreResponseHook(...)` call
- Minor size reduction, but meaningfully less moving parts in `activate()`

### `packages/core/src/scorer.ts`
After removing `scoreFact` and `DECAY_LAMBDA`, the file shrinks to three exports:
`computeDecay`, `scoreRawLog`, `scoreMemoryFact`. These are all actively used.

### `packages/core/src/index.ts`
Remove exports for: `scoreFact`, `chunkExchange`, `CHUNK_WORDS`, `OVERLAP_WORDS`, `Chunk`,
`DecayRate`, `Fact`, `SearchResult`.

---

## Schema note
The `subject`, `predicate`, `object`, `confidence`, `decay_rate` columns in `memory_facts`
exist in the schema and migrations. Leave the migrations as-is (they're guarded by
`IF NOT EXISTS` / column-existence checks and are harmless). The columns can stay in the
schema DDL too — they don't cost anything and removing them would require a migration.
What changes is that no code ever writes to them going forward.

---

## Summary

| Item | Type | Lines ~|
|---|---|---|
| `mcp-client.ts` | Delete file | ~100 |
| `nudge.ts` | Delete file | ~130 |
| `scoreFact` + `DECAY_LAMBDA` | Delete functions | ~20 |
| `Fact`, `SearchResult`, `DecayRate` | Delete types | ~25 |
| `store()` + `search()` on LocalStore | Delete methods | ~90 |
| `chunkExchange` + constants | Delete from chunker | ~35 |
| `pre-response.ts` nudge block | Simplify | ~30 |
| `plugin-module.ts` nudge wiring | Simplify | ~10 |
| **Total** | | **~440 lines** |
