---
description: Remove Plumb — stop the service, unwind the wiring, restore CLAUDE.md, and give the user their accumulated memory back
---

# Uninstall Plumb

This command runs on the bad day. It must work immediately after install and
three weeks later, and on a broken system — service already dead, port taken,
`CLAUDE.md` hand-edited since. **Assume nothing is healthy.**

The governing rule: **never delete the wiki corpus.** `scripts/uninstall.mjs`
has no flag that deletes it. Someone uninstalling a memory system has not asked
to forget anything, and the corpus is the only artifact that cannot be
regenerated.

## 1. Plan

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs plan
```

This is the dry run. It reports what is running, what was installed, how the
wiki splits between imported and net-new pages, and which `CLAUDE.md` strategy
applies:

- **restore** — put back the install-time backup. Exact and provably complete,
  but only correct when Plumb's block is the *sole* difference.
- **surgical** — remove only Plumb's block, leave everything else.

**The diff decides, not the calendar.** Elapsed time is a reasonable hint — a
same-day uninstall usually restores — but the script compares the current file
against the install-time backup and will choose surgical for a twenty-minute-old
install if the user has made unrelated edits. Restoring over those would destroy
work that had nothing to do with Plumb, which is the most damaging thing this
command could do. Show the user the recommendation and its reason; let them
choose.

If no backup was recorded, the script falls back to surgical and says so. Be
explicit that marker-based removal is less exact than a manifest-backed restore.

## 2. Export before removing anything

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs export --out <dir>
```

After real use the wiki holds two populations, and they need opposite handling.
Pages carrying a `source_refs` origin came from somewhere and can be returned
there. Pages without one were created inside Plumb and **exist nowhere else** —
after a few weeks that is usually the majority, and it is the entire reason the
user got value from the product. Returning only the imported ones would discard
exactly what Plumb was for.

The export copies both, and writes an `INDEX.md` separating them with each
imported page's origin path. Do this before removing anything, so a failure here
costs nothing.

Then offer the judgment step a script cannot do: condensing the highest-value
net-new facts back into whatever memory format the user had before.

## 3. Apply

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs apply --strategy <restore|surgical> --yes
```

Refuses to touch anything without `--yes`. Add `--remove-telemetry` only if the
user asks; it holds counts and timings, never query text.

It stops the service and confirms the port is free, handles `CLAUDE.md` by the
chosen strategy (keeping a pre-uninstall copy either way), removes the installed
runtime, and leaves the corpus alone. Each step reports separately, and absent
things count as success rather than failure — that is what makes it safe on a
half-broken system.

The MCP server and prompt hook were registered declaratively by the plugin, so
removing the plugin removes them. Verify rather than edit; do not go hand-editing
`settings.json` unless the user added a hook there themselves, and ask first
because it may predate Plumb.

## 4. Report

Confirm each claim with its evidence: service stopped and port free, `CLAUDE.md`
clean with unrelated edits intact, runtime gone, export written, corpus intact.

Report the corpus path last and prominently. It is the thing the user will want
next week, and the one thing this command deliberately did not clean up.
