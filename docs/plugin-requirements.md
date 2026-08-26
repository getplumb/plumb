# Plumb Claude Code Plugin — Requirements

**Status:** living document. Last updated 2026-08-26.

**Where this stands right now:** branch `release/1.0.0-public`, 3 commits ahead
of the public `main`, nothing pushed. Phases 0 and 2–6 are done; Phase 1 is
prepared and awaiting a review. The `PII_PATTERNS` repository secret is set
(2026-08-26), so the PII gate can run. Two known-untested things: no CI run has
happened on any platform yet, and the Claude Code plugin has never been loaded
in a live session.
**Owner:** Clay Waters
**Scope:** the Claude Code plugin that installs, configures, seeds, and removes
Plumb. Not the retrieval engine itself, which is `packages/wiki-search-service`.

---

## 1. Why this exists

Plumb's parts all work, but installing them is manual: register an MCP server,
paste a hook into `settings.json`, start a daemon, build an index, and write
memory instructions into `CLAUDE.md`. The plugin turns that into one step, and —
just as importantly — turns *uninstalling* into one step.

The governing principle: **an install that half-succeeds must be visible, not
silent.** Every failure this project has hit has been the same shape — retrieval
quietly degrading to keyword-only while looking healthy. The plugin inherits
that hazard and must be built against it.

---

## 2. Delivery model — three tiers

The split is **deterministic vs. judgment-requiring**, not "code vs. agent."

| Tier | Mechanism | User action |
|---|---|---|
| 1. Declarative | `.mcp.json`, `hooks/hooks.json`, plugin manifest | none — install does it |
| 2. Deterministic scripts | CLI commands with exit codes | none — tier 3 calls them |
| 3. Judgment | slash commands whose body is an agent instruction set | one command |

**Rules:**

- Push everything possible into tier 1. Declarative components uninstall
  themselves when the plugin is removed; imperative ones must be unwound.
- Tier 3 calls tier 2; it never reimplements it. An agent should run
  `plumb-wiki-search --print-daemon-config --platform darwin` and adapt the
  output, not hand-author a launchd plist.
- The agent instruction set ships **inside the plugin**, as command bodies. Users
  do not paste prose. This keeps the instructions versioned, improvable per
  release, and immune to transcription loss.

---

## 3. What a Claude Code plugin can and cannot do

Verified against the plugin reference on 2026-08-25.

**Can ship:** `.mcp.json` (MCP servers), `hooks/hooks.json` (hooks),
`skills/<name>/SKILL.md`, `commands/<name>.md`, `agents/<name>.md`, `bin/`,
`scripts/`. Paths use `${CLAUDE_PLUGIN_ROOT}`.

**Cannot do — hard constraint:**

> A `CLAUDE.md` file at the plugin root is not loaded as project context.
> Plugins contribute context through skills, agents, and hooks rather than
> CLAUDE.md.

Plugins also cannot modify the system prompt. So the CLAUDE.md requirement
(§6) can never be satisfied declaratively. It is necessarily tier 3.

Reference implementation for the format: `keeping-up-with-agents`, which already
ships `.claude-plugin/{plugin.json,marketplace.json}`, `commands/`, `skills/`.

---

## 4. Commands

| Command | Tier 3 body | Tier 2 script it calls |
|---|---|---|
| `/plumb-setup` | CLAUDE.md conflict handling | `install.mjs` |
| `/plumb-doctor` | ranking and interpretation | `doctor.mjs` |
| `/plumb-migrate` | source choice, transcript extraction, page review | `migrate.mjs discover\|stage\|promote\|status` |
| `/plumb-uninstall` | strategy confirmation, condensing memory back | `uninstall.mjs plan\|export\|apply` |

Diagnose and repair are separate verbs deliberately: a user must be able to
inspect a system they do not want changed, and `setup` must be safe to re-run.

---

## 5. Install requirements

1. Register the MCP server declaratively (`.mcp.json`).
2. Register the `UserPromptSubmit` injection hook declaratively
   (`hooks/hooks.json`).
3. Ensure the search service is reachable — see the open decision in §9.
4. Build the index (`plumb-wiki index`), which must exit non-zero on partial
   contextual coverage.
5. Write memory instructions into the user's `CLAUDE.md` — see §6.
6. **Write an install manifest before touching anything** — see §8.
7. Verify every step (§10) and report honestly.

