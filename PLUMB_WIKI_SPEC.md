# Plumb 2.0: Personal Wiki System

## Spec Document

**Author:** Clay Waters + Terra
**Date:** 2026-04-15
**Status:** Draft
**Version:** 0.1.0

---

## 1. Vision

Plumb 2.0 adds a persistent, LLM-maintained wiki layer to the existing Plumb memory system. The wiki is a structured, interlinked collection of markdown files that compounds over time, covering every domain of Clay's life. It sits alongside Plumb V1 (the fact store), not replacing it. Together, they form a three-mode retrieval system:

1. **Auto-injection** — relevant facts and wiki page pointers injected before each response
2. **Vector/semantic search** — active search mid-reasoning across wiki pages and facts
3. **Wiki traversal** — LLM follows links between .md files to navigate structured knowledge

The wiki is the **compiled knowledge layer**. Plumb V1 is the **raw memory layer**. The wiki synthesizes; Plumb V1 remembers.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Plumb 2.0                           │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  Plumb V1    │    │  Wiki Layer  │                   │
│  │  memory.db   │◄───│  ~/.plumb/   │                   │
│  │  (facts,     │read│  wiki/       │                   │
│  │   raw logs)  │only│  wiki.db     │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                           │
│         ▼                   ▼                           │
│  ┌──────────────────────────────────────┐               │
│  │         Injection Layer              │               │
│  │  (config flag: v1 | v2 | shadow)    │               │
│  └──────────────────────────────────────┘               │
│                                                         │
│  ┌──────────────────────────────────────┐               │
│  │         Maintenance Layer            │               │
│  │  Standing Prompt | Dream Cron        │               │
│  └──────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────┘
```

### 2.1 Storage Layout

```
~/.plumb/
├── memory.db              ← V1 (unchanged, untouched by V2)
├── wiki.db                ← V2 page embeddings + metadata index
├── config.json            ← mode flag: "v1" | "v2" | "v2-shadow"
└── wiki/
    ├── SCHEMA.md          ← wiki rules, conventions, structure definition
    ├── index.md           ← master catalog of all pages
    ├── log.md             ← append-only activity log
    ├── people/
    │   ├── _index.md      ← directory-level index
    │   ├── clay-waters.md
    │   ├── sandra.md
    │   ├── dylan-sellberg.md
    │   └── ...
    ├── companies/
    │   ├── _index.md
    │   ├── samsara.md
    │   ├── zapier.md
    │   ├── tapestry.md
    │   ├── power-takeoff.md
    │   ├── linevision.md
    │   └── ...
    ├── projects/
    │   ├── _index.md
    │   ├── plumb.md
    │   ├── terra.md
    │   ├── job-search.md
    │   └── ...
    ├── interviews/
    │   ├── _index.md
    │   ├── samsara-loop.md
    │   ├── zapier-skills.md
    │   ├── tapestry-riedl.md
    │   └── ...
    ├── concepts/
    │   ├── _index.md
    │   ├── pm-frameworks.md
    │   ├── ai-second-brain.md
    │   └── ...
    ├── stories/
    │   ├── _index.md
    │   ├── icing-detection-ui.md
    │   ├── nerc-cip-on-prem.md
    │   ├── power-takeoff-data-platform.md
    │   ├── data-quality-script.md
    │   └── ...
    ├── life/
    │   ├── _index.md
    │   ├── home.md
    │   ├── health.md
    │   ├── finances.md
    │   └── ...
    └── sources/
        └── (raw immutable inputs, if any)
```

### 2.2 File Format

Every wiki page uses YAML frontmatter + Obsidian-compatible markdown:

```markdown
---
type: person                          # person | company | project | interview | concept | story | life
created: 2026-04-15
updated: 2026-04-15
source_refs:
  - plumb:c457530e                    # Plumb fact IDs
  - memory/2026-03-27.md              # memory log files
  - chat:2026-03-23                   # chat session dates
tags: [samsara, interview, ai-platform]
confidence: high                      # high | medium | low
---
# Dylan Sellberg

Head of AI Platform at [[Samsara]]. Joined from [[HubSpot]].

## Role
Leads 30 engineers across two pillars...

## Interview Notes
Clay interviewed with Dylan on 2026-03-23. See [[Samsara Loop Interview]].

## Key Quotes
- "I think of myself like a PM agent, like a sports agent. How do I get my PMs paid."
- On fun: "At HubSpot, building products is solving for everyone — boiling the ocean. At Samsara, you deliver a more powerful product."

