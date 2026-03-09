# Plumb

**Persistent memory for AI agents.**

Plumb gives your AI agents a two-layer memory system: a raw conversation log and an automatically-extracted fact graph. No "remember this" commands. No manual tagging. Just context that sticks — across sessions, across tools.

---

## Why Plumb?

- **Zero-config for OpenClaw users:** Install the plugin, memory just works. No MCP config required.
- **Two-layer architecture:** Raw logs (full fidelity) + fact graph (structured knowledge). Both layers queried on every turn.
- **Automatic ingestion:** Every exchange is logged and extracted. No manual commands, no "please remember this."

---

## How it works

Every exchange gets ingested automatically. Plumb runs two layers in parallel:

**Layer 1 — Raw log:** Full conversation history stored with hybrid semantic + keyword search. Preserves exact wording, context, and nuance.

**Layer 2 — Fact graph:** Structured facts extracted via LLM from conversations. Each fact is confidence-scored, timestamped, and time-decayed. Facts include topics, preferences, decisions, and entity relationships.

At retrieval time, both layers are queried (semantic search on raw logs, topic + recency ranking on facts) and merged into a concise `[PLUMB MEMORY]` block that gets injected into the agent's system prompt before each response.

```
┌─────────────┐
│   Agent     │
│  Exchange   │
└──────┬──────┘
       │
       ├───────────────────────────────┐
       │                               │
       ▼                               ▼
 ┌──────────┐                  ┌──────────────┐
 │ Raw Log  │                  │  Extraction  │
 │ (hybrid  │                  │  (LLM-based) │
 │  search) │                  └──────┬───────┘
 └────┬─────┘                         │
      │                               ▼
      │                        ┌──────────┐
      │                        │ Fact     │
      │                        │ Graph    │
      │                        │ (scored) │
      │                        └────┬─────┘
      │                             │
      └──────────┬──────────────────┘
                 ▼
          ┌─────────────┐
          │   Retrieval │
          │   (merged)  │
          └──────┬──────┘
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

This is a monorepo. All packages under `packages/` are MIT licensed. Hosted infrastructure under `hosted/` is BSL 1.1.

| Package | Description | License |
|---|---|---|
| [`@getplumb/core`](./packages/core) | MemoryStore interface, types, LocalStore, fact extraction, search | MIT |
| [`@getplumb/mcp-server`](./packages/mcp-server) | Self-hostable MCP server (stdio) | MIT |
| [`@getplumb/plumb`](./packages/openclaw-plugin) | OpenClaw agent plugin — auto-ingest + memory injection | MIT |
| [`plumb-memory`](./packages/cli) | CLI tool — init, status, export, reprocess | MIT |
| `@getplumb/cloud-store` (hosted) | Postgres/pgvector CloudStore driver | BSL 1.1 |
| `@getplumb/api-server` (hosted) | Hosted MCP endpoint | BSL 1.1 |

---

## Self-hosting

All packages under `packages/` are MIT licensed — use them however you want. The default LocalStore uses SQLite and lives in `~/.plumb/` on your machine. No network calls, no telemetry.

To run the hosted MCP endpoint yourself:
1. Clone this repo
2. Deploy `hosted/api-server` to Fly.io or any Node.js host
3. Set up Postgres with pgvector (Supabase works well)
4. Point your MCP config to your deployed endpoint

---

## Telemetry

The Plumb OpenClaw plugin sends anonymous usage events to help us understand how many people are using it and which versions are active.

**What is sent:** plugin version, OS platform (`linux`/`darwin`/`win32`), CPU architecture. Nothing else — no file paths, no memory content, no user data.

**When:** once on first install (`plugin_installed`) and once per gateway activation (`plugin_activated`).

**Opt out:** set `PLUMB_TELEMETRY=0` in your environment and nothing will ever be sent.

## License

**packages/\*** is MIT — use it however you want.

**hosted/\*** (the cloud driver and API server) is BSL 1.1 — free for non-production use, commercial use requires a license. The OSS core never depends on the BSL code.

BSL 1.1 converts to MIT after 4 years.

- [`packages/core/LICENSE`](./packages/core/LICENSE) — MIT
- [`hosted/LICENSE`](./hosted/LICENSE) — BSL 1.1

---

## Links

- **Docs:** [docs.getplumb.dev](https://docs.getplumb.dev)
- **Hosted tier:** [plumb.run](https://plumb.run) ($9/mo — Postgres + pgvector, cross-device sync, backups)

---

## Status

Early development. V1 targets [OpenClaw](https://openclaw.ai) and Claude Code users.
