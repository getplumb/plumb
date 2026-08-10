import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
const EMBEDDING_DIMENSIONS = 384
const RRF_K = 60
const MAX_QUERY_LENGTH = 500
const VECTOR_SEARCH_CGROUP_GUARD_BYTES = Number(process.env.WIKI_SEARCH_GUARD_BYTES) || 300 * 1024 * 1024
// Fast mode holds the embedding model resident, so its guard must sit above the
// model's own footprint or the guard would permanently disable the vectors it protects.
const FAST_VECTOR_SEARCH_CGROUP_GUARD_BYTES = Number(process.env.WIKI_SEARCH_FAST_GUARD_BYTES) || 450 * 1024 * 1024
// Service patch: idle shutdown was a terra-chat memory-cap constraint (512MB
// heap). This service has its own 1GB cgroup, and real prompt traffic is bursty
// with gaps longer than any reasonable idle window, so the burst-entry query
// would almost always pay the ~400ms cold spawn. WIKI_EMBEDDER_IDLE_MS=0 keeps
// the embedder warm permanently (~180MB); unset preserves original behavior.
const RESIDENT_WORKER_IDLE_MS = process.env.WIKI_EMBEDDER_IDLE_MS === undefined || process.env.WIKI_EMBEDDER_IDLE_MS === ''
  ? 5 * 60 * 1000
  : Number(process.env.WIKI_EMBEDDER_IDLE_MS)
const SKIP_DIRECTORIES = new Set(['.git', '.obsidian'])
// Machinery vs. demotion are different concepts, so they get different lists.
// SKIP_DIRECTORIES above is "not content, never emit". HIDDEN_TREE_DIRECTORIES
// below is "real content, deliberately demoted": these are emitted with
// hidden: true and sorted last, and the explorer collapses them behind a
// toggle. Root-relative paths, so a nested 'archive/' elsewhere is unaffected.
// archive/ holds superseded 2026-04-16 snapshots plus preserved corruption
// copies; none of it is in the search index, but it is still linked from live
// pages (e.g. tools/openclaw-mcp-plugin.md), so it must stay reachable.
const HIDDEN_TREE_DIRECTORIES = new Set(['archive'])
// 'standard'    — hybrid vector+BM25 with a fresh embedding child process per query
//                 (memory-clean: model memory returns to the OS after every query;
//                 latency dominated by the ~400ms per-query model load)
// 'fast'        — precomputed BM25 index, no vector search (keyword-only, ~2ms)
// 'fast-hybrid' — hybrid vector+BM25 with precomputed BM25 and a resident embedding
//                 child process (identical results to 'standard', ~15ms warm; holds
//                 the model resident between queries, idle shutdown after 5 minutes)
const SEARCH_MODES = new Set(['standard', 'fast', 'fast-hybrid'])

// Service patch (vs. the terra-chat original): the transformers entrypoint used
// to be hardcoded to ~/.openclaw/extensions/plumb/node_modules. This package
// vendors its own @xenova/transformers so the service has no OpenClaw-tree
// dependency; WIKI_TRANSFORMERS_PATH overrides for tests/relocation.
const TRANSFORMER_ENTRY = process.env.WIKI_TRANSFORMERS_PATH
  || new URL('../node_modules/@xenova/transformers/src/transformers.js', import.meta.url).pathname

let embeddingQueue = Promise.resolve()
let cachedSearchIndex = null
let cachedSearchMode = null
const searchResultCache = new Map()
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const SEARCH_CACHE_MAX_ENTRIES = 50

function safeJsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeWikiPath(input, { requireMarkdown = false } = {}) {
  const normalized = String(input || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('\0')) throw new Error('Wiki path is required')
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid wiki path')
  if (requireMarkdown && extname(normalized).toLowerCase() !== '.md') throw new Error('Wiki page must be Markdown')
  return normalized
}

function absoluteWikiPath(wikiRoot, input, options) {
  const relPath = normalizeWikiPath(input, options)
  const root = resolve(wikiRoot)
  const absolute = resolve(root, relPath)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error('Invalid wiki path')
  return { relPath, absolute }
}