## What He's Looking For
- Adaptability
- Ability to handle pressure
- Curiosity for hardware and firmware
- Embrace enterprise requirements

## Related
- [[Samsara]]
- [[Samsara Loop Interview]]
- [[Dan Gardner]]
```

### 2.3 Special Files

**`SCHEMA.md`** — The wiki's constitution. Defines:
- Page types and their expected structure
- Naming conventions (kebab-case filenames, Title Case headings)
- Link conventions (Obsidian wikilinks: `[[Page Name]]`)
- What belongs in the wiki vs. what stays in Plumb V1
- Frontmatter field definitions
- Rules for the dream cron and standing prompt

**`index.md`** — Master catalog. Every page listed with:
- Link
- One-line summary
- Type tag
- Last updated date
- Organized by directory/category

**`log.md`** — Append-only activity log:
```markdown
## 2026-04-15

### Dream Session (02:00 MT)
- Created: people/dylan-sellberg.md (from Plumb facts + chat 2026-03-23)
- Updated: companies/samsara.md — added AI platform team structure
- Updated: index.md — 3 new entries
- Contradiction resolved: interviews/samsara-loop.md — updated panel debrief date from April 6 to April 7

### Standing Prompt (14:32 MT)
- Updated: projects/plumb.md — added wiki system design session notes
- Created: concepts/ai-second-brain.md — from Karpathy wiki discussion
```

**`_index.md`** (per directory) — Local directory index for faster navigation within a category.

---

## 3. Isolation Model

### 3.1 Mode Configuration

`~/.plumb/config.json` gains a `wikiMode` field:

```json
{
  "wikiMode": "v2-shadow",
  "extractionEnabled": false,
  "llmProvider": "anthropic",
  ...
}
```

| Mode | V1 Injection | V2 Injection | Wiki Writes | V1 Writes |
|---|---|---|---|---|
| `v1` | ✅ Active | ❌ Off | ❌ Off | ✅ Active |
| `v2-shadow` | ✅ Active | ❌ Off | ✅ Building | ✅ Active |
| `v2` | ❌ Off | ✅ Active | ✅ Active | ✅ Active (raw log only) |

### 3.2 Data Flow Isolation

```
V1 memory.db ──read-only──► V2 wiki/ + wiki.db
                             │
                             ▼
                        Wiki pages
                             │
                             ▼ (v2 mode only)
                        Injection layer
```

- V2 **reads from** V1 data (one-way, during seeding and dreaming)
- V1 **never reads from** V2
- They write to completely separate storage
- Switching modes is a config flag change, no data migration needed
- V1's data is never modified by V2

### 3.3 Switching Between Modes

- `v1` → `v2-shadow`: Wiki starts building. No user-facing change.
- `v2-shadow` → `v2`: Injection switches to wiki-based. V1 stops injecting.
- `v2` → `v1`: Instant rollback. Wiki sits idle. V1 resumes injecting.
- Any transition: zero data loss, zero migration required.

---

## 4. Retrieval (V2 Mode)

When `wikiMode: "v2"`, the injection layer changes:

### 4.1 Auto-Injection (before each response)

1. Query `wiki.db` with embedded user message (vector similarity search)
2. Return top-K relevant wiki page summaries + paths
3. Inject as `[PLUMB WIKI]` block:

```
[PLUMB WIKI]
## Relevant wiki pages
[HIGH] people/dylan-sellberg.md — Head of AI Platform at Samsara, interviewed 2026-03-23
[HIGH] interviews/samsara-loop.md — Loop interview intel, formats, focus areas by interviewer
[MED] companies/samsara.md — AI platform team, 30 engineers, Agent Studio

## Key facts
- Dylan looking for: adaptability, hardware curiosity, enterprise mindset
- Loop panel debriefs Monday April 7
- → Read full pages with plumb_wiki_read

