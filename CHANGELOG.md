# Changelog

## 1.0.0 — unreleased

The first release of Plumb as a wiki-based memory system.

### If you used an earlier version

**`@getplumb/plumb` 0.4.x and earlier was a different product** — an OpenClaw
plugin backed by a SQLite fact store, retired in August 2026. Version 1.0.0
shares no API, no storage format, and no configuration with it. It is not an
upgrade; it is a replacement that reclaimed the package name.

The older packages `plumb-memory` and `@getplumb/mcp-server` are no longer
published. Their source remains in the repository.

### What Plumb is now

A local markdown wiki with hybrid vector + keyword retrieval, wired into Claude
Code. It stores what you decide and why, indexes it, and puts the relevant pages
in front of the model on every prompt. Everything runs on your machine.

### Added

- **`@getplumb/wiki-search-service`** — the retrieval service, the MCP server,
  and the `UserPromptSubmit` injection hook, all serving one benchmarked engine.
  Hybrid retrieval with contextual embeddings; the embedder is local, so
  indexing needs no API key.
- **`@getplumb/wiki`** — the indexer. `plumb-wiki index` exits non-zero on
  partial contextual coverage, because a single missing embedding demotes every
  query to keyword-only and does so silently.
- **`@getplumb/wiki-worker`** — processes queued wiki edits.
- **`@getplumb/plumb`** — meta-package installing the engine and the indexer
  together.
- **A Claude Code plugin** (`plugins/plumb`) with `/plumb-setup`,
  `/plumb-doctor`, `/plumb-migrate`, and `/plumb-uninstall`.

### On-demand service lifecycle

The search service starts itself when the hook or the MCP server needs it,
roughly 0.8 s, and stops itself after 15 idle minutes, returning about 300 MB.
Warm queries are around 15 ms. Nothing needs supervising.

Failures are visible rather than silent: a service that will not start produces
a rate-limited notice naming `/plumb-doctor`, and a service answering
keyword-only says so instead of quietly returning worse results.

### Changed

- **Licence: MIT → Elastic License 2.0.** Source-available, not OSI open source.
- **Node floor raised to 22.16.** The index is read through the built-in
  `node:sqlite` module. `DatabaseSync` landed in 22.5, but stayed behind
  `--experimental-sqlite` until 22.13, and the bundled SQLite had no FTS5 until
  22.16. On 22.5–22.12 `require("node:sqlite")` throws
  `ERR_UNKNOWN_BUILTIN_MODULE`; on 22.13–22.15 the service starts and then fails
  with `no such module: fts5`, FTS5 being the keyword half of hybrid retrieval.
- Removed an unused `openai` dependency from `@getplumb/core`.
- **`@getplumb/core` no longer uses `better-sqlite3`.** Its SQLite wrapper now
  uses the runtime's built-in `node:sqlite`, so `@getplumb/core` has no runtime
  dependencies at all and installing Plumb requires no compiler. On a clean
  install the pinned `^9.4.3` was compiling from source — there is no prebuild
  for Node 22 — which turned "install the plugin" into "have a working C++
  toolchain". Install size dropped from 350 MB to 291 MB.

### Packaging

Published from CI with npm provenance. Packages are packed with pnpm — which
rewrites `workspace:` ranges — and published with npm, which is the only one of
the two that can attest provenance. CI fails the build if a workspace range
reaches a tarball.
