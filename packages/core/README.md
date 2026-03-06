# @getplumb/core

> Cross-session AI memory — storage abstraction, types, and local SQLite driver

The core library for [Plumb](https://plumb.run) — a local-first, MCP-native memory layer for AI agents.

## What it does

- **Two-layer memory:** raw conversation log (Layer 1) + extracted fact graph (Layer 2)
- **Hybrid search:** BM25 + semantic vectors + RRF fusion + cross-encoder reranking
- **Local storage:** SQLite WASM, zero native dependencies (works on all platforms)
- **Pluggable LLM:** bring your own OpenAI or Anthropic client for fact extraction

## Install

```bash
npm install @getplumb/core
```

## Quick start

```ts
import { LocalStore } from '@getplumb/core';

// Create store (async factory required for WASM initialization)
const store = await LocalStore.create({ dbPath: '~/.plumb/memory.db' });

// Ingest a conversation turn
await store.ingest({
  sessionId: 'my-session',
  userMessage: 'I prefer TypeScript over Python',
  agentResponse: 'Noted! TypeScript it is.',
  timestamp: new Date(),
  source: 'openclaw'
});

// Retrieve relevant memory
const results = await store.searchRawLog('TypeScript preferences', 5);
```

## Links

- [Docs](https://docs.getplumb.dev)
- [GitHub](https://github.com/getplumb/plumb)
- [plumb.run](https://plumb.run)

## License

MIT