export function parseFrontmatter(raw) {
  const text = String(raw || '')
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text }
  const closing = text.indexOf('\n---\n', 4)
  if (closing < 0) return { frontmatter: {}, body: text }
  const frontmatter = {}
  for (const line of text.slice(4, closing).split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      value = value.replace(/^['"]|['"]$/g, '')
    }
    frontmatter[key] = value
  }
  return { frontmatter, body: text.slice(closing + 5) }
}

function titleFromMarkdown(body, fallback) {
  const heading = String(body).match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || fallback.replace(/[-_]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function buildTreeDirectory(wikiRoot, relativeDirectory = '') {
  const directory = relativeDirectory ? join(wikiRoot, relativeDirectory) : wikiRoot
  const directories = []
  const pages = []

  for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.') || SKIP_DIRECTORIES.has(name)) continue
    const absolute = join(directory, name)
    const stat = statSync(absolute)
    const relPath = relative(wikiRoot, absolute).split(sep).join('/')
    if (stat.isDirectory()) {
      const node = {
        kind: 'directory',
        name,
        path: relPath,
        children: buildTreeDirectory(wikiRoot, relPath),
      }
      if (HIDDEN_TREE_DIRECTORIES.has(relPath)) node.hidden = true
      directories.push(node)
    } else if (stat.isFile() && extname(name).toLowerCase() === '.md') {
      pages.push({
        kind: 'page',
        name: basename(name, '.md'),
        path: relPath,
      })
    }
  }

  // Hidden directories sort last so they are never the first thing in the
  // explorer even when the caller chooses to show them.
  const visible = directories.filter(node => !node.hidden)
  const hidden = directories.filter(node => node.hidden)
  return [...visible, ...pages, ...hidden]
}

function openWikiDb(wikiDbPath) {
  return new DatabaseSync(wikiDbPath, { readOnly: true })
}

function pageRecord(db, relPath) {
  return db.prepare(`
    SELECT id, path, type, title, created, updated, confidence, tags, source_refs, status, word_count
    FROM wiki_pages
    WHERE path = ?
  `).get(relPath)
}

function pagePathForId(db, pageId) {
  if (!pageId) return null
  return db.prepare('SELECT path FROM wiki_pages WHERE id = ? AND COALESCE(status, \'active\') = \'active\'').get(pageId)?.path || null
}

function resolveLinkTarget(db, targetTitle) {
  const normalizedTarget = String(targetTitle || '').trim().replace(/\.md$/i, '')
  if (!normalizedTarget) return null
  const direct = db.prepare(`
    SELECT path FROM wiki_pages
    WHERE COALESCE(status, 'active') = 'active'
      AND (id = ? COLLATE NOCASE OR path = ? COLLATE NOCASE OR title = ? COLLATE NOCASE)
    LIMIT 1
  `).get(normalizedTarget, `${normalizedTarget}.md`, normalizedTarget)
  if (direct?.path) return direct.path
  return db.prepare(`
    SELECT p.path
    FROM wiki_aliases a
    JOIN wiki_pages p ON p.id = a.page_id
    WHERE a.alias = ? COLLATE NOCASE AND COALESCE(p.status, 'active') = 'active'
    LIMIT 1
  `).get(normalizedTarget)?.path || null
}

function wikiLinks(db, relPath) {
  const record = pageRecord(db, relPath)
  if (!record) return { outbound: [], inbound: [] }
  const outbound = db.prepare(`
    SELECT target_title AS title, target_page_id AS pageId, resolved
    FROM wiki_links
    WHERE source_page_id = ?
    ORDER BY target_title COLLATE NOCASE
  `).all(record.id).map(link => ({
    title: link.title,
    path: pagePathForId(db, link.pageId) || resolveLinkTarget(db, link.title),
    resolved: Boolean(link.resolved),
  }))
  const inbound = db.prepare(`
    SELECT l.target_title AS title, p.title AS sourceTitle, p.path AS sourcePath
    FROM wiki_links l
    JOIN wiki_pages p ON p.id = l.source_page_id
    WHERE l.target_page_id = ? AND COALESCE(p.status, 'active') = 'active'
    ORDER BY p.title COLLATE NOCASE
  `).all(record.id).map(link => ({
    title: link.sourceTitle,
    path: link.sourcePath,
    via: link.title,
  }))
  return { outbound, inbound }
}

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []
}

