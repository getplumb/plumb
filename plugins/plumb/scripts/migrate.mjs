#!/usr/bin/env node
// Tier 2: the mechanical half of /plumb-migrate.
//
// What is deterministic lives here -- finding sources, measuring them,
// converting authored markdown into wiki pages, tracking what has already been
// imported, and promoting reviewed pages into the corpus. What requires
// judgment stays with the agent: deciding which sources are appropriate at all,
// and extracting durable facts out of raw transcripts.
//
// Two properties this file exists to guarantee:
//
//   Nothing reaches the wiki unreviewed. Staging is a real directory the user
//   can read and delete; `promote` is a separate, explicit step. A memory
//   system that ingests text and then injects it into every future prompt is a
//   self-poisoning surface, so "we generated pages" and "the model will now be
//   told these things" must never be the same action.
//
//   Nothing is imported twice. Every import is watermarked by source path and
//   content hash, so re-running is safe and reports what it skipped.
//
// Subcommands: discover | stage | promote | status
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { applyUserConfig, runtimeDir } from './runtime.mjs'
import { formatPage, splitFrontmatter } from './lib/frontmatter.mjs'

const args = process.argv.slice(2)
const command = args[0]
const JSON_OUT = args.includes('--json')
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

applyUserConfig()
const WIKI_ROOT = resolve(process.env.WIKI_ROOT || join(homedir(), '.plumb', 'wiki'))
const PLUMB_HOME = resolve(flag('--plumb-home', join(homedir(), '.plumb')))
const STAGING = join(PLUMB_HOME, 'migration-staging')
const WATERMARK = join(PLUMB_HOME, 'migration-watermark.json')
const CLAUDE_HOME = resolve(flag('--claude-home', join(homedir(), '.claude')))

const out = (payload, human) => {
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2))
  else human()
}
const die = (message) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: message }, null, 2))
  else console.error(message)
  process.exit(1)
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const readWatermark = () => {
  try { return JSON.parse(readFileSync(WATERMARK, 'utf8')) } catch { return { sources: {} } }
}
const bytesToMb = (n) => (n / 1048576).toFixed(1)

