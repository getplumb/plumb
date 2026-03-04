# Plumb

**Persistent memory for AI agents.**

Plumb gives your AI agents a two-layer memory system: a raw conversation log and an automatically-extracted fact graph. No "remember this" commands. No manual tagging. Just context that sticks — across sessions, across tools.

---

## How it works

Every exchange gets ingested automatically. Plumb runs two layers in parallel:

- **Layer 1 — Raw log:** Full conversation history with hybrid semantic + keyword search
- **Layer 2 — Fact graph:** Structured facts extracted from conversations, confidence-scored and time-decayed

At retrieval time, both layers are queried and merged into a concise `[MEMORY CONTEXT]` block that gets injected into the agent's system prompt before each response.

```json
// .cursor/mcp.json or claude_desktop_config.json
{
  "mcpServers": {
    "plumb": {
      "command": "npx",
      "args": ["-y", "@plumb/mcp-server"]
    }
  }
}
```

---

## Quickstart

```bash
npm install -g @plumb/mcp-server
plumb init
```

Then add Plumb to your MCP config (see above) and restart your agent. That's it.

---

## Packages

This is a monorepo. All packages under `packages/` are MIT licensed. Hosted infrastructure under `hosted/` is BSL 1.1.

| Package | Description |
|---|---|
| [`@plumb/core`](./packages/core) | MemoryStore interface, types, fact extraction, confidence scoring |
| [`@plumb/mcp-server`](./packages/mcp-server) | Self-hostable MCP server (stdio) |
| [`@plumb/openclaw-plugin`](./packages/openclaw-plugin) | OpenClaw agent plugin — auto-ingest + memory injection |
| [`@plumb/cli`](./packages/cli) | `plumb` CLI — init, status, export |

---

## Hosted

The hosted tier (`$9/mo`) runs on Postgres + pgvector via Supabase and Fly.io, with cross-device sync and automatic backups.

→ [getplumb.dev](https://getplumb.dev)

---

## License

- `packages/*` — [MIT](./packages/core/LICENSE)
- `hosted/*` — [BSL 1.1](./hosted/LICENSE) (converts to MIT after 4 years)

---

## Status

Early development. V1 targets [OpenClaw](https://openclaw.ai) and Claude Code users.
