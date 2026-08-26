#!/usr/bin/env node
// plumb-wiki-search: standalone HTTP service around the benchmarked
// wikiNavigator engine (extracted verbatim from terra-chat, 2026-08-09).
//
// Design contract:
//   - Loopback-only. All three consumers (injection hook, MCP server, console)
//     live on this host.
//   - GET-only JSON API: /health /search /page /tree /links /resolve
//   - Fail visible, not silent: /health reports search mode, contextual
//     coverage, and embedder residency/cooldown, because every one of those has
//     silently degraded in production before.
//   - Request logs carry timings and counts, never query text or page content.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Default the mode before first search; getWikiSearchMode() honors this env.
if (!process.env.WIKI_SEARCH_MODE) process.env.WIKI_SEARCH_MODE = 'fast-hybrid'

const { createWikiNavigator, searchStats, getWikiSearchMode, rebuildContextualIndex } = await import('./wikiNavigator.js')

// PORT=0 must survive as 0 (ephemeral bind for tests), so no `|| default`.
const PORT = Number.isInteger(Number(process.env.PORT)) && process.env.PORT !== undefined && process.env.PORT !== ''
  ? Number(process.env.PORT)
  : 18795
const HOST = '127.0.0.1'
const WIKI_DB_PATH = process.env.WIKI_DB_PATH || join(homedir(), '.plumb', 'wiki.db')
const WIKI_ROOT = process.env.WIKI_ROOT || join(homedir(), '.plumb', 'wiki')
// The engine has no internal deadline; a wedged embedder child would hang
// requests forever without this. On timeout the client gets a 503 and the
// underlying promise is abandoned (it settles into a resolved race, harmless).
const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 10_000

// Service patch (multi-instance, 2026-08-10): identity and bind options for
// running N copies of this service behind one shared port.
//   INSTANCE_ID  labels every log line, /health, and the x-plumb-instance
//                response header so clients and telemetry can attribute work.
//   REUSE_PORT=1 binds PORT with SO_REUSEPORT; the kernel balances new
//                connections across instances and stops routing to a socket
//                the moment its owner dies.
//   ADMIN_PORT   optional second listener serving the same routes, because the
//                shared port cannot target a specific instance for /health.
const INSTANCE_ID = process.env.INSTANCE_ID || 'single'
const REUSE_PORT = process.env.REUSE_PORT === '1'
const ADMIN_PORT = process.env.ADMIN_PORT !== undefined && process.env.ADMIN_PORT !== ''
  ? Number(process.env.ADMIN_PORT)
  : undefined

// On-demand lifecycle (plugin install, 2026-08-25). The plugin spawns this
// service lazily on the first hook or MCP call rather than supervising it 24/7,
// so it needs to hand the memory back when the user walks away.
//   IDLE_TIMEOUT_MS  0 disables idle shutdown, and 0 is the default: a
//                    long-running supervised daemon (the author's systemd
//                    units) must keep behaving exactly as it does today. The
//                    spawn helper opts in explicitly when it starts a service.
//   SPAWN_RACE_OK=1  losing the port race is a success, not a failure. Set by
//                    the spawn helper, where a rival instance winning means the
//                    caller's invariant already holds. Unset for manual or
//                    systemd starts, which must still fail loudly.
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 0
const SPAWN_RACE_OK = process.env.SPAWN_RACE_OK === '1'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const STARTED_AT = Date.now()
const navigator = createWikiNavigator({ wikiRoot: WIKI_ROOT, wikiDbPath: WIKI_DB_PATH })

const VALIDATION_ERRORS = new Set([
  'Wiki path is required',
  'Invalid wiki path',
  'Wiki page must be Markdown',
])