export function contextualBm25Search(query, docs, top = 1000) {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || docs.length === 0) return []
  const averageLength = docs.reduce((sum, doc) => sum + tokenize(doc.text).length, 0) / docs.length
  const frequencies = new Map()
  const documentLengths = new Map()
  const documentFrequency = new Map()

  for (const doc of docs) {
    const tokens = tokenize(doc.text)
    documentLengths.set(doc.id, tokens.length)
    const termFrequency = new Map()
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) || 0) + 1)
    frequencies.set(doc.id, termFrequency)
    for (const token of new Set(tokens)) {
      if (queryTerms.includes(token)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)
    }
  }

  const k1 = 1.2
  const b = 0.75
  return docs.map(doc => {
    let score = 0
    for (const term of queryTerms) {
      const frequency = frequencies.get(doc.id)?.get(term) || 0
      if (!frequency) continue
      const df = documentFrequency.get(term) || 0
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      score += idf * (frequency * (k1 + 1))
        / (frequency + k1 * (1 - b + b * ((documentLengths.get(doc.id) || 0) / (averageLength || 1))))
    }
    return { id: doc.id, score }
  }).filter(item => item.score > 0)
    .sort((a, bValue) => bValue.score - a.score)
    .slice(0, top)
    .map(item => item.id)
}

// Precompute the per-document statistics that contextualBm25Search re-derives on
// every query. Scoring with these is mathematically identical: term frequencies,
// document lengths, per-term document frequency, and average length are all
// query-independent.
export function buildBm25Index(docs) {
  const order = []
  const termFrequencies = new Map()
  const documentLengths = new Map()
  const documentFrequency = new Map()
  let totalLength = 0
  for (const doc of docs) {
    order.push(doc.id)
    const tokens = tokenize(doc.text)
    totalLength += tokens.length
    documentLengths.set(doc.id, tokens.length)
    const termFrequency = new Map()
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) || 0) + 1)
    termFrequencies.set(doc.id, termFrequency)
    for (const token of termFrequency.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)
    }
  }
  return {
    order,
    termFrequencies,
    documentLengths,
    documentFrequency,
    averageLength: docs.length ? totalLength / docs.length : 0,
    count: docs.length,
  }
}

export function bm25SearchIndexed(query, bm25Index, top = 1000) {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || bm25Index.count === 0) return []
  const k1 = 1.2
  const b = 0.75
  const { averageLength } = bm25Index
  return bm25Index.order.map(id => {
    let score = 0
    for (const term of queryTerms) {
      const frequency = bm25Index.termFrequencies.get(id)?.get(term) || 0
      if (!frequency) continue
      const df = bm25Index.documentFrequency.get(term) || 0
      const idf = Math.log(1 + (bm25Index.count - df + 0.5) / (df + 0.5))
      score += idf * (frequency * (k1 + 1))
        / (frequency + k1 * (1 - b + b * ((bm25Index.documentLengths.get(id) || 0) / (averageLength || 1))))
    }
    return { id, score }
  }).filter(item => item.score > 0)
    .sort((a, bValue) => bValue.score - a.score)
    .slice(0, top)
    .map(item => item.id)
}

export function reciprocalRankFusion(rankedLists) {
  const scores = new Map()
  for (const list of rankedLists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank)))
  }
  return scores
}

function cosineDistance(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator ? 1 - dot / denominator : Number.POSITIVE_INFINITY
}

function contextualChildText(chunk) {
  const breadcrumb = [...new Set([
    chunk.title,
    ...String(chunk.section || '').split(/\s*[>›/]\s*/).map(part => part.trim()).filter(Boolean),
  ])].join(' › ')
  return `Title: ${chunk.title}\nType: ${chunk.type || 'page'}\nBreadcrumb: ${breadcrumb}\n\n${chunk.content}`
}

// SQLite in WAL mode commits (wiki queue integrations, embedding backfills)
// without touching the main db file's mtime, so mtime alone leaves this cache
// stale until a checkpoint. PRAGMA data_version on a persistent probe connection
// changes whenever any other connection commits; mtime still catches wholesale
// file replacement, which resets the probe.
let indexVersionProbe = null
let indexGeneration = 0

