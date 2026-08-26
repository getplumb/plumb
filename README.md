# Plumb

**Persistent memory for AI agents.**

Plumb gives your AI agents a cross-session memory store with fast hybrid retrieval. Store high-signal facts, get the right ones injected automatically before every response — across sessions, across tools.

---

## Why Plumb?

- **Zero-config for OpenClaw users:** Install the plugin, memory injection happens automatically. No MCP config required.
- **Hybrid retrieval:** BM25 + vector search + RRF fusion + recency decay + reranking. Retrieval quality is the product.
- **Local and private:** SQLite on your machine. No cloud, no external embedding API, no telemetry beyond anonymous usage counts.

---

## How it works

You store facts with `plumb_remember`. Plumb embeds them locally and retrieves the most relevant ones at query time using a multi-stage hybrid pipeline.

```
┌─────────────────────────┐
│  plumb_remember(fact)   │
│  Session seed from      │
│  memory files           │
└──────────┬──────────────┘
           │
           ▼
    ┌──────────────┐
    │ Memory Store │
    │  (SQLite +   │
    │  embeddings) │
    └──────┬───────┘
           │
           ▼
    ┌──────────────────────────┐
    │  Retrieval Pipeline      │
    │  BM25 + KNN → RRF →      │
    │  Recency decay → Rerank  │
    └──────┬───────────────────┘
           │
           ▼
    [PLUMB MEMORY] block
    injected into system prompt
```

---

## Quickstart

### For OpenClaw users

Install the Plumb plugin — memory ingestion and retrieval happen automatically:

```bash
openclaw plugins install @getplumb/plumb
```

That's it. No MCP config required. Plumb hooks into OpenClaw's exchange lifecycle and injects memory into every turn.

### For other tools (Claude Desktop, Cursor, etc.)

Install the MCP server globally:

```bash
npm install -g @getplumb/mcp-server
```

Add Plumb to your MCP config:

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
// %APPDATA%\Claude\claude_desktop_config.json (Windows)
// .cursor/mcp.json (Cursor)
{
  "mcpServers": {
    "plumb": {
      "command": "plumb-mcp"
    }
  }
}
```

Restart your tool. Plumb will start ingesting conversations and providing memory context automatically.

---

## Packages

This is a monorepo. Every package under `packages/` is licensed under the
[Elastic License 2.0](./LICENSE) — source-available, not OSI open source.

The hosted infrastructure (`cloud-store`, `api-server`) is no longer in this
repository — it moved to a private repo in August 2026. The OSS core never
depended on it, so nothing here changed as a result.

| Package | Description | License |
|---|---|---|
| [`@getplumb/core`](./packages/core) | MemoryStore interface, types, LocalStore, fact extraction, search | Elastic-2.0 |
| [`@getplumb/mcp-server`](./packages/mcp-server) | Self-hostable MCP server (stdio) | Elastic-2.0 |
| [`@getplumb/plumb`](./packages/openclaw-plugin) | OpenClaw agent plugin — auto-ingest + memory injection | Elastic-2.0 |
| [`plumb-memory`](./packages/cli) | CLI tool — init, status, export, reprocess | Elastic-2.0 |

Versions published before 1.0 were released under the MIT license and remain
available under those terms. The relicense applies to 1.0 and later.

---

## Self-hosting

All packages under `packages/` are licensed under the Elastic License 2.0: you
may use, copy, modify, and redistribute them freely, including commercially and
internally. The one thing you may not do is offer them to third parties as a
hosted or managed service. The default LocalStore uses SQLite and lives in
`~/.plumb/` on your machine. No network calls, no telemetry.

To run an MCP server yourself, use [`@getplumb/mcp-server`](./packages/mcp-server),
which speaks stdio. The managed hosted endpoint is a separate, closed-source
product and is not buildable from this repository.

---

## Telemetry

The Plumb OpenClaw plugin sends anonymous usage events to help us understand how many people are using it and which versions are active.

**What is sent:** plugin version, OS platform (`linux`/`darwin`/`win32`), CPU architecture. Nothing else — no file paths, no memory content, no user data.

**When:** once on first install (`plugin_installed`) and once per gateway activation (`plugin_activated`).

**Opt out:** set `PLUMB_TELEMETRY=0` in your environment and nothing will ever be sent.

## License

**Everything in this repository is licensed under the
[Elastic License 2.0](./LICENSE)** (SPDX: `Elastic-2.0`), copyright Plumb LLC.

ELv2 is *source-available*, not OSI open source. In practice: use it, run it,
fork it, modify it, ship it inside your own products — commercially or not. You
may not provide the software to third parties as a managed service, strip the
license keys, or remove licensing notices.

Releases before 1.0 were MIT and stay MIT; the relicense is not retroactive.

The hosted cloud driver and API server were previously in `hosted/` under BSL
1.1. They moved to a private repository in August 2026 and are no longer
distributed here. Their prior contents remain in this repository's git history
under the BSL terms that applied at the time.

- [`LICENSE`](./LICENSE) — Elastic License 2.0, applied to every package

---

## Links

- **Docs:** [docs.getplumb.dev](https://docs.getplumb.dev)
- **Hosted tier:** [plumb.run](https://plumb.run) ($9/mo — Postgres + pgvector, cross-device sync, backups)

---

## Status

Early development. V1 targets [OpenClaw](https://openclaw.ai) and Claude Code users.
