// Regression suite for the on-demand service lifecycle (2026-08-25).
//
// Everything here exists because the plugin cannot ask a user to supervise a
// daemon, so the service starts itself, stops itself, and must be honest about
// which of those it just did. None of these paths are exercised by a normal
// install, which is exactly why they need tests -- the multi-instance code
// went untested for the same reason and drifted.
//
// Same cgroup caveat as service.test.mjs: this suite runs far above the
// engine's vector-search memory guard, so tests that care about hybrid mode
// override it explicitly. Tests that care about *degradation* deliberately do
// not, and use the guard as a convenient way to make the embedder unavailable.
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { readiness, autoSpawnAllowed, ensureService } from '../src/ensure-service.mjs'
import { fileURLToPath } from 'node:url'

const SNAPSHOT = process.env.WIKI_TEST_SNAPSHOT
  || fileURLToPath(new URL('../../../../plumb-benchmark/real-wiki/artifacts/v7-snapshot-20260807', import.meta.url))
const TEST_DB = process.env.WIKI_TEST_DB || `${SNAPSHOT}/wiki.db`
const TEST_ROOT = process.env.WIKI_TEST_ROOT || `${SNAPSHOT}/wiki`

// The default fixture is a snapshot of a real wiki that lives in a separate
// private repository, so a public CI runner will never have it. Skipping is the
// honest outcome there -- better than inventing assertions that pass without
// testing retrieval. The cross-platform workflow covers CI with a synthetic
// corpus instead (see .github/scripts/smoke-test.mjs).
const FIXTURE_PRESENT = existsSync(TEST_DB) && existsSync(TEST_ROOT)
const SKIP = FIXTURE_PRESENT
  ? false
  : `benchmark fixture not present (set WIKI_TEST_DB / WIKI_TEST_ROOT, or WIKI_TEST_SNAPSHOT)`
if (SKIP) console.error(`# SKIP ${SKIP}`)
const test = (name, fn) => nodeTest(name, { skip: SKIP }, fn)

const SERVER = new URL('../src/server.js', import.meta.url).pathname
const HIGH_GUARD = String(64 * 1024 * 1024 * 1024)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Several tests here need a *known* port rather than an ephemeral one, because
 * what they are testing is port binding itself -- two processes racing for the
 * same address, or a shared SO_REUSEPORT socket.
 *
 * Hardcoding those numbers made the suite flaky the moment it ran alongside
 * anything else: turbo runs packages concurrently, and a second copy of this
 * file, or an unrelated service on the same machine, collides. Asking the
 * kernel for a free port and releasing it keeps the number known while making
 * collisions vanishingly unlikely.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(String(port)))
    })
  })
}

function launch(extraEnv = {}, { port = '0' } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: port,
      WIKI_DB_PATH: TEST_DB,
      WIKI_ROOT: TEST_ROOT,
      WIKI_SEARCH_MODE: 'fast-hybrid',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not start within 20s')), 20_000)
    let buffer = ''
    child.stdout.on('data', (data) => {
      buffer += data.toString()
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          logs.push(entry)
          if (entry.event === 'listening') { clearTimeout(timer); resolve(entry.port) }
        } catch { /* non-JSON noise */ }
      }
    })
    child.stderr.on('data', () => {})
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early: ${code}`)) })
  })
  // Race-loser tests deliberately never await `ready`, because losing the port
  // is the expected outcome there. Attach a handler so that rejection is not
  // reported as an unhandled one; callers that do await still see the error.
  ready.catch(() => {})
  return { child, logs, ready }
}

async function stop(service) {
  if (!service || service.child.exitCode !== null) return
  await new Promise((resolve) => {
    service.child.once('exit', resolve)
    service.child.kill('SIGTERM')
  })
}

const exited = (service) =>
  new Promise((resolve) => {
    if (service.child.exitCode !== null) return resolve(service.child.exitCode)
    service.child.once('exit', resolve)
  })

// --- /reindex reachability -------------------------------------------------
// The guard used to key on which listener accepted the request, which made the
// route unreachable in the configuration every plugin user runs.

test('single instance serves /reindex on its only port', async () => {
  const service = launch({ WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD })
  const port = await service.ready
  try {
    const response = await fetch(`http://127.0.0.1:${port}/reindex`)
    const body = await response.json()
    assert.equal(response.status, 200, 'push invalidation must work without an admin port')
    assert.equal(body.ok, true)
    assert.equal(typeof body.indexGeneration, 'number')
  } finally {
    await stop(service)
  }
})