function wikiDbDataVersion(wikiDbPath, modifiedAt) {
  if (indexVersionProbe?.wikiDbPath !== wikiDbPath || indexVersionProbe.modifiedAt !== modifiedAt) {
    try {
      indexVersionProbe?.db.close()
    } catch {
      // already closed
    }
    indexVersionProbe = { wikiDbPath, modifiedAt, db: openWikiDb(wikiDbPath) }
  }
  return indexVersionProbe.db.prepare('PRAGMA data_version').get().data_version
}

function contextualIndex(wikiDbPath) {
  const modifiedAt = statSync(wikiDbPath).mtimeMs
  const dataVersion = wikiDbDataVersion(wikiDbPath, modifiedAt)
  if (cachedSearchIndex?.wikiDbPath === wikiDbPath
    && cachedSearchIndex.modifiedAt === modifiedAt
    && cachedSearchIndex.dataVersion === dataVersion) return cachedSearchIndex

  const db = openWikiDb(wikiDbPath)
  try {
    const eligible = db.prepare(`
      SELECT c.id, c.page_id AS pageId, c.content, COALESCE(c.section, '') AS section,
             c.chunk_index AS chunkIndex, p.path, p.title, p.type,
             e.dimensions, e.embedding, e.status AS contextualStatus
      FROM wiki_chunks c
      JOIN wiki_pages p ON p.id = c.page_id
      LEFT JOIN wiki_chunk_context_embeddings e
        ON e.chunk_id = c.id AND e.model = ?
      WHERE c.embed_status = 'done' AND c.embedding IS NOT NULL
        AND COALESCE(p.status, 'active') = 'active'
      ORDER BY p.path, c.chunk_index
    `).all(DEFAULT_MODEL)
    const contextual = eligible.filter(row => (
      row.contextualStatus === 'done'
      && row.dimensions === EMBEDDING_DIMENSIONS
      && typeof row.embedding === 'string'
    ))
    const useContextual = contextual.length > 0 && contextual.length === eligible.length
    const rows = useContextual ? contextual : eligible.map(row => ({ ...row, embedding: db.prepare('SELECT embedding FROM wiki_chunks WHERE id = ?').get(row.id)?.embedding }))
    const chunks = rows.map(row => ({
      ...row,
      vector: new Float32Array(JSON.parse(row.embedding)),
    }))
    const parentContexts = new Map()
    for (const chunk of chunks) {
      const key = `${chunk.pageId}\0${chunk.section}`
      const values = parentContexts.get(key) || []
      values.push(chunk)
      parentContexts.set(key, values)
    }
    indexGeneration += 1
    cachedSearchIndex = {
      wikiDbPath, modifiedAt, dataVersion, generation: indexGeneration, chunks, parentContexts, useContextual,
      // Service patch: coverage counts surfaced by searchStats() so /health can
      // report the all-or-nothing contextual gate instead of it degrading silently
      // (the 2026-08-06..08 outage mode).
      eligibleCount: eligible.length,
      contextualCount: contextual.length,
    }
    return cachedSearchIndex
  } finally {
    db.close()
  }
}

function currentCgroupMemory() {
  try {
    const cgroupPath = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find(line => line.startsWith('0::'))
      ?.slice(3)
    if (!cgroupPath) return null
    return Number(readFileSync(join('/sys/fs/cgroup', cgroupPath, 'memory.current'), 'utf8').trim())
  } catch {
    return null
  }
}

function embedQueryInChildProcess(query) {
  // A fresh child process per query, not a worker thread: onnxruntime-node's
  // native binding registers only in the first worker thread of a process and
  // fails with "Module did not self-register" in every later one, which silently
  // disabled vector search under the old per-query-worker design. A child process
  // loads it reliably and still returns all model memory to the OS on exit.
  const transformerEntry = TRANSFORMER_ENTRY
  const script = new URL('./wikiEmbeddingChildProcess.js', import.meta.url).pathname
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, transformerEntry, DEFAULT_MODEL], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
      child.kill()
    }
    child.stdout.on('data', data => {
      buffer += data.toString()
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.ready) {
          child.stdin.write(`${JSON.stringify({ id: 1, query })}\n`)
          continue
        }
        if (message.error) finish(rejectPromise, new Error(message.error))
        else finish(resolvePromise, new Float32Array(message.vector || []))
      }
    })
    child.stderr.on('data', () => {})
    child.once('error', error => finish(rejectPromise, error))
    child.once('exit', code => {
      if (!settled) finish(rejectPromise, new Error(`Embedding process exited with code ${code}`))
    })
  })
}