## Tools available
- plumb_wiki_read(path) — read a wiki page
- plumb_wiki_search(query) — semantic search across wiki
- plumb_wiki_list(directory?) — list pages/structure
- plumb_wiki_links(path) — get inbound/outbound links for a page
[/PLUMB WIKI]
```

### 4.2 Active Search (mid-reasoning)

Tools exposed to the LLM:

| Tool | Description |
|---|---|
| `plumb_wiki_read(path)` | Read a specific wiki page by path |
| `plumb_wiki_search(query)` | Vector + keyword search across all wiki pages, returns ranked results with snippets |
| `plumb_wiki_list(directory?)` | List pages and subdirectories, optionally scoped to a directory |
| `plumb_wiki_links(path)` | Return all pages that link to/from a given page (graph traversal) |
| `plumb_remember(fact)` | Still works — writes to V1 fact store (raw memory) |
| `plumb_search(query)` | Still works — searches V1 fact store |

### 4.3 Wiki Traversal Pattern

The LLM can navigate the wiki by:
1. Reading `index.md` to find relevant pages
2. Reading a page, following `[[wikilinks]]` to related pages
3. Using `plumb_wiki_links(path)` to discover pages that reference the current page
4. Using `plumb_wiki_search(query)` when the link graph doesn't surface what's needed

This gives three distinct retrieval modes that complement each other:
- **Injection** catches the obvious context
- **Search** finds things by meaning
- **Traversal** discovers adjacent knowledge the query didn't directly ask about

---

## 5. Maintenance

### 5.1 In-Band Extraction & Async Queue (Replaces Standing Prompt)

**Trigger:** During conversations, explicitly called by the LLM via tool.

**Behavior:**
1. **In-Band Tool Call:** When Terra learns a durable fact during a conversation, she explicitly calls a tool (e.g., `plumb_wiki_queue_edit(fact)`). This eliminates the need for a background LLM to poll every message.
2. **Instant Response:** The tool instantly returns "Edit queued", allowing Terra to reply to Clay with zero latency.
3. **Async Worker (Background):** A separate background worker reads the queue.
   - It determines which wiki pages are affected (reads `index.md` + relevant frontmatter).
   - Generates a structured changeset.
   - A Sonnet worker receives the changeset + existing page content, writes the actual prose, and saves the file.
   - Git commit (auto, message: `"wiki: <summary>"`).
4. **Concurrency:** The queue processes edits sequentially, eliminating race conditions and Git lock errors if multiple facts are queued rapidly.

**Cost estimate:** $0.00 for scanning (handled naturally in-band by the chat model). $0.00-$0.05 per actual edit.

### 5.2 Dream Cron (Nightly Batch)

**Schedule:** 2:00 AM MT daily

**Behavior:**
1. **Gather inputs:**
   - Read today's chat logs from OpenClaw session storage
   - Read today's Plumb V1 facts (newly created today)
   - Read today's `log.md` entries (what standing prompt already handled)
2. **Haiku scan phase** (~$0.02-0.05):
   - Process all chat logs for the day
   - Extract wiki-relevant facts that the standing prompt may have missed
   - Cross-reference against existing wiki pages for contradictions
   - Identify new entities (people, companies, concepts) that deserve their own page
   - Generate a changeset
3. **Sonnet write phase** (~$0.05-0.15):
   - Create new pages
   - Update existing pages with new information
   - Resolve contradictions (see §5.4)
   - Update cross-references and wikilinks
   - Rebuild `index.md` if new pages were created
   - Update directory `_index.md` files
4. **Refactoring & Chunking Phase** (Sonnet, ~$0.05):
   - **Size Limits:** Enforces a maximum page size (e.g., 1000 words or ~100 lines).
   - If a page exceeds the limit, Sonnet identifies the most distinct/largest sub-topic within the document.
   - Creates a new child page for that sub-topic.
   - Replaces the extracted section in the parent page with a brief summary and a `[[wikilink]]` to the new child page.
   - Updates global inbound/outbound links as necessary to maintain graph integrity.
5. **Lint phase** (Haiku, ~$0.01):
   - Orphan pages (no inbound links)
   - Stale pages (not updated in 30+ days, referenced today)
   - Missing pages (wikilinks that point to non-existent pages)
   - Frontmatter inconsistencies
   - Report appended to `log.md`
6. **Commit:**
   - `git add -A && git commit -m "dream: YYYY-MM-DD — <summary>"`
   - Push to GitHub backup (nightly cloud backup)

**Estimated nightly cost:** $0.08-0.22, depending on conversation volume.

### 5.3 Standing Prompt Classification Rules

The standing prompt uses these rules to decide what's wiki-worthy:

**Always wiki-worthy (create or update):**
- New person mentioned with context (name + role + relationship)
- New company or organization with context
- Life fact changes (address, job, relationship, health status)
- Decisions made with reasoning
- Interview intel (people, format, questions, feedback)
- Project milestones or architecture decisions
- Research findings or synthesized learnings
- Preferences that affect future behavior
- Stories practiced or refined (interview prep)

**Never wiki-worthy (V1 fact store only):**
- Emotional states or mood
- One-time scheduling ("meet at 3pm")
- Transient debugging details
- Tool configuration minutiae
- Greetings, small talk, acknowledgments

**Judgment call (standing prompt decides, dream cron reviews):**
- Technical details about ongoing projects (wiki if architectural, skip if bug-fix-level)
- Conversation topics that might recur
- Partial information about new entities

### 5.4 Contradiction Handling

When V2 detects a contradiction between the wiki and new information:

**Auto-resolve (update immediately, log the change):**
- Project status changes
- Tool/config version updates
- Interview schedule changes
- Preference updates
- Any fact where the new information is clearly more recent and authoritative

**High-Sensitivity Changes (Auto-Resolve + Inbox Flag):**
- Home address, Job/employment status, Relationship status, Financial information, Health information.
- The system **never** blocks on user confirmation synchronously or at night.
- Instead, it applies the update based on the newest context, but logs the change directly into a `~/.plumb/wiki/REVIEW.md` (or `INBOX.md`) file.
- Clay can review this file at his leisure. If the AI hallucinated or updated something incorrectly, he can manually correct it or ask Terra to revert it.

All contradiction resolutions are logged in `log.md` with the old value, new value, and resolution method (auto-resolved).

### 5.5 Deletions and Archiving

**Never use `rm` to permanently delete a wiki file.**

1. **Page-Level Deletions (The Archive Folder):** If the Dream Cron or Async Queue determines a page is completely invalid, superseded, or hallucinated, it moves the file to the `archive/` folder (`~/.plumb/wiki/archive/`) and prepends `status: archived` to the YAML frontmatter. It must then update any inbound `[[wikilinks]]` in other files to remove the link or point elsewhere. This keeps the Obsidian workspace clean and prevents the page from showing up in search results, but ensures no catastrophic data loss occurs from a rogue AI hallucination.
2. **Intra-Page Deletions (Text Removal):** If the system is deleting a paragraph or section within a page because it's outdated, it simply relies on Git. The AI deletes the text, saves the file, and the Git commit captures the diff. If it makes a mistake, it's easily recoverable via standard version control, and `log.md` will note exactly what was removed.

---

## 6. Seeding (Big Bang)

### 6.1 Seed Sources

| Source | Location | Content Type | Estimated Size |
|---|---|---|---|
| Plumb V1 facts | `~/.plumb/memory.db` | Extracted facts | ~6,500+ facts |
| Memory daily logs | `~/.openclaw/workspace/memory/` | Session summaries | ~15-20 files |
| People directory | `~/.openclaw/workspace/people/` | Person profiles | ~5-10 files |
| Job hunt files | `~/.openclaw/workspace/job-hunt/` | Job search data | ~10-15 files |
| Interview prep docs | Various workspace locations | Prep notes, grades | Scattered |

### 6.2 Seed Process

**Phase 1: Entity extraction (Haiku, ~$0.30-0.50)**
1. Feed all Plumb V1 facts to Haiku in batches (100 facts per batch)
2. Haiku extracts and deduplicates entities: people, companies, projects, concepts, stories, life facts
3. Output: entity registry (JSON) with entity name, type, and source fact IDs

**Phase 2: Page generation (Sonnet, ~$1.00-2.00)**
1. For each entity, gather all related facts + memory log excerpts
2. Sonnet generates the wiki page with proper frontmatter, wikilinks, and structure
3. Pages are written to disk in the correct directory

**Phase 3: Index and cross-reference (Haiku, ~$0.10)**
1. Build `index.md` from all generated pages
2. Build directory `_index.md` files
3. Validate all wikilinks resolve to existing pages
4. Generate initial `log.md` entry documenting the seed

**Phase 4: Embed (local, ~free)**
1. Embed all wiki pages into `wiki.db` using the same embedding model as V1
2. Store: page path, chunk text, embedding vector, frontmatter metadata

**Estimated total seed cost:** $1.50-3.00

### 6.3 Seed Quality Check

After seeding, run a manual review:
1. Browse `index.md` — does it look comprehensive?
2. Spot-check 5-10 pages — are facts accurate? Are wikilinks working?
3. Run the lint phase — any orphans, missing pages, broken links?
4. Compare a few wiki pages against source Plumb facts — did anything get lost or hallucinated?

Clay reviews before switching to `v2-shadow` mode.

---

## 7. Wiki DB (wiki.db)

Separate SQLite database for wiki page embeddings and metadata:

```sql
CREATE TABLE wiki_pages (
  path TEXT PRIMARY KEY,              -- "people/dylan-sellberg.md"
  title TEXT NOT NULL,                -- "Dylan Sellberg"
  type TEXT NOT NULL,                 -- "person", "company", etc.
  summary TEXT,                       -- one-line summary for injection
  tags TEXT,                          -- JSON array
  confidence TEXT DEFAULT 'high',     -- "high", "medium", "low"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT NOT NULL          -- for change detection
);

