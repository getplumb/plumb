// Shared "is the wiki service up, and if not start it" helper for the two
// consumers that need retrieval: the UserPromptSubmit injection hook and the
// MCP server.
//
// Why on-demand rather than a 24/7 daemon (decided 2026-08-25, see
// docs/plugin-requirements.md §5a): a supervised daemon costs ~305 MB resident
// forever, and the alternative of an in-process engine per session costs more
// than that per session. Spawning lazily and idling out after 15 minutes gives
// the memory back when the user walks away, and measured spawn-to-first-answer
// is ~800ms -- slow enough to notice once, cheap enough to wait for.
//
// The contract that matters: this never fails silently. A caller that cannot
// get a service gets a reason string it is expected to surface.
import { spawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:18795'
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

const SERVER_PATH = fileURLToPath(new URL('./server.js', import.meta.url))
const LOG_PATH = process.env.PLUMB_WIKI_LOG_PATH ?? join(homedir(), '.plumb', 'logs', 'wiki-search.log')

// Health probes are cheap and the answer is usually "already up", so keep the
// warm-path probe tight. A running-but-wedged service should not cost the
// caller its whole budget before it decides to act.
const PROBE_TIMEOUT_MS = 400
const POLL_INTERVAL_MS = 50

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function probe(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Readiness is two-tier, and conflating the tiers was a real bug (2026-08-25).
 *
 * `up` means the service can answer a query at all. `degraded` means it will
 * answer with keyword-only results because the embedder is not resident --
 * which happens transiently for ~350ms after launch, and persistently whenever
 * the memory guard trips, the model download failed, or the machine is tight on
 * RAM.
 *
 * Gating `up` on the embedder turned every one of those into a reported outage
 * and injected nothing, which is strictly worse than injecting BM25 results.
 * So the caller waits briefly for vectors, then proceeds either way and reports
 * the degradation rather than hiding it -- silent keyword-only demotion is the
 * failure this project has hit more than any other.
 */
export function readiness(health) {
  if (!health?.ok) return { up: false, degraded: false }
  const stats = health.stats ?? {}
  const wantsVectors = String(stats.searchMode ?? '').includes('hybrid')
  const vectorsReady = stats.embedder?.resident === true
  return {
    up: stats.bm25IndexReady !== false,
    degraded: wantsVectors && !vectorsReady,
    searchMode: stats.searchMode,
    coverageRatio: stats.coverageRatio,
  }
}

// How long to keep waiting for the embedder once the service is already
// answering. Measured warmup lands ~350ms after the port opens; beyond a couple
// of seconds it is not coming and waiting only costs the user their prompt.
const VECTOR_GRACE_MS = Number(process.env.PLUMB_WIKI_VECTOR_GRACE_MS) || 2500

function isLoopback(url) {
  try {
    const { hostname } = new URL(url)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Auto-spawn is wrong in two configurations, and both are silent failures if we
 * get it wrong:
 *   - REUSE_PORT=1. SO_REUSEPORT means the bind no longer excludes, so the port
 *     race stops being a mutex and every session would add another instance.
 *     Multi-instance deployments are supervised on purpose; leave them alone.
 *   - A non-loopback service URL. Starting a local copy does nothing for a
 *     service the user deliberately pointed somewhere else.
 */
export function autoSpawnAllowed(url = DEFAULT_SERVICE_URL) {
  if (process.env.PLUMB_WIKI_AUTOSPAWN === '0') return false
  if (process.env.REUSE_PORT === '1') return false
  return isLoopback(url)
}

function launch(url) {
  const port = new URL(url).port || '18795'
  let stdio = 'ignore'
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    const fd = openSync(LOG_PATH, 'a')
    stdio = ['ignore', fd, fd]
  } catch {
    // Losing the log is survivable; losing the service is not. Carry on.
  }
  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio,
    env: {
      ...process.env,
      PORT: port,
      // Losing the port race means someone else is already serving, which is
      // the outcome we wanted anyway.
      SPAWN_RACE_OK: '1',
      IDLE_TIMEOUT_MS: String(process.env.PLUMB_WIKI_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS),
    },
  })
  // Detach fully: the service must outlive the hook process that started it,
  // and a hook process lives for one prompt.
  child.unref()
  return child
}

/**
 * Returns { ok, spawned, degraded, elapsedMs, reason, health }.
 *
 * `spawned` tells the caller which latency budget it should have been using --
 * a warm call has no business waiting the cold-start budget. `degraded` means
 * the answer will be keyword-only; the caller is expected to surface that, not
 * swallow it.
 */
export async function ensureService({
  url = process.env.PLUMB_WIKI_SERVICE_URL || DEFAULT_SERVICE_URL,
  coldStartBudgetMs = 10_000,
} = {}) {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)

  /** Once the service answers, give vectors a bounded grace period, then go. */
  const settle = async (health, spawned) => {
    let state = readiness(health)
    const graceUntil = Math.min(elapsed() + VECTOR_GRACE_MS, coldStartBudgetMs)
    while (state.degraded && elapsed() < graceUntil) {
      await sleep(POLL_INTERVAL_MS)
      const next = await probe(url)
      if (!next) break
      health = next
      state = readiness(health)
    }
    return {
      ok: true,
      spawned,
      degraded: state.degraded,
      searchMode: state.searchMode,
      elapsedMs: elapsed(),
      health,
    }
  }

  const warm = await probe(url)
  const warmState = readiness(warm)
  // A service that is already up and still degraded is persistently degraded --
  // the guard tripped, the model is missing, the machine is tight. Waiting the
  // vector grace here would bill every prompt for a condition that will not
  // resolve on its own. Report it and let the query proceed on BM25.
  if (warmState.up) {
    return {
      ok: true,
      spawned: false,
      degraded: warmState.degraded,
      searchMode: warmState.searchMode,
      elapsedMs: elapsed(),
      health: warm,
    }
  }

  // Answering but not usable yet: something else just started it. Wait rather
  // than piling on another spawn.
  const alreadyStarting = warm !== null

  if (!alreadyStarting && !autoSpawnAllowed(url)) {
    return {
      ok: false,
      spawned: false,
      degraded: false,
      elapsedMs: elapsed(),
      reason: process.env.REUSE_PORT === '1'
        ? 'service down and auto-spawn is disabled for multi-instance (REUSE_PORT=1) deployments'
        : `service down at ${url} and auto-spawn is disabled`,
    }
  }

  if (!alreadyStarting) launch(url)

  // Keep the last thing the service said about itself. "Did not become ready"
  // is a symptom; "there is no wiki.db" is the actual answer, and the caller is
  // expected to show it to a human.
  let lastError = null
  while (elapsed() < coldStartBudgetMs) {
    await sleep(POLL_INTERVAL_MS)
    const health = await probe(url)
    if (health?.error) lastError = health.error
    if (readiness(health).up) return settle(health, !alreadyStarting)
  }

  return {
    ok: false,
    spawned: !alreadyStarting,
    degraded: false,
    elapsedMs: elapsed(),
    reason: lastError
      ? `${lastError} (log: ${LOG_PATH})`
      : `service did not become ready within ${coldStartBudgetMs}ms (log: ${LOG_PATH})`,
  }
}

export { LOG_PATH }
