#!/usr/bin/env node
// Tier 2: the deterministic half of /plumb-setup.
//
// Everything here has a checkable outcome, so none of it belongs in an agent's
// judgment. The agent calls this, reads the JSON, and handles only what is
// genuinely ambiguous -- chiefly CLAUDE.md, which no script can safely edit.
//
// Design rule inherited from the rest of Plumb: a step that half-succeeds must
// say so. Every step reports ok/failed with a reason, and the process exits
// non-zero if any required step failed, so "it printed some output" can never
// be mistaken for "it worked".
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyUserConfig, entryPoint, isInstalled, PACKAGE_NAME, runtimeDir } from './runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEXER_PACKAGE = '@getplumb/wiki'
const MIN_NODE = [22, 13, 0]

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const JSON_OUT = args.includes('--json')

const steps = []
const record = (step, ok, detail, extra = {}) => {
  steps.push({ step, ok, detail, ...extra })
  if (!JSON_OUT) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function finish(ok, summary) {
  if (JSON_OUT) console.log(JSON.stringify({ ok, summary, steps }, null, 2))
  else console.log(`\n${ok ? 'Setup complete' : 'Setup incomplete'}: ${summary}`)
  process.exit(ok ? 0 : 1)
}

// --- 1. Node version -------------------------------------------------------
// node:sqlite's DatabaseSync landed in 22.5 but stayed behind
// --experimental-sqlite until 22.13; on 22.5-22.12 `require("node:sqlite")`
// throws ERR_UNKNOWN_BUILTIN_MODULE. 22.13 is the real floor. Below it the engine does not
// merely run slower, it cannot open the index at all.
const current = process.versions.node.split('.').map(Number)
const meetsFloor = current[0] > MIN_NODE[0] || (current[0] === MIN_NODE[0] && current[1] >= MIN_NODE[1])
if (!record('node >= 22.13', meetsFloor, `found ${process.versions.node}`)) {
  finish(false, `Node ${process.versions.node} is too old; Plumb needs 22.13 or newer for node:sqlite.`)
}

// --- 2. Install the engine -------------------------------------------------
const dir = resolve(flag('--runtime', runtimeDir()))
const version = flag('--version', JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version)

mkdirSync(dir, { recursive: true })
// npm refuses to install into a prefix with no package.json of its own, and
// would otherwise walk upward and pollute a parent directory.
const manifest = join(dir, 'package.json')
if (!existsSync(manifest)) {
  writeFileSync(manifest, JSON.stringify({ name: 'plumb-runtime', private: true, version: '1.0.0' }, null, 2) + '\n')
}

// --tarballs lets CI (and a pre-publish smoke test) install the exact artifacts
// that would be published, rather than whatever the registry currently holds.
// It is the only honest way to test an install before the packages exist.
const tarballDir = flag('--tarballs', null)
const spec = tarballDir
  ? readdirSync(tarballDir).filter((f) => f.endsWith('.tgz')).map((f) => join(resolve(tarballDir), f))
  : [`${PACKAGE_NAME}@${version}`, `${INDEXER_PACKAGE}@${version}`]
if (tarballDir && spec.length === 0) {
  record('install engine', false, `no .tgz files in ${tarballDir}`)
  finish(false, 'Nothing to install.')
}
const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--prefix', dir, '--no-audit', '--no-fund', ...spec],
  { encoding: 'utf8', shell: process.platform === 'win32' })

if (npm.status !== 0) {
  record('install engine', false, (npm.stderr || npm.stdout || 'npm failed').trim().split('\n').slice(-4).join(' | '))
  finish(false, `Could not install ${spec.join(' and ')}.`)
}
if (!record('install engine', isInstalled(dir), `${spec.join(', ')} → ${dir}`)) {
  finish(false, 'npm reported success but the engine entry point is missing.')
}

// --- 3. The wiki, which starts empty --------------------------------------
// A pre-seeded wiki teaches the model things the user never said. Empty means
// every page has known provenance from day one; /plumb-migrate seeds it later,
// with consent.
applyUserConfig()
const wikiRoot = resolve(flag('--wiki-root', process.env.WIKI_ROOT || join(homedir(), '.plumb', 'wiki')))
// Matches the engine's own default when the wiki is in its usual place, so the
// plugin does not invent a second convention that disagrees with the service.
const defaultDb = wikiRoot === join(homedir(), '.plumb', 'wiki')
  ? join(homedir(), '.plumb', 'wiki.db')
  : join(wikiRoot, '.wiki.db')