function log(entry) {
  // Service patch (multi-instance): instance label on every line.
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), instance: INSTANCE_ID, ...entry })}\n`)
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Service patch (multi-instance): attribution header. The /search body must
    // stay byte-identical to the engine output (parity contract), so the
    // instance id rides a header instead.
    'x-plumb-instance': INSTANCE_ID,
  })
  res.end(payload)
  return status
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const routes = {
  '/health': async () => {
    // A missing or unreadable index must come back as a *diagnosis*, not a 500.
    // /health is what every caller reaches for when something is wrong -- the
    // spawn helper, the doctor, a watchdog -- and a 500 tells all three of them
    // nothing. This surfaced as a fresh install failing with "did not become
    // ready" when the real answer was "there is no wiki.db yet".
    let stats = null
    let statsError = null
    try {
      stats = searchStats(WIKI_DB_PATH)
    } catch (error) {
      statsError = error instanceof Error ? error.message : String(error)
    }
    return {
      status: 200,
      body: {
        ok: statsError === null,
        ...(statsError ? { error: `index unavailable at ${WIKI_DB_PATH}: ${statsError}` } : {}),
        service: 'plumb-wiki-search',
        instance: INSTANCE_ID,
        version: VERSION,
        pid: process.pid,
        uptimeMs: Date.now() - STARTED_AT,
        rssBytes: process.memoryUsage.rss(),
        wikiDbPath: WIKI_DB_PATH,
        wikiRoot: WIKI_ROOT,
        stats,
      },
    }
  },
  '/search': async (params) => {
    const query = params.get('q') || ''
    const topK = params.get('topK')
    const value = await withTimeout(
      navigator.search(query, topK === null ? undefined : Number(topK)),
      SEARCH_TIMEOUT_MS,
      'search',
    )
    return { status: 200, body: value, resultCount: value.results.length, mode: value.mode }
  },
  '/page': async (params) => {
    const page = navigator.page(params.get('path') || '')
    if (!page) return { status: 404, body: { error: 'Page not found' } }
    return { status: 200, body: page }
  },
  '/tree': async () => ({ status: 200, body: { tree: navigator.tree() } }),
  '/links': async (params) => ({ status: 200, body: navigator.links(params.get('path') || '') }),
  '/resolve': async (params) => ({ status: 200, body: { path: navigator.resolve(params.get('title') || '') } }),
  // Push invalidation (2026-08-13). The writer that just committed to wiki.db
  // calls this so the refresh happens when the write happens, instead of being
  // billed to whichever user query arrives first afterwards (~330ms, and the
  // reason prompt-injection latency was bimodal). Still GET, per the API's
  // GET-only convention -- this is loopback-only and idempotent.
  '/reindex': async (params) => {
    const before = searchStats(WIKI_DB_PATH).indexGeneration
    const started = performance.now()
    const index = await withTimeout(
      rebuildContextualIndex(WIKI_DB_PATH, { force: params.get('force') === '1' }),
      SEARCH_TIMEOUT_MS,
      'reindex',
    )
    // generation only moves when rows were actually re-read, so `rebuilt: false`
    // honestly reports "already current" rather than pretending work happened.
    return {
      status: 200,
      body: {
        ok: true,
        instance: INSTANCE_ID,
        rebuilt: index.generation !== before,
        indexGeneration: index.generation,
        chunkCount: index.chunks.length,
        useContextual: index.useContextual,
        rebuildMs: Math.round((performance.now() - started) * 100) / 100,
      },
      indexGeneration: index.generation,
    }
  },
}

// Routes that must never be served on a *shared* port. A /reindex arriving on a
// SO_REUSEPORT socket is load-balanced to exactly one of the N instances,
// silently leaving the others stale -- a bug that would look like it worked.
// Callers must ping each instance's own ADMIN_PORT. Rejected loudly, per this
// file's fail-visible contract.
//
// The gate is REUSE_PORT, not "did the admin listener accept this?" (fixed
// 2026-08-25). Keying on the listener meant a single-instance install -- which
// has no admin listener at all -- could not reach /reindex on any port, so push
// invalidation was dead and every refresh was billed to the next user query.
// With REUSE_PORT off there is exactly one process behind the port, so the route
// is unambiguous and safe to serve there.
const ADMIN_ONLY_ROUTES = new Set(['/reindex'])

// Service patch (multi-instance): named handler shared by the main listener
// and the optional per-instance admin listener.
// `admin` is passed explicitly by whichever listener accepted the connection,
// rather than sniffed from req.socket.localPort: the listener knows the answer
// for certain, and it keeps the shared/admin distinction a property of the
// wiring instead of an inference. It rides the log line so a per-instance
// /reindex is attributable after the fact.
async function handleRequest(req, res, { admin = false } = {}) {
  const started = performance.now()
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const route = routes[url.pathname]
  // Idle accounting deliberately ignores /health: a watchdog or `plumb-doctor`
  // polling health every minute would otherwise pin the service alive forever
  // and the on-demand lifecycle would never return the memory.
  if (url.pathname !== '/health') lastWorkAt = Date.now()
  inFlight += 1
  let status
  let extra = {}
  try {
    if (req.method !== 'GET') {
      status = send(res, 405, { error: 'GET only' })
    } else if (!route) {
      status = send(res, 404, { error: 'Unknown route' })
    } else if (!admin && REUSE_PORT && ADMIN_ONLY_ROUTES.has(url.pathname)) {
      status = send(res, 404, {
        error: `${url.pathname} is admin-port only: the shared port load-balances to one instance, which would leave the others stale. Call each instance's ADMIN_PORT.`,
      })
    } else {
      const result = await route(url.searchParams)
      const { status: routeStatus, body, ...rest } = result
      extra = rest
      status = send(res, routeStatus, body)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (VALIDATION_ERRORS.has(message)) status = send(res, 400, { error: message })
    else if (message.includes('timed out')) status = send(res, 503, { error: message })
    else status = send(res, 500, { error: message })
  }
  inFlight -= 1
  log({ route: url.pathname, listener: admin ? 'admin' : 'shared', status, elapsedMs: Math.round((performance.now() - started) * 100) / 100, ...extra })
}

