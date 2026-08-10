// Regression suite for the wiki-search HTTP service.
//
// Runs against the frozen v7 benchmark snapshot by default (deterministic,
// never mutated), overridable via WIKI_TEST_DB / WIKI_TEST_ROOT.
//
// The session cgroup this suite runs in is far above the engine's vector-search
// memory guard, so every spawned service gets an explicit high guard override;
// without it the guard silently degrades searches to BM25-only and the hybrid
// parity assertions would be testing the wrong path.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const SNAPSHOT = '/home/openclaw-host/.openclaw/workspace/plumb-benchmark/real-wiki/artifacts/v7-snapshot-20260807'
const TEST_DB = process.env.WIKI_TEST_DB || `${SNAPSHOT}/wiki.db`
const TEST_ROOT = process.env.WIKI_TEST_ROOT || `${SNAPSHOT}/wiki`
const SERVER = new URL('../src/server.js', import.meta.url).pathname
const HIGH_GUARD = String(64 * 1024 * 1024 * 1024)

async function startService(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: '0',
      WIKI_DB_PATH: TEST_DB,
      WIKI_ROOT: TEST_ROOT,
      WIKI_SEARCH_MODE: 'fast-hybrid',
      WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD,
      WIKI_SEARCH_GUARD_BYTES: HIGH_GUARD,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  let stdoutBuffer = ''
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('service did not start within 15s')), 15_000)
    child.stdout.on('data', data => {
      stdoutBuffer += data.toString()
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          logs.push(entry)
          if (entry.event === 'listening') {
            clearTimeout(timer)
            resolvePromise(entry.port)
          }
        } catch {
          // non-JSON noise (e.g. node experimental warnings routed oddly)
        }
      }
    })
    child.stderr.on('data', () => {})
    child.once('exit', code => {
      clearTimeout(timer)
      rejectPromise(new Error(`service exited early with code ${code}`))
    })
  })
  return { child, port, logs, url: (path) => `http://127.0.0.1:${port}${path}` }
}

async function stopService(service) {
  if (!service) return
  service.child.kill('SIGTERM')
  await once(service.child, 'exit').catch(() => {})
}

async function getJson(service, path) {
  const response = await fetch(service.url(path))
  return { status: response.status, body: await response.json() }
}

