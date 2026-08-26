# Plumb 2.0 Wiki Maintenance — Critique & Ideas

**Author:** Terra
**Date:** 2026-04-16
**Scope:** §5 (Maintenance), §7 (wiki.db / search), §8 (V1 integration) — plus adjacent cost and retrieval concerns

---

## TL;DR

The spec is solid on vision and storage. It's thin on the loop that actually keeps the wiki *coherent* over time. My critique focuses on four things:

1. **The standing prompt → in-band queue rewrite is good, but the worker is under-specified.** The hard problems live in the worker, and right now they're hand-waved.
2. **The dream cron does too much and not enough.** Too much Sonnet work on a fixed cadence; not enough observability into whether the wiki is actually getting better.
3. **Retrieval is a two-stage search but the cheap stage is missing.** BM25 + vector is good for ranking; neither catches the cases where a `[[wikilink]]` *is* the best retrieval signal.
4. **Cost is misestimated low.** The §10 number doesn't include embedding refresh, context bloat in the worker prompts, or the real tail when Sonnet has to read 5 linked pages to resolve a contradiction.

Then some concrete ideas to hit the "low-cost, keep it fresh" dream without dying on details.

---

## 1. What's working well in the spec

- **Three-mode isolation (v1 / v2-shadow / v2)** with one-way V1→V2 reads is the right call. Clean rollback, no migration tax.
- **In-band `plumb_wiki_queue_edit` + async worker** (§5.1) — this is a real improvement over a background standing-prompt poller. Terra already knows what she learned; explicit is better than inferred.
- **Archive-not-delete + git + REVIEW.md** for high-sensitivity changes — correct posture. You cannot trust an LLM with `rm` on your life OS.
- **Mode isolation** lets you flip back to V1 in 5 seconds. That's the feature that makes shipping this even survivable.
- **SCHEMA.md as constitution** — having a single authoritative rulebook the worker reads every run is cheap and very powerful. Keep it.

The bones are right. The meat is where the spec needs work.

---

## 2. Critique — Maintenance (§5)

### 2.1 The async worker is the actual product and it's under-specified

The spec says (paraphrased): "queue a fact → worker figures out affected pages → Sonnet writes prose → commit." That hides every hard problem:

- **Which pages does a fact affect?** "Jordan mentioned his team has 30 engineers" touches `people/jordan-lee.md`, `companies/northwind.md`, and possibly `interviews/northwind-loop.md`. The spec says the worker "reads `index.md` + relevant frontmatter" but that's too vague to implement without thrashing.
- **How do you prevent the worker from rewriting a 900-word page just to update one sentence?** Without a diff/patch discipline, Sonnet will happily rephrase the whole page every time and destroy stylistic continuity.
- **How do you prevent the worker from re-introducing a fact Alex just manually deleted?** If Alex removes a paragraph via Obsidian and two hours later the queue re-adds a fact that implies that paragraph should exist, the worker will resurrect it. That's a *correctness regression loop*.
- **What's the failure mode?** No dead-letter queue, no retry policy, no backpressure if Alex is in a very talky session.

#### Recommendations

1. **Affected-page resolution must be a cheap first-class step.** Run it as a Haiku call with a tiny prompt: `{fact, list of all page titles + one-line summaries}` → returns page paths. Budget this step ~150 input / 50 output tokens. $0.00005 per fact is fine. Don't hand this to Sonnet.
2. **The worker must produce a structured patch, not rewritten prose.** Think `{action: "append_section" | "update_line" | "replace_paragraph", page, anchor, text}`. A thin deterministic applier turns patches into file edits. This gives you:
   - Reviewable diffs (git already does this; structured patches make it reversible per-fact).
   - A cheap way to dedupe edits (hash the patch, skip if already applied).
   - The ability to roll back one fact without reverting a whole commit.
