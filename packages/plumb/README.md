# Plumb

Durable memory for coding agents: a local markdown wiki with hybrid vector +
keyword retrieval. Everything runs on your machine — no cloud, no account, no
data leaving the host.

This package is a meta-package. Installing it pulls in both halves of the
system:

- [`@getplumb/wiki-search-service`](https://www.npmjs.com/package/@getplumb/wiki-search-service)
  — the retrieval service, the MCP server, and the prompt-injection hook
- [`@getplumb/wiki`](https://www.npmjs.com/package/@getplumb/wiki) — the indexer

## Most people should not install this directly

If you use Claude Code, install the plugin instead. It wires up the MCP server,
the prompt hook, and the memory instructions, and it can seed the wiki from
memory you already have:

```
/plugin marketplace add getplumb/plumb
/plugin install plumb
/plumb-setup
```

Install this package directly only if you are embedding Plumb in something else.

## Manual use

```
npm install @getplumb/plumb

npx plumb-wiki index ~/.plumb/wiki        # build the index
npx plumb-wiki-search                      # start the retrieval service
npx plumb-wiki-mcp                         # MCP server (stdio)
npx plumb-wiki-hook --print-config         # hook wiring for settings.json
```

Requires Node 22.13 or newer: the index is read through the built-in
`node:sqlite` module.

## Versioning note

Versions 0.4.x and earlier of this package were a different product — an
OpenClaw plugin, retired in August 2026. 1.0.0 is the wiki-based system and
shares no API with them.

## Licence

Elastic License 2.0 — source-available. See `LICENSE`.
