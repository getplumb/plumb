# Plumb — Installation Guide

This guide covers installing Plumb from source for local/self-hosted use.

---

## Prerequisites

Before installing Plumb, ensure you have:

- **Node.js** >= 18.0.0
- **pnpm** >= 9.0.0 (install via `npm install -g pnpm` or `corepack enable`)
- **Build tools** for native modules (required for `better-sqlite3`):
  - **Linux/macOS**: `gcc`, `g++`, `make`, `python3`
  - **macOS**: Install Xcode Command Line Tools: `xcode-select --install`
  - **Linux (Ubuntu/Debian)**: `sudo apt install build-essential python3`
  - **Linux (Fedora/RHEL)**: `sudo dnf install gcc gcc-c++ make python3`
  - **Windows**: Visual Studio Build Tools or run `npm install -g windows-build-tools`

---

## LLM Configuration

Plumb uses an LLM to extract facts from your conversations and notes. You can choose from multiple providers based on your preference and infrastructure.

### Supported Providers

Configure your provider by setting the `PLUMB_LLM_PROVIDER` environment variable:

#### OpenAI (default)

Uses OpenAI's API (requires API key).

```bash
export PLUMB_LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export PLUMB_LLM_MODEL=gpt-4o-mini  # Optional, default: gpt-4o-mini
```

#### Anthropic

Uses Anthropic's Claude API (requires API key, optional dependency).

```bash
export PLUMB_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
export PLUMB_LLM_MODEL=claude-haiku-4-5-20251001  # Optional, default shown
```

**Note:** Install the Anthropic SDK if using this provider:
```bash
npm install @anthropic-ai/sdk
```

#### Ollama (local)

Uses a local Ollama instance (no API key required).

```bash
export PLUMB_LLM_PROVIDER=ollama
export OLLAMA_HOST=http://localhost:11434/v1  # Optional, default shown
export PLUMB_LLM_MODEL=llama3.1  # Optional, default: llama3.1
```

**Prerequisites:**
- Install and run [Ollama](https://ollama.ai): `ollama pull llama3.1`
- Ensure Ollama is running: `ollama serve`

#### OpenAI-Compatible

Uses any OpenAI-compatible API endpoint (Together AI, Groq, Fireworks, vllm, LM Studio, etc.).

```bash
export PLUMB_LLM_PROVIDER=openai-compatible
export PLUMB_LLM_BASE_URL=https://api.together.xyz/v1
export OPENAI_API_KEY=your-api-key
export PLUMB_LLM_MODEL=meta-llama/Llama-3.1-70B-Instruct  # Provider-specific model ID
```

### OpenClaw Integration

If you're using Plumb with OpenClaw, API keys can also be resolved from `~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "openai:default": {
      "key": "sk-..."
    },
    "anthropic:default": {
      "key": "sk-ant-..."
    }
  }
}
```

Environment variables take precedence over OpenClaw config.

### Configuration Summary

| Variable | Description | Default |
|----------|-------------|---------|
| `PLUMB_LLM_PROVIDER` | LLM provider: `openai`, `anthropic`, `ollama`, `openai-compatible` | `openai` |
| `PLUMB_LLM_MODEL` | Model ID (provider-specific) | Provider defaults (see above) |
| `OPENAI_API_KEY` | OpenAI API key (for `openai` and `openai-compatible`) | None (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key (for `anthropic`) | None (required) |
| `OLLAMA_HOST` | Ollama API endpoint (for `ollama`) | `http://localhost:11434/v1` |
| `PLUMB_LLM_BASE_URL` | API base URL (for `openai-compatible`) | None (required) |

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/plumb-labs/plumb.git
cd plumb
```

### 2. Install dependencies

```bash
pnpm install
```

This will install all packages in the monorepo, including:
- `@plumb/core` — memory engine with SQLite + vector search
- `@plumb/mcp-server` — MCP stdio server
- `plumb-memory` — CLI tools (status, export, connect)
- `@plumb/openclaw-plugin` — OpenClaw agent plugin

> **Note:** The first install compiles native dependencies (`better-sqlite3`, `sqlite-vec`). This may take 1-2 minutes.

### 3. Build all packages

```bash
pnpm build
```

This compiles TypeScript to JavaScript for all packages in the monorepo.

### 4. Link the CLI and MCP server globally (optional but recommended)

```bash
# From the repo root
cd packages/cli
npm link
cd ../mcp-server
npm link
cd ../..
```

Alternatively, use them directly from the repo without linking:
```bash
node packages/cli/dist/index.js status
node packages/mcp-server/dist/index.js
```

---

## Verify Installation

### Check CLI is working

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

MCP server:     not found (run npm install -g @plumb/mcp-server)
```

> **Note:** The message about MCP server not found appears if you haven't installed it globally or if it's not in your PATH. This is expected after a fresh build. After running `npm link` in `packages/mcp-server`, the status will show "installed" if it's in PATH as `plumb-mcp`.

### Database auto-initialization

The database is created automatically on first use at `~/.plumb/memory.db`. No manual `plumb init` command is needed.

### First-run model download

The first time you store or search memory, Plumb downloads embedding models (~100-150 MB total):
- **Xenova/bge-small-en-v1.5** (~100 MB) — passage embeddings
- **Xenova/ms-marco-MiniLM-L-6-v2** (~50 MB) — cross-encoder reranker

