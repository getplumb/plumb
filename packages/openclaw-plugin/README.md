# @getplumb/plumb — Plumb Memory Plugin for OpenClaw

> Persistent memory for [OpenClaw](https://openclaw.ai) — automatic ingest and context injection, no setup required.

**Made by [Plumb](https://plumb.run) · [GitHub](https://github.com/getplumb/plumb) · [npm](https://www.npmjs.com/package/@getplumb/plumb)**

This is the official OpenClaw memory plugin from Plumb (plumb.run). It replaces OpenClaw's default `memory-core` slot with a persistent SQLite-backed memory that learns from your conversations and injects relevant context automatically.

## Install

```bash
openclaw plugins install @getplumb/plumb
```

Then restart the gateway to activate:

```bash
openclaw gateway restart
```

That's it. Plumb starts learning from your conversations immediately.

> **Note on security warning:** OpenClaw may show a warning about "environment variable access combined with network send." This is expected — Plumb reads your configured LLM API key and uses it to extract memory facts from conversations. No credentials are sent anywhere except the LLM provider you configure. You can safely proceed past this warning.

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

**Recommended (Gemini 2.0 Flash — extremely cheap and fast):**
```json
{
  "llmProvider": "google",
  "llmModel": "gemini-2.0-flash",
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