async function embedQuery(query) {
  // Serialize embedding processes. Exiting the child returns ONNX memory to the
  // OS instead of permanently consuming Terra Chat's 600 MB cgroup headroom.
  const run = embeddingQueue.then(() => embedQueryInChildProcess(query))
  embeddingQueue = run.catch(() => undefined)
  return run
}

// ── Fast mode: resident embedding child process ──────────────────────────────
// Keeps the ONNX model loaded between queries instead of paying the spawn+load
// cost every time. A child process (not a worker thread) because onnxruntime-node
// fails with "Module did not self-register" inside worker_threads. Shuts itself
// down after RESIDENT_WORKER_IDLE_MS of inactivity so idle memory returns to the
// OS, and backs off for RESIDENT_FAILURE_COOLDOWN_MS after a startup failure so a
// broken embedder cannot cause a per-query spawn storm.
// Service patch: crash recovery now mirrors the systemd service-level policy
// (fast retry, exponential backoff on repeated failure) instead of the original
// flat 10-minute lockout, which treated one transient crash as harshly as a
// persistently broken embedder. Base 2s matches the unit's RestartSec=2; the
// cap preserves the original spawn-storm ceiling. Streak resets on the first
// successful embed, so only *consecutive* failures escalate.
const RESIDENT_FAILURE_BASE_COOLDOWN_MS = Number(process.env.WIKI_EMBEDDER_RETRY_BASE_MS) > 0
  ? Number(process.env.WIKI_EMBEDDER_RETRY_BASE_MS)
  : 2000
const RESIDENT_FAILURE_MAX_COOLDOWN_MS = Number(process.env.WIKI_EMBEDDER_RETRY_MAX_MS) > 0
  ? Number(process.env.WIKI_EMBEDDER_RETRY_MAX_MS)
  : 10 * 60 * 1000
let residentEmbedder = null
let residentEmbedderFailedAt = 0
let residentEmbedderFailureStreak = 0

function residentCooldownMs() {
  if (residentEmbedderFailureStreak <= 0) return 0
  return Math.min(
    RESIDENT_FAILURE_MAX_COOLDOWN_MS,
    RESIDENT_FAILURE_BASE_COOLDOWN_MS * 2 ** Math.min(residentEmbedderFailureStreak - 1, 30),
  )
}

// Service patch: in keep-warm mode (WIKI_EMBEDDER_IDLE_MS=0) the embedder is
// supervised, not lazy. An unexpected death schedules its own respawn after the
// current backoff; the respawn probe embed both warms the ONNX pipeline and
// resets the failure streak, so "warm" doesn't wait for the next real query.
// Intentional stops (idle timeout, cgroup memory guard) deliberately stay lazy:
// auto-respawning against the memory guard would fight the very thing it guards.
let residentEmbedderRespawnTimer = null
function scheduleResidentEmbedderRespawn() {
  if (RESIDENT_WORKER_IDLE_MS > 0) return
  if (residentEmbedderRespawnTimer) return
  const timer = setTimeout(() => {
    residentEmbedderRespawnTimer = null
    if (residentEmbedder) return
    residentEmbedQuery('embedder keep-warm respawn probe').catch(() => {
      // A spawned-then-failed attempt reschedules via its own exit handler; a
      // cooldown-boundary miss reschedules here. The timer-exists guard above
      // prevents duplicates either way.
      scheduleResidentEmbedderRespawn()
    })
  }, residentCooldownMs() + 50)
  timer.unref?.()
  residentEmbedderRespawnTimer = timer
}

function stopResidentEmbedder(reason) {
  const current = residentEmbedder
  if (!current) return
  residentEmbedder = null
  clearTimeout(current.idleTimer)
  for (const pending of current.pending.values()) {
    pending.reject(new Error(`Resident embedding process stopped: ${reason}`))
  }
  current.pending.clear()
  // Mark the shutdown as intentional so the exit handler does not treat the
  // killed child's nonzero exit as a startup failure and enter the cooldown.
  current.stopping = true
  current.child.kill()
}

