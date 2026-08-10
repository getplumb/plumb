#!/usr/bin/env node
// Thin-client Plumb wiki injection hook (Phase 2 cutover, 2026-08-10).
//
// Replaces the tsx-spawned in-process engine (~730ms p50, silent timeouts) with
// one HTTP call to the supervised plumb-wiki-search service on 127.0.0.1:18795
// (the benchmarked engine, warm index + resident embedder, ~15ms).
//
// Contract preserved from the old hook:
//   - UserPromptSubmit protocol: hookSpecificOutput.additionalContext
//   - [PLUMB WIKI] block format (numbered chunks, tools footer)
//   - requires_live_data skip heuristic
//   - telemetry JSONL: counts/timings only, never query text
//   - fail open on ANY error, but fail VISIBLE via telemetry reason
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'

const SERVICE = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
const SEARCH_DEADLINE_MS = Number(process.env.PLUMB_HOOK_SEARCH_DEADLINE_MS) || 1500
const HARD_TIMEOUT_MS = Number(process.env.PLUMB_HOOK_HARD_TIMEOUT_MS ?? 2500)
const TOP_K = 5
const INJECTION_TOKEN_BUDGET = 900

const timer = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS)

const TELEMETRY_PATH =
  process.env.PLUMB_TRAFFIC_TELEMETRY_PATH ?? '/home/openclaw-host/.plumb/telemetry/claude-code-traffic.jsonl'

function recordTelemetry(entry) {
  try {
    mkdirSync('/home/openclaw-host/.plumb/telemetry', { recursive: true })
    appendFileSync(
      TELEMETRY_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'plumb.wiki_injection',
        mode: 'v2',
        backend: 'wiki-search-service',
        topK: TOP_K,
        budgetTokens: INJECTION_TOKEN_BUDGET,
        ...entry,
      }) + '\n',
    )
  } catch {
    // Telemetry must never affect prompt handling.
  }
}

const estimateTokens = (text) => Math.ceil(text.length / 4)
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()

// Ported verbatim from wiki-injection.ts shouldSkipWikiInjectionForLiveData.
function requiresLiveData(query) {
  const normalized = query.toLowerCase()
  const hasRouteIntent = /\b(?:route|traffic|directions)\b/.test(normalized)
    || /\bfastest\s+way\b/.test(normalized)
    || /\bdriving\s+time\b/.test(normalized)
  const hasCurrentIntent = /\b(?:current|live|today|now)\b/.test(normalized)
    || /\bright\s+now\b/.test(normalized)
  return hasRouteIntent && hasCurrentIntent
}

function stripInjectedBlocks(text) {
  return String(text || '')
    .replace(/\[PLUMB MEMORY\][\s\S]*?\[\/PLUMB MEMORY\]/g, '')
    .replace(/\[PLUMB WIKI\][\s\S]*?\[\/PLUMB WIKI\]/g, '')
    .trim()
}

function formatBlock(results) {
  const header = ['[PLUMB WIKI]', 'Relevant wiki chunks:', '']
  const footer = [
    '',
    'Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links',
    '[/PLUMB WIKI]',
  ]
  let tokensUsed = estimateTokens(header.join('\n') + footer.join('\n'))
  const lines = [...header]
  let injected = 0
  for (const [index, result] of results.entries()) {
    const section = result.section ? ` — ${oneLine(result.section)}` : ''
    const head = `${index + 1}. **${result.title}** (${result.path}) [${result.type || 'page'}]${section}`
    const snippet = oneLine(result.snippet)
    const entryTokens = estimateTokens(`${head}\n   ${snippet}\n`)
    // Always include at least one result; after that, respect the budget.
    if (injected > 0 && tokensUsed + entryTokens > INJECTION_TOKEN_BUDGET) {
      const remaining = (INJECTION_TOKEN_BUDGET - tokensUsed - estimateTokens(`${head}\n`)) * 4
      if (remaining < 200) continue
      lines.push(head, `   ${snippet.slice(0, remaining)}…`)
      tokensUsed = INJECTION_TOKEN_BUDGET
      injected += 1
      continue
    }
    lines.push(head, `   ${snippet}`)
    tokensUsed += entryTokens
    injected += 1
  }
  lines.push(...footer)
  return { block: lines.join('\n'), tokensUsed, injected }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  if (input.hook_event_name !== 'UserPromptSubmit') process.exit(0)

  const prompt = stripInjectedBlocks(typeof input.prompt === 'string' ? input.prompt : '')
  if (!prompt) process.exit(0)

  if (requiresLiveData(prompt)) {
    recordTelemetry({ status: 'skipped', reason: 'requires_live_data', resultCount: 0, tokensUsed: 0, elapsedMs: 0 })
    process.exit(0)
  }

  const started = performance.now()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), SEARCH_DEADLINE_MS)
  let payload
  // Which service instance served us (x-plumb-instance, multi-instance
  // deployment 2026-08-10). Absent when the request never reached a service.
  let instance
  try {
    const response = await fetch(
      `${SERVICE}/search?q=${encodeURIComponent(prompt)}&topK=${TOP_K}`,
      { signal: controller.signal },
    )
    instance = response.headers.get('x-plumb-instance') || undefined
    if (!response.ok) throw new Error(`service HTTP ${response.status}`)
    payload = await response.json()
  } catch (error) {
    const timedOut = error?.name === 'AbortError'
    recordTelemetry({
      status: 'skipped',
      reason: timedOut ? 'timeout' : 'service_unreachable',
      ...(instance ? { instance } : {}),
      resultCount: 0,
      tokensUsed: 0,
      elapsedMs: Math.round(performance.now() - started),
    })
    process.exit(0)
  } finally {
    clearTimeout(deadline)
  }

  const elapsedMs = Math.round(performance.now() - started)
  const results = Array.isArray(payload.results) ? payload.results : []
  if (results.length === 0) {
    recordTelemetry({ status: 'skipped', reason: 'no_results', instance, searchMode: payload.mode, resultCount: 0, tokensUsed: 0, elapsedMs })
    process.exit(0)
  }

  const { block, tokensUsed, injected } = formatBlock(results)
  recordTelemetry({
    status: 'fired',
    reason: 'ok',
    instance,
    searchMode: payload.mode,
    candidateCount: results.length,
    resultCount: injected,
    tokensUsed,
    elapsedMs,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: block,
      },
    }),
  )
} catch {
  // Fail open. Claude receives no additional context, but the prompt proceeds.
} finally {
  clearTimeout(timer)
}