function walk(dir, filter, limit = Infinity) {
  const found = []
  const stack = [dir]
  while (stack.length && found.length < limit) {
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

const measure = (files) => {
  let bytes = 0
  let newest = 0
  for (const f of files) {
    try {
      const st = statSync(f)
      bytes += st.size
      newest = Math.max(newest, st.mtimeMs)
    } catch { /* raced */ }
  }
  return { count: files.length, bytes, newest: newest ? new Date(newest).toISOString() : null }
}

// --- discover --------------------------------------------------------------
// Report evidence, never a generic offer. The sources differ by orders of
// magnitude and carry very different risk; a user cannot consent meaningfully
// to "your memory files" as one undifferentiated blob.
function discover() {
  const watermark = readWatermark()
  const sources = []

  const globalClaudeMd = join(CLAUDE_HOME, 'CLAUDE.md')
  if (existsSync(globalClaudeMd)) {
    sources.push({
      id: 'claude-md',
      label: 'Global CLAUDE.md',
      character: 'authored',
      risk: 'low',
      paths: [globalClaudeMd],
      ...measure([globalClaudeMd]),
      note: 'Instructions you wrote. Sections become pages close to verbatim.',
    })
  }

  const memoryFiles = walk(CLAUDE_HOME, (f) =>
    extname(f) === '.md' && /(^|\/)(memory)(\/|$)/.test(dirname(f) + '/'))
  if (memoryFiles.length) {
    sources.push({
      id: 'memory-files',
      label: 'File-based memory store',
      character: 'curated',
      risk: 'low',
      paths: memoryFiles,
      ...measure(memoryFiles),
      note: 'Structured notes with frontmatter. Imported one page per file.',
    })
  }

  const transcripts = walk(CLAUDE_HOME, (f) => extname(f) === '.jsonl' && f.includes('/projects/'))
  if (transcripts.length) {
    const stats = measure(transcripts)
    const projects = new Set(transcripts.map((f) => basename(dirname(f))))
    sources.push({
      id: 'transcripts',
      label: 'Agent transcripts',
      character: 'raw',
      risk: 'high',
      paths: [],
      ...stats,
      projects: projects.size,
      // Roughly four characters per token. Deliberately not converted into a
      // price: that depends on the model chosen, and a wrong number here would
      // be worse than no number.
      approxInputTokens: Math.round(stats.bytes / 4),
      note: 'Raw and noisy. Cannot be imported mechanically -- these need fact ' +
        'extraction, which is model work and is not free. This is also where ' +
        'instruction-shaped text hides, so extracted pages must be reviewed.',
      requiresExtraction: true,
    })
  }

  // Other memory MCP servers: worth surfacing because migrating away from one
  // is a common reason to be here at all.
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
    const names = Object.keys(config.mcpServers ?? {})
      .filter((n) => /memory|recall|knowledge|notes|vault/i.test(n) && n !== 'plumb')
    if (names.length) {
      sources.push({
        id: 'memory-mcp',
        label: 'Other memory MCP servers',
        character: 'external',
        risk: 'unknown',
        paths: [],
        count: names.length,
        bytes: 0,
        newest: null,
        servers: names,
        note: 'Detected by name. Their contents are reachable only through their own tools, so importing them is agent work.',
        requiresExtraction: true,
      })
    }
  } catch { /* no config, or unreadable */ }

  for (const source of sources) {
    const done = source.paths.filter((p) => watermark.sources?.[p])
    source.alreadyImported = done.length
    source.pending = source.paths.length ? source.paths.length - done.length : null
  }

  out({ ok: true, wikiRoot: WIKI_ROOT, staging: STAGING, sources }, () => {
    if (!sources.length) return console.log('No existing memory sources found.')
    console.log('Memory found on this machine:\n')
    for (const s of sources) {
      const size = s.bytes ? `${bytesToMb(s.bytes)} MB` : '—'
      const scope = s.projects ? ` across ${s.projects} projects` : ''
      const done = s.alreadyImported ? `, ${s.alreadyImported} already imported` : ''
      console.log(`  ${s.id.padEnd(14)} ${String(s.count).padStart(6)} file(s), ${size}${scope}${done}`)
      console.log(`  ${''.padEnd(14)} ${s.character}, risk ${s.risk} — ${s.note}`)
      if (s.newest) console.log(`  ${''.padEnd(14)} newest ${s.newest.slice(0, 10)}`)
      console.log()
    }
    console.log(`Stage one with:  migrate.mjs stage --source <id>`)
  })
}

// --- stage -----------------------------------------------------------------
const WIKI_TYPES = { concept: 'concept', project: 'project', reference: 'reference', user: 'reference', feedback: 'reference' }

function titleFrom(data, body, fallback) {
  if (data?.title) return data.title
  const heading = /^#\s+(.+)$/m.exec(body)
  if (heading) return heading[1].trim()
  if (data?.name) return String(data.name).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return fallback
}

// Prefer a prose line, but fall back to the first bullet rather than giving up:
// summary is a retrieval signal, and "Imported from CLAUDE.md" is no signal at
// all. Many authored sections are bullets end to end.
function summarise(content) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  const prose = lines.find((l) => !l.startsWith('-') && !l.startsWith('#') && !l.startsWith('|'))
  const bullet = lines.find((l) => l.startsWith('-'))?.replace(/^[-*]\s*/, '')
  return (prose ?? bullet ?? '').replace(/\*\*/g, '').slice(0, 160)
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

function stagePage({ relPath, title, type, summary, tags, body, sourcePath }) {
  const today = new Date().toISOString().slice(0, 10)
  const page = formatPage({
    type,
    created: today,
    updated: today,
    // The provenance tag that makes uninstall correct as well as migration.
    // A page carrying a source_ref came from somewhere and can be returned
    // there; a page without one was created inside Plumb and can only be
    // exported. Two features read this field.
    source_refs: [`file://${sourcePath}`],
    tags: tags.length ? tags : ['imported'],
    confidence: 'medium',
    summary: summary || `Imported from ${basename(sourcePath)}.`,
  }, body.trim().startsWith('#') ? body : `# ${title}\n\n${body}`)
  const target = join(STAGING, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, page)
  return { path: relPath, title, sourcePath, bytes: Buffer.byteLength(page) }
}

function stageClaudeMd(sourcePath) {
  const raw = readFileSync(sourcePath, 'utf8')
  const { body: full } = splitFrontmatter(raw)
  // Strip Plumb's own block before splitting. /plumb-setup writes memory
  // instructions into CLAUDE.md, so migrating it afterwards would import those
  // instructions as a wiki page and then inject them back into every prompt --
  // the wiki explaining the wiki, forever.
  const body = full.replace(/<!--\s*plumb:begin\s*-->[\s\S]*?<!--\s*plumb:end\s*-->/g, '').trim()
  // One page per H2 keeps the "one topic per page" rule, which is what makes
  // retrieval able to rank any of them.
  const sections = body.split(/^##\s+/m).slice(1)
  const staged = []
  if (!sections.length) {
    staged.push(stagePage({
      relPath: `reference/${slug(basename(sourcePath, '.md'))}.md`,
      title: basename(sourcePath, '.md'), type: 'reference', summary: '',
      tags: ['imported', 'instructions'], body, sourcePath,
    }))
    return staged
  }
  for (const section of sections) {
    const title = section.split('\n')[0].trim()
    const content = section.slice(section.indexOf('\n') + 1).trim()
    if (!content) continue
    staged.push(stagePage({
      relPath: `reference/${slug(title)}.md`,
      title, type: 'reference',
      summary: summarise(content),
      tags: ['imported', 'instructions'], body: `# ${title}\n\n${content}`, sourcePath,
    }))
  }
  return staged
}

function stageMemoryFile(sourcePath) {
  const raw = readFileSync(sourcePath, 'utf8')
  const { data, body } = splitFrontmatter(raw)
  const title = titleFrom(data, body, basename(sourcePath, '.md'))
  const declared = String(data?.type ?? data?.['metadata.type'] ?? '').toLowerCase()
  const type = WIKI_TYPES[declared] ?? 'reference'
  const tags = Array.isArray(data?.tags) ? data.tags : []
  return [stagePage({
    relPath: `${type === 'project' ? 'projects' : type === 'concept' ? 'concepts' : 'reference'}/${slug(title)}.md`,
    title, type,
    summary: data?.description ?? data?.summary ?? summarise(body),
    tags: [...tags, 'imported'], body, sourcePath,
  })]
}

function stage() {
  const sourceId = flag('--source', null)
  if (!sourceId) die('Usage: migrate.mjs stage --source <claude-md|memory-files>')

  if (sourceId === 'transcripts' || sourceId === 'memory-mcp') {
    die(`Source "${sourceId}" cannot be staged mechanically. It needs fact extraction, ` +
      `which is model work: read the sources, write pages asserting durable facts about ` +
      `the user and their work, never instructions, and stage them into ${STAGING}.`)
  }

  const watermark = readWatermark()
  const paths = sourceId === 'claude-md'
    ? [join(CLAUDE_HOME, 'CLAUDE.md')].filter(existsSync)
    : walk(CLAUDE_HOME, (f) => extname(f) === '.md' && /(^|\/)(memory)(\/|$)/.test(dirname(f) + '/'))

  if (!paths.length) die(`No files found for source "${sourceId}".`)

  mkdirSync(STAGING, { recursive: true })
  const staged = []
  const skipped = []
  for (const sourcePath of paths) {
    const raw = readFileSync(sourcePath, 'utf8')
    const hash = sha(raw)
    if (watermark.sources?.[sourcePath]?.hash === hash) {
      skipped.push({ sourcePath, reason: 'already imported, unchanged' })
      continue
    }
    // MEMORY.md style index files are pointers to other files, not facts. They
    // would import as a page of links to pages, which is noise.
    if (/^memory\.md$/i.test(basename(sourcePath))) {
      skipped.push({ sourcePath, reason: 'index file, not content' })
      continue
    }
    try {
      staged.push(...(sourceId === 'claude-md' ? stageClaudeMd(sourcePath) : stageMemoryFile(sourcePath)))
    } catch (error) {
      skipped.push({ sourcePath, reason: `could not parse: ${error.message}` })
    }
  }

  out({ ok: true, source: sourceId, staging: STAGING, staged, skipped }, () => {
    console.log(`Staged ${staged.length} page(s) from "${sourceId}" into ${STAGING}\n`)
    for (const page of staged) console.log(`  ${page.path.padEnd(48)} ${page.title}`)
    if (skipped.length) {
      console.log(`\nSkipped ${skipped.length}:`)
      for (const s of skipped) console.log(`  ${basename(s.sourcePath)} — ${s.reason}`)
    }
    console.log(`\nNothing is searchable yet. Review the files above, delete any you do not want,`)
    console.log(`then run:  migrate.mjs promote`)
  })
}

// --- promote ---------------------------------------------------------------
async function promote() {
  if (!existsSync(STAGING)) die(`Nothing staged at ${STAGING}.`)
  const staged = walk(STAGING, (f) => extname(f) === '.md')
  if (!staged.length) die(`Nothing staged at ${STAGING}.`)

  const watermark = readWatermark()
  const moved = []
  const collisions = []
  for (const file of staged) {
    const rel = relative(STAGING, file)
    const target = join(WIKI_ROOT, rel)
    if (existsSync(target)) {
      // Never silently overwrite a page the user already has. Migration adds;
      // it does not adjudicate conflicts.
      collisions.push(rel)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    renameSync(file, target)
    moved.push(rel)
    const { data } = splitFrontmatter(readFileSync(target, 'utf8'))
    for (const ref of data?.source_refs ?? []) {
      const sourcePath = String(ref).replace(/^file:\/\//, '')
      if (!existsSync(sourcePath)) continue
      watermark.sources ??= {}
      watermark.sources[sourcePath] = {
        hash: sha(readFileSync(sourcePath, 'utf8')),
        importedAt: new Date().toISOString(),
        pages: [...(watermark.sources[sourcePath]?.pages ?? []), rel],
      }
    }
  }

  mkdirSync(dirname(WATERMARK), { recursive: true })
  writeFileSync(WATERMARK, JSON.stringify(watermark, null, 2) + '\n')

  // Only now does any of this become searchable. Reindex, and let a non-zero
  // exit stand: a partial index demotes every query to keyword-only, including
  // queries about pages that imported perfectly.
  const indexer = join(runtimeDir(), 'node_modules', '@getplumb/wiki', 'dist', 'cli.js')
  const dbPath = process.env.WIKI_DB_PATH || join(homedir(), '.plumb', 'wiki.db')
  let indexed = { ok: false, detail: 'indexer not found' }
  if (existsSync(indexer)) {
    const built = spawnSync(process.execPath, [indexer, 'index', WIKI_ROOT, '--db', dbPath], { encoding: 'utf8' })
    indexed = {
      ok: built.status === 0,
      detail: `${built.stdout || ''}${built.stderr || ''}`.trim().split('\n').slice(-3).join(' | '),
    }
  }

  // Tell the running service its index changed, rather than billing the next
  // user query for the rebuild. This must be awaited: fire-and-forget before
  // process exit means the request is never actually sent, which left a freshly
  // promoted page unsearchable and the service still serving its old, empty
  // index.
  const serviceUrl = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
  let refreshed = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const response = await fetch(`${serviceUrl}/reindex?force=1`, { signal: controller.signal })
    clearTimeout(timer)
    refreshed = response.ok ? await response.json() : { ok: false, status: response.status }
  } catch (error) {
    // Not running is fine -- it will build a current index when it next starts.
    refreshed = { ok: false, reason: error?.cause?.code === 'ECONNREFUSED' ? 'service not running' : String(error?.message ?? error) }
  }

  try { if (!walk(STAGING, () => true).length) rmSync(STAGING, { recursive: true, force: true }) } catch { /* leave it */ }

  out({ ok: indexed.ok, moved, collisions, indexed, refreshed }, () => {
    console.log(`Promoted ${moved.length} page(s) into ${WIKI_ROOT}`)
    if (collisions.length) {
      console.log(`\n${collisions.length} left staged because a page already exists at that path:`)
      for (const c of collisions) console.log(`  ${c}`)
    }
    console.log(`\nindex: ${indexed.ok ? 'ok' : 'FAILED'} — ${indexed.detail}`)
    console.log(`live service: ${refreshed?.ok
      ? `refreshed, generation ${refreshed.indexGeneration}, ${refreshed.chunkCount} chunk(s), contextual ${refreshed.useContextual}`
      : `not refreshed (${refreshed?.reason ?? refreshed?.status ?? 'unknown'}) — it will rebuild on next start`}`)
    if (!indexed.ok) console.log('Retrieval would be keyword-only until this is fixed. Run /plumb-doctor.')
  })
  process.exit(indexed.ok ? 0 : 1)
}

// --- status ----------------------------------------------------------------
function status() {
  const watermark = readWatermark()
  const staged = existsSync(STAGING) ? walk(STAGING, (f) => extname(f) === '.md') : []
  const imported = Object.entries(watermark.sources ?? {})
  out({ ok: true, staged: staged.map((f) => relative(STAGING, f)), imported: imported.length }, () => {
    console.log(`Staged, awaiting review: ${staged.length}`)
    for (const f of staged) console.log(`  ${relative(STAGING, f)}`)
    console.log(`\nSources already imported: ${imported.length}`)
    for (const [path, info] of imported.slice(0, 20)) {
      console.log(`  ${basename(path).padEnd(40)} ${info.importedAt?.slice(0, 10)} → ${info.pages?.length ?? 0} page(s)`)
    }
  })
}

switch (command) {
  case 'discover': discover(); break
  case 'stage': stage(); break
  case 'promote': await promote(); break
  case 'status': status(); break
  default:
    console.error('Usage: migrate.mjs <discover|stage|promote|status> [--source <id>] [--json]')
    process.exit(1)
}
