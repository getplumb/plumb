# Handoff: Wiki Boundary + Index Coverage Gate

**Written** 2026-08-12 by a Claude Code session on the user's host (Nukbox).
**Audience** the next agent implementing this. You need no prior context; everything is below.
**Scope** Plumb wiki (`~/.plumb/wiki`) and its index (`~/.plumb/wiki.db`). Not the AIEWF project.

---

## 1. What you are building

Two things, in this order:

1. **An index coverage gate** — a deterministic check that every wiki page which *should* be
   indexed *is* indexed, and that nothing which should be excluded is present. This is the
   higher priority. A three-day silent search outage happened today and nothing caught it.
2. **A raw-transcript boundary** — a supported way to keep verbatim transcripts inside the
   wiki tree while excluding them from the retrieval layer, linked from their summaries.

Do (1) before (2). (2) widens exactly the blind spot that caused today's incident, so the
gate must exist first or the new exclusions become indistinguishable from new bugs.

---

## 2. Background: the incident (2026-08-12)

the user noticed that a wiki page created that morning was not findable via `plumb_wiki_search`.
Investigation found it was never indexed at all — not a ranking problem.

**Scope of the outage:** `wiki_pages` held 301 rows against 326 pages on disk. Thirteen
content pages created between 2026-08-10 and 2026-08-12 had no index rows, including live
job-search material (`interviews/locusview-head-of-product.md`, `interviews/northwind-sdk-sam.md`,
`people/kevin-au.md`, `people/robin-vance.md`, `people/ben-glickman.md`) and seven project
pages. `max(updated)` in `wiki_pages` was 2026-08-08.

**Decisive test** (reuse this shape when you verify your own work): search for a string that
appears verbatim on the target page and nowhere else in the corpus. If the page does not come
back, it is an indexing problem, not a ranking problem. Here, the exact phrase
`"Tony Stark is not texting Jarvis"` returned Latchkey and Sam Okafor and never the page.

**Already remediated in that session** (you do not need to redo this):

- Ran `runWikiEmbed()` — 53 pages embedded, 0 errors, 961 chunks, 164s.
- Ran `backfillContextualEmbeddings()` — 184 chunks, 0 failed, `coverageRatio: 1`, 15s.
- Post-state: 314 indexed pages, 2297 chunks, 2297 contextual embeddings, gap 0. The failing
  query now returns the page at rank 1.
- Backup of the pre-fix index: `~/.plumb/wiki.db.bak-pre-reindex-20260812-173830`.

**Root cause — still unfixed, this is yours.** `~/.plumb/wiki/.git/hooks/post-commit` is a
*push-to-origin* hook installed 2026-04-24. It is **not** the re-index hook that
`packages/core/src/wiki-git-hook.ts` (`installWikiGitHook`) is designed to install. So
committing the wiki has never triggered re-indexing; that path is inert. Separately, the wiki
currently has ~90 uncommitted modified/untracked files, so even a correct hook would not have
fired for them. Whatever was indexing until 2026-08-08 stopped and nothing replaced it.

**Why nothing alarmed.** The `plumb-wiki-search-watchdog` cron runs every minute
(`jobs/src/jobs/plumb-wiki-search-watchdog.ts`) but is a *service liveness probe*: it checks
that the search service instances on port 18795 respond and restarts a wedged instance. It
never inspects index contents. The service was healthy and empty, so it stayed quiet.

---

## 3. The policy decision (the user's — authoritative, do not relitigate)

the user wants the wiki boundary treated seriously: deliberate about what enters the wiki.

- **Raw transcripts of things the user asks to be put in the wiki should live in the wiki tree**,
  in a folder that is **not indexed and not returned by wiki search**, and will typically be
  **linked from the summary** of that transcript.
- **Summaries are wiki content** — indexed, searchable, first-class.
- **AIEWF 2026 is an explicit exception.** Those are third-party conference transcripts, not
  the user's own material. They live at `~/aiewf-2026` and stay there. Only concepts and
  conclusions cross into the wiki. There is one project page (`projects/aiewf-2026-wiki.md`)
  and that is the correct amount. Do not import that corpus.

---

## 4. How exclusion works today

All in `packages/core/src/wiki-fs.ts` (repo root `~/.openclaw/workspace/plumb`):

| Thing | Location | Behavior |
|---|---|---|
| `listWikiPages()` | `wiki-fs.ts:326` | entry point the indexer enumerates from |
| `walk()` | `wiki-fs.ts:336` | recursive; the only directory exclusion |
| `archive/` skip | `wiki-fs.ts:353` | `if (!includeArchive && relEntry === 'archive') continue;` |
| `SKIP_FILENAMES` | `wiki-fs.ts:308` | `SCHEMA.md`, `index.md`, `log.md`, `REVIEW.md`, `_index.md` |
| `SKIP_PREFIXES` | `wiki-fs.ts:317` | `AUDIT_`, `EVAL_`, `REPORT_` |