**The wiki starts empty.** A pre-seeded wiki teaches the model facts the user
never asserted. Empty means every page has known provenance from day one.
Seeding is a separate, consented step (§7).

---

## 5a. Service lifecycle — RESOLVED 2026-08-25

**Decision: one on-demand instance, shared by the hook and the MCP server. No
in-process runtime fallback.**

Rejected: an in-process fallback engine in the MCP server. Measured on the
author's host, that path costs 133 MB parent + 254 MB embedder child = **387 MB
per session process**, against 11 MCP proxies live at the time of measurement.
Peak memory rises the moment two sessions are open. It is also the architecture
already abandoned on 2026-08-10: `claude-code-hook.mjs` records the tsx-spawned
in-process engine at "~730ms p50, silent timeouts", and a fresh measurement
reproduced it at 745 ms. The hook is a new process per prompt, so it can never
amortise that cost.

The in-process path survives only as the **Phase 5 CI fixture**, where a smoke
test must index and search without supervising a daemon.

### Cold start is waited on, never failed open

Measured spawn-to-ready, two trials:

| Stage | Time |
|---|---|
| spawn → `/health` answers | ~315 ms |
| spawn → warmup complete (`hybrid-contextual-fast`) | 670–691 ms |
| spawn → first real search returned | **765–784 ms** |
| warm steady state | 15–25 ms |

So the caller spawns detached and waits. ~0.8 s once per idle period is
acceptable; a silent miss is not.

**Requirements:**

1. **Two deadlines, not one.** The warm path keeps its 1500 ms budget — a
   *running* service that is slow is a fault, not something to wait on. Only a
   call that itself triggered a spawn gets the extended budget. The Claude Code
   hook timeout rises from 3 s to 10 s to cover slower hardware.
2. **Spawn failure must be visible.** Fail-open-silently is correct when the
   service is merely slow. When a spawn *fails*, the hook injects a one-line
   notice naming `/plumb-doctor` instead of returning nothing. Latency was never
   the troubleshooting problem; invisibility was.
3. **The port bind is the lock.** Verified: two processes racing one port leave
   the loser dead on `EADDRINUSE` and the winner serving. No lockfile needed.
   Two consequences — the loser must exit cleanly with a log line instead of the
   current unhandled-exception stack trace, and **auto-spawn must be disabled
   when `REUSE_PORT=1`**, because `SO_REUSEPORT` removes the exclusion and
   sessions would silently accumulate instances.
4. **Idle shutdown at 15 minutes, counting work and not health.** `/health` must
   not reset the timer, or any watchdog polling it pins the service alive
   forever. On fire, close the listener before exiting so a request arriving in
   the gap gets a clean connection-refused, which the caller already handles by
   spawning.
5. **Pre-warm at install.** The 0.8 s figure assumes a warm page cache and the
   embedding model already on disk. A first-ever run also downloads ~34 MB.
   `/plumb-setup` fetches the model and builds the index during install, where a
   progress bar is expected — never on the user's first prompt.

### Topology: single by default, multi-instance retained

Default install is **one instance**: `REUSE_PORT` off, `INSTANCE_ID` `single`,
no admin port. The multi-instance capability stays in the shipped code, opt-in
by environment variable, because the author runs it and it is how you get a
per-instance memory ceiling and rolling restarts without dropping requests.

This obliges two things:

- **A bug fix.** `/reindex` is currently unreachable in the default
  configuration — the guard at `server.js:179` keys off whether the *admin
  listener* accepted the connection, and a default install has no admin
  listener. Verified: `GET /reindex` on a single-instance service returns the
  "admin-port only" 404. Push invalidation is therefore dead for every plugin
  user, and each refresh (~330 ms) is billed to the next user query — the exact
  bimodal latency `/reindex` was built to remove, made worse by migration, which
  writes many pages at once. Fix: gate enforcement on `REUSE_PORT` rather than
  on `admin`. With `REUSE_PORT` off there is exactly one process behind the
  port, so the route is unambiguous. With it on, the current hard block stands.
- **A CI job, or it rots.** No default install exercises `REUSE_PORT`,
  `INSTANCE_ID`, or the admin listener. A Linux job must start two instances on
  one port, hit each admin `/health`, and confirm `/reindex` on the *shared*
  port is still refused. `reusePort` maps to `SO_REUSEPORT`, whose semantics
  differ on macOS and Windows; the cross-platform matrix must establish whether
  `REUSE_PORT=1` works, misbehaves, or throws there. If it is not reliably
  supported, the service refuses to start with a clear message rather than
  binding and quietly serving a topology that does not balance.