function touchResidentEmbedderIdleTimer() {
  if (!residentEmbedder) return
  clearTimeout(residentEmbedder.idleTimer)
  if (RESIDENT_WORKER_IDLE_MS <= 0) return // keep-warm mode: never idle out
  residentEmbedder.idleTimer = setTimeout(() => stopResidentEmbedder('idle timeout'), RESIDENT_WORKER_IDLE_MS)
  residentEmbedder.idleTimer.unref?.()
}

function startResidentEmbedder() {
  const transformerEntry = TRANSFORMER_ENTRY
  const script = new URL('./wikiEmbeddingChildProcess.js', import.meta.url).pathname
  const child = spawn(process.execPath, [script, transformerEntry, DEFAULT_MODEL], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = {
    child,
    pending: new Map(),
    nextId: 1,
    idleTimer: null,
    buffer: '',
    ready: null,
  }
  state.ready = new Promise((resolvePromise, rejectPromise) => {
    state.resolveReady = resolvePromise
    state.rejectReady = rejectPromise
  })
  child.stdout.on('data', data => {
    state.buffer += data.toString()
    let newline
    while ((newline = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newline)
      state.buffer = state.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.ready) {
        state.resolveReady?.()
        continue
      }
      const pending = state.pending.get(message.id)
      if (!pending) continue
      state.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else {
        // A real embed succeeded: the embedder is healthy, so consecutive-failure
        // escalation starts over. (Deliberately not reset at mere 'ready' — a
        // load-then-crash loop must keep escalating.)
        residentEmbedderFailureStreak = 0
        pending.resolve(new Float32Array(message.vector || []))
      }
    }
  })
  child.stderr.on('data', () => {})
  // 'error' and 'exit' can both fire for one dead child; count the failure once.
  const recordFailure = () => {
    if (state.failureCounted) return
    state.failureCounted = true
    residentEmbedderFailedAt = Date.now()
    residentEmbedderFailureStreak += 1
  }
  child.once('error', error => {
    recordFailure()
    state.rejectReady?.(error)
    if (residentEmbedder === state) stopResidentEmbedder(error.message)
    scheduleResidentEmbedderRespawn()
  })
  child.once('exit', code => {
    // Capture intent BEFORE stopResidentEmbedder below marks this state
    // stopping; otherwise a crash would be misread as an intentional stop and
    // the keep-warm supervisor would never re-arm.
    const intentional = state.stopping
    if (!intentional && code !== 0) recordFailure()
    state.rejectReady?.(new Error(`Embedding process exited with code ${code}`))
    if (residentEmbedder === state) stopResidentEmbedder(`process exited with code ${code}`)
    if (!intentional) scheduleResidentEmbedderRespawn()
  })
  residentEmbedder = state
  touchResidentEmbedderIdleTimer()
  return state
}

async function residentEmbedQuery(query) {
  if (!residentEmbedder && Date.now() - residentEmbedderFailedAt < residentCooldownMs()) {
    throw new Error('resident embedder in failure cooldown')
  }
  const state = residentEmbedder || startResidentEmbedder()
  await state.ready
  residentEmbedderFailedAt = 0
  touchResidentEmbedderIdleTimer()
  return new Promise((resolvePromise, rejectPromise) => {
    const id = state.nextId
    state.nextId += 1
    state.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
    state.child.stdin.write(`${JSON.stringify({ id, query })}\n`)
  })
}

// ── Search mode switch ───────────────────────────────────────────────────────
// Runtime-flippable with no restart. Resolution order:
//   1. WIKI_SEARCH_MODE env var (tests and offline evaluation)
//   2. server/wiki-search-mode.<env>.json (per-environment: prod/beta/dev,
//      derived the same way index.js derives CURRENT_ENV, so beta can run fast
//      while prod stays standard even though all environments share this source)
//   3. server/wiki-search-mode.json (shared)
// Missing or invalid config means 'standard'.
const SERVER_DIR = dirname(new URL(import.meta.url).pathname)
const CURRENT_ENV = process.env.TERRA_ENV
  || (process.env.PORT === '3002' ? 'dev' : process.env.PORT === '3001' ? 'beta' : 'prod')
