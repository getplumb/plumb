# T-124: Inject one-time orientation block on first Plumb activation

**Status:** Ready  
**Priority:** Medium  
**Assigned to:** Claude Code  
**Phase:** Phase 2  

---

## Context

When a user installs Plumb into an existing OpenClaw workspace, they may have a heavily customized AGENTS.md with complex memory instructions already in place. Plumb should never touch that file automatically — any modification could silently break a carefully built setup.

Instead, on the very first `before_prompt_build` call after a fresh install, Plumb injects a one-time orientation block into the system prompt. This tells the agent:
- What Plumb does and what's now available
- The two tools: `plumb_remember` and `plumb_search`
- A non-prescriptive suggestion to update AGENTS.md and MEMORY.md if they don't already reference Plumb

The agent then has the context it needs to use Plumb correctly and can surface the suggestion to the user in natural conversation. After the orientation fires once, it is never injected again.

This is similar in spirit to the existing upgrade nudge (T-012) but fires at install time, not on a behavioral trigger. It lives in the same `before_prompt_build` hook and uses the same fire-once tracking pattern (a flag in the DB or a small marker file).

**Key design constraints:**

- **Do not write to AGENTS.md, MEMORY.md, or any workspace file.** The orientation is injected into the prompt only.
- The orientation should be **compact** — 5-8 lines max. It's a nudge, not documentation. Agents skim boilerplate.
- The suggestion to update AGENTS.md/MEMORY.md must be **non-prescriptive** — "you may want to" not "update these files now."
- The flag tracking whether orientation has fired must survive gateway restarts (i.e. persisted in SQLite, not in-memory).
- Orientation fires **before** the normal `[PLUMB MEMORY]` block, or replaces it if memory is empty on first activation (new install with no facts yet).

---

## Orientation text (reference — not verbatim)

Something like:

```
[PLUMB MEMORY — First activation]
Plumb is now active. Memory is retrieved automatically and injected before each response.

Tools available to you:
- plumb_remember("fact") — store something worth keeping across sessions
- plumb_search("query") — search memory mid-reasoning for a specific topic

Memory is written to: ~/.plumb/memory.db

If your AGENTS.md or MEMORY.md don't already reference Plumb, you may want to update them so future sessions start with the right mental model.
[/PLUMB MEMORY]
```

Adjust tone to match Plumb's existing voice. Keep it factual and brief.

---

## Out of scope

- Do not write to any workspace files (AGENTS.md, MEMORY.md, TOOLS.md, etc.)
- Do not implement a CLI `plumb install` command — that is a separate task
- Do not modify the upgrade nudge (T-012) logic
- Do not add any user-facing banner, modal, or UI element
- Do not change the orientation text based on config values (e.g. custom dbPath) — keep it generic for now

---

## Output artifacts

- `packages/core/src/schema.ts` — adds `orientation_log` table (or reuses `nudge_log` with a new trigger type — see notes)
- `packages/openclaw-plugin/src/hooks/pre-response.ts` — updated to check and fire the orientation block on first call
- `packages/openclaw-plugin/src/orientation.ts` — `OrientationManager` class: `hasOrientationFired(db)`, `recordOrientation(db)`, `getOrientationText(dbPath)` 
- `packages/openclaw-plugin/src/orientation.test.ts` — fire-once tests

---

## Acceptance criteria

- `OrientationManager.hasOrientationFired(db)` returns `false` on a fresh DB, `true` after `recordOrientation(db)` is called
- Orientation fires exactly once: on the first `before_prompt_build` call with a fresh DB, the returned `prependContext` includes the orientation text
- On all subsequent calls (same or different session, after gateway restart), orientation is not injected
- The orientation text includes: the word "Plumb", both tool names (`plumb_remember` and `plumb_search`), and a suggestion to update AGENTS.md/MEMORY.md
- Orientation block is prepended before normal `[PLUMB MEMORY]` content, or stands alone if memory retrieval returns empty
- In shadow mode, orientation text is logged but not injected (consistent with existing shadow mode behavior)
- `pnpm install && pnpm build` completes with zero errors
- `pnpm --filter @plumb/openclaw-plugin test` passes including orientation-specific tests

---

## Verify command

```bash
bash -c 'export PATH="$PATH:~/..npm-global/bin"; cd ~/..openclaw/workspace/plumb && pnpm install && pnpm build && pnpm --filter @plumb/openclaw-plugin test && grep -q "OrientationManager" packages/openclaw-plugin/src/orientation.ts && grep -q "plumb_remember" packages/openclaw-plugin/src/orientation.ts && grep -q "plumb_search" packages/openclaw-plugin/src/orientation.ts && echo "orientation checks passed"'
```

---

## Notes

**DB flag vs marker file:** Prefer a DB row (same pattern as nudge_log in T-012) over a marker file. It keeps all Plumb state in one place and survives across installs as long as the DB path is the same. Consider reusing `nudge_log` with `trigger_type = 'first_activation'` rather than creating a new table — check if the schema supports it cleanly before adding a new table.

**OrientationManager vs NudgeManager:** These could potentially share a base class or utility, but don't force it. If the nudge_log reuse works cleanly, a thin `OrientationManager` that just wraps nudge_log with a fixed trigger type is fine.

**dbPath in orientation text:** The `getOrientationText(dbPath)` signature takes the resolved dbPath so the orientation text can show the user where their DB is. Expand `~` to the full path in the displayed string so it's unambiguous.

**Timing:** The orientation fires in `before_prompt_build`, same as memory injection. It does not need its own hook registration.

**First-session edge case:** On the very first activation, `LocalStore.create()` is called but `seedFromMemoryFiles` may still be running (it's async/fire-and-forget). The orientation text should not wait on seeding — inject it regardless of whether facts exist yet.
