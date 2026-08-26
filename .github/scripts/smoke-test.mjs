#!/usr/bin/env node
// Cross-platform acceptance test: does a real install actually work?
//
// This is the test that matters for a release. It does not import anything from
// the source tree -- it drives the *installed packages* exactly as a user would:
// build an index, start the service, ask a question, and check that the answer
// came back through vector search rather than a keyword fallback.
//
// It exists because the failures worth catching here are install-shaped and
// platform-shaped, and none of them show up in unit tests:
//   - a native dependency that needs a compiler the runner does not have
//   - Windows path handling (`URL.pathname` yields `/C:/...`)
//   - npm hoisting placing dependencies somewhere the engine did not expect
//   - an embedding model that fails to download, leaving retrieval silently
//     degraded to keyword-only while every surface reports success
//
// The corpus is synthetic and lives here, so this runs anywhere.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALL_DIR = process.env.PLUMB_SMOKE_DIR
if (!INSTALL_DIR) fail('PLUMB_SMOKE_DIR must point at the directory where the packages were installed')

const bin = (pkg, file) => join(INSTALL_DIR, 'node_modules', '@getplumb', pkg, file)
const INDEXER = bin('wiki', join('dist', 'cli.js'))
const SERVER = bin('wiki-search-service', join('src', 'server.js'))