---

## 6. CLAUDE.md / memory instructions

**Requirement:** Claude must reliably save durable facts to the wiki. Language
modelled on Clay's own Memory section — search before asking, queue durable
edits for preferences/decisions/corrections/lessons, treat injected context as
background rather than proof of current state — generalised, with the
Clay-specific parts removed.

**Two mechanisms, both required:**

1. **Standing line in the injected block.** The `UserPromptSubmit` hook already
   fires on every prompt. A compact instruction in the `[PLUMB WIKI]` footer
   (~30 tokens against the 900-token budget) gives the same always-on guarantee
   CLAUDE.md gives, and does not depend on the user having run setup.
2. **`/plumb-setup` writes the fuller block into `CLAUDE.md`,** with consent.
   CLAUDE.md is user-owned territory; a plugin editing it silently would be
   wrong.

**Conflict handling is mandatory, not optional.** Users may already run the
built-in memory tool, a competing memory MCP, or their own notes discipline.
Appending blindly produces contradictory instructions, which is worse than none
— the model then has to guess which wins. The agent must read what is there,
detect conflicts, and reconcile explicitly. This is the clearest example of why
this step cannot be a script.

---

## 7. Migration requirements

Runs **after** install is verified, never during. A known-good baseline on an
empty wiki means a bad migration is diagnosable.

### Discovery

Scan and report with evidence — size, count, recency, character — not a generic
offer. Categories:

- authored instruction files (`CLAUDE.md`, global and project)
- file-based memory stores
- agent transcripts
- other memory MCPs (detect via configured `mcpServers`)

Worked example, measured on a real Claude Code host (2026-08-25):

| Source | Size | Character |
|---|---|---|
| Global `CLAUDE.md` | 7 KB | curated, authored |
| File-based memory (63 files) | 268 KB | curated, structured |
| Transcripts (7,163 files, 200 projects) | 1.3 GB | raw, noisy, most sensitive |

Three orders of magnitude apart. **Consent is per-source, and so is strategy** —
a single yes/no prompt is wrong.

### Extraction, not copy

Copying raw transcripts into a wiki produces an unusable wiki. Migration extracts
durable facts and writes pages, which is an LLM job on the `wiki-worker` path.

**Cost note:** indexing needs no API key (the embedder is local). *Migration
does.* Different operation. Estimate cost and show it before the user consents.

### Poisoning — the non-obvious risk

A memory system that ingests transcripts and then injects its contents into every
future prompt is a self-poisoning surface. Instruction-shaped text in a
transcript — a pasted web page, a debugging session, an actual injection attempt
— can become a wiki page that is fed into every prompt thereafter.

Therefore: the extraction prompt must capture **facts about the user and their
work, never instructions**, and migrated pages are quarantined for review before
indexing. Precedent to encode: summaries indexed, raw transcripts excluded by
path.

### Non-negotiables

- **Dry run always.** Show proposed pages before writing any.
- **Provenance tags.** Every migrated page carries `source_refs` back to its
  origin. This is also what makes uninstall correct (§8) — build it properly
  because two features depend on it.
- **Watermark.** Re-running must not duplicate.
- **Detect existing installs** and refuse to double-seed.

---

## 8. Uninstall requirements

Must work immediately after install *and* three weeks later, and must work on a
broken system — the daemon already dead, the port taken, `CLAUDE.md` hand-edited.
It runs on the bad day, so it cannot assume health.

### Strategy selection — measured, not guessed

Two strategies: **backup-restore** (return files to install-time state) and
**surgical removal** (remove only what Plumb added).

Time is a proxy; divergence is the real variable. At uninstall, diff current
`CLAUDE.md` against the install-time backup:

- differences are **only** Plumb's block → **restore**; exact and provably complete
- **unrelated changes present** → **surgical**; restore would silently destroy
  edits the user made for reasons having nothing to do with Plumb

Elapsed time is the default *recommendation* shown to the user. The diff is the
*decider*. A 20-minute-old install with unrelated edits still goes surgical.

### Restore ≠ export

After any real usage the wiki holds two populations:

