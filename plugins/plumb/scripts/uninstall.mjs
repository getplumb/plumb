#!/usr/bin/env node
// Tier 2: the mechanical half of /plumb-uninstall.
//
// This runs on the bad day, so it assumes nothing is healthy: the service may
// be dead, the port taken by something else, CLAUDE.md hand-edited since
// install, the manifest missing. Every step checks whether it applies before it
// acts, and reports what it skipped.
//
// Two rules that override everything else here:
//
//   The wiki corpus is never deleted. Not by default, not by a flag on this
//   script. Someone uninstalling a memory system has not asked to forget
//   anything, and the corpus is the only artifact that cannot be regenerated.
//
//   Strategy is chosen by diffing, not by elapsed time. Restoring a backup over
//   a CLAUDE.md the user has since edited would destroy work that had nothing
//   to do with Plumb. Time is a hint; the diff decides.
//
// Subcommands: plan | export | apply
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { applyUserConfig, runtimeDir } from './runtime.mjs'
import { splitFrontmatter } from './lib/frontmatter.mjs'

const args = process.argv.slice(2)
const command = args[0]
const JSON_OUT = args.includes('--json')
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

applyUserConfig()
const PLUMB_HOME = resolve(flag('--plumb-home', join(homedir(), '.plumb')))
const CLAUDE_HOME = resolve(flag('--claude-home', join(homedir(), '.claude')))
const CLAUDE_MD = join(CLAUDE_HOME, 'CLAUDE.md')
const MANIFEST = join(PLUMB_HOME, 'install-manifest.json')
const TELEMETRY = process.env.PLUMB_TRAFFIC_TELEMETRY_PATH ?? join(PLUMB_HOME, 'telemetry', 'claude-code-traffic.jsonl')
const SERVICE_URL = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
const PLUMB_BLOCK = /<!--\s*plumb:begin\s*-->[\s\S]*?<!--\s*plumb:end\s*-->\n?/g

const out = (payload, human) => {
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2))
  else human()
}

const readManifest = () => {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return null }
}

function walk(dir, filter) {
  const found = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (filter(full)) found.push(full)
    }
  }
  return found
}

