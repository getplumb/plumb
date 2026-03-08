# @getplumb/plumb — Plumb Memory Plugin for OpenClaw

> Persistent memory for [OpenClaw](https://openclaw.ai) — automatic ingest and context injection, no setup required.

**Made by [Plumb](https://plumb.run) · [GitHub](https://github.com/getplumb/plumb) · [npm](https://www.npmjs.com/package/@getplumb/plumb)**

This is the official OpenClaw memory plugin from Plumb (plumb.run). It replaces OpenClaw's default `memory-core` slot with a persistent SQLite-backed memory that learns from your conversations and injects relevant context automatically.

## Install

### Recommended: agent-assisted install

The easiest way to install Plumb is to let your OpenClaw agent handle it. Open a chat with your agent and paste:

> Install and activate the Plumb memory plugin from npm (`@getplumb/plumb`). After installing, set `plugins.slots.memory` to `"plumb"` in openclaw.json and restart the gateway.

Your agent will download the package, patch the config, and restart the gateway for you.

### Manual install

If you prefer to do it yourself:

**1. Install the plugin:**
```bash
openclaw plugins install @getplumb/plumb
```

> **Note on security warning:** OpenClaw may warn about shell command execution in the plugin. This is expected — Plumb downloads a native SQLite binary on first run (since OpenClaw installs with `--ignore-scripts`). No code runs at install time; the download happens when the plugin activates. You can safely proceed.

**2. Assign the memory slot** — this step is required. Open your `openclaw.json` and add:
```json
"plugins": {
  "slots": {
    "memory": "plumb"
  }
}
```

Or via CLI:
```bash
openclaw config set plugins.slots.memory plumb
```

**3. Restart the gateway:**
```bash
openclaw gateway restart
```

Plumb starts learning from your conversations immediately.

## What it does

- **Auto-ingest** — every conversation turn is stored to a local SQLite DB after the response
- **Context injection** — relevant memory facts are injected into the system prompt before each response
- **Shadow mode** — observe what would be injected without actually injecting it (good for testing)
- **Local only** — all data stays on your machine; nothing is sent to external servers

## Configuration

Configuration lives under `plugins.entries.plumb.config` in your `openclaw.json`. All fields are optional — defaults work out of the box.

| Field | Default | Description |
|---|---|---|
| `dbPath` | `~/.plumb/memory.db` | Path to the SQLite database file |
| `userId` | `default` | User ID for scoping memory |
| `shadowMode` | `false` | If true, retrieves context but does not inject it |
| `llmProvider` | *(inherits from OpenClaw)* | LLM provider for fact extraction (`openai`, `anthropic`, `ollama`, `openai-compatible`) |
| `llmModel` | *(inherits from OpenClaw)* | Model for fact extraction |
| `llmApiKey` | *(inherits from OpenClaw)* | API key for fact extraction |

To configure via CLI:

```bash
openclaw config set plugins.entries.plumb.config.userId "clay"
openclaw gateway restart
```

### Enabling Fact Extraction

Fact extraction requires an LLM provider. Create `~/.plumb/config.json` with your API key:

**Recommended (Gemini 2.5 Flash Lite — extremely cheap and fast):**
```json
{
  "llmProvider": "google",
  "llmModel": "gemini-2.5-flash-lite",
  "llmApiKey": "YOUR_GEMINI_API_KEY"
}
```

**Alternative (OpenAI):**
```json
{
  "llmProvider": "openai",
  "llmModel": "gpt-4o-mini",
  "llmApiKey": "YOUR_OPENAI_API_KEY"
}
```

Then restart the gateway:
```bash
openclaw gateway restart
```

## Uninstall

```bash
openclaw plugins uninstall @getplumb/plumb
```

Then manually restore the memory slot in your `openclaw.json` — OpenClaw does not do this automatically:

```json
"plugins": {
  "slots": {
    "memory": "memory-core"
  },
  "entries": {
    "memory-core": { "enabled": true }
  }
}
```

Remove any `"plumb"` blocks from `plugins.entries` and `plugins.installs`, then restart:

```bash
openclaw gateway restart
```

> **Note:** Skipping the manual config cleanup will leave OpenClaw with a broken memory slot. This is a known gap in the OpenClaw plugin uninstall flow — [filed as an issue](https://github.com/openclaw/openclaw/issues).

## Links

- [Plumb](https://plumb.run)
- [OpenClaw](https://openclaw.ai)

## License

MIT