let failures = 0
function fail(message) {
  console.error(`FAIL  ${message}`)
  failures += 1
}
function pass(message) {
  console.log(`ok    ${message}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// --- a small synthetic corpus, written fresh so this test is hermetic -------
const PAGES = {
  'concepts/tide-pool-ecology.md': {
    type: 'concept',
    summary: 'How intertidal zonation decides which species survive at each shore height.',
    body: 'Intertidal zonation is driven by desiccation tolerance high on the shore and by ' +
      'predation and competition low on it. Barnacles hold the upper band because they ' +
      'tolerate air exposure; mussels dominate the middle until sea stars crop them back. ' +
      'See [[Keystone Predation]].',
  },
  'concepts/keystone-predation.md': {
    type: 'concept',
    summary: 'A predator whose removal collapses diversity rather than increasing it.',
    body: 'Removing a keystone predator reduces diversity, because one competitive dominant ' +
      'then monopolises the substrate. The classic demonstration removed sea stars from a ' +
      'rocky shore and watched mussels take the entire middle band. Related to ' +
      '[[Tide Pool Ecology]].',
  },
  'projects/lantern-rewrite.md': {
    type: 'project',
    summary: 'Why the Lantern parser was rewritten instead of patched.',
    body: 'We rewrote the Lantern parser rather than patching it. The deciding factor was ' +
      'that error recovery was interleaved with parsing, so every bug fix risked changing ' +
      'which syntax was accepted. Rewriting separated the two and kept a compatibility ' +
      'suite as the contract.',
  },
  'projects/harbor-migration.md': {
    type: 'project',
    summary: 'The Harbor move to Postgres, and why it slipped twice.',
    body: 'The Harbor migration to Postgres was deferred twice: first because connection ' +
      'pooling was unresolved, then because a schema change landed mid-flight. It is ' +
      'unblocked once the pooling decision is made. See [[Lantern Rewrite]].',
  },
}

// Queries deliberately share no distinctive keywords with the page that should
// win. If BM25 is silently doing all the work, these rank wrong or return
// nothing -- which is the whole point of asserting on them.
const QUERIES = [
  { q: 'why would removing one animal from an ecosystem reduce the number of species',
    expect: 'concepts/keystone-predation.md' },
  { q: 'what did we decide about the parser and what drove that call',
    expect: 'projects/lantern-rewrite.md' },
  { q: 'what is holding up the switch to a different database engine',
    expect: 'projects/harbor-migration.md' },
]

async function main() {
  if (!existsSync(INDEXER)) fail(`indexer not found at ${INDEXER}`)
  if (!existsSync(SERVER)) fail(`service not found at ${SERVER}`)
  if (failures) process.exit(1)
  pass('installed packages are present')

  const work = mkdtempSync(join(tmpdir(), 'plumb-smoke-'))
  const wikiRoot = join(work, 'wiki')
  const dbPath = join(work, 'wiki.db')
  const today = new Date().toISOString().slice(0, 10)

  for (const [rel, page] of Object.entries(PAGES)) {
    const target = join(wikiRoot, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target,
      `---\ntype: ${page.type}\ncreated: ${today}\nupdated: ${today}\n` +
      `tags: [smoke]\nconfidence: high\nsummary: ${page.summary}\n---\n\n` +
      `# ${rel.split('/').pop().replace(/\.md$/, '').replace(/-/g, ' ')}\n\n${page.body}\n`)
  }
  pass(`wrote a ${Object.keys(PAGES).length}-page synthetic wiki`)

  // --- index -----------------------------------------------------------------
  // Non-zero exit means partial contextual coverage, which would demote every
  // query to keyword-only. It is a failure, not a warning.
  const indexed = await run(process.execPath, [INDEXER, 'index', wikiRoot, '--db', dbPath], {})
  if (indexed.code !== 0) {
    fail(`indexing exited ${indexed.code}\n${indexed.output.split('\n').slice(-8).join('\n')}`)
    cleanup(work)
    process.exit(1)
  }
  pass('index built with complete contextual coverage')

  // --- serve -----------------------------------------------------------------
  const port = await freePort()
  // The service's output goes to a FILE, not a pipe, and that is load-bearing
  // on Windows. With piped stdio, exiting while the killed child's pipes were
  // still tearing down aborted the process:
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
  // exit code 127 -- AFTER printing "Smoke test passed.". Windows passed every
  // assertion and the gate reported failure. Detaching the pipe listeners first
  // was not enough; the only reliable fix is to never create the pipes.
  const logPath = join(work, 'service.log')
  const logFd = openSync(logPath, 'a')
  const service = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), WIKI_DB_PATH: dbPath, WIKI_ROOT: wikiRoot },
    stdio: ['ignore', logFd, logFd],
  })
  let spawnError = null
  service.on('error', (e) => { spawnError = e })
  const readServiceLog = () => {
    try { return readFileSync(logPath, 'utf8') } catch { return '' }
  }

  const base = `http://127.0.0.1:${port}`
  let health = null
  let lastStatus = null
  let lastBody = null
  for (let i = 0; i < 600 && !health; i += 1) {
    await sleep(250)
    if (service.exitCode !== null) break
    try {
      const r = await fetch(`${base}/health`)
      lastStatus = r.status
      if (r.ok) {
        const body = await r.json()
        lastBody = body
        if (body.ok && body.stats?.embedder?.resident) health = body
      }
    } catch (e) { lastStatus = `no response (${e.cause?.code ?? e.code ?? e.message})` }
  }

  if (!health) {
    // Report enough to diagnose from a CI log alone. An earlier version printed
    // the last 12 lines of the service log, which on a healthy-but-degraded
    // service is 12 identical /health request lines and on a service that never
    // started is nothing at all -- twice this hid the actual cause.
    const events = readServiceLog().split('\n').filter((l) => l && !l.includes('"route"'))
    fail([
      `service never became ready on ${base}`,
      `  spawn error:    ${spawnError ? `${spawnError.code} ${spawnError.message}` : 'none'}`,
      `  process:        exitCode=${service.exitCode} signal=${service.signalCode} pid=${service.pid}`,
      `  last /health:   ${lastStatus}`,
      `  last body:      ${lastBody ? JSON.stringify(lastBody) : '(never parsed a body)'}`,
      `  service stderr/stdout (${events.length} non-request lines):`,
      ...(events.length ? events.map((l) => `    ${l}`) : ['    (the service wrote nothing at all)']),
    ].join('\n'))
    await stopService(service, logFd); cleanup(work); process.exitCode = 1; return
  }
  pass(`service ready (mode ${health.stats.searchMode}, ${health.stats.chunkCount} chunks)`)

  if (health.stats.coverageRatio !== 1) {
    fail(`contextual coverage is ${health.stats.coverageRatio}, not 1 — every query would be keyword-only`)
  } else {
    pass('contextual coverage complete')
  }

  // --- search ----------------------------------------------------------------
  for (const { q, expect } of QUERIES) {
    try {
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&topK=3`)
      const body = await r.json()
      const paths = (body.results ?? []).map((r) => r.path)
      const rank = paths.indexOf(expect)
      // Two separate assertions, and only the first is about this test's job.
      // Mode proves vector search actually ran; rank proves the index is real
      // and not empty. Exact top-1 ordering on a four-page corpus would be a
      // retrieval-quality benchmark, which belongs elsewhere and would flake here.
      if (String(body.mode).startsWith('bm25')) {
        fail(`"${q.slice(0, 40)}…" served by ${body.mode} — vector search is not working`)
      } else if (rank === -1) {
        fail(`"${q.slice(0, 40)}…" did not return ${expect} at all (got ${paths.join(', ') || 'nothing'})`)
      } else {
        pass(`semantic hit: ${expect} at rank ${rank + 1} (${body.mode})`)
      }
    } catch (error) {
      fail(`search failed: ${error.message}`)
    }
  }

  await stopService(service, logFd)
  cleanup(work)

  console.log(failures === 0 ? '\nSmoke test passed.' : `\nSmoke test failed: ${failures} problem(s).`)
  // process.exitCode rather than process.exit(): see the stdio comment above.
  // Forcing an immediate exit is what tripped the libuv assertion on Windows.
  process.exitCode = failures === 0 ? 0 : 1
}

// Shut the service down without tripping libuv on Windows.
//
// `service.kill()` immediately followed by process.exit() aborted the runner
// with: Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
// -- the parent exiting while the killed child's stdio pipes were still closing.
// That surfaced as exit code 127, which would have turned a PASSING run into a
// failure. Detach the pipes first, then wait for the child to actually go.
function stopService(child, fd) {
  return new Promise((resolve) => {
    const shut = () => { if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } } }
    if (child.exitCode !== null || child.signalCode !== null) { shut(); return resolve() }
    child.stdout?.removeAllListeners('data')
    child.stderr?.removeAllListeners('data')
    child.stdout?.destroy()
    child.stderr?.destroy()
    const done = () => { clearTimeout(timer); shut(); resolve() }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } done() }, 5000)
    child.once('exit', done)
    try { child.kill('SIGTERM') } catch { done() }
  })
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => { output += d.toString() })
    child.stderr.on('data', (d) => { output += d.toString() })
    child.on('close', (code) => resolve({ code, output }))
  })
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

// Safety net for dropping process.exit(). An unref'd timer cannot keep the
// process alive, so this never delays a clean exit -- it only fires if some
// stray handle would otherwise hang the job forever, which is worse than a
// wrong answer because it burns the runner's whole timeout.
const watchdog = setTimeout(() => {
  console.error('FAIL  smoke test did not exit on its own within 60s of finishing')
  process.exit(process.exitCode ?? 1)
}, 60_000)
watchdog.unref()

await main()