test('shared port still refuses /reindex when REUSE_PORT balances across instances', async () => {
  const port = await freePort()
  const service = launch({ REUSE_PORT: '1', WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD }, { port })
  await service.ready
  try {
    const shared = await fetch(`http://127.0.0.1:${port}/reindex`)
    assert.equal(shared.status, 404, 'a load-balanced /reindex would leave sibling instances stale')
    assert.match((await shared.json()).error, /admin-port only/)
  } finally {
    await stop(service)
  }
})

// --- idle shutdown ---------------------------------------------------------

test('idle shutdown is off by default, so supervised daemons are unaffected', async () => {
  const service = launch({ WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD })
  const port = await service.ready
  try {
    await sleep(3000)
    assert.equal(service.child.exitCode, null, 'a daemon with no IDLE_TIMEOUT_MS must never self-exit')
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
  } finally {
    await stop(service)
  }
})

test('idle window elapses with no work: the service exits cleanly on its own', async () => {
  const service = launch({ IDLE_TIMEOUT_MS: '2000', WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD })
  await service.ready
  const code = await Promise.race([exited(service), sleep(20_000).then(() => 'timeout')])
  assert.equal(code, 0, 'idle shutdown must be a clean exit, not a crash')
  assert.ok(
    service.logs.some((entry) => entry.event === 'shutdown' && entry.reason === 'idle'),
    'the reason must be logged, or an operator cannot tell idle-exit from a crash',
  )
})

test('/health polling does not count as activity', async () => {
  // A watchdog or plumb-doctor polling health every few seconds would otherwise
  // pin the service alive forever and the memory would never come back.
  const service = launch({ IDLE_TIMEOUT_MS: '2000', WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD })
  const port = await service.ready
  const poller = setInterval(() => {
    fetch(`http://127.0.0.1:${port}/health`).catch(() => {})
  }, 300)
  try {
    const code = await Promise.race([exited(service), sleep(20_000).then(() => 'timeout')])
    assert.equal(code, 0, 'health checks must not keep an otherwise idle service alive')
  } finally {
    clearInterval(poller)
  }
})

test('real queries do reset the idle window', async () => {
  const service = launch({ IDLE_TIMEOUT_MS: '2000', WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD })
  const port = await service.ready
  const worker = setInterval(() => {
    fetch(`http://127.0.0.1:${port}/search?q=agents&topK=3`).catch(() => {})
  }, 500)
  try {
    const outcome = await Promise.race([exited(service), sleep(6000).then(() => 'alive')])
    assert.equal(outcome, 'alive', 'a service under continuous load must not idle out from under the user')
  } finally {
    clearInterval(worker)
    await stop(service)
  }
})

// --- the port bind as a mutex ----------------------------------------------

test('losing the port race exits cleanly, and only counts as success when racing', async () => {
  const port = await freePort()
  const winner = launch({ WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD }, { port })
  await winner.ready
  try {
    const racer = launch({ SPAWN_RACE_OK: '1', WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD }, { port })
    const racerCode = await Promise.race([exited(racer), sleep(20_000).then(() => 'timeout')])
    assert.equal(racerCode, 0, 'a spawn helper that loses the race already has what it wanted')
    assert.ok(
      racer.logs.some((entry) => entry.event === 'port_in_use'),
      'the loss must be logged rather than raising an unhandled EADDRINUSE',
    )

    const manual = launch({ WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD }, { port })
    const manualCode = await Promise.race([exited(manual), sleep(20_000).then(() => 'timeout')])
    assert.equal(manualCode, 1, 'a manual or systemd start must fail loudly, not report success')
  } finally {
    await stop(winner)
  }
})

// --- readiness -------------------------------------------------------------
// Conflating "up" with "has vectors" turned every transient warmup and tripped
// memory guard into a reported outage that injected nothing at all.

