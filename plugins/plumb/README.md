# Plumb — durable memory for Claude Code

Plumb keeps what you decide and why in a local markdown wiki, indexes it with
hybrid vector + keyword retrieval, and puts the relevant pages in front of Claude
on every prompt. It runs entirely on your machine: no cloud, no account, no data
leaving the host.

## Install

```
/plugin marketplace add getplumb/plumb
/plugin install plumb
/plumb-setup
```

`/plumb-setup` installs the retrieval engine, builds the index, downloads the
embedding model, starts the service, and writes memory instructions into your
`CLAUDE.md`. It verifies each step and tells you if any of them half-succeeded.

**The wiki starts empty on purpose.** Every page should have known provenance
rather than inheriting facts you never asserted. Run `/plumb-migrate` afterwards
and Plumb will find memory you already have — `CLAUDE.md` files, memory stores,
transcripts — report what it found, and ask before importing any of it.

## Commands

| Command | What it does |
|---|---|
| `/plumb-setup` | Install, configure, verify. Idempotent; safe to re-run to repair. |
| `/plumb-doctor` | Diagnose only. Never changes anything. |
| `/plumb-migrate` | Seed the wiki from memory you already have, with a dry run. |
| `/plumb-uninstall` | Stop the service, unwind the wiring, give your memory back. |

## How it runs

One local service, shared by the prompt hook and the MCP tools. It starts on
demand when something needs it — about 0.8 s — and stops itself after fifteen
idle minutes, handing back roughly 300 MB. Warm queries take around 15 ms. You
do not have to supervise anything.

Set **Idle shutdown** to `0` in the plugin settings to keep it resident.

## Requirements

- Node 22.16 or newer (`node:sqlite` reads the index; it is flag-gated before 22.13 and has no FTS5 before 22.16)
- About 300 MB of disk, most of it the ONNX runtime that runs the embedding
  model locally
- No compiler and no build tools: there are no native dependencies

## Uninstalling

`/plumb-uninstall` stops the service, removes the wiring, and restores your
`CLAUDE.md`. It **never deletes your wiki.** Facts that came from somewhere else
are offered back to where they came from; facts created inside Plumb are exported
as portable markdown you keep. The corpus stays on disk, and the command tells
you where.

## Licence

Elastic License 2.0 — source-available. See `LICENSE` in the repository root.
