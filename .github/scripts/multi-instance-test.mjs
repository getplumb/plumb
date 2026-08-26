#!/usr/bin/env node
// Multi-instance topology check (Linux).
//
// Running N copies of the service behind one SO_REUSEPORT socket is how a
// memory-capped deployment scales and how it restarts without dropping
// requests. No default install turns it on, which is precisely why it needs a
// job of its own: the feature previously went untested and drifted.
//
// The property that matters most here is a refusal. `/reindex` on the shared
// port would be load-balanced to exactly one instance, silently leaving the
// others serving a stale index -- a bug that looks like success. The service
// must reject it there and accept it only on a per-instance admin port.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.env.PLUMB_SMOKE_DIR ?? process.cwd()
const INDEXER = join(ROOT, 'packages', 'wiki', 'dist', 'cli.js')
const SERVER = join(ROOT, 'packages', 'wiki-search-service', 'src', 'server.js')

let failures = 0
const fail = (m) => { console.error(`FAIL  ${m}`); failures += 1 }
const pass = (m) => console.log(`ok    ${m}`)
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

async function json(url) {
  const r = await fetch(url)
  return { status: r.status, body: await r.json(), instance: r.headers.get('x-plumb-instance') }
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch { /* not up yet */ }
    await sleep(250)
  }
  return null
}

const work = mkdtempSync(join(tmpdir(), 'plumb-multi-'))
const wikiRoot = join(work, 'wiki')
const dbPath = join(work, 'wiki.db')
const today = new Date().toISOString().slice(0, 10)

mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
for (const [name, body] of [
  ['harbor-fog', 'Fog forms over the harbour when warm air moves across cold water and the dew point is reached.'],
  ['tide-clock', 'A tide clock tracks the lunar day of roughly 24 hours and 50 minutes rather than the solar day.'],
]) {
  writeFileSync(join(wikiRoot, 'concepts', `${name}.md`),
    `---\ntype: concept\ncreated: ${today}\nupdated: ${today}\ntags: [multi]\n` +
    `confidence: high\nsummary: ${body.slice(0, 80)}\n---\n\n# ${name.replace(/-/g, ' ')}\n\n${body}\n`)
}

const indexed = spawn(process.execPath, [INDEXER, 'index', wikiRoot, '--db', dbPath], { stdio: 'inherit' })
await new Promise((r) => indexed.on('close', r))
pass('indexed a synthetic corpus')

const shared = await freePort()
const adminA = await freePort()
const adminB = await freePort()

const instances = ['A', 'B'].map((id, i) => spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PORT: String(shared),
    REUSE_PORT: '1',
    INSTANCE_ID: id,
    ADMIN_PORT: String([adminA, adminB][i]),
    WIKI_DB_PATH: dbPath,
    WIKI_ROOT: wikiRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
for (const p of instances) { p.stdout.on('data', () => {}); p.stderr.on('data', () => {}) }

const healthA = await waitFor(`http://127.0.0.1:${adminA}/health`)
const healthB = await waitFor(`http://127.0.0.1:${adminB}/health`)
if (!healthA || !healthB) {
  fail('both instances did not come up on their admin ports')
} else if (healthA.instance !== 'A' || healthB.instance !== 'B') {
  fail(`admin ports report the wrong identities: ${healthA.instance} / ${healthB.instance}`)
} else {
  pass('two instances share one port, each reachable on its own admin port')
}

// The refusal, which is the point of the whole job.
try {
  const r = await json(`http://127.0.0.1:${shared}/reindex`)
  if (r.status === 404 && /admin-port only/.test(r.body.error ?? '')) {
    pass('/reindex refused on the shared port (would have left a sibling stale)')
  } else {
    fail(`/reindex on the shared port returned ${r.status} instead of refusing`)
  }
} catch (error) {
  fail(`/reindex probe failed: ${error.message}`)
}

for (const [id, port] of [['A', adminA], ['B', adminB]]) {
  try {
    const r = await json(`http://127.0.0.1:${port}/reindex`)
    if (r.status === 200 && r.body.ok) pass(`/reindex accepted on instance ${id}'s admin port`)
    else fail(`/reindex on instance ${id} admin port returned ${r.status}`)
  } catch (error) {
    fail(`/reindex on instance ${id} failed: ${error.message}`)
  }
}

// Searches on the shared port must work regardless of which instance answers.
//
// This must NOT use fetch(): it pools keep-alive connections per origin, so
// every request would ride the first connection and be pinned to whichever
// instance accepted it -- the test would report success having exercised one
// instance. SO_REUSEPORT balances per NEW connection, so force a fresh one.
function freshGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, instance: res.headers['x-plumb-instance'] }))
    })
    req.on('error', reject)
  })
}

const seen = new Set()
for (let i = 0; i < 24; i += 1) {
  try {
    const r = await freshGet(shared, '/search?q=why+does+fog+form&topK=2')
    if (r.status !== 200) { fail(`shared-port search returned ${r.status}`); break }
    if (r.instance) seen.add(r.instance)
  } catch (error) {
    fail(`shared-port search failed: ${error.message}`); break
  }
}
if (seen.size === 2) {
  pass(`shared port balanced across both instances (${[...seen].sort().join(', ')})`)
} else if (seen.size === 1) {
  // Not fatal: the kernel is free to favour one socket. But say what happened
  // rather than reporting a balance that was never observed.
  console.log(`warn  shared port only reached instance ${[...seen][0]} in 24 fresh connections`)
} else {
  fail('shared-port searches returned no instance attribution at all')
}

for (const p of instances) p.kill('SIGTERM')
await sleep(500)
try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }

console.log(failures === 0 ? '\nMulti-instance checks passed.' : `\nMulti-instance checks failed: ${failures}.`)
process.exit(failures === 0 ? 0 : 1)
