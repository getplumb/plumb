# Plumb Feature Gaps

Work needed to complete the memory architecture redesign (2026-03-07).
Goal: agent explicitly sends extracted memories to Plumb via a tool; Plumb injects
confidence-tiered results per query; always-injected memory files go away.

---

## Gap 1 — `plumb_remember` write tool

**What's missing:** There is no way for the agent to store a discrete fact into Plumb.
`ingestMemoryFact()` exists on `LocalStore` and the `memory_facts` table is fully set up,
but neither is exposed as an agent-callable tool.

**What to build:**
Register a `plumb_remember` tool in `plugin-module.ts` alongside `plumb_search`.

Input schema:
```ts
{
  fact: string,           // The memory to store (required)
  confidence?: 'high' | 'medium' | 'low',  // Default: 'high'
  tags?: string[],        // Optional topic tags for retrieval
  decay?: 'slow' | 'medium' | 'fast'       // Default: 'slow'
}
```

Confidence maps to a float stored in `memory_facts.confidence`:
- `high` → 0.95
- `medium` → 0.75
- `low` → 0.5

Decay maps directly to `memory_facts.decay_rate` (`slow` / `medium` / `fast`).

The tool calls `store.ingestMemoryFact({ content: fact, sourceSessionId, tags })` and
also writes `confidence` and `decay_rate` to the row. Returns a confirmation string with
the `factId`.

**Why this approach:** The agent already decides what's worth remembering — it currently
writes to dated memory files. This just changes the destination. No background extraction,
no LLM-in-the-loop, no latency. The agent calls `plumb_remember` the same way it currently
appends to `memory/YYYY-MM-DD.md`.

**Files to change:**
- `packages/openclaw-plugin/src/plugin-module.ts` — register the tool
- `packages/core/src/local-store.ts` — extend `ingestMemoryFact()` to accept and write
  `confidence` and `decay_rate` (currently hardcodes defaults)

---

## Gap 2 — Confidence-tiered injection in `[PLUMB MEMORY]` block

**What's missing:** The injected block currently treats all results equally. Memory facts
get a 2× boost in scoring but the agent has no visibility into how confident a result is.
The agent can't distinguish "this is a strong match" from "this is a weak guess."

**What to build:**
Add score-to-tier mapping in `context-builder.ts` and annotate each line.

Tier thresholds (tunable):
- `[HIGH]` — memory fact score ≥ 0.7, or raw log `final_score` ≥ 0.6
- `[MED]`  — memory fact score 0.4–0.7, or raw log 0.3–0.6
- `[LOW]`  — below those thresholds

Output format:
```
[PLUMB MEMORY]

## Remembered facts
[HIGH] Never restart prod gateway without Clay's approval
[HIGH] Clay uses a Tailscale URL for terra-chat links
[MED]  Plumb dev DB is at ~/.plumb-dev/memory.db

## Related conversations
[MED] [terra-chat] yesterday: "Discussed the Plumb memory architecture..."
[LOW] [plumb-dev] 3 days ago: "OOM investigation and T-115 fixes..."
```

The agent can use tier labels to weight its reasoning — HIGH facts are treated as ground
truth; LOW results are hints only.

**Files to change:**
- `packages/core/src/context-builder.ts` — add `scoreTier()` helper, update
  `formatMemoryLine()` and `formatChunkLine()` to prepend tier label

---

## Gap 3 — Auto-seed from existing memory files on first activation

**What's missing:** Installing the plugin starts with an empty `memory_facts` table and a
`raw_log` seeded only from exchanges that happened after install. Years of prior memory
files (`memory/YYYY-MM-DD.md`, `MEMORY.md`) are not imported.

**What to build:**
On plugin activation, check if `memory_facts` has zero rows for this `userId`. If so, scan
`workspaceDir/memory/` for `*.md` files and ingest each one.

Ingestion strategy:
- Parse each file as plain text
- Split on `##` headings — each section becomes one `ingestMemoryFact()` call
- Tag with `source:memory-file` and the filename date (e.g. `date:2026-03-06`)
- Set confidence `0.85` (slightly below fresh agent-written facts at 0.95) and decay `slow`
- Skip files already ingested (track by a `seeded_files` table or a simple hash in the DB)

`workspaceDir` is available on `PluginHookAgentContext` as `ctx.workspaceDir` during hooks,
but needs to be captured at activation time. OpenClaw passes `workspaceDir` in the plugin
config or context — confirm the exact field name from the OpenClaw plugin SDK.

**Files to change:**
- `packages/openclaw-plugin/src/plugin-module.ts` — add seed-on-first-activate logic
- `packages/core/src/local-store.ts` — optionally add a `hasBeenSeeded()` / `markSeeded()`
  helper, or just check `factCount === 0` on `status()`

**Note:** This is one-shot seeding only. Ongoing writes go to Plumb directly via
`plumb_remember`. The dated files become a human-readable log, not a memory source.

---

## Gap 4 — Stop injecting dated memory files as always-on context

**What's missing:** `AGENTS.md` currently instructs the agent to read `memory/YYYY-MM-DD.md`
(today + yesterday) at the start of every session. On busy days these files are 300–600 lines.
This is loaded unconditionally regardless of whether the content is relevant to the current
query. With Plumb handling retrieval, this is redundant and expensive.

**What to build:**
This is a documentation/config change, not code:

1. Update `AGENTS.md` — remove the instruction to read daily memory files. Replace with:
   "Plumb injects relevant memories automatically. Use `plumb_remember` to store new facts.
   Write to `memory/YYYY-MM-DD.md` only as a human-readable log if you want Clay to be able
   to review what happened — don't rely on it for your own memory."

2. Trim `MEMORY.md` to hard invariants only — things that must be known every session
   regardless of query (e.g. "never restart prod gateway without approval", "no markdown
   tables", "primary channel is Slack"). Target: 10–15 lines. Everything else gets migrated
   into Plumb via `plumb_remember` calls.

3. The daily files stop being injected. They become a logbook for Clay. Plumb is the
   knowledge base.

**Files to change:**
- `workspace/AGENTS.md`
- `workspace/MEMORY.md` (trim + migrate facts into Plumb)

---

## Dependency order

```
Gap 1 (plumb_remember tool)
  └── Gap 3 (auto-seed, can call ingestMemoryFact once Gap 1 is wired)
  └── Gap 4 (AGENTS.md / MEMORY.md update, best done once plumb_remember works)

Gap 2 (confidence tiers) — independent, can land anytime
```

Gap 1 is the critical path. Everything else follows from having a working write tool.

---

## What's already built and does not need changing

- BM25 + vector KNN + RRF merge — `raw-log-search.ts`, `memory-facts-search.ts`
- Recency decay — applied in `raw-log-search.ts` (lambda=0.012)
- Cross-encoder reranking — `embedder.ts` / `rerankScores()`
- `memory_facts` table + `ingestMemoryFact()` — schema, migration, and write path exist
- `searchMemoryFacts()` + `buildMemoryContext()` — Layer 2 is live and parallelized with Layer 1
- `plumb_search` tool — mid-reasoning RAG lookups already registered
- Parent-child chunking for raw log — T-108, no changes needed
- OOM safeguards — T-115, heap guard + batch size + cache cap, already in dev