3. **Anti-regression log.** Any paragraph removed by Alex (detected by git + `manual commit`) writes a tombstone to `wiki.db` that the worker must consult before re-adding similar text. Simple: hash the removed sentence, store the hash + "do not re-add before YYYY-MM-DD" for 30 days.
4. **Dead-letter queue and retry.** If the worker fails 3x on a queue item, park it in `wiki/queue-dead.jsonl` and surface it to Alex in the daily lint report. Do not silently drop.
5. **Rate limit & backpressure.** Cap the worker at N edits/hour. Excess items coalesce: N facts about the same page get merged into one worker invocation. This also cuts cost dramatically.

### 2.2 The dream cron does too much

Current §5.2 has the dream cron doing: scan → write → refactor → lint → commit. That's four Sonnet-level tasks back-to-back on a nightly cadence, and the estimated cost ($0.08–0.22) is optimistic once you include prompt overhead (SCHEMA.md + index.md + affected pages, multiplied across phases).

More importantly: **if the in-band queue is doing its job, dream should be doing almost nothing.** Dream's role should narrow to:

- **Catch missed items.** Haiku reads yesterday's chat logs, cross-references against `log.md`, flags facts that the queue missed. (This is the only phase that needs to touch raw chat logs.)
- **Refactoring (size limits).** This is fine nightly.
- **Link graph integrity.** Rebuild `wiki_links` from source of truth (the markdown files themselves). This should be deterministic parsing, not LLM work.
- **Lint report.** Orphans, stale pages, broken links. All deterministic.

Stop doing Sonnet-level content writes in the dream cron. If the queue missed a fact, queue it during dream and let the normal worker handle it the next hour. This:

- Separates "catch up" from "write," giving you the same cost shape every day regardless of how much was queued vs missed.
- Makes dream cheap and predictable (~$0.02–0.05/night).
- Means a failed dream run doesn't block content writes.

### 2.3 Refactoring (size limits) is brittle

§5.2.4 says "if a page exceeds 1000 words, Sonnet identifies the most distinct sub-topic and creates a child page." In practice this will:

