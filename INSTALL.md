# Plumb — Installation Guide

This guide covers installing Plumb for local/self-hosted use.

---

## Prerequisites

- **Node.js** >= 18.0.0
- **pnpm** >= 9.0.0 (install via `npm install -g pnpm` or `corepack enable`)
- **C++ build tools** (required by `better-sqlite3` native module):
  - **macOS**: Xcode Command Line Tools: `xcode-select --install`
  - **Linux (Ubuntu/Debian)**: `sudo apt install build-essential python3`
  - **Linux (Fedora/RHEL)**: `sudo dnf install gcc gcc-c++ make python3`
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

> **No API keys required.** Plumb runs entirely locally — embeddings are computed on-device using `@xenova/transformers`. No external LLM calls are made.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/getplumb/plumb.git
cd plumb
```

### 2. Install dependencies

```bash
pnpm install
```

This installs all packages in the monorepo:
- `@getplumb/core` — memory engine (SQLite + local vector search)
- `@getplumb/mcp-server` — MCP stdio server (exposes `memory_search` and `memory_status` tools)
- `plumb-memory` — CLI (`plumb status`, `plumb export`, `plumb connect`, etc.)
- `@getplumb/plumb` — OpenClaw agent plugin

> **Note:** The first install compiles `better-sqlite3` from source. This may take 1–2 minutes and requires the C++ build tools listed above.

### 3. Build all packages

```bash
pnpm build
```

### 4. Link the CLI and MCP server globally (optional but recommended)

```bash
cd packages/cli && npm link && cd ../..
cd packages/mcp-server && npm link && cd ../..
```

This makes `plumb` and `plumb-mcp` available as global commands. If you skip this step, you can run them directly:

```bash
node packages/cli/dist/index.js status
node packages/mcp-server/dist/index.js
```

---

## Verify Installation

```bash
plumb status
```

Expected output:

```
Plumb Memory — Local Store
──────────────────────────
Facts:          0
Raw log:        0 exchanges
Last ingestion: never
Storage:        22.2 MB
```

The database is created automatically at `~/.plumb/memory.db` on first use.

### First-run model download

The first time you store or search memory, Plumb downloads two embedding models (~150 MB total):

- **Xenova/bge-small-en-v1.5** (~100 MB) — passage embeddings (384-dim)
- **Xenova/ms-marco-MiniLM-L-6-v2** (~50 MB) — cross-encoder reranker (currently disabled, downloaded but unused)

Models are cached at `~/.cache/huggingface/hub/` and reused on subsequent runs.

> **Tip:** To pre-download models, run `plumb status` or ingest a test entry:
> ```bash
> echo "test" | plumb ingest --stdin
> ```

---

## Connect to Claude Desktop

### 1. Generate config snippet

```bash
plumb connect claude-desktop
```

### 2. Add to Claude Desktop config

Edit your config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "plumb": {
      "command": "plumb-mcp",
      "args": []
    }
  }
}
```

If you didn't run `npm link`, use the full path instead:

```json
{
  "mcpServers": {
    "plumb": {
      "command": "node",
      "args": ["/absolute/path/to/plumb/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### 3. Restart Claude Desktop

Plumb exposes two MCP tools:
- `memory_search` — search conversation history (hybrid BM25 + vector KNN)
- `memory_status` — view store statistics

---

## Connect to Claude Code

```bash
plumb connect claude-code
```

Or register manually:

```bash
claude mcp add plumb --scope user -- plumb-mcp
```

This also creates/updates `~/.claude/CLAUDE.md` with Plumb memory integration instructions.

---

## Connect to Cursor

```bash
plumb connect cursor
```

Add to your Cursor settings (`settings.json`):

```json
{
  "mcp.servers": {
    "plumb": {
      "command": "plumb-mcp",
      "args": []
    }
  }
}
```

---

## Connect to OpenClaw

Install the Plumb OpenClaw plugin:

```bash
openclaw plugins install @getplumb/plumb
```

That's it. The plugin hooks into OpenClaw's exchange lifecycle automatically — ingesting conversations after each exchange and injecting memory context before each response.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `plumb status` | Show memory store health and statistics |
| `plumb export` | Export facts and raw log to files |
| `plumb ingest <file>` | Ingest a text file into the raw log |
| `plumb ingest --stdin` | Ingest from stdin |
| `plumb ingest --text "..."` | Ingest inline text |
| `plumb connect [tool]` | Setup wizard for MCP clients |
| `plumb setup` | Interactive configuration wizard |
| `plumb health` | Run health checks |
| `plumb bulk-embed` | Backfill embeddings for unembedded entries |
| `plumb uninstall` | Remove Plumb data and config |

---

## Configuration

The MCP server and CLI accept configuration via environment variables and CLI flags.

| Variable | Description | Default |
|----------|-------------|---------|
| `PLUMB_USER_ID` | User ID for multi-user setups | `default` |
| `PLUMB_DB_PATH` | Path to SQLite database | `~/.plumb/memory.db` |

CLI flags (`--user-id`, `--db`) override environment variables.

---

## How It Works

Plumb has a two-layer architecture. Both layers are local, no external services required:

**Layer 1 — Raw log:** Full conversation history stored as chunks with vector embeddings. Searched via hybrid BM25 (keyword) + cosine KNN (semantic) with reciprocal rank fusion.

**Layer 2 — Memory facts:** Curated facts stored via `plumb_remember` (or programmatically). Each fact has confidence scores, tags, and time-decay. Searched with the same hybrid approach, with a 2× score boost over raw log results.

At retrieval time, both layers are queried in parallel and merged into a `[PLUMB MEMORY]` block injected into the agent's system prompt.

---

## Troubleshooting

### `pnpm: command not found`

```bash
npm install -g pnpm@10
# OR
corepack enable pnpm
```

### `node-gyp rebuild` fails during install

You're missing C++ build tools. See [Prerequisites](#prerequisites).

### `plumb: command not found` after `npm link`

Your npm global bin directory isn't in PATH:

```bash
npm config get prefix
# Add <prefix>/bin to your PATH
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Models downloading on every run

Models should cache at `~/.cache/huggingface/hub/`. If they re-download, check disk space and file permissions in that directory.

### Database issues

Reset the database:

```bash
rm -rf ~/.plumb/memory.db*
plumb status  # Re-creates automatically
```

---

## What Gets Installed

- **CLI binary**: `plumb` (via `npm link` in packages/cli)
- **MCP server binary**: `plumb-mcp` (via `npm link` in packages/mcp-server)
- **Database**: `~/.plumb/memory.db` (auto-created on first use)
- **Embedding model cache**: `~/.cache/huggingface/hub/` (~150 MB after first run)

---

## Updating

```bash
cd plumb
git pull origin main
pnpm install
pnpm build
```

No need to re-link. Your database and model cache are preserved.

---

## Known Limitations

- **Windows**: `better-sqlite3` native compilation can be painful. Ensure Visual Studio Build Tools are installed before running `pnpm install`. A WASM-based alternative is planned.
- **First-run model download** (~150 MB) happens silently with no progress indicator.
- **Cross-encoder reranker** is downloaded but currently disabled due to a compatibility issue with `@xenova/transformers`. Ranking falls back to BM25 + cosine fusion (RRF), which works well in practice.
- **`plumb connect cursor`** and **`plumb connect cline`** output config snippets but aren't fully tested.

---

## Support

- **Issues**: https://github.com/getplumb/plumb/issues