- **(a) migrated facts** — have an origin to return to → **restore**
- **(b) net-new facts** created inside Plumb — have no prior location anywhere →
  **export**

(b) is the majority after three weeks and is the user's accumulated value.
Returning only (a) would discard the reason they used the product. Export emits
portable markdown the user keeps, and optionally condenses the highest-value
facts into whatever memory format they used before.

The `source_refs` tags from §7 are what sort (a) from (b). Migration and
uninstall are the same mechanism viewed from opposite ends.

### The install manifest

Install writes `~/.plumb/install-manifest.json` **before modifying anything**,
recording every file Plumb will touch with pre-change content hashes and copies.

- backup-restore reads the stored copies
- surgical reads the hashes to distinguish "Plumb's line" from "drifted"

Without the manifest, surgical removal is pattern-matching guesswork. With it,
both strategies are exact. **One artifact enables both paths.**

### Inventory to unwind

daemon (unit file + running process + port) · MCP registration · hook
registration · `CLAUDE.md` block · wiki corpus and `wiki.db` · migrated memories
· telemetry JSONL · installed packages · any scheduled jobs.

MCP and hook registration unwind themselves if declarative — another reason to
keep them in tier 1.

### Non-negotiables

- **Never delete the wiki corpus.** Default is leave it and print the path.
  Precedent: the 2026-08-13 OpenClaw teardown produced a durable archive, not
  deletions, with paths explicitly marked never-delete.
- **Dry run first**, same as migration.
- **Verify after** (§10).

---

## 9. Open decisions

| # | Decision | Status |
|---|---|---|
| 1 | **Daemon strategy.** | **RESOLVED 2026-08-25 — see §5a.** Single on-demand instance shared by hook and MCP; no in-process runtime fallback; 15-minute idle shutdown; cold start waited on, not failed open. |
| 2 | Author's name in shipped code comments (`"Clay's rule…"`). Keep as authorship or neutralise for a public 1.0. | Open, low stakes. |
| 3 | Whether `/plumb-setup` should offer to repoint an existing hand-rolled install at the packaged components. | Open. Relevant to exactly one user today. |

---

## 10. Verification requirements

"Make sure" needs a checkable definition. Every agentic step ships with one:

| Step | Verification |
|---|---|
| Daemon | `GET /health` → 200, `coverage: 1` |
| Index | exit 0 **and** `embeddingGap: 0` |
| MCP | `plumb_wiki_search` present in the tool list |
| Hook | a `[PLUMB WIKI]` block appears on the next prompt |
| CLAUDE.md | re-read; block present, no surviving contradictions |
| Migration | dry-run diff reviewed; pages carry `source_refs` |
| Uninstall | service down, port free, no MCP/hook entries, CLAUDE.md clean, corpus intact at named path |

Without these, an agent reports success from having *run commands* — which is
precisely the failure mode that produced a working-looking install silently
degraded to BM25, twice, during Phase 3.

---

## 11. Where the 1.0 work stands

Branch `release/1.0.0`, local only, nothing pushed.

- **Phase 0 — relicense.** MIT → Elastic License 2.0 across all packages. Done.
- **Phase 1 — merge to `main`.** Prepared, not pushed. `release/1.0.0-public`
  branches from `getplumb/main` and carries the whole release as **one squashed
  commit** plus two follow-ups. Squashed rather than fast-forwarded because the
  60-commit development history contains real people's names and host paths that
  later commits removed — a fast-forward publishes every one of those states.
  Verified: the squashed tree is byte-identical to the detailed branch, the
  pushed commits contain zero gitleaks findings, and the commit removes
  `hosted/` (16 files, 1,328 deletions) from the public repo. Full history is
  preserved locally as `release/1.0.0-detailed`, which is never pushed.
- **Phase 2 — reconcile the service** with what actually runs in production.
  Done. Verified by byte-parity against the live service: 40/40 search bodies and
  12/12 endpoint and error paths identical. The benchmark was deliberately *not*
  spent — the engine is byte-identical to production, so it would have measured
  production. Holdout ledger untouched.
- **Phase 3 — make a fresh install bootstrap itself.** Done. Added
  `plumb-wiki index`, fixed two install-breaking bugs (npm hoisting vs
  package-local `node_modules`; `URL.pathname` on Windows), packaged the
  injection hook, removed hardcoded host paths.
