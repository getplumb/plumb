# API Key Security: The Plumb Install Problem

**Author:** Clay Waters  
**Date:** 2026-03-05  
**Status:** Open — needs design decision  

---

## The Vision

The install experience we want looks like this:

> "OpenClaw, install the official Plumb memory plugin for OpenClaw. It's made by plumb.run and gives your agent persistent memory across sessions. Run: `openclaw plugins install @getplumb/plumb`."

That's it. One sentence. One command. The agent runs the install, OpenClaw restarts, and from that moment forward every conversation is automatically ingested — raw exchanges stored locally, facts extracted and confidence-scored, memory injected into every future prompt. The user immediately gets a smarter agent with no additional setup.

That experience is achievable. We're close. The obstacle is a single choke point: **fact extraction needs an LLM, and the LLM needs an API key.**

---

## What Fact Extraction Does

Plumb operates two memory layers in parallel:

**Layer 1 — Raw log.** Every exchange is stored verbatim (user message + agent response) with embeddings for semantic search. This layer is zero-config: no keys, no external calls, just SQLite + WASM.

**Layer 2 — Fact graph.** After each exchange, Plumb runs a secondary LLM call to extract structured facts: entities, relationships, confidence scores, time decay. This is what turns "I just moved to Denver" into a queryable fact that surfaces months later when you ask about restaurants. This layer is what makes Plumb *good* — not just a log dump.

Fact extraction is the whole point. Without it, Plumb is basically a search engine on your chat history. With it, Plumb builds a model of you and your context that compounds over time.

---

## Why Fact Extraction Needs a Key

Fact extraction sends the exchange content to an LLM and parses the response. In the current architecture, that LLM is configurable (OpenAI, Anthropic, any OpenAI-compatible endpoint, Ollama for local) — but *some* LLM client config is always required.

During install, the user's OpenClaw agent already has an API key configured — that's how the agent itself works. The obvious path is: let Plumb use the same key. One fewer thing to configure.

---

## The Security Concern: OpenClaw's Perspective

OpenClaw's plugin sandbox enforces one critical rule: **a plugin cannot read the host agent's API keys.**

This isn't paranoia. It's a legitimate supply chain concern. When a user runs `openclaw plugins install @getplumb/plumb`, they're trusting an npm package from an external publisher. If plugins could freely access the host agent's credentials, the attack surface becomes:

- A malicious (or compromised) plugin reads `process.env.ANTHROPIC_API_KEY`
- Exfiltrates it over the network during what looks like a routine fact extraction call
- The user's key is harvested with no visible sign anything went wrong

OpenClaw's scanner specifically flags any plugin code that reads from `process.env` for common key names. During our install testing, this scanner blocked early versions of `@getplumb/plumb-openclaw` that contained lines like:

```ts
const apiKey = process.env.OPENAI_API_KEY ?? api.pluginConfig?.llmApiKey;
```

