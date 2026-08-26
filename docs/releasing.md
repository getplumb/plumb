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

## Release

1. Confirm the working tree is clean and `pnpm test` passes locally.
2. Dry run first: **Actions → Publish to npm → Run workflow**, leaving
   *Dry run* checked. Read the output — it lists exactly what would be
   published, at what versions, with resolved dependency ranges.
3. Tag and push:

   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```

   The tag triggers the real publish and creates a GitHub release with the
   tarballs attached.

4. Verify from a clean machine, not from this repo:

   ```
   npm view @getplumb/plumb version
   npm view @getplumb/wiki-search-service dist-tags
   ```

   Then install the plugin somewhere fresh and run `/plumb-setup`. The installer
   requests `<package>@<plugin version>`, so a version mismatch between
   `plugins/plumb/.claude-plugin/plugin.json` and the published packages shows up
   here as "no matching version found".

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