- **Phase 4 — naming, versioning, provenance.** Done. All four packaging
  blockers closed, each verified by packing and installing rather than by
  inspection:

  1. **Version skew** — the five published packages are now `1.0.0`, matching
     the plugin version the installer requests. Verified by installing the
     packed tarballs: `@getplumb/core@1.0.0`, `@getplumb/wiki@1.0.0`,
     `@getplumb/wiki-search-service@1.0.0`.
  2. **`workspace:*`** — CI now packs with pnpm (which rewrites the ranges) and
     publishes the tarballs with npm (the only one of the two that can attest
     provenance; pnpm 10.30.3 has no `--provenance` flag). A guard step fails the
     build if a workspace range survives into a tarball, because that mistake is
     unfixable for 72 hours once published. Verified locally: all five tarballs
     clean, dependency ranges resolved to `1.0.0`.
  3. **Stale `openai` dependency** — removed from `@getplumb/core`.
  4. **`better-sqlite3`** — removed entirely. `wasm-db.ts` now uses the
     runtime's built-in `node:sqlite`, so **`@getplumb/core` has no runtime
     dependencies at all**.

     This turned out to be worse than predicted and easier to fix than feared.
     On a clean install the pinned `^9.4.3` *compiled from source* — node-gyp
     output was present in the runtime, no prebuild exists for Node 22 — so
     "install the plugin" required a working C++ toolchain. The port was gated
     on behaviour verified empirically first: `StatementSync.all()` executes DML
     as well as queries (so no SELECT-versus-DML detection is needed), integers
     come back as numbers, multi-statement `exec()` works, and `undefined` is
     rejected exactly as before. The one real difference — blobs return
     `Uint8Array` rather than `Buffer` — does not reach core, which only
     serialises embeddings; the read path lives in the service, which has been
     using `node:sqlite` against this same database in production for weeks.

     Core's 253 tests pass, the full monorepo suite passes, and a clean install
     now contains no native modules and no compile step. Install size 350 MB →
     291 MB.

  Also: `@getplumb/plumb` reclaimed as the 1.0 umbrella meta-package (the
  OpenClaw plugin it used to be is now private under its own name), `CHANGELOG.md`
  and `docs/releasing.md` written, `repository` and `engines` fields set on every
  published package, and the plugin README's disk-space claim corrected — it said
  "roughly 150 MB" against a measured 291 MB.

  **Remaining, and Clay's to run:** the publish itself, and `npm deprecate` on
  the 0.4.x line. Both need npm auth, which returns 401 on this host; CI holds
  the token. Exact commands are in `docs/releasing.md`.

- **Phase 5 — retarget `cross-platform.yml`.** Done. The workflow tested the
  retired product: it packed `packages/openclaw-plugin` and smoke-tested
  `memory.db`/LocalStore, so the new stack had never run on Windows or macOS at
  all. Three jobs now:

  1. **build-and-unit** — OS x Node matrix, unchanged in shape.
  2. **install-smoke** — packs the published packages, installs them into a
     clean directory the way a user would, then builds an index, starts the
     service and runs real queries. Verified locally end to end: 4-page
     synthetic corpus, gap 0, all three semantic queries returning the right
     page at rank 1 in `hybrid-contextual-fast`. It also fails the build if any
     `.node` addon appears in the install tree, which is the standing guarantee
     that removing `better-sqlite3` bought.
  3. **multi-instance** (Linux) — two instances behind one `SO_REUSEPORT`
     socket, asserting that `/reindex` is *refused* on the shared port and
     accepted on each admin port. Verified locally, including balancing across
     both instances.

  **The private-fixture problem is now explicit rather than hidden.** 21 of the
  36 wiki-search-service tests need a snapshot of a real wiki that lives in a
  separate private repo, which public CI will never have. They now skip with a
  stated reason instead of failing: 36/36 pass where the fixture exists, 36
  skipped and 0 failed where it does not. Retrieval coverage in CI comes from
  the synthetic corpus in job 2 instead — inventing assertions that pass without
  exercising retrieval would have been worse than skipping.

  Two bugs found by running the new tests rather than reading them: the smoke
  test's third query was ambiguous on a four-page corpus (sharpened, and the
  rank assertion loosened to match what the test is actually for — install and
  platform correctness, not retrieval quality), and the multi-instance test used
  `fetch`, whose keep-alive pooling pinned every request to one instance, so it
  reported success having exercised half the topology. It now forces a fresh
  connection per request, as the existing service suite already did.