Even though the intent was legitimate (fallback to user's key if no plugin-specific key is configured), the pattern is indistinguishable from a credential harvester. OpenClaw's scanner correctly flagged it and prevented install.

This is the right behavior. The scanner is doing its job. **The problem is that we don't yet have a clean, safe way to thread an API key from the host agent into a plugin for a legitimate use case like Plumb's.**

---

## The Exact Sequence of Events (What We Observed)

Here's what happened during our live install tests:

1. **User installs Plumb** via `openclaw plugins install @getplumb/plumb`. Plugin installs successfully (after several packaging fixes — bundling, manifest fields, native addon issues).

2. **Layer 1 works immediately.** Raw exchanges start flowing into `~/.plumb/memory.db`. The `[PLUMB MEMORY]` block appears in subsequent prompts.

3. **Layer 2 silently fails.** Gateway logs show:
   ```
   Fact extraction failed: Error: Plumb fact extraction requires OPENAI_API_KEY
   ```
   No fact graph is built. The memory block is populated only from the raw log.

4. **Root cause:** `plumb setup` (the CLI-based setup flow) writes `PLUMB_LLM_PROVIDER` and `PLUMB_API_KEY` to `~/.zshrc`. But OpenClaw runs as a **systemd daemon** — it never sources shell RC files. Those environment variables are invisible to the plugin.

5. **Attempted fix (blocked by scanner):** Thread `llmProvider` and `llmApiKey` through `openclaw.json` plugin config → pass them into `LocalStore` → use them for fact extraction. This works, but requires the user to manually add their API key to `openclaw.json`. That's bad UX and exposes the key in a plaintext config file.

6. **Alternative fix (also problematic):** Have Plumb read the host agent's key from `process.env`. Scanner flags it. Blocked.

7. **Current published state:** Fact extraction is disabled in the plugin. A no-op extraction queue is used. Layer 2 doesn't run at all. This is safe and installable, but it means the plugin ships without its most important feature.

---

## Why the Current Workarounds Don't Solve It

### Option A: User manually adds key to `openclaw.json`
```json
{
  "plugins": {
    "plumb": {
      "dbPath": "~/.plumb/memory.db",
      "llmProvider": "openai",
      "llmApiKey": "sk-..."
    }
  }
}
```

Problems:
- API key is in plaintext in a config file. Bad hygiene, especially on shared machines.
- Requires the user to know which provider/model to pick.
- Breaks the one-command install promise entirely. This is a 5-step setup.
- `openclaw config set` doesn't have a way to store secrets — it's for config values, not credentials.

### Option B: Plugin reads `process.env` directly
```ts
const apiKey = process.env.OPENAI_API_KEY;
```

Problems:
- Flagged by OpenClaw's security scanner. Correctly so.
- Even if we could bypass the scanner, this sets a precedent that any plugin can harvest env vars.
- Indistinguishable from malicious behavior at the code level.

### Option C: Ollama / local LLM, no key needed
Run fact extraction against a local model. No API key, no scanner issue.

Problems:
- Most users don't have Ollama installed.
- Adds a significant dependency to what should be a one-command install.
- Quality of local fact extraction at small model sizes is meaningfully worse.
- Doesn't solve the problem for hosted LLM users, just sidesteps it.

### Option D: Plumb-hosted extraction endpoint
User sends exchanges to `api.plumb.run`, Plumb runs extraction server-side, returns facts.

Problems:
- Requires a Plumb account and API key (plumb.run key, not OpenAI key).
- Sends conversation content to a third-party server — significant privacy concern.
- Adds network dependency to a plugin that currently works fully offline.
- Requires Plumb to build and maintain a hosted extraction service.
- Still requires some form of key (Plumb's own key) — trades one key problem for another.

---

## The Real Problem Statement

**There is no first-class, safe, OpenClaw-sanctioned mechanism for a plugin to perform LLM calls using the user's existing LLM credentials.**

This is a gap in OpenClaw's plugin API. Plugins can:
- Read config values from `openclaw.json`
- Store data locally
- Hook into the agent lifecycle (pre-prompt, post-exchange)
- Inject content into prompts

Plugins cannot:
- Make authenticated LLM calls through OpenClaw's credential store
- Request "use my LLM key" without reading `process.env` directly or requiring manual config

For the vast majority of plugins, this isn't a problem — most plugins don't need to call an LLM themselves. Plumb is unusual: it's a memory plugin whose core value proposition requires an LLM call *outside* the main agent loop, running asynchronously after every exchange.

---

## What an Ideal Solution Looks Like

The cleanest fix is a new OpenClaw plugin API surface — something like:

```ts
// Hypothetical plugin API
const llmClient = api.getLLMClient();
const facts = await llmClient.complete(extractionPrompt);
```

Where `api.getLLMClient()` returns a sandboxed client that:
- Uses the user's configured provider and model
- Routes through OpenClaw's existing credential store (never exposes the raw key to the plugin)
- Is rate-limited and auditable (logged as a plugin call, not a user call)
- Can be disabled per-plugin in OpenClaw config

This would let Plumb (and any future plugin that needs LLM access) make authenticated calls without ever touching the user's raw API key. The plugin never sees the key. OpenClaw acts as a credential broker.

An alternative, lower-lift approach:

```ts
// Hypothetical plugin API
const llmConfig = api.getLLMConfig(); 
// Returns: { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: '<redacted-token>' }
```

Where the returned `apiKey` is a **scoped, short-lived token** generated by OpenClaw — not the user's actual key. The token can only be used for the specific plugin, can be revoked, and has a TTL. Even if a malicious plugin exfiltrated it, the blast radius is limited.

---

## Impact on the Install Promise

Until this is solved, the install experience has a silent failure mode:

```
User: "OpenClaw, install the official Plumb memory plugin."
→ Plugin installs. ✅
→ Layer 1 works. ✅
→ Memory block appears in prompts. ✅
→ Fact extraction fails silently. ❌
→ User sees memory working but doesn't know it's running at ~50% capability.
```

The user's experience *looks* like it's working. The `[PLUMB MEMORY]` block appears. Queries return raw-log results. But the fact graph — the feature that makes memory compound and get smarter over time — isn't running.

This is worse than a hard failure in some ways. A hard failure is visible. A silent partial failure looks like success.

---

## What We Shipped as a Stopgap

The current published `@getplumb/plumb@0.2.x` uses a **no-op extraction queue**:

```ts
// From plugin-module.ts
const noopQueue = new ExtractionQueue(async (_exchange, _userId) => []);
const store = await LocalStore.create({
  dbPath,
  userId,
  extractionQueue: noopQueue,
});
```

This means:
- Zero network calls from the plugin
- Zero env var reads
- Passes the OpenClaw security scanner
- Layer 1 (raw log + semantic search) works fully
- Layer 2 (fact graph) does not run at all

The plugin is installable, safe, and delivers real value via Layer 1. But it's not the full Plumb experience.

---

## Next Steps

This problem needs a decision from both sides:

**From OpenClaw:**
- Is a sandboxed `api.getLLMClient()` or scoped token API on the roadmap?
- Is there an approved pattern today for plugins that need LLM access?
- Can the security scanner be relaxed for verified publishers with a specific `capabilities: ["llm_access"]` declaration in the manifest?

**From Plumb:**
- Should we ship a user-facing setup step that stores the LLM key in a Plumb-specific keychain (not `openclaw.json`)?
- Should we make fact extraction opt-in with a clear `plumb setup --llm` command that explains what it does and stores config in `~/.plumb/config.json` (not the shell RC)?
- Should we pursue the hosted extraction tier sooner, with strong privacy guarantees and opt-in framing?

The path of least resistance that doesn't compromise safety: **store a Plumb-specific LLM config in `~/.plumb/config.json`**, read it at plugin activation time (not from env), and document it clearly in the post-install output. The user provides their key once to Plumb directly, it lives in Plumb's own config, and neither `openclaw.json` nor shell env vars are involved.

This doesn't solve the *underlying* gap in OpenClaw's plugin API — but it's a clean workaround that preserves the user's security posture and gets fact extraction working without scanner flags.

---

## Summary

| Layer | Status | Blocker |
|---|---|---|
| Raw log ingest | ✅ Working | None |
| Semantic search (Layer 1) | ✅ Working | None |
| Fact extraction (Layer 2) | ❌ Disabled | No safe path for plugin → LLM key |
| One-command install | ✅ Working (partial) | Layer 2 silently absent |
| Full one-command install | ❌ Not yet | API key security gap |

The install command is right. The plugin packaging works. The memory injection works. The missing piece is a safe, seamless way for Plumb to call an LLM for fact extraction without OpenClaw's security model treating it as a credential harvester — because from the scanner's perspective, it looks exactly like one.
