---
name: plumb
description: Persistent cross-session memory for OpenClaw agents — automatically ingests conversations and injects relevant memories before each response.
---

# Plumb — Cross-Session Memory Plugin

Plumb gives OpenClaw agents long-term memory that persists across sessions. It stores conversation facts in a local SQLite database and retrieves relevant context before each response.

## Setup

1. Install the Plumb packages (from the monorepo root):

```bash
pnpm install && pnpm build
```

2. The plugin connects to the `@plumb/mcp-server` binary via stdio. By default it looks for `plumb-mcp` on `$PATH`. To use an explicit path:

```json
{
  "mcpServerPath": "./node_modules/.bin/plumb-mcp",
  "userId": "default",
  "enabled": true
}
```

3. The plugin hooks into OpenClaw's message pipeline:
   - **After every exchange** — ingests the conversation into the memory store
   - **Before every response** — searches memory for relevant context and injects it

## How It Works

- **Layer 1 (Raw Log):** Every conversation chunk is stored verbatim with vector embeddings for semantic search.
- **Layer 2 (Facts):** An extraction step distills conversations into structured subject-predicate-object triples with confidence scores and decay rates.
- **Search:** Queries both layers in parallel, combining semantic similarity with recency and confidence scoring.

## MCP Tools

The underlying MCP server exposes four tools:

| Tool | Description |
|------|-------------|
| `memory_store` | Persist a fact or conversation chunk |
| `memory_search` | Query both layers by semantic similarity |
| `memory_delete` | Soft-delete a fact by ID |
| `memory_status` | Get store statistics (counts, last ingestion, size) |