let lastWorkAt = Date.now()
let inFlight = 0

function shutdown(reason) {
  log({ event: 'shutdown', reason })
  // Close the listeners before exiting so anything arriving in the gap gets a
  // clean connection-refused. Callers treat that as "spawn one and wait", which
  // is correct and costs them one cold start.
  if (adminServer) adminServer.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

if (IDLE_TIMEOUT_MS > 0) {
  const tick = Math.max(1000, Math.min(IDLE_TIMEOUT_MS, 30_000))
  setInterval(() => {
    if (inFlight > 0) return
    if (Date.now() - lastWorkAt < IDLE_TIMEOUT_MS) return
    shutdown('idle')
  }, tick).unref()
}

const server = createServer((req, res) => handleRequest(req, res, { admin: false }))

// Service patch (multi-instance): per-instance admin listener. Started before
// the shared port so a watchdog can see an instance that is up but still
// waiting for the shared port (e.g. during cutover while another process holds
// a non-reusePort bind on it).
const adminServer = ADMIN_PORT !== undefined
  ? createServer((req, res) => handleRequest(req, res, { admin: true }))
  : null
if (adminServer) {
  adminServer.listen(ADMIN_PORT, HOST, () => {
    log({ event: 'admin_listening', host: HOST, port: adminServer.address().port })
  })
}

server.on('error', (error) => {
  if (error?.code !== 'EADDRINUSE') throw error
  // Two sessions cold-starting at once both spawn; the port bind is the mutex,
  // so exactly one wins and the rest land here. For the spawn helper that is the
  // desired end state -- a service is listening -- so it exits 0. A manual or
  // systemd start has no such rival in mind and must still fail loudly, or a
  // supervisor would read "already running" as "started successfully".
  log({ event: 'port_in_use', port: PORT, raceOk: SPAWN_RACE_OK })
  process.exit(SPAWN_RACE_OK ? 0 : 1)
})

server.listen({ port: PORT, host: HOST, reusePort: REUSE_PORT }, async () => {
  // PORT=0 binds an ephemeral port (tests); report the real one.
  log({ event: 'listening', host: HOST, port: server.address().port, reusePort: REUSE_PORT, version: VERSION, searchMode: getWikiSearchMode(), idleTimeoutMs: IDLE_TIMEOUT_MS })
  // Warm the index and resident embedder so the first real query is fast, and
  // log what mode warmup actually achieved (bm25-* here means degraded).
  try {
    const warmStart = performance.now()
    const warm = await navigator.search('service warmup priming query', 5)
    log({ event: 'warmup', mode: warm.mode, elapsedMs: Math.round(performance.now() - warmStart) })
  } catch (error) {
    log({ event: 'warmup_failed', error: error instanceof Error ? error.message : String(error) })
  }
})

// systemd kills the whole cgroup (embedder child included); shutdown()'s timer
// just bounds a graceful close for manual runs.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => shutdown(signal))
}
