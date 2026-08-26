---
description: Install and configure Plumb — engine, index, service, and the memory instructions in CLAUDE.md
---

# Set up Plumb

Idempotent. Safe to re-run at any time, including to repair a partial install.

Two things are true at once here: almost all of this is deterministic and
belongs in the script, and the one part that is not — editing a file the user
wrote — is the part most likely to do harm. Keep that line sharp.

## 1. Install the engine

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/install.mjs --json
```

This checks the Node floor, installs the engine into the plugin's data
directory, creates the wiki root, builds the index, downloads the embedding
model, starts the service, and confirms hybrid retrieval is actually live. It
exits non-zero if any of that failed.

**Read the JSON. Do not infer success from the command having run.** If
`ok` is false, report the failing step's `detail` verbatim and stop — do not
proceed to CLAUDE.md, and do not describe Plumb as installed. In particular:

- A failing `index` step means retrieval would silently be keyword-only. That is
  a failed install, not a warning.
- A failing `vector search` step means the same thing, detected one layer later.
- A failing `node` step cannot be worked around. Say what version is needed.

## 2. Write the memory instructions into CLAUDE.md

A plugin cannot contribute `CLAUDE.md`, and the `plumb-memory` skill only loads
when a request looks relevant. The instruction to *save* things has to be always
on, so it belongs in the user's `CLAUDE.md` — usually `~/.claude/CLAUDE.md`.

**Back it up first**, to `~/.plumb/backups/CLAUDE.md.<ISO8601>`, and record the
path in `~/.plumb/install-manifest.json` under `claudeMdBackup`. Uninstall needs
it and cannot reconstruct it later.

Then insert this block, verbatim, between its markers. If the markers already
exist, replace what is between them rather than adding a second copy.

```markdown
<!-- plumb:begin -->
## Memory

Plumb is durable memory: a local markdown wiki with hybrid retrieval. Relevant
pages are injected into prompts automatically, and the `plumb-memory` skill
covers how to read and write it.

- Search Plumb before asking me for something I may already have on record — a
  preference, a past decision, a contact, an account detail, a project's
  history.
- Treat injected wiki content as background, not as proof of current state.
  Verify anything mutable — services, versions, file contents, schedules — live
  before acting on it.
- Queue a durable edit when a decision gets made, when I state a preference,
  when I correct you, and when something is learned worth keeping. Record the
  reasoning, not just the conclusion.
- Never put credentials, tokens, or private keys in the wiki. A pointer to where
  a secret lives is fine; the secret is not.
- Never invent a memory. If retrieval is unavailable or finds nothing, say so.
- A queued edit is not yet saved. Do not describe it as searchable until the
  worker has processed it.
<!-- plumb:end -->
```

### Handling conflicts — required, not optional

Before writing, read the whole file. If it already contains memory instructions
— a different memory system, a "remember this" convention, rules about what to
persist — **stop and show the user the specific conflicting lines.** Ask whether
to replace them, keep both, or skip the Plumb block entirely.

Two sets of memory instructions that disagree is worse than either alone: the
model will follow one, the user will expect the other, and nothing will look
broken. This is the single place in setup where guessing causes lasting damage,
so it is the one place that must ask.

If there is no conflict, insert the block and say where you put it.

## 3. Verify, and be specific about what you verified

Run `/plumb-doctor` and report its output. Then confirm each of these
individually, naming the evidence:

| Claim | Evidence |
|---|---|
| Engine installed | `install.mjs` step `install engine` ok |
| Retrieval is hybrid | doctor `retrieval` ok, not `DEGRADED` |
| Coverage complete | doctor `coverage` ratio 1 |
| Instructions in place | doctor `CLAUDE.md` ok |
| Injection works | a `[PLUMB WIKI]` block appears on the next prompt |

The last one cannot be confirmed from inside this command — the hook runs on the
*next* prompt. Say that plainly rather than claiming it works.

## 4. Offer to seed it

The wiki starts empty on purpose: every page should have known provenance. Tell
the user that, then offer `/plumb-migrate`, which finds memory they already have
and asks before importing any of it.
