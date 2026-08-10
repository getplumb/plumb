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

const { createWikiNavigator, searchStats, getWikiSearchMode } = await import('./wikiNavigator.js')

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
    const stats = searchStats(WIKI_DB_PATH)
    return {
      status: 200,
      body: {
        ok: true,
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
}

// Service patch (multi-instance): named handler shared by the main listener
// and the optional per-instance admin listener.
async function handleRequest(req, res) {
  const started = performance.now()
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const route = routes[url.pathname]
  let status
  let extra = {}
  try {
    if (req.method !== 'GET') {
      status = send(res, 405, { error: 'GET only' })
    } else if (!route) {
      status = send(res, 404, { error: 'Unknown route' })
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
  log({ route: url.pathname, status, elapsedMs: Math.round((performance.now() - started) * 100) / 100, ...extra })
}

const server = createServer(handleRequest)

// Service patch (multi-instance): per-instance admin listener. Started before
// the shared port so a watchdog can see an instance that is up but still
// waiting for the shared port (e.g. during cutover while another process holds
// a non-reusePort bind on it).
const adminServer = ADMIN_PORT !== undefined ? createServer(handleRequest) : null
if (adminServer) {
  adminServer.listen(ADMIN_PORT, HOST, () => {
    log({ event: 'admin_listening', host: HOST, port: adminServer.address().port })
  })
}

server.listen({ port: PORT, host: HOST, reusePort: REUSE_PORT }, async () => {
  // PORT=0 binds an ephemeral port (tests); report the real one.
  log({ event: 'listening', host: HOST, port: server.address().port, reusePort: REUSE_PORT, version: VERSION, searchMode: getWikiSearchMode() })
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

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    log({ event: 'shutdown', signal })
    if (adminServer) adminServer.close()
    server.close(() => process.exit(0))
    // systemd kills the whole cgroup (embedder child included); this timer just
    // bounds a graceful close for manual runs.
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
