# @getplumb/wiki-search-service

Standalone loopback HTTP service around the benchmarked `wikiNavigator` wiki
search engine, extracted verbatim from terra-chat on 2026-08-09. Intended as the
single retrieval backend for all three consumers: the Claude Code injection
hook, the Claude Code MCP server, and the Terra Console wiki surface.

## Why it exists

Production ran three divergent retrieval engines (Plumb core cold-spawned per
prompt for injection, Plumb core warm for MCP, wikiNavigator warm for Terra
Chat) while the benchmark suite only ever measured wikiNavigator. This package
makes the benchmarked engine the deployed engine, decoupled from both terra-chat
(retiring) and the `~/.openclaw` tree (decommissioning).

## Layout

- `src/wikiNavigator.js` — the engine, copied from
  `terra-chat/server/wikiNavigator.js` with three deliberate patches, each
  marked `// Service patch`:
  1. transformers entrypoint resolves to this package's own `node_modules`
     (override: `WIKI_TRANSFORMERS_PATH`), not `~/.openclaw/extensions/plumb`
  2. the index caches contextual coverage counts
  3. `searchStats()` export for `/health`
  Everything else is byte-identical to the benchmarked original. Keep it that
  way; quality changes belong in an experiment first.
- `src/wikiEmbeddingChildProcess.js` — resident embedder child, unmodified copy.
- `src/server.js` — HTTP wrapper. GET-only: `/health` `/search` `/page` `/tree`
  `/links` `/resolve`. Adds a search deadline (`SEARCH_TIMEOUT_MS`, default
  10s -> 503) because the engine has none. Logs timings/counts only, never
  query text.
- `test/service.test.mjs` — regression suite (`npm test`), runs against the
  frozen v7 snapshot. Covers parity vs. direct engine call, validation,
  traversal, embedder-crash fallback, deadline.
- `bench/eval-v7-http.mjs` — the v7 evaluator with retrieval over HTTP to a
  self-spawned service instance. Same scoring code as
  `plumb-benchmark/real-wiki/v4/eval-v7.mjs`.

## Deployment (2026-08-09)

- Deployed copy: `~/plumb-services/wiki-search/` (own `node_modules`, model
  cache vendored at `node_modules/@xenova/transformers/.cache`). No references
  into `~/.openclaw` at runtime.
- Unit: `~/.config/systemd/user/plumb-wiki-search.service`
  (port 18795, loopback, `Restart=always`, `MemoryMax=1G`, guard 800MB).
- Update flow: edit in this package, `npm test`, copy changed files to
  `~/plumb-services/wiki-search/`, `systemctl --user restart plumb-wiki-search`.

## Operational notes

- `/health` `stats` is the truth about degradation: `useContextual` false or
  `coverageRatio` < 1 means the all-or-nothing contextual gate fell back to
  plain embeddings (2026-08-06..08 outage mode; fix with
  `plumb wiki contextual-backfill`). `embedder.inCooldown` true means vector
  search is temporarily BM25-only after an embedder crash.
- Embedder lifecycle (Clay-approved 2026-08-10): kept warm permanently
  (`WIKI_EMBEDDER_IDLE_MS=0`; unset restores the original 5-min idle shutdown).
  In keep-warm mode the embedder is supervised: an unexpected death schedules
  its own respawn (no query needed) after a backoff mirroring systemd policy,
  2s base doubling per consecutive failure to a 10-min cap
  (`WIKI_EMBEDDER_RETRY_BASE_MS` / `WIKI_EMBEDDER_RETRY_MAX_MS`); the respawn
  probe embed warms the pipeline and resets the streak. Intentional stops
  (idle timeout, cgroup guard) stay lazy on purpose. Live drill 2026-08-10:
  SIGKILL -> fully self-recovered (resident, streak 0) in 2.6s, zero queries.
- Measured 2026-08-09 on the live corpus (1,866 chunks): warm search ~12-15ms;
  throughput ceiling ~85 RPS (embedder serializes); 500-request burst worst
  case 5.9s with zero errors; RSS ~150-240MB under load.
