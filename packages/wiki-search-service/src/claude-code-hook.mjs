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
//
// Wire it up with:  plumb-wiki-hook --print-config
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureService } from './ensure-service.mjs'

const SERVICE = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
// Two deadlines, not one (2026-08-25). A *running* service that is slow is a
// fault and should not be waited on -- hence the tight warm budget. Only a call
// that just paid for a cold start gets the longer one. Measured spawn-to-ready
// is ~800ms, so 6s of spawn budget is generous for slower hardware while
// leaving room under the hard timeout.
const SEARCH_DEADLINE_MS = Number(process.env.PLUMB_HOOK_SEARCH_DEADLINE_MS) || 1500
const COLD_SEARCH_DEADLINE_MS = Number(process.env.PLUMB_HOOK_COLD_SEARCH_DEADLINE_MS) || 2500
const COLD_START_BUDGET_MS = Number(process.env.PLUMB_HOOK_COLD_START_BUDGET_MS) || 6000
// Backstop only, and it must stay under the Claude Code hook timeout (10s).
const HARD_TIMEOUT_MS = Number(process.env.PLUMB_HOOK_HARD_TIMEOUT_MS ?? 9000)
// A service that will not start is a real fault and must be visible -- silent
// degradation is the failure mode this whole project keeps hitting. But a
// permanently broken install must not nag on every single prompt, so the notice
// is rate limited.
const NOTICE_COOLDOWN_MS = Number(process.env.PLUMB_HOOK_NOTICE_COOLDOWN_MS ?? 10 * 60 * 1000)
const NOTICE_STATE_PATH =
  process.env.PLUMB_HOOK_NOTICE_STATE_PATH ?? join(homedir(), '.plumb', 'state', 'hook-notice.json')
const TOP_K = 5
const INJECTION_TOKEN_BUDGET = 900

const TELEMETRY_PATH =
  process.env.PLUMB_TRAFFIC_TELEMETRY_PATH ?? join(homedir(), '.plumb', 'telemetry', 'claude-code-traffic.jsonl')

// Argument handling runs BEFORE stdin is touched. The hook's normal mode blocks
// reading fd 0, so a human typing `plumb-wiki-hook --help` would otherwise hang
// on a terminal with nothing to read.
const args = process.argv.slice(2)
if (args.includes('--print-config') || args.includes('--help') || args.includes('-h')) {
  const self = process.argv[1]
  console.log(`
Plumb wiki injection hook for Claude Code.

Runs on every UserPromptSubmit, searches your wiki through the local
plumb-wiki-search service, and prepends the best-matching chunks to the prompt.
Fails open: if the service is down or slow, your prompt proceeds unchanged.

Add this to the "hooks" object in ~/.claude/settings.json:

{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${self}"],
            "timeout": 10,
            "statusMessage": "Loading Plumb wiki context"
          }
        ]
      }
    ]
  }
}

If the service is not running, the hook starts it and waits (~800ms once, then
~15ms while it stays warm). The service idles itself out after 15 minutes.

Environment:
  PLUMB_WIKI_SERVICE_URL             default http://127.0.0.1:18795
  PLUMB_HOOK_SEARCH_DEADLINE_MS      default 1500   (warm path)
  PLUMB_HOOK_COLD_SEARCH_DEADLINE_MS default 2500   (just after a spawn)
  PLUMB_HOOK_COLD_START_BUDGET_MS    default 6000   (spawn to ready)
  PLUMB_HOOK_HARD_TIMEOUT_MS         default 9000   (backstop, under the 10s hook timeout)
  PLUMB_WIKI_IDLE_TIMEOUT_MS         default 900000 (service idle shutdown)
  PLUMB_WIKI_AUTOSPAWN               set to 0 to require a supervised service
  PLUMB_TRAFFIC_TELEMETRY_PATH       default ${TELEMETRY_PATH}
`.trim())
  process.exit(0)
}

const timer = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS)

function recordTelemetry(entry) {
  try {
    mkdirSync(dirname(TELEMETRY_PATH), { recursive: true })
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

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    }),
  )
}

/**
 * True at most once per cooldown window, per kind. Keeps a fault visible without
 * turning every prompt of a broken install into a nag. Kinds are tracked
 * separately so an outage notice cannot mask a later degradation notice.
 */
function shouldNotice(kind) {
  let state = {}
  try {
    state = JSON.parse(readFileSync(NOTICE_STATE_PATH, 'utf8'))
    if (Date.now() - (state[kind] ?? 0) < NOTICE_COOLDOWN_MS) return false
  } catch {
    // No state file yet, or it is unreadable: treat as "never notified".
  }
  try {
    mkdirSync(dirname(NOTICE_STATE_PATH), { recursive: true })
    writeFileSync(NOTICE_STATE_PATH, JSON.stringify({ ...state, [kind]: Date.now() }))
  } catch {
    // If we cannot persist the timestamp we would notify every prompt, which is
    // worse than staying quiet. Only notify when we could record it.
    return false
  }
  return true
}

const estimateTokens = (text) => Math.ceil(text.length / 4)
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()

// Smallest snippet worth showing. Below this a chunk is a citation, not
// evidence, so the block drops the result rather than teasing it.
const MIN_SNIPPET_CHARS = 160

/**
 * Split `total` across `wants` so no claimant is starved by an earlier one.
 *
 * Classic water-filling: settle the smallest claim first, then re-divide what
 * is left among those still unsatisfied. Anyone wanting less than an equal
 * share donates the difference automatically, so a short chunk subsidises a
 * long one instead of a long one erasing it.
 */