Consumers: `runWikiEmbed()` at `packages/core/src/wiki-embedder.ts:466` (incremental — skips
pages whose `content_hash` is unchanged) and `backfillContextualEmbeddings()` at
`packages/core/src/wiki-contextual-embeddings.ts:259`.

**Both embedding passes are local.** `DEFAULT_CONTEXTUAL_MODEL = 'Xenova/bge-small-en-v1.5'`
(`wiki-contextual-embeddings.ts:6`). No API key, no network, no subscription cost. Keep it
that way — see guardrails.

**Two sharp edges you must design around:**

1. **Directory names are never tested against `SKIP_PREFIXES`; only filenames are.** So a
   folder named `_transcripts/` does *not* get skipped — `walk()` recurses into it and indexes
   `call.md` because that filename has no underscore. Underscore-prefixing a folder does
   nothing today.
2. **The indexer only adds and updates. It never prunes.** Adding an exclusion rule does not
   remove already-indexed rows. Live proof in the current DB: `AUDIT_2026-04-16.md` and
   `EVAL_2026-04-16.md` are both in `wiki_pages` and returned by search despite matching
   `SKIP_PREFIXES`, because they were indexed before that rule existed. There is also a ghost
   row, `projects/plumb-20-wiki-system.md`, whose file no longer exists on disk.

---

## 5. Work items

### WI-1 — Index coverage gate (do first)

A deterministic check, no model calls, that asserts:

- every page on disk that passes the exclusion rules has a row in `wiki_pages`
- every `wiki_pages` row has a file on disk (catches ghosts)
- no `wiki_pages` row violates the current exclusion rules (catches stale rows)
- `count(wiki_chunks) == count(wiki_chunk_context_embeddings)` (catches a half-indexed state
  where pages are findable but on a degraded ranking path)

**Critical design requirement:** the gate must be *exclusion-aware* — it reads the same
exclusion source of truth the indexer uses, so "excluded on purpose" and "missing by accident"
are never conflated. If it cannot distinguish those, it will go noisy and be ignored, which is
worse than no gate.

On failure it should be loud and specific (which pages, which class of failure). Consider
having it auto-remediate the additive case (run the embed pass for missing pages) but **not**
auto-delete rows — deletion should require a human or an explicit flag.

Wire it into the existing scheduled-jobs registry (`scripts/claude-cron/`), never a direct
crontab edit. It is cheap enough to run frequently. Do **not** bolt it onto
`plumb-wiki-search-watchdog` — that job has a single clear responsibility (service liveness)
and conflating the two makes both harder to reason about.

**Acceptance:** running the gate against the current DB passes. Then delete one page's rows
from `wiki_pages` by hand in a *copy* of the DB and confirm the gate fails with a useful
message naming that page.

### WI-2 — Repair the indexing trigger

Today's fix was manual. Decide and implement a durable trigger. Options, in rough order of
preference:

1. Have the coverage gate itself reindex what it finds missing (self-healing; makes WI-1 do
   double duty and removes the trigger as a separate failure point).
2. Repair the git hook path — `installWikiGitHook` composes with the existing push hook rather
   than overwriting it. Note this only helps if the wiki actually gets committed; there are
   ~90 uncommitted files right now, so this alone is insufficient.
3. A scheduled reindex independent of git.

Whatever you choose, the coverage gate is what proves it works. Do not ship a trigger without
the gate.

### WI-3 — Raw-transcript boundary

Implement the policy in §3. **Prefer a declarative exclusion** over a second hardcoded folder
name. Two candidate designs — pick one and justify it in your writeup:

- **`.plumbignore` at the wiki root** — gitignore-style patterns, read by `wiki-fs.ts` and by
  the coverage gate from the same parsed source. Handles directories properly.
- **Frontmatter flag** (`indexed: false`) — a transcript stays a legitimate wiki page with
  frontmatter and links, it just does not enter the retrieval layer. Nice property: the
  boundary travels with the file rather than with its location.

Either way, extend `walk()` so directory-level exclusion is a real concept, and make the same
rule source readable by the gate.

**Pruning is part of this work item.** Since the indexer never prunes, shipping an exclusion
without a prune pass means anything already indexed stays searchable. Include a one-time
cleanup for the three known stale rows (`AUDIT_2026-04-16.md`, `EVAL_2026-04-16.md`,
`projects/plumb-20-wiki-system.md`) and make pruning a normal part of the gate's remediation
path (behind an explicit flag, per WI-1).

**Linking convention:** summaries link to transcripts with **relative markdown links**, not
`[[wikilinks]]`. An unindexed target has no `wiki_pages` row, so a wikilink to it dangles in
`wiki_links` and reads as a broken link to lint. If you choose the frontmatter-flag design,
re-examine this — a flagged page may still legitimately hold a `wiki_pages` row, in which case
wikilinks are fine. State which you chose and why.

