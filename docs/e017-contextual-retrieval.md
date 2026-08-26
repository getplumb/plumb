# E017 Contextual Wiki Retrieval

E017 adds an opt-in, rollback-safe retrieval candidate for Plumb wiki injection.

## What changes

- Plain `wiki_chunks.embedding` rows remain unchanged and stay the default fallback.
- Contextual child embeddings are stored in the sidecar table `wiki_chunk_context_embeddings` keyed by `(chunk_id, model)`.
- Contextual embedding text mirrors the measured E017 compact recipe:
  - title
  - type
  - title-plus-section breadcrumb
  - raw child content
- Contextual active mode also mirrors the measured E017 keyword candidate treatment: BM25 runs over that compact contextual child text before RRF, while plain/off mode continues using native FTS5 over raw wiki text.
- Snippets and citations still use the raw `wiki_chunks.content`, not the contextual text.

## Modes

Configure under the plugin namespace:

```json
{
  "plumb": {
    "wikiMode": "v2",
    "contextualRetrieval": {
      "mode": "off",
      "model": "Xenova/bge-small-en-v1.5",
      "parentTokenBudgets": [400, 300, 125, 100, 75],
      "maxParentTokens": 1000
    }
  }
}
```

Modes:

- `off`, default, current plain vector + FTS5/BM25 + RRF behavior. The plain result shape is preserved and no `retrievalSource` field is added for plain hits.
- `shadow`, runs contextual retrieval diagnostics, including partial-coverage comparison when possible, but always returns the plain/off result set and injected context.
- `active`, uses contextual child vector ranking plus existing FTS5/BM25 and RRF only when contextual coverage is complete for every currently eligible `wiki_chunks.embed_status='done'` row for the supported model/hash/dimensions. Missing, stale, partial, or dimension-mismatched sidecars emit fallback telemetry and fail open to the full plain corpus.

## Backfill and refresh

Run against an isolated copied/dev wiki DB first:

```bash
cp ~/.plumb/wiki.db /tmp/plumb-e017-wiki.db
pnpm --filter plumb-memory exec plumb wiki contextual-backfill --db /tmp/plumb-e017-wiki.db --verbose
```

The backfill leaves plain embeddings untouched. It upserts pending sidecar rows, writes completed rows as `status='done'`, validates 384 dimensions, and reports coverage stats: total eligible plain chunks, completed contextual chunks, pending rows, failed rows, dimension mismatches, coverage ratio, and whether the run stopped because `--limit` or `--batch-size` left more work.

Changed/new pages do not incur surprise production cost while contextual retrieval is default-off. The regular embed path refreshes contextual rows only when called with the explicit contextual refresh option, or when sidecar rows were already provisioned for that page. Chunk replacement is atomic for plain rows; deleting old chunks relies on SQLite foreign keys to cascade-clean old sidecar rows before new contextual rows are generated.

## Shadow rollout

1. Copy the wiki DB to a dev path.
2. Run `plumb wiki contextual-backfill --db <copy>`.
3. Point dev plugin config at the copied DB.
4. Set `contextualRetrieval.mode` to `shadow`.
5. Review local `plumb.wiki_contextual_search` diagnostics for fallback/error rates and candidate counts.
6. Only after shadow looks healthy, test `active` in dev.

## Rollback

Set:

```json
"contextualRetrieval": { "mode": "off" }
```

No production plain embedding columns are changed, so rollback does not require data migration. The sidecar table can remain in place safely.

## Observability

When contextual mode is `shadow` or `active`, local diagnostics include:

- mode
- status: `ok`, `fallback`, or `error`
- fallback reason, for example `missing_contextual_index`, `partial_contextual_index`, or `dimension_mismatch`
- coverage stats (`totalEligible`, `contextualDone`, `mismatchedDimensions`, `coverageRatio`)
- plain result count
- contextual result count
- elapsed milliseconds

Backfill metrics are one-time indexing metrics and are reported separately from query latency.

## Active-mode ranking and parent assembly

Active mode follows the measured E017 production-candidate semantics:

1. rank contextual child-vector hits plus raw FTS5/BM25 hits with RRF at the child-chunk level;
2. walk the full ranked child list and select only the first winning child per page until five unique pages are collected;
3. preserve the winning child provenance (`path`, `section`, `chunkIndex`, child text, child score, and source chunk id when available);
4. reconstruct the selected child’s raw parent H2 section from all ordered raw chunks on the same page and section, independent of duplicate rows in the ranked result set.

Active contextual injection uses deterministic approximate token budgets based on `ceil(characters / 4)`, not provider-tokenizer-exact counts. The E008 defaults are preserved under this estimator:

```text
400, 300, 125, 100, 75 estimated tokens, capped at 1000 estimated tokens total
```

Configuration is strict: unknown keys are rejected, budgets must be positive integers, `maxParentTokens` cannot exceed 1000, and the configured per-parent budget sum must not exceed the max cap.

Injected entries preserve path, section, chunk index, raw matched-child snippet, parent context, and ranking provenance where available. If a reconstructed parent section fits within its page-rank budget, it is used fully. If it exceeds the budget, injection uses a child-centered window that retains the section breadcrumb in the result header and keeps adjacent raw parent content around the winning child. Active plugin retrieval asks for the measured E017 top five unique pages, not top eight.

## Current production-candidate limitations

- Supported contextual embedding model is exactly `Xenova/bge-small-en-v1.5` (384 dimensions). Other model names are rejected rather than silently labeling default embeddings as another model.
- Query and document embeddings must use that same model and dimensions.
- Active mode never searches a partial contextual corpus silently; it falls back to the complete plain corpus instead.
- Budgets are approximate estimated tokens (`ceil(chars / 4)`) until a provider-accurate local tokenizer is intentionally introduced and tested.

## Production safety

This task does not deploy, edit production config, mutate production wiki data, or restart production. Production activation requires a separate explicit rollout step after copied-DB off/shadow/active smoke validation.