async function serviceHealth() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(`${SERVICE_URL}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok ? await response.json() : null
  } catch { return null }
}

/**
 * Restore is only safe when Plumb's block is the *sole* difference from the
 * install-time backup. Anything else means the user edited this file for their
 * own reasons since, and putting the backup back would silently delete that
 * work -- the single most destructive thing this command could do.
 */
function chooseStrategy(manifest) {
  if (!existsSync(CLAUDE_MD)) {
    return { strategy: 'surgical', reason: 'CLAUDE.md does not exist; nothing to restore', divergence: null }
  }
  const current = readFileSync(CLAUDE_MD, 'utf8')
  const hasBlock = /<!--\s*plumb:begin\s*-->/.test(current)
  const backupPath = manifest?.claudeMdBackup
  if (!backupPath || !existsSync(backupPath)) {
    return {
      strategy: 'surgical',
      reason: backupPath
        ? `the recorded backup is missing (${backupPath})`
        : 'no install-time backup was recorded',
      divergence: null,
      hasBlock,
    }
  }
  const backup = readFileSync(backupPath, 'utf8')
  const withoutPlumb = current.replace(PLUMB_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim()
  const baseline = backup.replace(/\n{3,}/g, '\n\n').trim()
  const identical = withoutPlumb === baseline
  return {
    strategy: identical ? 'restore' : 'surgical',
    reason: identical
      ? 'the only difference from the install-time backup is Plumb\'s own block'
      : 'CLAUDE.md has unrelated edits since install; restoring the backup would discard them',
    divergence: identical ? 0 : Math.abs(withoutPlumb.length - baseline.length),
    backupPath,
    hasBlock,
  }
}

/**
 * Two populations, opposite handling. A page carrying a file:// source_ref came
 * from somewhere and can be returned there. A page without one was created
 * inside Plumb and exists nowhere else -- after a few weeks that is the
 * majority, and it is the entire reason the user got value from the product.
 * Returning only the first group would discard exactly what Plumb was for.
 */
function partitionCorpus(wikiRoot) {
  const migrated = []
  const netNew = []
  if (!existsSync(wikiRoot)) return { migrated, netNew }
  for (const file of walk(wikiRoot, (f) => extname(f) === '.md')) {
    const rel = relative(wikiRoot, file)
    let refs = []
    try {
      const { data } = splitFrontmatter(readFileSync(file, 'utf8'))
      refs = (data?.source_refs ?? []).filter((r) => String(r).startsWith('file://'))
    } catch { /* unparseable frontmatter counts as net-new, which is the safe side */ }
    if (refs.length) migrated.push({ path: rel, origin: String(refs[0]).replace(/^file:\/\//, '') })
    else netNew.push({ path: rel })
  }
  return { migrated, netNew }
}

function inventory(manifest) {
  const wikiRoot = resolve(manifest?.wikiRoot || process.env.WIKI_ROOT || join(homedir(), '.plumb', 'wiki'))
  const runtime = resolve(manifest?.runtimeDir || runtimeDir())
  return {
    wikiRoot,
    dbPath: manifest?.dbPath ?? null,
    runtime,
    runtimeExists: existsSync(runtime),
    telemetry: existsSync(TELEMETRY) ? TELEMETRY : null,
    manifest: manifest ? MANIFEST : null,
    wikiRootCreatedByPlumb: manifest?.wikiRootCreatedByPlumb ?? null,
  }
}

// --- plan ------------------------------------------------------------------
async function plan() {
  const manifest = readManifest()
  const inv = inventory(manifest)
  const strategy = chooseStrategy(manifest)
  const health = await serviceHealth()
  const { migrated, netNew } = partitionCorpus(inv.wikiRoot)
  const installedAt = manifest?.installedAt
  const ageDays = installedAt ? (Date.now() - Date.parse(installedAt)) / 86_400_000 : null

  const payload = {
    ok: true,
    installedAt: installedAt ?? null,
    ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
    strategy,
    service: health ? { running: true, pid: health.pid, url: SERVICE_URL } : { running: false, url: SERVICE_URL },
    inventory: inv,
    corpus: { total: migrated.length + netNew.length, migrated: migrated.length, netNew: netNew.length },
  }

  out(payload, () => {
    console.log('Uninstall plan\n')
    console.log(`  installed        ${installedAt ? `${installedAt.slice(0, 10)} (${payload.ageDays} days ago)` : 'unknown — no manifest'}`)
    console.log(`  service          ${health ? `running, pid ${health.pid}` : 'not running'}`)
    console.log(`  runtime          ${inv.runtimeExists ? inv.runtime : `${inv.runtime} (absent)`}`)
    console.log(`  telemetry        ${inv.telemetry ?? 'none'}`)
    console.log()
    console.log(`  CLAUDE.md strategy: ${strategy.strategy.toUpperCase()}`)
    console.log(`    ${strategy.reason}`)
    if (ageDays !== null && ageDays < 1 && strategy.strategy === 'surgical') {
      console.log(`    (note: a same-day uninstall usually restores, but the diff overrides the calendar)`)
    }
    console.log()
    console.log(`  Wiki: ${payload.corpus.total} page(s) at ${inv.wikiRoot}`)
    console.log(`    ${migrated.length} migrated — can be returned to where they came from`)
    console.log(`    ${netNew.length} created in Plumb — exist nowhere else, export or lose them`)
    console.log()
    console.log('  WILL NOT be deleted: the wiki corpus and its index.')
    console.log()
    console.log('  Next:  uninstall.mjs export --out <dir>')
    console.log(`         uninstall.mjs apply --strategy ${strategy.strategy} --yes`)
  })
}

// --- export ----------------------------------------------------------------
function exportCorpus() {
  const manifest = readManifest()
  const inv = inventory(manifest)
  const outDir = resolve(flag('--out', join(homedir(), `plumb-export-${new Date().toISOString().slice(0, 10)}`)))
  const { migrated, netNew } = partitionCorpus(inv.wikiRoot)

  mkdirSync(outDir, { recursive: true })
  const copy = (rel) => {
    const target = join(outDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(inv.wikiRoot, rel), target)
  }
  for (const page of [...migrated, ...netNew]) copy(page.path)

  // An index the user can actually act on: which of these have a home to go
  // back to, and which are only here.
  const lines = [
    '# Plumb export',
    '',
    `Exported ${migrated.length + netNew.length} page(s) on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## Created in Plumb',
    '',
    'These exist nowhere else. They are the memory Plumb accumulated for you.',
    '',
    ...netNew.map((p) => `- \`${p.path}\``),
    '',
    '## Imported from elsewhere',
    '',
    'These were migrated in and can be returned to their original locations.',
    '',
    ...migrated.map((p) => `- \`${p.path}\` → ${p.origin}`),
    '',
  ]
  writeFileSync(join(outDir, 'INDEX.md'), lines.join('\n'))

  out({ ok: true, outDir, migrated: migrated.length, netNew: netNew.length }, () => {
    console.log(`Exported ${migrated.length + netNew.length} page(s) to ${outDir}`)
    console.log(`  ${netNew.length} created in Plumb (exist nowhere else)`)
    console.log(`  ${migrated.length} imported from elsewhere (origins listed in INDEX.md)`)
    console.log(`\nThe original wiki is untouched at ${inv.wikiRoot}.`)
  })
}