const dbPath = resolve(flag('--db', process.env.WIKI_DB_PATH || defaultDb))
process.env.WIKI_ROOT = wikiRoot
process.env.WIKI_DB_PATH = dbPath

const existed = existsSync(wikiRoot)
mkdirSync(wikiRoot, { recursive: true })
const pageCount = readdirSync(wikiRoot, { recursive: true }).filter((f) => String(f).endsWith('.md')).length
record('wiki root', true, `${wikiRoot} (${existed ? 'existing' : 'created'}, ${pageCount} page(s))`, { wikiRoot, pageCount, existed })

// --- 4. Build the index ----------------------------------------------------
// Exits non-zero on partial contextual coverage, which is the whole point: one
// missing sidecar row silently demotes every query to keyword-only.
{
  // Run even on an empty wiki. Skipping it leaves no wiki.db at all, and the
  // service cannot open a database that does not exist -- which made the
  // default fresh install fail at the last step. An empty index is valid: the
  // indexer reports 0 pages and exits 0.
  const indexer = join(dir, 'node_modules', INDEXER_PACKAGE, 'dist', 'cli.js')
  const built = spawnSync(process.execPath, [indexer, 'index', wikiRoot, '--db', dbPath], { encoding: 'utf8' })
  const output = `${built.stdout || ''}${built.stderr || ''}`.trim()
  const detail = pageCount === 0
    ? 'empty index created — the wiki starts empty by design'
    : output.split('\n').slice(-3).join(' | ')
  if (!record('index', built.status === 0, detail)) {
    finish(false, 'The index is incomplete. Retrieval would silently fall back to keyword-only.')
  }
}

// --- 5. Prove the engine actually serves ----------------------------------
// Also the point at which the ~34MB embedding model downloads, so it happens
// here behind a progress report rather than on the user's first prompt.
const { ensureService } = await import(entryPoint('ensure-service.mjs', dir))
const service = await ensureService({ coldStartBudgetMs: 180_000 })

if (!record('search service', service.ok, service.ok
  ? `ready in ${service.elapsedMs}ms (mode ${service.searchMode})`
  : service.reason, { elapsedMs: service.elapsedMs, degraded: service.degraded })) {
  finish(false, 'The engine installed but would not serve a query.')
}

if (service.degraded) {
  record('vector search', false,
    `the service answers but has no embedder resident (mode ${service.searchMode}), so results are keyword-only`)
  finish(false, 'Installed, but retrieval is degraded to keyword-only. Run /plumb-doctor.')
}
record('vector search', true, `hybrid retrieval live (mode ${service.searchMode})`)

// --- 6. Record what we changed --------------------------------------------
// Uninstall has to know what Plumb created versus what it merely used, or it
// has to guess -- and guessing wrong means deleting a wiki the user already
// had. Written last so it describes what actually happened, and merged rather
// than overwritten so a re-run does not lose the original install's record of
// what pre-existed.
const manifestPath = resolve(flag('--manifest', join(homedir(), '.plumb', 'install-manifest.json')))
try {
  let prior = {}
  try { prior = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* first install */ }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify({
    ...prior,
    pluginVersion: version,
    installedAt: prior.installedAt ?? new Date().toISOString(),
    lastSetupAt: new Date().toISOString(),
    runtimeDir: dir,
    wikiRoot,
    dbPath,
    // The load-bearing field: false means the corpus predates Plumb and must
    // survive an uninstall untouched.
    wikiRootCreatedByPlumb: prior.wikiRootCreatedByPlumb ?? !existed,
    packages: spec,
  }, null, 2) + '\n')
  record('install manifest', true, manifestPath, { manifestPath })
} catch (error) {
  // Not fatal -- the install works -- but uninstall will have to fall back to
  // surgical detection, so say so plainly.
  record('install manifest', false, `could not write ${manifestPath}: ${error.message}; /plumb-uninstall will need to detect changes instead`)
}

finish(true, pageCount === 0
  ? 'Plumb is installed and running against an empty wiki. Run /plumb-migrate to seed it from memory you already have.'
  : `Plumb is installed and serving ${pageCount} page(s).`)