- **Phase 6 — the plugin.** Built and verified end to end against packed
  tarballs. `plugins/plumb/` ships the manifest, `.mcp.json`, `hooks/hooks.json`,
  two entry-point shims, three tier-2 scripts, the `plumb-memory` skill, and the
  four commands; the marketplace manifest sits at the repo root.

  Verified by installing the packed artifacts into a scratch runtime, not by
  inspection:

  | Path | Result |
  |---|---|
  | Fresh install, empty wiki | all 7 steps ok, service ready in 147 ms |
  | Fresh install, 4-page wiki | indexed, gap 0, hybrid live |
  | Hook shim, semantic query | correct page ranked first on a query sharing no keywords with it |
  | Hook shim, runtime absent | rate-limited instruction to run `/plumb-setup`, no crash |
  | MCP shim over stdio | initialize, all 5 tools, search and read correct |
  | `doctor.mjs` | reported the fixture install healthy, and this host's real drift |

  **Two bugs the install test caught**, both invisible to unit tests because
  both only appear on a genuinely fresh machine:

  - The installer skipped indexing an empty wiki, so no `wiki.db` was ever
    created, so the service had nothing to open — and the *default* first-run
    path failed at its last step. An empty index is valid and is now always
    built.
  - `/health` returned 500 when the index was missing. That is the one endpoint
    every caller reaches for when something is wrong — the spawn helper, the
    doctor, a watchdog — and a 500 told all three of them nothing. It now
    returns a diagnosis, which `ensureService` propagates, so the failure reads
    "index unavailable at <path>" instead of "did not become ready".

  **Migration and uninstall dropped to tier 2** (`migrate.mjs`, `uninstall.mjs`).
  Both commands now call scripts rather than describing procedures, leaving the
  agent only the genuinely judgmental parts: which sources are appropriate, what
  a transcript actually says, and whether a proposed page asserts a fact or a
  directive.

  `migrate.mjs discover | stage | promote | status` — verified against this
  host's real memory (1 authored `CLAUDE.md`, 63 memory files, 7,179 transcripts
  / 1.2 GB / 200 projects, matching the figures in §7). Staged 6 pages from
  `CLAUDE.md` split by `##`, 62 from memory files with the `MEMORY.md` index
  correctly skipped as pointers rather than content, promoted into a scratch
  wiki, and confirmed the pages were then *retrievable* — "how should I pick
  which model to use" returned the model-selection page, "what should I do
  before shipping something that could fail quietly" returned the evals page.
  Re-running `stage` skipped the already-imported source instead of duplicating.

  `uninstall.mjs plan | export | apply` — verified that the diff overrides the
  calendar: a **same-day** install still chose surgical once the user had made an
  unrelated `CLAUDE.md` edit. Surgical removal left both the original content and
  the user's later edit intact while removing only Plumb's block; the corpus
  survived at its path, the runtime was removed, and the port was freed. `apply`
  refuses to touch anything without `--yes`.

  **Three bugs found by running them rather than reading them:**

  - `promote` fired `/reindex` without awaiting it, so the process exited before
    the request was sent. Pages landed in the wiki, the on-disk index was
    rebuilt, and the running service kept serving its old empty index — a
    freshly migrated page was simply unfindable, with every surface reporting
    success. Now awaited, forced, and reported.
  - Staging `CLAUDE.md` re-imported Plumb's own instruction block, since
    `/plumb-setup` writes one there. That would have made the wiki explain the
    wiki and inject it into every prompt forever. The block is now stripped
    before splitting.
  - Bullet-only sections produced the summary "Imported from CLAUDE.md", which is
    no retrieval signal at all. Summaries now fall back to the first bullet.

  **Phase 6 is complete.**

**Test fragility fixed:** the lifecycle suite hardcoded ports 18771-18773, which
made it flake under turbo's parallel execution (one failure in a full `pnpm test`
run, passing in isolation). Tests that need a *known* port — the ones exercising
port binding itself — now ask the kernel for a free one and release it.

**Known drift to close:** the injection hook now exists both in the package and
at `~/.claude/hooks/` on the author's host. That is exactly how
`wiki-search-service` came to differ from its own package by 190 lines.