CREATE TABLE wiki_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_path TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,       -- position within page
  embedding BLOB,                     -- vector embedding
  FOREIGN KEY (page_path) REFERENCES wiki_pages(path)
);

CREATE TABLE wiki_links (
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  link_text TEXT,                      -- display text of the wikilink
  PRIMARY KEY (source_path, target_path),
  FOREIGN KEY (source_path) REFERENCES wiki_pages(path)
);

CREATE TABLE wiki_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  page_path TEXT NOT NULL,
  action TEXT NOT NULL,               -- "create", "update", "delete", "contradiction"
  summary TEXT NOT NULL,
  old_value TEXT,                     -- for contradictions
  new_value TEXT,                     -- for contradictions
  resolution TEXT,                    -- "auto" or "prompted"
  source TEXT NOT NULL                -- "standing", "dream", "manual", "seed"
);
```

### 7.1 Search Pipeline & State Synchronization

Before `plumb_wiki_search(query)` executes:
1. **Hash Check:** The system briefly checks the file modification time (`mtime`) or hash of the files against `wiki_pages.content_hash`.
2. **Auto-Re-embed:** If Clay manually edited a file in Obsidian, the hash will mismatch. The system automatically re-embeds that specific file before proceeding, ensuring the vector index is always perfectly synced with the filesystem.

`plumb_wiki_search(query)`:
1. Embed the query
2. Vector similarity search across `wiki_chunks.embedding`
3. BM25 keyword search across `wiki_chunks.chunk_text`
4. RRF (Reciprocal Rank Fusion) to merge results
5. Return: `[{path, title, type, snippet, score}]`

### 7.2 Link Graph Queries

`plumb_wiki_links(path)`:
1. Query `wiki_links` for `source_path = path` (outbound links)
2. Query `wiki_links` for `target_path = path` (inbound links)
3. Return: `{outbound: [{path, title}], inbound: [{path, title}]}`

---

## 8. Integration with Plumb V1

### 8.1 Shadow Mode (v2-shadow)

- V1 injection continues as-is
- No wiki content surfaces in conversations
- **Unified Extraction (Cost Efficiency):** To avoid paying for two separate LLM extractions (one for V1, one for V2), the system uses a single extraction step. When Terra calls `plumb_remember(fact)`, that *exact same fact* is both written to V1's `memory.db` and pushed onto the V2 Async Queue. The V2 background worker picks it up and integrates it into the wiki. This means zero cost duplication during the shadow period.
- Wiki pages embed into `wiki.db`
- Purpose: build and validate the wiki before switching injection

### 8.2 V2 Mode

- V1 injection turns off
- Wiki injection turns on (`[PLUMB WIKI]` block)
- V1 raw log continues recording (conversations are still logged)
- V1 fact extraction can be disabled (wiki is the synthesis layer now)
- `plumb_remember` still writes to V1 (quick facts during conversation)
- Dream cron reads V1 facts + chat logs to update wiki

### 8.3 Plumb V1 Re-indexing from Wiki (Future)

When V2 is stable and wiki quality is validated:
- Plumb V1's fact injection can be replaced entirely by wiki page summaries
- V1 becomes pure storage (raw log + quick facts), wiki becomes the retrieval layer
- `plumb_search` could search wiki.db instead of (or in addition to) memory.db
- This is a future optimization, not required for V2 launch

---

## 9. Implementation Plan

### Phase 1: Foundation (Week 1)
- [ ] Create `~/.plumb/wiki/` directory structure
- [ ] Write `SCHEMA.md` (wiki constitution)
- [ ] Create `wiki.db` schema
- [ ] Implement basic file operations (read, write, list pages)
- [ ] Implement wikilink parser (extract `[[links]]` from markdown)
- [ ] Implement `wiki_links` table population on page write

### Phase 2: Seeding (Week 1-2)
- [ ] Build seed script: entity extraction (Haiku) + page generation (Sonnet)
- [ ] Run seed against Plumb V1 facts + memory/ files
- [ ] Clay review of seed output
- [ ] Build `index.md` and `_index.md` files
- [ ] Embed all pages into `wiki.db`

### Phase 3: Dream Cron (Week 2)
- [ ] Build dream cron job (OpenClaw cron, 2:00 AM MT)
- [ ] Implement Haiku scan phase (chat log processing)
- [ ] Implement Sonnet write phase (page creation/update)
- [ ] Implement lint phase
- [ ] Implement git auto-commit + push
- [ ] Test dream cron for 3-5 days in shadow mode

### Phase 4: Standing Prompt (Week 2-3)
- [ ] Implement background async wiki update after exchanges
- [ ] Implement Haiku classification (durable vs. ephemeral)
- [ ] Implement Sonnet page writer
- [ ] Implement contradiction detection
- [ ] Test standing prompt for 3-5 days in shadow mode

### Phase 5: Retrieval (Week 3)
- [ ] Implement wiki search pipeline (vector + BM25 + RRF)
- [ ] Implement `plumb_wiki_read`, `plumb_wiki_search`, `plumb_wiki_list`, `plumb_wiki_links` tools
- [ ] Implement `[PLUMB WIKI]` injection block
- [ ] Implement mode switching (v1/v2/v2-shadow config flag)

### Phase 6: Shadow Validation (Week 3-4)
- [ ] Run in v2-shadow mode for 1-2 weeks
- [ ] Compare wiki retrieval quality against V1 injection (manual evaluation)
- [ ] Fix wiki quality issues discovered during shadow period
- [ ] Clay decision: switch to v2 or continue shadow

### Phase 7: V2 Go-Live
- [ ] Switch to v2 mode
- [ ] Monitor for 1 week
- [ ] Iterate on injection format, search quality, maintenance prompts

---

## 10. Cost Estimates

### One-Time

| Item | Cost |
|---|---|
| Seeding (entity extraction + page generation) | $1.50-3.00 |

### Ongoing (Daily)

| Item | Cost |
|---|---|
| Dream cron (nightly) | $0.08-0.22 |
| Standing prompt (per-exchange, avg) | $0.005-0.05 |
| Standing prompt (daily, ~20 exchanges) | $0.10-0.50 |
| **Daily total** | **$0.18-0.72** |
| **Monthly total** | **$5.40-21.60** |

### Comparison to Current

Plumb V1 (embed-only mode): effectively $0/day (local embeddings, no LLM calls)
Plumb V2 adds: $5-22/month for wiki maintenance

---

## 11. Success Criteria

Before switching from v2-shadow to v2:

1. **Coverage:** Wiki has pages for all major entities Clay has discussed (people, companies, projects, interviews)
2. **Accuracy:** Spot-check of 20 random pages shows <5% factual errors
3. **Freshness:** Dream cron successfully updates wiki for 5+ consecutive days
4. **Retrieval quality:** For 10 test queries, wiki injection provides equal or better context than V1 injection
5. **Browsability:** Clay can open `~/.plumb/wiki/` in Obsidian and navigate it usefully
6. **Rollback clean:** Switching back to v1 mode works instantly with no data loss

---

## 12. Open Questions

1. **Chat log access:** How does the dream cron access today's chat logs? OpenClaw session storage format needs investigation.
2. **Embedding model:** Use the same model as V1 (Xenova/all-MiniLM-L6-v2) or upgrade for wiki content?
3. **Page size limits:** Should wiki pages have a max length? Large pages (>5k tokens) may need chunking strategy.
4. **Multi-session standing prompt:** If Clay has conversations across terra-chat and Slack, do both trigger standing prompt updates?
5. **Manual edits:** When Clay edits a wiki page directly, how does the system detect and re-embed the change?
6. **Backup cadence:** Nightly git push to GitHub, or more frequent? Piggyback on existing 4x/day backup cron?

---

## 13. References

- Andrej Karpathy's LLM Wiki pattern: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Plumb V1 architecture: see `plumb/` monorepo and Google Docs (Business Plan, Product Roadmap, Technical Architecture)
- Current Plumb config: `~/.plumb/config.json`
- Plumb kanban: `~/.openclaw/workspace/state.json`