- Produce weird splits (the biggest section isn't always the right split; the *most-linked* section often is).
- Break inbound wikilinks if the split changes the parent page's identity.
- Thrash — a page that hovers around 1000 words will get split, then merged (by new facts accreting), then re-split.

#### Recommendations

- Use **hysteresis**: split at 1200 words, merge-back eligible only below 600 words. Add a cooldown (don't split the same page twice in 7 days).
- **Split by H2 section, not by "most distinct sub-topic."** Every page type's standard sections (§5 of SCHEMA) are natural split points. Sonnet's job becomes "pick which H2 to externalize," a 50-token decision.
- **Never split without a named target.** The child page needs a deterministic name derivable from `{parent}-{section}`, otherwise links churn.

### 2.4 Contradiction handling needs a third bucket

§5.4 has auto-resolve and high-sensitivity-with-flag. Missing: **soft contradictions that should trigger a question, not a write.**

Example: Plumb V1 fact says Jordan joined Northwind "~4 months before March 2026." A new chat says "Jordan told me today he joined in Q4 2025." These are consistent, but a bad worker will rephrase the existing text three times across three edits, producing drift.

Recommendation: add a **"no-op if consistent"** check. Before writing, the worker asks Haiku: `{existing_section, new_fact}` → "is the new fact already represented?" If yes, do nothing, log "noop: consistent." Costs $0.00003, saves churn and commits.

### 2.5 Manual edit detection is a hand-wave

§12 open questions #5 asks this. It's not optional — if Alex edits in Obsidian and the wiki.db doesn't know, your search silently serves stale content.

Solution is cheap:
- **Watch via fs events (inotify / chokidar).** On file write, enqueue a re-embed job. Debounce 30s.
- **Git hook fallback.** `post-commit` hook re-embeds changed files. Runs regardless of who made the commit (Alex via Obsidian, the worker via queue, or Terra manually).
- `content_hash` in `wiki_pages` is already in the schema — use it. Any search that notices a hash mismatch re-embeds on the fly (§7.1 says this, but only for search path; it needs to cover injection too).

---

## 3. Critique — Retrieval (§4 + §7)

### 3.1 The cheap stage is missing

Vector + BM25 + RRF is great for open queries ("what do I know about Northwind's AI org?"). It's overkill for closed queries ("what's Jordan's title?"). And it misses the *best* retrieval signal you have: **the wikilink graph**.

If an injection decides "this conversation is about the Northwind interview," the cheapest, highest-precision retrieval is:
1. Find the anchor page (interviews/northwind-loop.md).
2. Read it + its 1-hop neighbors in the link graph.
3. Stop.

No embedding, no search, no LLM call. That's the graph-traversal case Karpathy describes, and §4.3 mentions it but doesn't elevate it. It should be the *first* retrieval step when the anchor is obvious.

#### Recommendations

1. **Entity-anchor detection as a cheap first pass.** A regex/string-match step tries to resolve "Jordan," "Northwind," "Plumb V2," etc. to wiki page paths using a pre-built alias map. If it hits, graph-walk from there.
2. **Alias map.** Every page gets aliases in frontmatter (`aliases: [Jordan, Jordan S., Lee]`). The audit already showed you're using these. Persist them in `wiki.db` and match with a trie/FTS.
3. **Fallback to vector+BM25 when anchors don't resolve.** Same as today.
4. **Inject graph neighborhoods, not just top-K pages.** When a page hits, include (a) its summary, (b) its direct outbound links' summaries (not full content). This turns injection into a budget-aware subgraph traversal rather than a pile of unrelated chunks.

This is how you get the retrieval quality of a big context window at a fraction of the token cost.

### 3.2 The injection budget is undefined

The `[PLUMB WIKI]` example in §4.1 has 3 items and ~150 tokens. In practice the worker will pick a K and a token budget with no governance, and you'll end up either under-injecting (missing relevant context) or over-injecting (defeating the whole point of Plumb V1).

Recommendation: codify an injection budget (e.g. "≤800 tokens, ≤5 pages, always include neighbors of exact-match anchors"). Put it in SCHEMA.md so the injection step and the evals share one definition.

### 3.3 BM25 over chunks is a gotcha

The spec says BM25 over `wiki_chunks.chunk_text`. Without chunk boundaries that respect markdown structure (H2 sections, not arbitrary 400-token windows), BM25 will mis-rank. Term frequency in a chunk that straddles two sections is noise.

Recommendation: chunk on H2 boundaries first, sub-chunk only when an H2 section exceeds ~300 tokens. Store `section` as a chunk field — it's useful for both snippets and for the "read full section, not full page" retrieval optimization.

### 3.4 No reranker

For the price ($0.20/million tokens on a small cross-encoder), a reranker on the top-20 fused results before returning top-K would meaningfully improve precision. It's optional, but for a personal wiki where retrieval quality compounds, it's worth it. `Xenova/bge-reranker-base` is already on your stack (per audit); use it.

---

## 4. Critique — Cost (§10)

The $5–22/month estimate is too low in the realistic-usage case. What's missing:

- **Affected-page resolution.** ~50 Haiku calls/day minimum. ~$0.02/day.
- **Worker context bloat.** Sonnet edits a page → needs page + SCHEMA.md + index.md in context. That's ~3–5k tokens input, not the naive "just write a paragraph" assumption. At 15 edits/day: ~75k tokens input. ~$0.22/day on Sonnet-4 pricing. Already at spec's upper bound.
- **Embedding refresh on manual edits.** Free if local. Non-zero if remote.
- **Rerank.** ~$0.001/search, ~50 searches/day. ~$0.05/day.
- **Dream catch-up.** Chat logs (20 exchanges × ~2k tokens) in Haiku = ~$0.01/day.
- **The long tail.** Contradictions that require reading 3–5 linked pages to resolve. Each is a Sonnet call with 8–15k input tokens. A few per day in a busy period.

Realistic shape: **$0.40–$1.50/day**, or **$12–45/month**. Still cheap. But say it's cheap honestly — $10/month is not defensible once you look at the actual worker prompts.

#### Recommendations

- Add a per-day cost ceiling (e.g. $2/day) with automatic throttling.
- Log every LLM call (`wiki_changelog` is there; add `tokens_in`, `tokens_out`, `cost`).
- Weekly cost report in `log.md` — if a week cost $20, that's signal something is looping.

---

## 5. Critique — V1 Integration (§8)

§8.1 says "unified extraction" — `plumb_remember` writes to V1 and pushes onto V2 queue. Good. But the spec doesn't address:

- **user-level facts vs. wiki-level facts.** Not everything in V1 belongs in the wiki. A one-off debugging detail is a V1 fact, not a wiki update. The queue needs a filter *before* enqueueing, not inside the worker.
- **Confidence decay.** V1 has a confidence field. Wiki pages do too. But V1 facts decay; wiki pages don't. If a medium-confidence V1 fact decays to low, does the wiki paragraph that was derived from it change? Probably yes, but spec is silent.

Recommendations:
- **Shared `isWikiWorthy(fact)` predicate** based on SCHEMA.md §9. Runs on every `plumb_remember` call. If false, V1 only; no enqueue.
- **Back-propagation of confidence.** When a V1 fact that sourced a wiki paragraph decays, the wiki paragraph's `confidence` in the parent page is updated. This is cheap (just metadata); surface in injection ("last updated 60d ago, medium confidence").

---

## 6. Big Ideas (the "low-cost" dream)

These are the patterns that make this genuinely cheap + fresh, beyond fixing the holes above.

### 6.1 Tier the wiki by hotness

Not all pages need the same maintenance cadence:

- **Hot pages (accessed/updated in last 7 days):** live re-embed, in-band worker writes.
- **Warm pages (last 30 days):** nightly dream cron touch.
- **Cold pages (>30 days):** no maintenance unless explicitly referenced; included in injection only on direct match.

Add `last_accessed` to `wiki_pages`. Hotness tiers cut your worker runtime by ~70% because most pages are cold at any given moment.

### 6.2 The queue is the interface; everything else is swappable

Don't couple the in-band tool, the worker, and the writer. They should be three processes with one shared JSONL queue:

```
terra call → plumb_wiki_queue_edit → queue.jsonl → resolver → writer → git
```

This lets you:
- Run the resolver and writer in a different process or even a different machine.
- Swap Sonnet for a local model without changing the tool surface.
- Reprocess the queue if the writer produces bad output (replay mode).
- Test the resolver and writer in isolation.

### 6.3 Wiki-as-a-Service discipline

Everything that reads or writes the wiki goes through one narrow API:

```
wiki.read(path) / wiki.write(patch) / wiki.query(...) / wiki.links(path)
```

No direct `fs.writeFile` on `~/.plumb/wiki/*`. This gives you:
- Automatic re-embed on write.
- Automatic changelog entries.
- Automatic link-graph updates.
- A single place to enforce size limits, frontmatter validation, naming rules.

Right now the audit found 33 pages with broken frontmatter because writes are happening outside a single gate.

### 6.4 Quality evals, not just lint

§11 Success Criteria includes "spot-check 20 random pages." Good, but one-off. For ongoing:

- A **weekly eval** — take 10 recent chat queries, run them through v1 injection and v2 injection, Sonnet judges which gave better context. Write the score into `wiki/evals/YYYY-WW.md`. Budget: $0.10/week.
- Three concrete metrics: **precision@5** (are injected pages relevant?), **recall@20** (did we miss anything?), **staleness** (avg days since last update on injected pages).

This is how you know the wiki is getting better and not just bigger.

### 6.5 BM25 should be SQLite FTS5, not rebuilt

The spec says "BM25 keyword search across `wiki_chunks.chunk_text`." Don't build it. Use SQLite's FTS5 extension. You get BM25 for free and it's already integrated with the DB you have. `better-sqlite3` supports it. Rebuild cost: an hour, not a week.

### 6.6 Give Alex a `/wiki` command

A first-class command surface for manual operations:
- `/wiki open jordan` → opens the page in Obsidian.
- `/wiki search northwind interviews` → runs the hybrid search and shows results.
- `/wiki diff` → shows today's uncommitted changes.
- `/wiki review` → opens REVIEW.md.
- `/wiki why-this-page path` → shows source_refs + changelog for a page (debugging).

Most of this is 20 lines of shell. It turns the wiki from a black box into a tool.

### 6.7 Karpathy's trick: personal glossary

He keeps a flat list of terms-of-art at the top of his wiki. Do the same: `wiki/glossary.md` — a single page with definitions of every term unique to Alex's world ("T-XXX," "Dream cron," "VUFE," "icing detection story"). Inject it *always*. It's cheap (a few hundred tokens) and it's the single biggest quality win for new-session context.

### 6.8 Periodic full-wiki rebuild option

Once a quarter, Alex runs a "full re-seed" from V1 + current wiki + all memory/ logs. Sonnet rewrites every page from scratch. Cost: $3–10. Purpose: drift correction. Today's audit showed significant drift in 3 months of operation — you'll need this more than you think.

---

## 7. Specific Fixes to the Spec Doc

Concrete edits I'd make to `PLUMB_WIKI_SPEC.md`:

| Section | Change |
|---|---|
| §5.1 | Expand worker spec: resolver → structured patch → applier. Add dead-letter queue, rate limit. |
| §5.2 | Narrow dream cron to: catch-up (Haiku), link graph rebuild (deterministic), lint (deterministic). Remove Sonnet writes. |
| §5.2.4 | Rewrite chunking: hysteresis thresholds, H2-boundary splits, cooldown, deterministic child-page naming. |
| §5.4 | Add "consistent / noop" bucket with Haiku precheck. |
| §5.6 (new) | Manual edit detection: fs watcher + git post-commit hook + mtime/hash check on read. |
| §7 | Add `aliases`, `last_accessed`, `tier` columns to `wiki_pages`. Add tokens_in/out/cost to `wiki_changelog`. Use SQLite FTS5 for BM25. |
| §8.1 | Add `isWikiWorthy` filter before enqueue. Address confidence back-propagation. |
| §10 | Revise cost estimate to $12–45/month realistic. Add per-day ceiling + throttle. |
| §11 | Add ongoing weekly eval (precision@5, recall@20, staleness) with a cost budget. |
| §12 Q1 | Chat log access: use OpenClaw's `sessions_history` — it's already available. |
| §12 Q5 | Manual edits: fs watcher + content_hash, resolved as above. |

---

## 8. What I'd do first (if I had one week)

In priority order, what moves the needle most for the dream of "low-cost, always-fresh":

1. **Wiki-as-a-Service API + frontmatter validator.** Fix the 33 broken-frontmatter pages and make sure they never come back. One day.
2. **SQLite FTS5 for BM25 + content_hash-based auto re-embed.** Retrieval is actually correct. One day.
3. **Resolver → structured patch → applier pipeline** replacing the "Sonnet rewrites pages" loop. Two days.
4. **Glossary + anchor-detection first-pass retrieval.** Two days. This is the single biggest quality win per dollar.
5. **Weekly eval harness.** One day. You can't improve what you don't measure.

The dream cron, the refactoring step, the REVIEW.md polish — all that can wait. The first five items above are the difference between a wiki that works and a wiki that quietly rots.

---

*End of critique.*