test('readiness separates "can answer" from "answers well"', () => {
  const hybridReady = {
    ok: true,
    stats: { bm25IndexReady: true, searchMode: 'fast-hybrid', embedder: { resident: true } },
  }
  const hybridWarming = {
    ok: true,
    stats: { bm25IndexReady: true, searchMode: 'fast-hybrid', embedder: { resident: false } },
  }
  const keywordOnlyByDesign = {
    ok: true,
    stats: { bm25IndexReady: true, searchMode: 'bm25', embedder: { resident: false } },
  }

  assert.deepEqual(
    { up: readiness(hybridReady).up, degraded: readiness(hybridReady).degraded },
    { up: true, degraded: false },
  )
  assert.deepEqual(
    { up: readiness(hybridWarming).up, degraded: readiness(hybridWarming).degraded },
    { up: true, degraded: true },
    'no embedder means keyword-only results, not an outage',
  )
  assert.deepEqual(
    { up: readiness(keywordOnlyByDesign).up, degraded: readiness(keywordOnlyByDesign).degraded },
    { up: true, degraded: false },
    'a deliberately keyword-only install is not degraded',
  )
  assert.equal(readiness(null).up, false)
  assert.equal(readiness({ ok: false }).up, false)
})

// --- auto-spawn refusals ---------------------------------------------------

test('auto-spawn refuses the configurations where starting a service is wrong', () => {
  const saved = { reuse: process.env.REUSE_PORT, off: process.env.PLUMB_WIKI_AUTOSPAWN }
  try {
    delete process.env.REUSE_PORT
    delete process.env.PLUMB_WIKI_AUTOSPAWN
    assert.equal(autoSpawnAllowed('http://127.0.0.1:18795'), true)

    assert.equal(
      autoSpawnAllowed('http://wiki.internal:18795'), false,
      'a deliberately remote service is not fixed by starting a local copy',
    )

    process.env.REUSE_PORT = '1'
    assert.equal(
      autoSpawnAllowed('http://127.0.0.1:18795'), false,
      'SO_REUSEPORT removes the bind exclusion, so sessions would stack up instances',
    )
    delete process.env.REUSE_PORT

    process.env.PLUMB_WIKI_AUTOSPAWN = '0'
    assert.equal(autoSpawnAllowed('http://127.0.0.1:18795'), false)
  } finally {
    if (saved.reuse === undefined) delete process.env.REUSE_PORT; else process.env.REUSE_PORT = saved.reuse
    if (saved.off === undefined) delete process.env.PLUMB_WIKI_AUTOSPAWN; else process.env.PLUMB_WIKI_AUTOSPAWN = saved.off
  }
})

test('ensureService reports the reason instead of failing silently', async () => {
  const saved = process.env.PLUMB_WIKI_AUTOSPAWN
  process.env.PLUMB_WIKI_AUTOSPAWN = '0'
  try {
    const result = await ensureService({ url: `http://127.0.0.1:${await freePort()}`, coldStartBudgetMs: 1000 })
    assert.equal(result.ok, false)
    assert.match(result.reason, /auto-spawn is disabled/, 'callers need something to show the user')
  } finally {
    if (saved === undefined) delete process.env.PLUMB_WIKI_AUTOSPAWN; else process.env.PLUMB_WIKI_AUTOSPAWN = saved
  }
})

test('ensureService starts a service that is not running, and reports it spawned one', async () => {
  const url = `http://127.0.0.1:${await freePort()}`
  const env = {
    PLUMB_WIKI_IDLE_TIMEOUT_MS: '4000',
    WIKI_DB_PATH: TEST_DB,
    WIKI_ROOT: TEST_ROOT,
    WIKI_SEARCH_FAST_GUARD_BYTES: HIGH_GUARD,
    WIKI_SEARCH_CGROUP_GUARD_BYTES: HIGH_GUARD,
  }
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    const cold = await ensureService({ url, coldStartBudgetMs: 20_000 })
    assert.equal(cold.ok, true)
    assert.equal(cold.spawned, true)
    assert.equal(cold.degraded, false, 'a healthy machine should reach vector search on first start')

    const warm = await ensureService({ url, coldStartBudgetMs: 20_000 })
    assert.equal(warm.ok, true)
    assert.equal(warm.spawned, false, 'the second call must not start a second service')

    // The spawned service is detached, so shut it down through its own API
    // rather than leaking it into the rest of the suite.
    const pid = (await (await fetch(`${url}/health`)).json()).pid
    process.kill(pid, 'SIGTERM')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})
