---
description: Diagnose a Plumb install — engine, index, coverage, service, wiring, and whether retrieval is silently degraded
---

# Diagnose Plumb

**This command does not change anything.** It does not create directories, build
indexes, start services, or edit files. If the user wants a fix applied, that is
`/plumb-setup`. Keeping diagnosis read-only is what makes it safe to run on a
system someone has not agreed to let you modify — and it keeps the report
honest, since nothing here can quietly repair the thing it is reporting.

## Run it

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs
```

Add `--json` if you want to reason over the findings programmatically.

## Interpreting what comes back

The checks are not equally important. Rank them for the user rather than
reciting them in order.

**`retrieval  DEGRADED` is the headline finding.** It means the service is
answering, the tools respond, results come back, and every one of them is
keyword-only. Nothing looks broken. This is the failure this system hits more
than any other, and it is the reason this command exists. Common causes:

- the embedder could not stay resident under a memory ceiling
- the embedding model never finished downloading
- the machine is too tight on RAM to hold it

**`coverage` below 1 is the same class of problem, one layer down.** Contextual
embeddings are all-or-nothing: a single missing row demotes *every* query, not
just queries about the affected page. `/plumb-setup` rebuilds the index.

**`index ... the wiki has changed since`** means recent pages are not searchable
yet. Re-running setup reindexes.

**`hook wiring` warnings about a hand-rolled hook** mean the prompt is being
injected twice — once by the plugin, once by a hook the user installed manually.
Beyond wasting the token budget, the two copies drift, and the manual one wins
arguments about behaviour that nobody remembers having.

**`service  not running` is normal.** The service starts on demand and stops
itself after fifteen idle minutes to hand back memory. Not running is the
expected state on an idle machine — do not report it as a fault.

**`recent injections`** is the only check that describes what actually happened
on real prompts rather than what the configuration implies. A high skip count
with reason `service_unavailable` means the service could not start; `timeout`
means it started but was too slow; `no_results` on a populated wiki suggests
retrieval quality, not health.

## Reporting

Lead with whether memory is actually working, then list what would change that.
Do not describe a degraded install as healthy because most checks passed — the
one that failed is the one that decides whether any of it is useful.