const SEARCH_MODE_FILES = [
  join(SERVER_DIR, `wiki-search-mode.${CURRENT_ENV}.json`),
  join(SERVER_DIR, 'wiki-search-mode.json'),
]

export function getWikiSearchMode() {
  const fromEnv = process.env.WIKI_SEARCH_MODE
  if (SEARCH_MODES.has(fromEnv)) return fromEnv
  for (const file of SEARCH_MODE_FILES) {
    try {
      const modifiedAt = statSync(file).mtimeMs
      const cached = cachedSearchMode?.file === file && cachedSearchMode.modifiedAt === modifiedAt
      if (!cached) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        cachedSearchMode = { file, modifiedAt, mode: SEARCH_MODES.has(parsed?.mode) ? parsed.mode : 'standard' }
      }
      return cachedSearchMode.mode
    } catch {
      cachedSearchMode = null
    }
  }
  return 'standard'
}

export async function searchWiki(query, wikiDbPath, topK = 10) {
  const cleanQuery = String(query || '').trim().slice(0, MAX_QUERY_LENGTH)
  if (!cleanQuery) return { results: [], mode: 'hybrid-contextual' }
  const searchMode = getWikiSearchMode()
  const fast = searchMode !== 'standard'
  const limit = Math.max(1, Math.min(Number(topK) || 10, 20))
  const index = contextualIndex(wikiDbPath)
  const cacheKey = `${searchMode}:${index.generation}:${limit}:${cleanQuery.toLowerCase()}`
  const cached = searchResultCache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) return cached.value

  let keywordList
  if (fast) {
    if (!index.bm25) {
      index.bm25 = buildBm25Index(index.chunks.map(chunk => ({
        id: chunk.id,
        text: index.useContextual ? contextualChildText(chunk) : chunk.content,
      })))
    }
    keywordList = bm25SearchIndexed(cleanQuery, index.bm25)
  } else {
    keywordList = contextualBm25Search(cleanQuery, index.chunks.map(chunk => ({
      id: chunk.id,
      text: index.useContextual ? contextualChildText(chunk) : chunk.content,
    })))
  }

  let vectorList = []
  let mode = index.useContextual ? 'hybrid-contextual' : 'hybrid-plain'
  if (searchMode === 'fast') {
    // Fast mode is keyword-only by design: on the 2026-08-06 102-case eval the
    // vector half added latency without improving page recall, and skipping the
    // embedder keeps results byte-identical to standard's live behavior.
    mode = index.useContextual ? 'bm25-contextual' : 'bm25-plain'
  } else {
    try {
      const cgroupMemory = currentCgroupMemory()
      const guardBytes = fast ? FAST_VECTOR_SEARCH_CGROUP_GUARD_BYTES : VECTOR_SEARCH_CGROUP_GUARD_BYTES
      if (cgroupMemory !== null && cgroupMemory > guardBytes) {
        if (fast) stopResidentEmbedder('cgroup memory guard')
        throw new Error(`cgroup memory guard active at ${Math.round(cgroupMemory / 1024 / 1024)} MB`)
      }
      const queryVector = fast ? await residentEmbedQuery(cleanQuery) : await embedQuery(cleanQuery)
      vectorList = index.chunks.map(chunk => ({ id: chunk.id, distance: cosineDistance(queryVector, chunk.vector) }))
        .sort((a, b) => a.distance - b.distance)
        .map(item => item.id)
    } catch (error) {
      console.warn('[wiki-search] vector search unavailable, using BM25:', error.message)
      mode = index.useContextual ? 'bm25-contextual' : 'bm25-plain'
    }
  }
  if (fast) mode = `${mode}-fast`

  const scores = reciprocalRankFusion(vectorList.length ? [vectorList, keywordList] : [keywordList])
  const byId = new Map(index.chunks.map(chunk => [chunk.id, chunk]))
  const ranked = [...scores.entries()].map(([id, score]) => ({ chunk: byId.get(id), score }))
    .filter(item => item.chunk)
    .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path))
  const selectedPages = new Set()
  const results = []
  for (const item of ranked) {
    if (selectedPages.has(item.chunk.path)) continue
    selectedPages.add(item.chunk.path)
    const parentKey = `${item.chunk.pageId}\0${item.chunk.section}`
    const parentContext = (index.parentContexts.get(parentKey) || [item.chunk])
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(chunk => chunk.content.trim())
      .filter(Boolean)
      .join('\n\n')
    results.push({
      path: item.chunk.path,
      title: item.chunk.title,
      type: item.chunk.type,
      section: item.chunk.section,
      snippet: parentContext.slice(0, 900),
      score: item.score,
    })
    if (results.length >= limit) break
  }
  const value = { results, mode }
  searchResultCache.set(cacheKey, { createdAt: Date.now(), value })
  while (searchResultCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    searchResultCache.delete(searchResultCache.keys().next().value)
  }
  return value
}

