# Plumb Wiki Injection Telemetry

This is the plugin-side schema for observing Plumb wiki prompt injection. It is local hook telemetry, not anonymous product telemetry. It can include the user query and wiki page paths, so it must not be sent to third-party analytics by default.

## Event name

`plumb.wiki_injection`

## Event shape

```ts
type WikiInjectionTelemetryEvent = {
  event: 'plumb.wiki_injection';
  status: 'fired' | 'skipped';
  reason: 'ok' | 'empty_query' | 'timeout' | 'search_error' | 'shadow_mode';
  mode: 'v2' | 'v2-shadow';
  query: string;
  candidatePages: Array<{
    path: string;
    title: string;
    type: string;
    score: number;
  }>;
  injectedPages: Array<{
    path: string;
    title: string;
    type: string;
    score: number;
    tokens: number;
  }>;
  budgetTokens: number;
  tokensUsed: number;
  elapsedMs: number;
  topK: number;
};
```

## Semantics

| Field | Meaning |
| --- | --- |
| `status` | `fired` when a `[PLUMB WIKI]` block was returned to OpenClaw, `skipped` otherwise. |
| `reason` | Skip or success reason. `shadow_mode` means search succeeded but the block was intentionally not injected. |
| `query` | The extracted last-user-message query used for wiki search. This may contain private text. |
| `candidatePages` | Pages returned by `WikiSearch.search()`, including scores, before formatting. |
| `injectedPages` | Pages included in the formatted prompt block, with estimated per-snippet tokens. |
| `budgetTokens` | Configured prompt-injection token budget for the hook. |
| `tokensUsed` | Estimated token count for the formatted `[PLUMB WIKI]` block. |
| `elapsedMs` | Hook elapsed time, including query extraction, search, formatting, and telemetry emission. |

## Integration points

- `packages/openclaw-plugin/src/wiki-injection.ts`
  - Defines `WikiInjectionTelemetryEvent`.
  - Accepts `onTelemetry?: (event) => void` on `createWikiInjectionHook()`.
  - Emits:
    - `skipped/empty_query` when no query can be extracted.
    - `skipped/timeout` when wiki search exceeds the injection timeout.
    - `skipped/search_error` on search or formatting errors.
    - `skipped/shadow_mode` when `wikiMode` is `v2-shadow`.
    - `fired/ok` when `wikiMode` is `v2` and the block is injected.
- `packages/openclaw-plugin/src/plugin-module.ts`
  - Wires `onTelemetry` to debug logging when `pluginConfig.wikiInjectionTelemetry` is true.

## Privacy rules

1. Do not send this event to PostHog or any external analytics sink by default.
2. Treat `query`, `path`, and `title` as user-private data.
3. If this is persisted for offline evals, store it locally and rotate or delete it after the eval window.
4. If a hosted telemetry sink is ever added, hash or omit `query` and page paths unless the user explicitly approves richer capture.