---

## 6. Verification requirements

Do not report success on any work item without:

- the coverage gate passing, with its actual output pasted
- a negative control — break something deliberately in a **copy** of the DB and show the gate
  catching it
- for anything touching retrieval, the verbatim-phrase test from §2 against a page you expect
  to be findable
- `count(wiki_chunks) == count(wiki_chunk_context_embeddings)` still holding

Back up `~/.plumb/wiki.db` before any write. Follow the existing convention:
`wiki.db.bak-<reason>-<YYYYMMDD-HHMMSS>`.

---

## 7. Guardrails

- **No Anthropic API key, ever.** All model calls on this host go through the user's subscription
  via `claude -p` or subagents. An unset `ANTHROPIC_API_KEY` is expected and is not a blocker.
  The embedding passes here are local (`Xenova/bge-small-en-v1.5`) and must stay local.
- **Never edit the crontab directly.** Use the registry tooling in `scripts/claude-cron/` so
  the job is registered, wrapped, and visible on the Scheduled Jobs dashboard.
- **The search service needs a rolling restart, never a hard stop.** Two SO_REUSEPORT
  instances share client port 18795, with admin/health ports 18801 and 18802. Verify over the
  tailnet URL rather than a localhost prefix.
- **Do not touch `the holdout corpus (path intentionally omitted)`** or any benchmark holdout/test split.
- **Do not import the AIEWF corpus** into the wiki (§3).
- Wiki writes normally go through the WaaS API (`packages/wiki/src/waas.ts`) rather than
  direct file writes. Respect that for any page content you create.

---

## 8. Open decisions — ask the user, do not decide these yourself

1. **Does the wiki git repo push raw transcripts to GitHub?** The wiki is git-backed and
   pushed to `claywaters13/plumb-wiki-backup`. Raw call transcripts would land there and
   inflate the repo. Options: gitignore the transcript folder, push to a private repo, or
   accept it. This is a privacy call, not a technical one.
2. **Obsidian still indexes excluded transcripts.** Obsidian searches the whole vault, so
   "unsearchable" would be true of Plumb but not of Obsidian. That is probably desirable —
   confirm rather than assume.
3. **Folder name and shape** — `transcripts/` at root, or per-type subfolders, or colocated
   with their summaries.
4. **Retention** — do transcripts expire once a summary exists, or persist indefinitely?

---

## 9. Reference commands

```bash
# Reindex (incremental, local, no API key)
cd /path/to/plumb
node -e "import('./packages/core/dist/index.js').then(async m => \
  console.log(await m.runWikiEmbed({ verbose: false })))"

# Contextual embedding backfill
node -e "import('./packages/core/dist/index.js').then(async m => { \
  const s = await m.WikiStore.create({ dbPath: process.env.HOME + '/.plumb/wiki.db' }); \
  console.log(await m.backfillContextualEmbeddings({ db: s.db })); })"

# Coverage snapshot (what the gate should formalize)
python3 - <<'PY'
import sqlite3, os, glob
db = sqlite3.connect('file:' + os.path.expanduser('~/.plumb/wiki.db') + '?mode=ro', uri=True)
idxd = {r[0] for r in db.execute('select path from wiki_pages')}
root = os.path.expanduser('~/.plumb/wiki')
disk = {os.path.relpath(p, root) for p in glob.glob(root + '/**/*.md', recursive=True)}
disk = {d for d in disk if not d.startswith(('archive/', 'clayswiki/'))}
print('indexed', len(idxd), 'disk', len(disk))
print('missing', sorted(disk - idxd))
print('ghosts', sorted(idxd - disk))
c = db.execute('select count(*) from wiki_chunks').fetchone()[0]
e = db.execute('select count(*) from wiki_chunk_context_embeddings').fetchone()[0]
print('chunks', c, 'contextual', e, 'gap', c - e)
PY
```

Relevant tables in `~/.plumb/wiki.db`: `wiki_pages`, `wiki_chunks`, `wiki_links`,
`wiki_changelog`, `wiki_fts*`, `wiki_aliases`, `wiki_chunk_context_embeddings`.

---

## 10. Related

- Wiki spec: `~/.openclaw/workspace/plumb/PLUMB_WIKI_SPEC.md`
- Plumb wiki page for this project context: `projects/aiewf-2026-wiki.md` (the incident's
  trigger, not its subject)
- Prior related incident: the Plumb contextual coverage outage of 2026-08-08, same family
  (search silently returning nothing relevant rather than failing loudly), fixed then by a
  contextual backfill. This is its second occurrence. Treat "returned results, all
  irrelevant" as a first-class alarm condition, not a soft signal.