export function createWikiNavigator({ wikiRoot, wikiDbPath }) {
  return {
    tree() {
      return buildTreeDirectory(wikiRoot)
    },
    page(inputPath) {
      const { relPath, absolute } = absoluteWikiPath(wikiRoot, inputPath, { requireMarkdown: true })
      if (!existsSync(absolute) || !statSync(absolute).isFile()) return null
      const raw = readFileSync(absolute, 'utf8')
      const parsed = parseFrontmatter(raw)
      const db = openWikiDb(wikiDbPath)
      try {
        const record = pageRecord(db, relPath)
        return {
          path: relPath,
          title: record?.title || titleFromMarkdown(parsed.body, basename(relPath, '.md')),
          type: record?.type || parsed.frontmatter.type || 'page',
          created: record?.created || parsed.frontmatter.created || null,
          updated: record?.updated || parsed.frontmatter.updated || null,
          confidence: record?.confidence || parsed.frontmatter.confidence || null,
          tags: record ? safeJsonArray(record.tags) : (parsed.frontmatter.tags || []),
          sourceRefs: record ? safeJsonArray(record.source_refs) : (parsed.frontmatter.source_refs || []),
          wordCount: record?.word_count || parsed.body.split(/\s+/).filter(Boolean).length,
          body: parsed.body.trim(),
          links: wikiLinks(db, relPath),
        }
      } finally {
        db.close()
      }
    },
    links(inputPath) {
      const relPath = normalizeWikiPath(inputPath, { requireMarkdown: true })
      const db = openWikiDb(wikiDbPath)
      try {
        return wikiLinks(db, relPath)
      } finally {
        db.close()
      }
    },
    resolve(targetTitle) {
      const db = openWikiDb(wikiDbPath)
      try {
        return resolveLinkTarget(db, targetTitle)
      } finally {
        db.close()
      }
    },
    search(query, topK) {
      return searchWiki(query, wikiDbPath, topK)
    },
    fingerprint() {
      return createHash('sha256').update(`${wikiRoot}:${statSync(wikiDbPath).mtimeMs}`).digest('hex').slice(0, 16)
    },
  }
}

// Service patch: observability for /health. Everything here has silently failed
// in production before (coverage gate -> plain fallback, cgroup guard -> BM25-only,
// embedder crash -> 10-minute vector cooldown), so the service reports it all.
export function searchStats(wikiDbPath) {
  const index = contextualIndex(wikiDbPath)
  const now = Date.now()
  const cooldownUntil = residentEmbedderFailedAt && residentEmbedderFailureStreak > 0
    ? residentEmbedderFailedAt + residentCooldownMs()
    : null
  return {
    searchMode: getWikiSearchMode(),
    useContextual: index.useContextual,
    chunkCount: index.chunks.length,
    eligibleCount: index.eligibleCount,
    contextualCount: index.contextualCount,
    coverageRatio: index.eligibleCount ? index.contextualCount / index.eligibleCount : 0,
    indexGeneration: index.generation,
    bm25IndexReady: Boolean(index.bm25),
    embedder: {
      resident: Boolean(residentEmbedder),
      pid: residentEmbedder?.child.pid ?? null,
      inCooldown: !residentEmbedder && cooldownUntil !== null && now < cooldownUntil,
      cooldownUntil,
      failureStreak: residentEmbedderFailureStreak,
      currentCooldownMs: residentCooldownMs(),
    },
  }
}
