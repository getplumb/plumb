# Releasing Plumb

**Publishing is irreversible in practice.** npm allows unpublishing only within
72 hours, and a version number can never be reused. Everything below that
touches the registry is a human decision.

## What gets published

Five packages, all versioned together at `1.0.0`:

| Package | What it is |
|---|---|
| `@getplumb/core` | shared library — no runtime dependencies |
| `@getplumb/wiki` | the indexer (`plumb-wiki`) |
| `@getplumb/wiki-search-service` | retrieval service, MCP server, injection hook |
| `@getplumb/wiki-worker` | queued-edit worker |
| `@getplumb/plumb` | meta-package installing the engine and indexer |

`plumb-memory`, `@getplumb/mcp-server`, and `@getplumb/openclaw-plugin` are
marked `private` and are **not** published. Their source stays in the repository.

## Why two package managers

Neither tool can do the whole job:

- **pnpm** rewrites `workspace:*` ranges into real versions when it packs. npm
  cannot, and publishing with npm directly would ship the literal string
  `workspace:*` as a dependency range, breaking every install.
- **npm** supports `--provenance`. pnpm 10.30.3 has no such flag, so publishing
  with pnpm would silently produce unattested packages.

So CI packs with pnpm and publishes the resulting tarballs with npm. A guard
step fails the build if a workspace range survives into any tarball — the
failure it exists to catch is unfixable for 72 hours once published.

**Never run `npm publish` from a package directory.** It would ship
`workspace:*`.

## The three stages

Two independent axes get confused here, so name them separately.

- **Git stage** decides *where CI runs*. It is free. Run everything.
- **npm dist-tag** decides *who receives the artifact*. This is the actual
  release gate.

There is no third long-lived branch. Stages are tags plus dist-tags:

| Stage | Trigger | CI | npm |
|---|---|---|---|
| Development | push / PR to `main` | build + unit matrix, PII scan | nothing |
| Release prep | branch `release/<version>` | full suite incl. install-smoke, multi-instance | nothing |
| Release candidate | tag `v<version>-rc.N` | full suite, as a hard gate | dist-tag `next` |
| Release | tag `v<version>` | full suite, as a hard gate | dist-tag `latest` |

`npm install @getplumb/wiki` keeps returning the previous release until a
`latest` publish. A candidate is reached only on purpose:

```
npm install @getplumb/wiki@next
```

## How the dist-tag is chosen

**`npm publish` defaults to `--tag latest` for every version, including semver
prereleases.** Publishing `1.0.0-rc.1` with no `--tag` therefore makes the
release candidate the default install for every user — the exact opposite of
what a candidate is for. So `publish.yml` derives the tag and never defaults it:

| Version | dist-tag | GitHub release |
|---|---|---|
| `1.0.0` | `latest` | normal |
| `1.0.0-rc.1` | `next` | marked prerelease |
| `1.0.0-beta.3` | `next` | marked prerelease |

Any hyphen means a prerelease under semver, so one rule covers `rc`, `beta`,
`alpha` and anything else. A `dist_tag` input on **workflow_dispatch** overrides
it; the override is logged as a warning.

Promoting a candidate to `latest` needs no rebuild and no new version:

```
for pkg in @getplumb/core @getplumb/wiki @getplumb/wiki-search-service \
           @getplumb/wiki-worker @getplumb/plumb; do
  npm dist-tag add $pkg@1.0.0-rc.1 latest
done
```

In practice prefer re-cutting a clean `v1.0.0` tag, so `latest` is a version
without an `-rc` suffix.

## What gates a publish

`publish.yml` runs four jobs, and the ordering is the point:

1. **plan** — resolves the version and dist-tag. Fails if the publishable
   packages disagree on a version, or if a git tag disagrees with `package.json`.
2. **verify** — calls `cross-platform.yml` as a reusable workflow, with
   `run_install_smoke: true`.
3. **security** — calls `pii-scan.yml` as a reusable workflow. Needs
   `secrets: inherit` for `PII_PATTERNS`.
4. **publish** — `needs: [plan, verify, security]`.

Both suites are invoked with `uses:` rather than left to run in parallel on
their own triggers. A `workflow_run` gate would not do: it cannot block, and a
red suite on an earlier commit would go unnoticed. Because publish depends on
them, a red suite means no publish — which is the whole point, given that a
publish is unfixable after 72 hours.

## Release

1. Cut `release/<version>` and push it. This alone triggers the full suite and
   publishes nothing. **Read the results before going further** — this is the
   first point at which cross-platform behaviour stops being theoretical.
2. Dry run: **Actions → Publish to npm → Run workflow**, *Dry run* checked. It
   prints the resolved version, the derived dist-tag, and exactly what would be
   published with dependency ranges rewritten.
3. Cut a candidate:

   ```
   git tag v1.0.0-rc.1
   git push origin v1.0.0-rc.1
   ```

   This publishes to `next`. `latest` is untouched and no existing user is
   affected.
4. **Install the candidate the way a stranger would**, on a machine that is not
   the development host:

   ```
   npm install @getplumb/wiki@next
   ```

   Then add the marketplace, install the plugin, and run `/plumb-setup`. This is
   the only step that exercises registry resolution across the five packages —
   CI installs local tarballs in a single `npm install`, so npm dedupes them and
   `@getplumb/wiki` never actually resolves `@getplumb/core` *through the
   registry*. Provenance attestation is likewise only real once published.
5. If the candidate holds, tag the real release:

   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```

6. Verify from a clean machine, not from this repo:

   ```
   npm view @getplumb/plumb version
   npm view @getplumb/wiki-search-service dist-tags
   ```

   The installer requests `<package>@<plugin version>`, so a mismatch between
   `plugins/plumb/.claude-plugin/plugin.json` and the published packages shows
   up here as "no matching version found".

## License change in 1.0.0

`@getplumb/core` 0.4.14 and `@getplumb/plumb` 0.4.23 are published under **MIT**.
1.0.0 is **Elastic-2.0**. Already-published MIT versions stay MIT permanently and
that grant cannot be withdrawn; a major bump means `^0.4` consumers will not
cross into the new terms by accident. State the change prominently in the
changelog and README rather than letting it be discovered.

## Deprecating the old line

`@getplumb/plumb` 0.4.x and earlier was a different product — the OpenClaw
plugin, retired August 2026. 1.0.0 reclaims the name. Anyone on the old line
should be told, since `latest` will now move them to something unrelated:

```
npm deprecate "@getplumb/plumb@<1.0.0" \
  "0.4.x was the OpenClaw plugin, retired in August 2026. 1.0.0 is a different product (a local memory wiki) and shares no API. Pin <1.0.0 if you still need the old one."

npm deprecate "plumb-memory@*" \
  "No longer maintained. Superseded by @getplumb/plumb 1.0."

npm deprecate "@getplumb/mcp-server@*" \
  "No longer maintained. Superseded by @getplumb/wiki-search-service."
```

Deprecation is reversible (`npm deprecate <pkg> ""`), unlike publishing.

## Prerequisites

- `NPM_TOKEN` in repository secrets, with publish rights on the `@getplumb`
  scope. As of 2026-08-25 npm auth on the development host returns 401 — CI is
  the supported path, and a local token is not needed for a release.
- The workflow needs `id-token: write` for provenance. It is already set; do not
  remove it, or packages publish unattested and silently lose their supply-chain
  attestation.
