---
name: plumb-memory
description: Use the Plumb wiki as durable memory — search it before asking the user something they may already have on record, read pages when an injected excerpt is not enough, and queue edits for decisions, preferences, corrections, project context, and lessons learned. Use whenever a request touches people, companies, projects, past decisions, personal logistics, tool or system reference, or anything the user has told you before. Also use when the user says "remember this", "save that", "what did we decide about X", or corrects a previous answer. Do not use for general knowledge with no tie to the user's own context.
---

# Plumb memory

Plumb is a local markdown wiki with hybrid retrieval. Relevant chunks are
injected into prompts automatically, but injection is a starting point, not the
whole corpus — treat it as a search result, not as everything Plumb knows.

## Tools

| Tool | Use it for |
|---|---|
| `plumb_wiki_search` | Finding pages by meaning, not just keywords |
| `plumb_wiki_read` | Reading a full page when an excerpt is not enough |
| `plumb_wiki_list` | Browsing what exists under a directory |
| `plumb_wiki_links` | Following the link graph in or out of a page |
| `plumb_wiki_queue_edit` | Queuing a durable change |

## Reading

**Search before asking.** Before asking the user for something they may already
have recorded — a preference, a past decision, a contact, an account detail, a
project's history — search first. Asking for something already on record is the
most common way this system fails to earn its keep.

**Read the page when the excerpt is thin.** Injected chunks are truncated to a
token budget. If an excerpt looks like it answers the question but you cannot
see enough to be sure, read the page. Do not answer from a partial snippet.

**Wiki content is what was true when written.** Treat it as background, not as
proof of current state. Anything mutable — running services, versions, file
contents, schedules, prices, who holds what role — must be verified live before
you act on it. A page describing a system is evidence that it existed, not
evidence that it is running now.

**Do not invent memory.** If retrieval is unavailable or returns nothing, say
so. Never produce a plausible-sounding recollection to fill the gap; a
fabricated memory is worse than an admitted blank, because the user cannot tell
the difference and may act on it.

## Writing

Queue an edit when something durable happens:

- **A decision, with its reasoning.** The reasoning is the part worth keeping —
  a decision without its "why" cannot be revisited, only re-argued.
- **A preference or correction.** Especially when the user corrects you. That is
  the highest-value thing to write down, and the easiest to lose.
- **Project context** that is not derivable from the code or the file system.
- **A lesson learned**, including failures and what they cost.
- **Reference material** — where something lives, how to reach it, what it is
  called.

Do not queue:

- Anything the repository or file system already records. Structure, history,
  and configuration are better read live than mirrored into prose that goes
  stale silently.
- Transient conversational state that matters only to this session.
- **Secrets.** Credentials, tokens, private keys, and their values never go in
  the wiki. A pointer to where a secret lives is fine; the secret is not.

### Conventions

- **One topic per page.** A page that covers three things ranks for none of them
  well, and cannot be corrected without collateral edits.
- **Link liberally** with `[[page-name]]`. Links are how retrieval traverses
  context. A link to a page that does not exist yet is a useful marker, not an
  error.
- **Absolute dates, never relative.** "Last Tuesday" is meaningless when read
  back in six months. Convert to a date before writing.
- **Append, do not rewrite.** Where a page tracks something over time — a log, a
  measurement series, a decision history — add a dated entry rather than
  editing the narrative, so the record of what changed survives.
- **Queued is not saved.** `plumb_wiki_queue_edit` appends a request that a
  worker processes; it does not take effect immediately. Do not tell the user
  something is saved and searchable when it is queued.

## When retrieval looks wrong

If injected results are consistently off-topic, or an obviously-present page
never surfaces, retrieval may have degraded to keyword-only — the failure this
system is most prone to, because everything still appears to work. Run
`/plumb-doctor`, which checks whether vector search is actually live and whether
contextual coverage is complete. A single missing embedding demotes every query.