async function waitForWarmup(service) {
  for (let i = 0; i < 300; i += 1) {
    if (service.logs.some(entry => entry.event === 'warmup' || entry.event === 'warmup_failed')) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('warmup never completed')
}

// ── Shared long-lived instance for most tests ────────────────────────────────
let service

before(async () => {
  service = await startService()
  await waitForWarmup(service)
})

after(async () => {
  await stopService(service)
})

test('health reports ok with mode, coverage, and embedder state', async () => {
  const { status, body } = await getJson(service, '/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.service, 'plumb-wiki-search')
  assert.equal(body.stats.searchMode, 'fast-hybrid')
  assert.equal(typeof body.stats.chunkCount, 'number')
  assert.ok(body.stats.chunkCount > 100, `expected an indexed corpus, got ${body.stats.chunkCount} chunks`)
  assert.equal(typeof body.stats.coverageRatio, 'number')
  assert.equal(typeof body.stats.embedder.resident, 'boolean')
  assert.ok(body.rssBytes > 0)
})

test('warmup achieved hybrid (not silently degraded to BM25)', async () => {
  const warmup = service.logs.find(entry => entry.event === 'warmup')
  assert.ok(warmup, 'warmup log entry missing')
  assert.match(warmup.mode, /^hybrid-/, `warmup mode was ${warmup.mode}; hybrid means guard+embedder are healthy`)
})

test('search returns ranked results in a -fast mode', async () => {
  const { status, body } = await getJson(service, '/search?q=Plumb+benchmark+retrieval+experiments&topK=5')
  assert.equal(status, 200)
  assert.match(body.mode, /-fast$/)
  assert.ok(body.results.length > 0 && body.results.length <= 5)
  for (const result of body.results) {
    assert.equal(typeof result.path, 'string')
    assert.equal(typeof result.title, 'string')
    assert.equal(typeof result.snippet, 'string')
    assert.ok(result.snippet.length <= 900)
    assert.equal(typeof result.score, 'number')
  }
  const paths = body.results.map(result => result.path)
  assert.equal(new Set(paths).size, paths.length, 'one result per page')
})

test('service results are byte-identical to a direct in-process engine call (hybrid parity)', async () => {
  process.env.WIKI_SEARCH_MODE = 'fast-hybrid'
  process.env.WIKI_SEARCH_FAST_GUARD_BYTES = HIGH_GUARD
  process.env.WIKI_TRANSFORMERS_PATH = process.env.WIKI_TRANSFORMERS_PATH
    || new URL('../node_modules/@xenova/transformers/src/transformers.js', import.meta.url).pathname
  const { searchWiki } = await import('../src/wikiNavigator.js')
  const queries = [
    'Samsara interview loop case study',
    'contextual retrieval coverage gate',
    'OpenClaw gateway extension deployment',
  ]
  for (const query of queries) {
    const direct = await searchWiki(query, TEST_DB, 5)
    const { status, body } = await getJson(service, `/search?q=${encodeURIComponent(query)}&topK=5`)
    assert.equal(status, 200)
    assert.deepEqual(body, JSON.parse(JSON.stringify(direct)), `parity failed for: ${query}`)
  }
})

test('empty query returns empty results, not an error', async () => {
  const { status, body } = await getJson(service, '/search?q=')
  assert.equal(status, 200)
  assert.deepEqual(body.results, [])
})

test('topK is clamped to [1, 20]', async () => {
  const big = await getJson(service, '/search?q=Plumb&topK=9999')
  assert.equal(big.status, 200)
  assert.ok(big.body.results.length <= 20)
  const zero = await getJson(service, '/search?q=Plumb&topK=0')
  assert.equal(zero.status, 200)
  assert.ok(zero.body.results.length <= 10)
})

test('oversized query is truncated, not rejected', async () => {
  const huge = encodeURIComponent(`Plumb ${'x'.repeat(10_000)}`)
  const { status, body } = await getJson(service, `/search?q=${huge}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.results))
})

test('page traversal attempts are rejected or safely normalized', async () => {
  // Dot-dot segments and empty paths are hard 400s.
  for (const attempt of ['..%2F..%2Fetc%2Fpasswd', 'a%2F..%2Fb.md', '']) {
    const { status } = await getJson(service, `/page?path=${attempt}`)
    assert.equal(status, 400, `expected 400 for traversal attempt: ${attempt}`)
  }
  // An absolute path is normalized into the wiki root (leading slash stripped),
  // so /etc/passwd.md becomes the nonexistent relative page etc/passwd.md: 404,
  // and critically not a file disclosure.
  const absolute = await getJson(service, '/page?path=%2Fetc%2Fpasswd.md')
  assert.equal(absolute.status, 404)
})

test('page round-trip: search result path resolves to a full page with body and links', async () => {
  const search = await getJson(service, '/search?q=Plumb+benchmark&topK=1')
  const path = search.body.results[0]?.path
  assert.ok(path, 'search returned no result to round-trip')
  const { status, body } = await getJson(service, `/page?path=${encodeURIComponent(path)}`)
  assert.equal(status, 200)
  assert.equal(body.path, path)
  assert.ok(body.body.length > 0)
  assert.ok(Array.isArray(body.links.outbound))
  assert.ok(Array.isArray(body.links.inbound))
})

test('missing page returns 404', async () => {
  const { status } = await getJson(service, '/page?path=nope%2Fdoes-not-exist.md')
  assert.equal(status, 404)
})

test('links requires a markdown path', async () => {
  const bad = await getJson(service, '/links?path=companies')
  assert.equal(bad.status, 400)
})

test('resolve maps a page title back to its path', async () => {
  const search = await getJson(service, '/search?q=Plumb+benchmark&topK=1')
  const { title, path } = search.body.results[0]
  const { status, body } = await getJson(service, `/resolve?title=${encodeURIComponent(title)}`)
  assert.equal(status, 200)
  assert.equal(body.path, path)
})

test('tree returns directories and pages, archive demoted last', async () => {
  const { status, body } = await getJson(service, '/tree')
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.tree) && body.tree.length > 0)
  const hidden = body.tree.filter(node => node.hidden)
  for (const node of hidden) {
    assert.ok(body.tree.indexOf(node) >= body.tree.length - hidden.length, 'hidden dirs must sort last')
  }
})

test('unknown route 404s and non-GET 405s', async () => {
  const unknown = await getJson(service, '/nope')
  assert.equal(unknown.status, 404)
  const post = await fetch(service.url('/search?q=x'), { method: 'POST' })
  assert.equal(post.status, 405)
})

test('20 concurrent unique searches all succeed', async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) => getJson(service, `/search?q=concurrent+probe+${index}+retrieval&topK=3`)),
  )
  for (const { status } of responses) assert.equal(status, 200)
})

// ── Isolated instances for state-poisoning scenarios ─────────────────────────

test('SIGKILLed embedder degrades to BM25 with a 200, and health reports the cooldown', async () => {
  const isolated = await startService()
  try {
    await waitForWarmup(isolated)
    const healthy = await getJson(isolated, '/health')
    const embedderPid = healthy.body.stats.embedder.pid
    assert.ok(embedderPid, 'embedder should be resident after warmup')
    process.kill(embedderPid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 300))
    const { status, body } = await getJson(isolated, '/search?q=degraded+path+probe&topK=3')
    assert.equal(status, 200, 'search must survive an embedder crash')
    assert.match(body.mode, /^bm25-/, `expected BM25 fallback, got ${body.mode}`)
    const after = await getJson(isolated, '/health')
    assert.equal(after.body.stats.embedder.inCooldown, true, 'health must expose the cooldown')
  } finally {
    await stopService(isolated)
  }
})

test('one embedder crash recovers after a short backoff, not a 10-minute lockout', async () => {
  const isolated = await startService({ WIKI_EMBEDDER_RETRY_BASE_MS: '400' })
  try {
    await waitForWarmup(isolated)
    const healthy = await getJson(isolated, '/health')
    process.kill(healthy.body.stats.embedder.pid, 'SIGKILL')
    await new Promise(r => setTimeout(r, 150))
    // Inside the 400ms window: degraded but serving.
    const during = await getJson(isolated, '/search?q=inside+backoff+window+probe&topK=2')
    assert.equal(during.status, 200)
    assert.match(during.body.mode, /^bm25-/)
    // Past the window: next query respawns the embedder and vectors return.
    await new Promise(r => setTimeout(r, 700))
    const after = await getJson(isolated, '/search?q=after+backoff+recovery+probe&topK=2')
    assert.equal(after.status, 200)
    assert.match(after.body.mode, /^hybrid-/, `expected vector recovery after backoff, got ${after.body.mode}`)
    const stats = await getJson(isolated, '/health')
    assert.equal(stats.body.stats.embedder.resident, true)
    assert.equal(stats.body.stats.embedder.failureStreak, 0, 'successful embed must reset the streak')
  } finally {
    await stopService(isolated)
  }
})

test('persistent embedder breakage escalates the backoff exponentially', async () => {
  const isolated = await startService({
    WIKI_TRANSFORMERS_PATH: '/nonexistent/transformers.js',
    WIKI_EMBEDDER_RETRY_BASE_MS: '200',
  })
  try {
    await waitForWarmup(isolated) // warmup itself fails the first spawn
    // Drive additional failed respawn attempts, waiting out each cooldown.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stats = await getJson(isolated, '/health')
      await new Promise(r => setTimeout(r, (stats.body.stats.embedder.currentCooldownMs || 200) + 250))
      const { status, body } = await getJson(isolated, `/search?q=escalation+probe+${attempt}&topK=2`)
      assert.equal(status, 200, 'must keep serving through persistent breakage')
      assert.match(body.mode, /^bm25-/)
    }
    const final = await getJson(isolated, '/health')
    const { failureStreak, currentCooldownMs } = final.body.stats.embedder
    assert.ok(failureStreak >= 2, `expected an escalating streak, got ${failureStreak}`)
    assert.equal(
      currentCooldownMs,
      Math.min(600000, 200 * 2 ** Math.min(failureStreak - 1, 30)),
      'cooldown must follow the exponential formula',
    )
  } finally {
    await stopService(isolated)
  }
})

test('keep-warm mode respawns a crashed embedder by itself, with no query needed', async () => {
  const isolated = await startService({ WIKI_EMBEDDER_IDLE_MS: '0', WIKI_EMBEDDER_RETRY_BASE_MS: '300' })
  try {
    await waitForWarmup(isolated)
    const healthy = await getJson(isolated, '/health')
    const crashedPid = healthy.body.stats.embedder.pid
    process.kill(crashedPid, 'SIGKILL')
    // Poll ONLY /health (which never triggers a spawn) until the supervisor
    // brings the embedder back on its own: backoff 300ms + model load.
    // Residency appears at spawn; the streak resets ~600ms later when the
    // probe embed completes. Poll for the fully-recovered state (both).
    let recovered = null
    for (let i = 0; i < 100; i += 1) {
      await new Promise(r => setTimeout(r, 200))
      const { body } = await getJson(isolated, '/health')
      const embedder = body.stats.embedder
      if (embedder.resident && embedder.pid !== crashedPid && embedder.failureStreak === 0) {
        recovered = embedder
        break
      }
    }
    assert.ok(recovered, 'embedder never fully self-recovered (resident + probe-reset streak) without a query')
    // And the first real query after recovery is already hybrid.
    const { body } = await getJson(isolated, '/search?q=first+query+after+self+respawn&topK=2')
    assert.match(body.mode, /^hybrid-/, `expected hybrid immediately, got ${body.mode}`)
  } finally {
    await stopService(isolated)
  }
})

test('idle knob: short window stops the embedder cleanly (no cooldown), next query respawns', async () => {
  const isolated = await startService({ WIKI_EMBEDDER_IDLE_MS: '500' })
  try {
    await waitForWarmup(isolated)
    // Wait past the idle window; the embedder should stop itself.
    await new Promise(r => setTimeout(r, 1500))
    const idle = await getJson(isolated, '/health')
    assert.equal(idle.body.stats.embedder.resident, false, 'embedder should idle out at 500ms')
    assert.equal(idle.body.stats.embedder.inCooldown, false, 'clean idle stop must not enter cooldown')
    // Next query lazily respawns it and stays hybrid.
    const { status, body } = await getJson(isolated, '/search?q=respawn+after+idle+probe&topK=3')
    assert.equal(status, 200)
    assert.match(body.mode, /^hybrid-/, `expected hybrid after respawn, got ${body.mode}`)
  } finally {
    await stopService(isolated)
  }
})

test('keep-warm mode (WIKI_EMBEDDER_IDLE_MS=0): embedder survives a window that would idle it out', async () => {
  const isolated = await startService({ WIKI_EMBEDDER_IDLE_MS: '0' })
  try {
    await waitForWarmup(isolated)
    // 2s is 4x the 500ms window proven fatal in the companion test above.
    await new Promise(r => setTimeout(r, 2000))
    const { body } = await getJson(isolated, '/health')
    assert.equal(body.stats.embedder.resident, true, 'keep-warm embedder must not idle out')
  } finally {
    await stopService(isolated)
  }
})

test('search deadline converts a too-slow query into 503, not a hang', async () => {
  const isolated = await startService({ SEARCH_TIMEOUT_MS: '1' })
  try {
    // No warmup wait: the first query pays index build + model load, far over 1ms.
    const { status, body } = await getJson(isolated, '/search?q=deadline+probe')
    assert.equal(status, 503)
    assert.match(body.error, /timed out/)
  } finally {
    await stopService(isolated)
  }
})