// --- apply -----------------------------------------------------------------
async function apply() {
  if (!args.includes('--yes')) {
    console.error('Refusing to modify anything without --yes. Run `uninstall.mjs plan` first.')
    process.exit(1)
  }
  const manifest = readManifest()
  const inv = inventory(manifest)
  const chosen = flag('--strategy', chooseStrategy(manifest).strategy)
  const steps = []
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail })
    if (!JSON_OUT) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
  }

  // 1. Stop the service. Absent is a success, not a failure.
  const health = await serviceHealth()
  if (!health) {
    record('service', true, 'not running')
  } else {
    try {
      process.kill(health.pid, 'SIGTERM')
      let stopped = false
      for (let i = 0; i < 60 && !stopped; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
        stopped = (await serviceHealth()) === null
      }
      record('service', stopped, stopped ? `stopped pid ${health.pid}, port free` : `pid ${health.pid} did not exit`)
    } catch (error) {
      record('service', false, `could not signal pid ${health.pid}: ${error.message}`)
    }
  }

  // 2. CLAUDE.md.
  if (!existsSync(CLAUDE_MD)) {
    record('CLAUDE.md', true, 'does not exist')
  } else if (chosen === 'restore') {
    const backupPath = manifest?.claudeMdBackup
    if (backupPath && existsSync(backupPath)) {
      copyFileSync(backupPath, CLAUDE_MD)
      record('CLAUDE.md', true, `restored from ${backupPath}`)
    } else {
      record('CLAUDE.md', false, 'restore requested but no backup exists; re-run with --strategy surgical')
    }
  } else {
    const before = readFileSync(CLAUDE_MD, 'utf8')
    const after = before.replace(PLUMB_BLOCK, '').replace(/\n{3,}/g, '\n\n')
    if (before === after) {
      record('CLAUDE.md', true, 'no Plumb block present')
    } else {
      // Keep a copy of what we edited. Surgical removal is exact, but the user
      // should never have to take our word for it.
      const safety = join(PLUMB_HOME, 'backups', `CLAUDE.md.pre-uninstall.${Date.now()}`)
      try {
        mkdirSync(dirname(safety), { recursive: true })
        writeFileSync(safety, before)
      } catch { /* best effort */ }
      writeFileSync(CLAUDE_MD, after)
      record('CLAUDE.md', true, `Plumb block removed surgically; prior copy at ${safety}`)
    }
  }

  // 3. Installed runtime.
  if (inv.runtimeExists) {
    try {
      rmSync(inv.runtime, { recursive: true, force: true })
      record('runtime', true, `removed ${inv.runtime}`)
    } catch (error) {
      record('runtime', false, `could not remove ${inv.runtime}: ${error.message}`)
    }
  } else {
    record('runtime', true, 'already absent')
  }

  // 4. Telemetry, only when asked. It holds counts and timings, never query text.
  if (args.includes('--remove-telemetry')) {
    if (inv.telemetry) {
      try { rmSync(inv.telemetry, { force: true }); record('telemetry', true, `removed ${inv.telemetry}`) }
      catch (error) { record('telemetry', false, error.message) }
    } else record('telemetry', true, 'none')
  } else {
    record('telemetry', true, inv.telemetry ? `left in place at ${inv.telemetry}` : 'none')
  }

  // 5. The corpus. Deliberately, emphatically, not deleted.
  const { migrated, netNew } = partitionCorpus(inv.wikiRoot)
  record('wiki corpus', true, `left intact: ${migrated.length + netNew.length} page(s) at ${inv.wikiRoot}`)

  const failed = steps.filter((s) => !s.ok)
  out({ ok: failed.length === 0, strategy: chosen, steps, wikiRoot: inv.wikiRoot }, () => {
    console.log()
    if (failed.length) console.log(`Uninstall incomplete: ${failed.length} step(s) failed.`)
    else console.log('Plumb removed.')
    console.log(`\nYour wiki is still at ${inv.wikiRoot} — ${migrated.length + netNew.length} page(s), untouched.`)
    console.log('The MCP server and prompt hook were registered by the plugin itself,')
    console.log('so removing the plugin removes them. Nothing to unwind there.')
  })
  process.exit(failed.length === 0 ? 0 : 1)
}

switch (command) {
  case 'plan': await plan(); break
  case 'export': exportCorpus(); break
  case 'apply': await apply(); break
  default:
    console.error('Usage: uninstall.mjs <plan|export|apply> [--strategy restore|surgical] [--out <dir>] [--yes] [--json]')
    process.exit(1)
}
