#!/usr/bin/env node
// Tier 2: diagnosis, and only diagnosis.
//
// This script never mutates anything -- it does not create directories, build
// indexes, or start the service. A user must be able to inspect a system they
// have not agreed to let anyone change, and /plumb-setup must stay the only
// thing that writes. That separation is also what makes the output trustworthy:
// nothing here can accidentally fix the problem it is reporting.
//
// It exists because "is Plumb working?" has a specific failure mode that looks
// like success: the service answers, the tools respond, and every result is
// silently keyword-only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyUserConfig, entryPoint, isInstalled, PACKAGE_NAME, runtimeDir } from './runtime.mjs'

const args = process.argv.slice(2)
const JSON_OUT = args.includes('--json')
const findings = []

const add = (check, status, detail, extra = {}) => {
  findings.push({ check, status, detail, ...extra })
  return status
}

// --- environment -----------------------------------------------------------
const nodeParts = process.versions.node.split('.').map(Number)
const nodeOk = nodeParts[0] > 22 || (nodeParts[0] === 22 && nodeParts[1] >= 13)
add('node', nodeOk ? 'ok' : 'fail', `${process.versions.node}${nodeOk ? '' : ' — below the 22.13 floor for node:sqlite'}`)

// --- engine ----------------------------------------------------------------
const dir = runtimeDir()
const installed = isInstalled(dir)
let engineVersion
if (installed) {
  try {
    engineVersion = JSON.parse(
      readFileSync(join(dir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'),
    ).version
  } catch { /* version is a nicety, not a check */ }
}
add('engine', installed ? 'ok' : 'fail',
  installed ? `${PACKAGE_NAME}@${engineVersion ?? 'unknown'} at ${dir}` : `not installed — run /plumb-setup`)

// --- corpus ----------------------------------------------------------------
applyUserConfig()
const wikiRoot = resolve(process.env.WIKI_ROOT || join(homedir(), '.plumb', 'wiki'))
const dbPath = resolve(process.env.WIKI_DB_PATH || join(wikiRoot, '..', 'wiki.db'))

let pageCount = 0
if (existsSync(wikiRoot)) {
  pageCount = readdirSync(wikiRoot, { recursive: true }).filter((f) => String(f).endsWith('.md')).length
  add('wiki', pageCount === 0 ? 'warn' : 'ok',
    pageCount === 0
      ? `${wikiRoot} exists but is empty — run /plumb-migrate to seed it`
      : `${pageCount} page(s) at ${wikiRoot}`, { wikiRoot, pageCount })
} else {
  add('wiki', 'fail', `${wikiRoot} does not exist`, { wikiRoot })
}

if (existsSync(dbPath)) {
  const st = statSync(dbPath)
  const ageHours = (Date.now() - st.mtimeMs) / 3_600_000
  // A corpus newer than its index means queries cannot see recent writes.
  let newestPage = 0
  if (existsSync(wikiRoot)) {
    for (const f of readdirSync(wikiRoot, { recursive: true })) {
      if (!String(f).endsWith('.md')) continue
      try { newestPage = Math.max(newestPage, statSync(join(wikiRoot, String(f))).mtimeMs) } catch { /* raced */ }
    }
  }
  const stale = newestPage > st.mtimeMs
  add('index', stale ? 'warn' : 'ok',
    `${(st.size / 1048576).toFixed(1)} MB, built ${ageHours.toFixed(1)}h ago` +
    (stale ? ' — the wiki has changed since; new pages are not searchable yet' : ''),
    { dbPath, stale })
} else {
  add('index', pageCount === 0 ? 'warn' : 'fail',
    `${dbPath} not found${pageCount === 0 ? ' (expected for an empty wiki)' : ' — retrieval cannot work'}`, { dbPath })
}

// --- service ---------------------------------------------------------------
// Probe only. Starting it here would mask exactly the condition worth reporting.
const serviceUrl = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
let health = null
try {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  const response = await fetch(`${serviceUrl}/health`, { signal: controller.signal })
  clearTimeout(timer)
  if (response.ok) health = await response.json()
} catch { /* not running is a normal state under on-demand lifecycle */ }

if (!health) {
  add('service', 'ok', `not running at ${serviceUrl} — normal; it starts on the next prompt and idles out after 15 minutes`,
    { running: false })
} else {
  // Prefer the engine's own readiness rule so there is one definition of
  // "degraded". When the engine is not installed here -- a user pointed at an
  // externally managed service, or the plugin runtime is missing -- fall back
  // to the same test inline rather than reporting nothing, since a degraded
  // service is the single most valuable thing this command can find.
  let readiness
  if (installed) {
    ({ readiness } = await import(entryPoint('ensure-service.mjs', dir)))
  } else {
    readiness = (h) => ({
      degraded: String(h?.stats?.searchMode ?? '').includes('hybrid') && h?.stats?.embedder?.resident !== true,
    })
  }
  const state = readiness(health)
  const s = health.stats ?? {}
  add('service', 'ok',
    `up as pid ${health.pid}, ${(health.rssBytes / 1048576).toFixed(0)} MB, ${(health.uptimeMs / 3600000).toFixed(1)}h`,
    { running: true, pid: health.pid })
  // The headline check. Everything can look healthy while every answer is
  // keyword-only, which is this system's most expensive failure.
  add('retrieval', state.degraded ? 'fail' : 'ok',
    state.degraded
      ? `DEGRADED — mode ${s.searchMode}, embedder not resident. Results are keyword-only.`
      : `hybrid retrieval live (mode ${s.searchMode})`,
    { degraded: state.degraded, searchMode: s.searchMode })
  add('coverage', s.coverageRatio === 1 ? 'ok' : 'fail',
    s.coverageRatio === 1
      ? `all ${s.chunkCount} chunk(s) have contextual embeddings`
      : `${s.contextualCount}/${s.eligibleCount} chunks embedded (ratio ${s.coverageRatio}) — one gap demotes every query`,
    { coverageRatio: s.coverageRatio })
}

// --- wiring ----------------------------------------------------------------
// The plugin registers its own hook and MCP server declaratively, so the thing
// worth checking is a *second*, hand-rolled registration -- a duplicate injects
// twice and burns the prompt budget, and it is how this host's own hook came to
// drift from the packaged one.
const settingsPath = join(homedir(), '.claude', 'settings.json')
if (existsSync(settingsPath)) {
  try {
    const raw = readFileSync(settingsPath, 'utf8')
    const entries = JSON.parse(raw)?.hooks?.UserPromptSubmit ?? []
    const plumbHooks = JSON.stringify(entries).match(/plumb[\w-]*\.mjs/gi) ?? []
    add('hook wiring', plumbHooks.length === 0 ? 'ok' : 'warn',
      plumbHooks.length === 0
        ? 'no hand-rolled Plumb hook in settings.json; the plugin supplies it'
        : `settings.json also registers ${plumbHooks.join(', ')} — that injects twice and drifts from the packaged hook`,
      { duplicates: plumbHooks })
  } catch {
    add('hook wiring', 'warn', `${settingsPath} could not be parsed`)
  }
}

// --- CLAUDE.md -------------------------------------------------------------
const claudeMd = join(homedir(), '.claude', 'CLAUDE.md')
if (existsSync(claudeMd)) {
  const body = readFileSync(claudeMd, 'utf8')
  const hasBlock = body.includes('<!-- plumb:begin -->') && body.includes('<!-- plumb:end -->')
  add('CLAUDE.md', hasBlock ? 'ok' : 'warn',
    hasBlock
      ? 'Plumb memory instructions present'
      : 'no Plumb instructions — Claude will not know to save durable facts. Run /plumb-setup.',
    { path: claudeMd })
} else {
  add('CLAUDE.md', 'warn', `${claudeMd} does not exist — run /plumb-setup to create it`)
}

// --- telemetry -------------------------------------------------------------
// What actually happened on real prompts, as opposed to what the config implies.
const telemetryPath = process.env.PLUMB_TRAFFIC_TELEMETRY_PATH
  ?? join(homedir(), '.plumb', 'telemetry', 'claude-code-traffic.jsonl')
if (existsSync(telemetryPath)) {
  const lines = readFileSync(telemetryPath, 'utf8').trim().split('\n').slice(-200)
  const rows = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (rows.length) {
    const fired = rows.filter((r) => r.status === 'fired')
    const degraded = fired.filter((r) => r.degraded).length
    const dropped = fired.filter((r) => r.droppedToBudget > 0).length
    const reasons = {}
    for (const r of rows.filter((r) => r.status === 'skipped')) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
    add('recent injections', degraded > 0 ? 'warn' : 'ok',
      `${fired.length}/${rows.length} prompts injected` +
      (degraded ? `, ${degraded} keyword-only` : '') +
      (dropped ? `, ${dropped} dropped results to the token budget` : '') +
      (Object.keys(reasons).length ? `; skipped: ${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(', ')}` : ''),
      { sampled: rows.length, fired: fired.length, degraded, dropped, skipReasons: reasons })
  }
} else {
  add('recent injections', 'warn', 'no telemetry yet — the hook has not run')
}

// --- report ----------------------------------------------------------------
const failed = findings.filter((f) => f.status === 'fail')
const warned = findings.filter((f) => f.status === 'warn')
const ok = failed.length === 0

if (JSON_OUT) {
  console.log(JSON.stringify({ ok, failed: failed.length, warned: warned.length, findings }, null, 2))
} else {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }
  for (const f of findings) console.log(`${mark[f.status]}  ${f.check.padEnd(18)} ${f.detail}`)
  console.log(`\n${ok ? (warned.length ? 'Working, with warnings' : 'Healthy') : 'Problems found'}: ` +
    `${failed.length} failing, ${warned.length} warning(s).`)
}
process.exit(ok ? 0 : 1)