function waterFill(wants, total) {
  const alloc = new Array(wants.length).fill(0)
  const bySizeAscending = wants.map((_, i) => i).sort((a, b) => wants[a] - wants[b])
  let left = total
  let claimants = wants.length
  for (const i of bySizeAscending) {
    const take = Math.min(wants[i], Math.floor(left / claimants))
    alloc[i] = take
    left -= take
    claimants -= 1
  }
  return alloc
}

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

function formatBlock(results, warning) {
  const header = warning
    ? ['[PLUMB WIKI]', `WARNING: ${warning}`, '', 'Relevant wiki chunks:', '']
    : ['[PLUMB WIKI]', 'Relevant wiki chunks:', '']
  const footer = [
    '',
    'Wiki tools: plumb_wiki_read · plumb_wiki_search · plumb_wiki_list · plumb_wiki_links',
    '[/PLUMB WIKI]',
  ]
  const overhead = estimateTokens(header.join('\n') + footer.join('\n'))

  const entries = results.map((result, index) => {
    const section = result.section ? ` — ${oneLine(result.section)}` : ''
    return {
      head: `${index + 1}. **${result.title}** (${result.path}) [${result.type || 'page'}]${section}`,
      snippet: oneLine(result.snippet),
    }
  })

  // Heads are mandatory for every result shown, so they come out of the budget
  // before any snippet does. Drop from the tail — never the head — until the
  // survivors can each clear MIN_SNIPPET_CHARS.
  const floorCost = (count) =>
    entries.slice(0, count).reduce(
      (sum, e) => sum + estimateTokens(`${e.head}\n   ${'x'.repeat(MIN_SNIPPET_CHARS)}\n`),
      overhead,
    )
  let shown = entries.length
  while (shown > 1 && floorCost(shown) > INJECTION_TOKEN_BUDGET) shown -= 1
  const kept = entries.slice(0, shown)

  // Whatever is left after overhead and heads is snippet budget, shared out so
  // that a verbose top hit can no longer consume the entire block. Previously
  // this loop filled greedily in rank order, which silently dropped the last
  // candidate on 66% of real injections — including the one page that answered
  // the question (2026-08-17).
  const headTokens = kept.reduce((sum, e) => sum + estimateTokens(`${e.head}\n   \n`), 0)
  const snippetChars = Math.max(0, (INJECTION_TOKEN_BUDGET - overhead - headTokens) * 4)
  const alloc = waterFill(kept.map((e) => e.snippet.length), snippetChars)

  const lines = [...header]
  let truncated = 0
  for (const [i, entry] of kept.entries()) {
    const full = entry.snippet.length <= alloc[i]
    if (!full) truncated += 1
    lines.push(entry.head, `   ${full ? entry.snippet : `${entry.snippet.slice(0, alloc[i])}…`}`)
  }
  lines.push(...footer)

  const block = lines.join('\n')
  return {
    block,
    tokensUsed: estimateTokens(block),
    injected: kept.length,
    droppedToBudget: entries.length - kept.length,
    truncated,
  }
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

  const service = await ensureService({ url: SERVICE, coldStartBudgetMs: COLD_START_BUDGET_MS })
  if (!service.ok) {
    recordTelemetry({
      status: 'skipped',
      reason: 'service_unavailable',
      detail: service.reason,
      spawned: service.spawned,
      resultCount: 0,
      tokensUsed: 0,
      elapsedMs: Math.round(performance.now() - started),
    })
    if (shouldNotice('unavailable')) {
      emit(
        `[PLUMB WIKI]\nWiki context is unavailable for this prompt: ${service.reason}\n` +
          `Run /plumb-doctor to diagnose. (This notice is rate limited; retrieval will ` +
          `resume automatically once the service is healthy.)\n[/PLUMB WIKI]`,
      )
    }
    process.exit(0)
  }

  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(),
    service.spawned ? COLD_SEARCH_DEADLINE_MS : SEARCH_DEADLINE_MS,
  )
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
      spawned: service.spawned,
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

  // Ground truth for degradation is the mode that actually served this query,
  // not the readiness snapshot taken before it. Only warn when a hybrid mode was
  // configured -- a deliberately keyword-only install is not degraded.
  const degraded =
    String(payload.mode || '').startsWith('bm25') && String(service.searchMode || '').includes('hybrid')
  const warning = degraded && shouldNotice('degraded')
    ? `Plumb returned keyword-only results (mode ${payload.mode}); vector search is unavailable. Run /plumb-doctor.`
    : undefined

  const { block, tokensUsed, injected, droppedToBudget, truncated } = formatBlock(results, warning)
  recordTelemetry({
    status: 'fired',
    reason: 'ok',
    instance,
    // Distinguishes "we paid for a cold start" from steady state, so the
    // telemetry can tell a slow install apart from a slow query.
    spawned: service.spawned,
    serviceWaitMs: service.elapsedMs,
    degraded,
    searchMode: payload.mode,
    candidateCount: results.length,
    resultCount: injected,
    // Watched by the daily health check: a nonzero drop rate means retrieval
    // is being paid for and thrown away.
    droppedToBudget,
    truncated,
    tokensUsed,
    elapsedMs,
  })
  emit(block)
} catch {
  // Fail open. Claude receives no additional context, but the prompt proceeds.
} finally {
  clearTimeout(timer)
}