Models are cached at `~/.cache/huggingface/hub/` and reused on subsequent runs.

> **Tip:** To pre-download models, run `plumb status` or store a test fact:
> ```bash
> echo "The sky is blue" | plumb ingest --stdin
> ```

---

## Connect to Claude Desktop (MCP)

### 1. Generate config snippet

```bash
plumb connect claude-desktop
```

This outputs the config you need to add to Claude Desktop.

### 2. Add to Claude Desktop config

Edit `~/.config/Claude/claude_desktop_config.json` (Linux/macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

> **Note:** If you didn't run `npm link` in `packages/mcp-server`, use the full path:
> ```json
> {
>   "mcpServers": {
>     "plumb": {
>       "command": "node",
>       "args": ["/absolute/path/to/plumb/packages/mcp-server/dist/index.js"]
>     }
>   }
> }
> ```

### 3. Restart Claude Desktop

Close and reopen Claude Desktop. Plumb will now be available as an MCP tool with 4 operations:
- `memory_store` — store facts
- `memory_search` — search facts and raw log
- `memory_delete` — soft-delete facts
- `memory_status` — view stats

---

## Connect to OpenClaw (Plugin)

### 1. Get connection instructions

```bash
plumb connect openclaw
```

### 2. Install the plugin globally

```bash
cd packages/openclaw-plugin
npm link
```

### 3. Add to OpenClaw config

Edit `~/.openclaw/config.json` or your project's OpenClaw config:

```json
{
  "plugins": [
    "@plumb/openclaw-plugin"
  ]
}
```

### 4. Restart OpenClaw

The plugin will auto-inject memory context into prompts and auto-ingest new exchanges.

---

## CLI Usage

### Check status

```bash
plumb status
```

### Export memory

```bash
plumb export
# Creates: plumb-export-YYYY-MM-DD-HHMMSS/facts.json + raw-log.md
```

### Ingest text manually

```bash
# From a file
plumb ingest notes.txt

# From stdin
echo "Important fact: Node.js >= 18 required" | plumb ingest --stdin

# Inline text
plumb ingest --text "Remember: pnpm >= 9 required"
```

### Connect to other tools

```bash
plumb connect         # Interactive wizard
plumb connect cursor  # Cursor-specific instructions (planned)
plumb connect cline   # Cline-specific instructions (planned)
```

---

## Troubleshooting

### Error: `pnpm: command not found`

Install pnpm globally:
```bash
npm install -g pnpm@10
# OR
corepack enable pnpm
```

### Error: `node-gyp rebuild` fails during `better-sqlite3` install

You're missing build tools. Install them:
- **macOS**: `xcode-select --install`
- **Ubuntu/Debian**: `sudo apt install build-essential python3`
- **Windows**: `npm install -g windows-build-tools`

### Error: `plumb: command not found` after `npm link`

Your npm global bin directory isn't in PATH. Find it with:
```bash
npm config get prefix
```

Add `<prefix>/bin` to your PATH in `~/.bashrc`, `~/.zshrc`, or equivalent:
```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

Then reload your shell:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

### Models downloading on every run

Models should cache at `~/.cache/huggingface/hub/`. If they re-download:
1. Check disk space in `~/.cache/`
2. Verify the directory isn't cleared by a cleanup script
3. Check file permissions: `ls -la ~/.cache/huggingface/`

### Database corruption

If you see SQLite errors, reset the database:
```bash
rm -rf ~/.plumb/memory.db*
plumb status  # Re-creates the database
```

---

## What Gets Installed

After a successful install, you'll have:

- **CLI binary**: `plumb` (via `npm link` in packages/cli)
- **MCP server binary**: `plumb-mcp` (via `npm link` in packages/mcp-server)
- **Database**: `~/.plumb/memory.db` (auto-created on first use)
- **Model cache**: `~/.cache/huggingface/hub/` (~150 MB after first run)

---

## Updating Plumb

To update to the latest version:

```bash
cd plumb
git pull origin main
pnpm install
pnpm build
```

No need to re-link if you already ran `npm link`. Your database and model cache are preserved.

---

## Next Steps

- Read the [Quickstart](./docs/quickstart.mdx) for usage examples
- Learn [How It Works](./docs/how-it-works.mdx) to understand the two-layer memory system
- See [MCP Tools Reference](./docs/mcp-tools.mdx) for the full API
- Explore [Self-Hosting](./docs/self-hosting.mdx) for production deployments

---

## Known Gaps & Follow-Ups

- **No `plumb init` command**: Database auto-initializes, but an explicit init command would be clearer for users. Consider adding in a future release.
- **No health check after install**: Users must manually run `plumb status` to verify. Consider adding a post-install hook or a `plumb doctor` command.
- **Model download progress**: First-run model download is silent. Consider adding progress indicators.
- **Windows PATH issues**: `npm link` on Windows often requires manual PATH updates. Document more explicitly or provide a setup script.
- **Cursor/Cline support**: `plumb connect cursor` and `plumb connect cline` are not yet implemented. Track in follow-up tasks.

---

## Support

- **Docs**: https://docs.plumb.run
- **Issues**: https://github.com/plumb-labs/plumb/issues
- **Discord**: https://discord.gg/plumb (coming soon)
