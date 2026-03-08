# @getplumb/plumb — Plumb Memory Plugin for OpenClaw

> Persistent memory for [OpenClaw](https://openclaw.ai) — context injection and agent-driven memory tools.

**Made by [Plumb](https://plumb.run) · [GitHub](https://github.com/getplumb/plumb) · [npm](https://www.npmjs.com/package/@getplumb/plumb)**

This is the official OpenClaw memory plugin from Plumb (plumb.run). It assigns itself to OpenClaw's `memory` plugin slot and provides your agent with persistent memory backed by a local SQLite database.

## Install

### Recommended: agent-assisted install

Open a chat with your OpenClaw agent and paste this exactly:

> Run these steps to install the Plumb memory plugin. Do not ask questions — just run the steps and report back.
> 
> 1. `openclaw plugins install @getplumb/plumb`
> 2. `openclaw config set plugins.slots.memory plumb`
> 3. `openclaw gateway restart`
> 
> If step 1 fails with a npm error, do the manual install instead:
> - Stop the gateway
> - Run `npm pack @getplumb/plumb@latest` in a temp directory
> - Extract the tarball, run `npm install --omit=dev` inside it
> - Move the folder to `~/.openclaw/extensions/plumb` (or `%USERPROFILE%\.openclaw\extensions\plumb` on Windows)
> - Update `plugins.installs.plumb.version` in openclaw.json to match the installed version
> - Set `plugins.slots.memory` to `"plumb"` in openclaw.json
> - Restart the gateway
> 
> Once done, confirm the gateway is running and Plumb is active. Do not configure anything else.

### Manual install

If you prefer to do it yourself:

**1. Install the plugin:**
```bash
openclaw plugins install @getplumb/plumb
```

> **Note on security warning:** OpenClaw may warn about shell command execution in the plugin. This is expected — Plumb downloads a native SQLite binary on first activation (since OpenClaw installs plugins with `--ignore-scripts`, skipping the normal binary setup). Nothing runs at install time. You can safely proceed.

**2. Assign the memory slot** — this step is required. Add to your `openclaw.json`:
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

## What it does

- **Memory injection** — relevant facts from your memory store are injected into every agent response as a `[PLUMB MEMORY]` block
- **Agent memory tools** — your agent gets `plumb_remember` and `plumb_search` as callable tools for reading and writing memory mid-conversation
- **Bootstrap from notes** — on first activation, automatically seeds memory from existing workspace `.md` files (e.g. `memory/YYYY-MM-DD.md`, `MEMORY.md`)
- **Shadow mode** — retrieve and log what would be injected without actually injecting it (useful for testing)
- **Local only** — all data stays on your machine in a SQLite database at `~/.plumb/memory.db`

## Configuration

Configuration lives under `plugins.entries.plumb.config` in your `openclaw.json`. All fields are optional.

| Field | Default | Description |
|---|---|---|
| `dbPath` | `~/.plumb/memory.db` | Path to the SQLite database file |
| `userId` | `default` | User ID for scoping memory |
| `shadowMode` | `false` | If true, retrieves context but does not inject it |
| `queryPort` | `18791` | Port for the internal memory query server |

To configure via CLI:

```bash
openclaw config set plugins.entries.plumb.config.userId "clay"
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

> **Note:** Skipping the manual config cleanup will leave OpenClaw with a broken memory slot. This is a known gap in the OpenClaw plugin uninstall flow.

## Links

- [Plumb](https://plumb.run)
- [OpenClaw](https://openclaw.ai)

## License

MIT
