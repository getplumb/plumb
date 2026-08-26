#!/usr/bin/env node
// MCP server for the Claude Code Plumb wiki surface (Phase 3 cutover 2026-08-10).
//
// Replaces @getplumb/plumb packages/mcp-server/dist/claude-wiki.js. Read tools
// (search/read/list/links) proxy the supervised plumb-wiki-search HTTP service,
// so MCP results come from the same benchmarked engine as injection and the
// console. plumb_wiki_queue_edit stays a local JSONL append, byte-compatible
// with @getplumb/core appendToQueue ({id, fact, queued_at, status:'pending'}).
//
// Tool names, input schemas, and output text formats mirror the old server so
// sessions, prompts, and the queue worker see no interface change.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureService } from './ensure-service.mjs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const SERVICE = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
const QUEUE_PATH = process.env.PLUMB_WIKI_QUEUE_PATH || join(homedir(), '.plumb', 'wiki-queue.jsonl')
const FETCH_DEADLINE_MS = Number(process.env.PLUMB_MCP_FETCH_DEADLINE_MS) || 5000
// An agent-initiated tool call tolerates far more latency than a prompt hook,
// and returning an error to the model is visible rather than silent, so the
// cold-start budget here is generous.
const COLD_START_BUDGET_MS = Number(process.env.PLUMB_MCP_COLD_START_BUDGET_MS) || 15_000
const TELEMETRY_PATH =
  process.env.PLUMB_TRAFFIC_TELEMETRY_PATH ?? join(homedir(), '.plumb', 'telemetry', 'claude-code-traffic.jsonl')

// Two axes on every search (2026-08-14).
//
// Searches used to report only status and serving instance, so the dashboard
// averaged the user's interactive searches together with the maintenance robots' --
// which is how a healthy interactive path (p50 68ms) came to look like a ~1s
// problem on the graph.
//
// AXIS 1, `workload`: a CLOSED set, validated here.
//
//   interactive  a human is in the loop, waiting on this answer
//   batch        unattended production work (cron jobs)
//   testing      tests, benchmarks, evals, health probes
//   unknown      unlabelled, or a value outside the set
//
// the user's rule for which bucket, and it is the test to apply to any new caller:
// is the wiki THE POINT, or is it scaffolding for testing something else?
// skill-evals runs real searches and a model genuinely tries to find things --
// but it is "using the wiki because it's needed to test something else", so it
// is `testing`. Note this is deliberately NOT "does anything consume the
// answer": a cron that reads the wiki to build a report nobody opens is still
// `batch`, because the wiki was being used to accomplish something.
//
// interactive + batch = productive work, which is the number the user actually
// wants. That is the whole reason `testing` exists as a bucket: to be excluded.
//
// The first version of this accepted any string, and within a day a project had
// labelled itself 'skill-eval' -- a project name in the category slot. A
// category answers "what kind of traffic is this" and stays true; a project
// name answers "what was I working on that week" and stops being true. Hence
// the closed set, and hence axis 2.
//
// AXIS 2, `purpose`: free text, at most three words, saying what the calls were
// for. Deliberately unvalidated as to VOCABULARY (a new project should be able
// to name itself without a code change) but normalised for SHAPE, because
// "three words" bounds length and not cardinality -- `matrix 20260814 073907`
// is three words and unique per run, and a handful of those would give
// Prometheus thousands of series for one label. So: lowercased, punctuation to
// spaces, any token carrying a run id or timestamp dropped, first three kept.
//
// Both default to 'unknown'/'unspecified' rather than guessing: an unlabelled
// caller must appear as a visible gap, never get counted as productive work.
// Callers on the retired legacy MCP server emit neither field and land in
// 'unknown' too, which makes un-migrated callers self-reporting.
const WORKLOADS = new Set(['interactive', 'batch', 'testing'])
const RAW_WORKLOAD = (process.env.PLUMB_SEARCH_WORKLOAD || '').trim().toLowerCase()
const WORKLOAD = WORKLOADS.has(RAW_WORKLOAD) ? RAW_WORKLOAD : 'unknown'

function normalisePurpose(raw) {
  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    // Drop run ids and timestamps: all-digit tokens, or anything with a run of
    // 3+ digits. Keeps deliberate names like "v2" or "t2" intact.
    .filter(t => t && !/^\d+$/.test(t) && !/\d{3,}/.test(t))
  return tokens.slice(0, 3).join(' ') || 'unspecified'
}

// A rejected workload value is carried into `purpose` when nothing better was
// given, so a typo stays traceable to whoever set it instead of vanishing.
const PURPOSE = normalisePurpose(
  process.env.PLUMB_SEARCH_PURPOSE || (WORKLOAD === 'unknown' ? RAW_WORKLOAD : ''),
)

// plumb.wiki_search telemetry, same event shape the old @getplumb/plumb MCP
// server wrote (the traffic exporter graphs it), plus backend and the serving
// instance (x-plumb-instance header, multi-instance deployment 2026-08-10).
// Counts and timings only, never query text.
function recordSearchTelemetry(entry) {
  try {
    mkdirSync(dirname(TELEMETRY_PATH), { recursive: true })
    appendFileSync(
      TELEMETRY_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'plumb.wiki_search',
        backend: 'wiki-search-service',
        workload: WORKLOAD,
        purpose: PURPOSE,
        ...entry,
      }) + '\n',
    )
  } catch {
    // Telemetry must never break a tool call.
  }
}

// Same 4-chars-per-token approximation the injection hook uses, so
// "avg tokens / search" and "avg tokens / injection" are comparable numbers.
const estimateTokens = (text) => Math.ceil(text.length / 4)

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

async function fetchOnce(path) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), FETCH_DEADLINE_MS)
  try {
    const response = await fetch(`${SERVICE}${path}`, { signal: controller.signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || `wiki-search service HTTP ${response.status}`)
    return { body, instance: response.headers.get('x-plumb-instance') || undefined }
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`wiki-search service timed out after ${FETCH_DEADLINE_MS}ms`)
    throw err
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * A refused connection means nobody is listening -- which, under the on-demand
 * lifecycle, is the expected state after 15 idle minutes rather than a fault.
 * A timeout or an HTTP error means somebody *is* listening and is unwell, and
 * spawning a rival would only lose the port race.
 */
function serviceIsDown(err) {
  const code = err?.cause?.code ?? err?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET'
}

// Returns { body, instance } so callers can attribute the response to a
// service instance; the body itself stays untouched engine output.
//
// Optimistic first (2026-08-25): the warm path pays nothing -- no health probe,
// no extra round trip. Only a refused connection triggers a start-and-retry, so
// the ~800ms cold start is billed once per idle period to whoever asks first.
async function service(path) {
  try {
    return await fetchOnce(path)
  } catch (err) {
    if (!serviceIsDown(err)) throw err
    const ensured = await ensureService({ url: SERVICE, coldStartBudgetMs: COLD_START_BUDGET_MS })
    if (!ensured.ok) throw new Error(`wiki-search service unavailable: ${ensured.reason}`)
    return await fetchOnce(path)
  }
}

const server = new McpServer({ name: 'plumb-wiki', version: '0.2.0' }, {
  instructions: 'Plumb wiki server for Claude. Use plumb_wiki_search to search existing wiki search indexes (stale-page precheck/re-embedding is disabled for ordinary MCP search), plumb_wiki_read to read full wiki pages, plumb_wiki_list to browse immediate wiki children, plumb_wiki_links to inspect inbound/outbound wikilinks, and plumb_wiki_queue_edit to queue durable wiki updates. Retrieval is served by the local plumb-wiki-search service (the benchmarked engine shared with prompt injection). This MCP server only appends queue requests and does not run a wiki queue worker.',
})

server.tool(
  'plumb_wiki_search',
  'Search the Plumb wiki for pages relevant to a query. Uses hybrid vector + BM25 ranking (RRF fusion). Returns up to 10 results with page title, path, type, and a matching snippet.',
  {
    query: z.string().describe('Natural language search query, e.g. "Jordan Lee Northwind VP"'),
    topK: z.number().int().optional().describe('Maximum number of results to return (default: 5, max: 10)'),
  },
  async (args) => {
    const k = Math.max(1, Math.min(args.topK ?? 5, 10))
    const started = performance.now()
    try {
      const { body: payload, instance } = await service(`/search?q=${encodeURIComponent(args.query)}&topK=${k}`)
      const results = payload.results ?? []
      let text = 'No wiki pages found matching this query.'
      if (results.length > 0) {
        const lines = [`Wiki search results for "${args.query}":`, '']
        results.forEach((r, i) => {
          const section = r.section ? ` — ${r.section}` : ''
          lines.push(`${i + 1}. **${r.title}** (${r.path}) [${r.type}]${section} score: ${r.score.toFixed(4)}`)
          lines.push(`   ${String(r.snippet || '').replace(/\s+/g, ' ').trim()}`)
          lines.push('')
        })
        text = lines.join('\n')
      }
      // tokensUsed is measured on the text actually handed back to the model,
      // which is why the result block is built before the telemetry write.
      recordSearchTelemetry({
        status: 'ok',
        instance,
        searchMode: payload.mode,
        resultCount: results.length,
        tokensUsed: estimateTokens(text),
        topK: k,
        elapsedMs: Math.round(performance.now() - started),
      })
      return textResult(text)
    } catch (err) {
      recordSearchTelemetry({
        status: 'error',
        topK: k,
        resultCount: 0,
        tokensUsed: 0,
        elapsedMs: Math.round(performance.now() - started),
      })
      return textResult(`Error searching wiki: ${errorMessage(err)}`, true)
    }
  },
)

server.tool(
  'plumb_wiki_read',
  'Read the full content of a Plumb wiki page. Provide the relative path (e.g. "people/jordan-lee.md" or "people/jordan-lee"). Returns the frontmatter and markdown body of the page.',
  {
    path: z.string().describe('Relative path to the wiki page from the wiki root, e.g. "people/jordan-lee.md"'),
  },
  async (args) => {
    try {
      const relPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`
      const { body: page } = await service(`/page?path=${encodeURIComponent(relPath)}`)
      const lines = [`# ${page.title ?? relPath}`, '']
      lines.push(`**Path:** ${page.path}`)
      lines.push(`**Type:** ${page.type}`)
      if (page.confidence) lines.push(`**Confidence:** ${page.confidence}`)
      if (page.updated) lines.push(`**Updated:** ${page.updated}`)
      if (page.tags?.length) lines.push(`**Tags:** ${page.tags.join(', ')}`)
      if (page.sourceRefs?.length) lines.push(`**Source refs:** ${page.sourceRefs.join(', ')}`)
      lines.push('', '---', '', page.body.trim())
      return textResult(lines.join('\n'))
    } catch (err) {
      return textResult(`Error reading wiki page "${args.path}": ${errorMessage(err)}`, true)
    }
  },
)

server.tool(
  'plumb_wiki_list',
  'List wiki pages and subdirectories. If no directory is given, lists the wiki root. Returns immediate .md files and immediate subdirectories at that level.',
  {
    directory: z.string().optional().describe('Relative directory path from the wiki root, e.g. "people". Omit for the wiki root.'),
  },
  async (args) => {
    try {
      const { body: { tree } } = await service('/tree')
      let nodes = tree
      const target = (args.directory ?? '').replace(/^\/+|\/+$/g, '')
      if (target) {
        for (const part of target.split('/')) {
          const next = nodes.find((n) => n.kind === 'directory' && n.name === part)
          if (!next) return textResult(`Directory not found: "${args.directory}"`, true)
          nodes = next.children
        }
      }
      const dirs = nodes.filter((n) => n.kind === 'directory').map((n) => `${n.name}/`)
      const pages = nodes.filter((n) => n.kind === 'page').map((n) => `${n.name}.md`)
      const lines = []
      if (dirs.length) {
        lines.push('Subdirectories:')
        for (const d of dirs) lines.push(`  ${d}`)
        lines.push('')
      }
      if (pages.length) {
        lines.push('Pages:')
        for (const f of pages) lines.push(`  ${f}`)
      } else {
        lines.push('(no pages)')
      }
      return textResult(lines.join('\n'))
    } catch (err) {
      return textResult(`Error listing wiki: ${errorMessage(err)}`, true)
    }
  },
)

server.tool(
  'plumb_wiki_links',
  'Return the inbound and outbound [[wikilinks]] for a given wiki page. Outbound links are pages this page links to; inbound links are pages that link to this page. Provide the relative path (e.g. "people/jordan-lee.md").',
  {
    path: z.string().describe('Relative path to the wiki page from the wiki root, e.g. "people/jordan-lee.md"'),
  },
  async (args) => {
    try {
      const relPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`
      const { body: { outbound, inbound } } = await service(`/links?path=${encodeURIComponent(relPath)}`)
      const lines = [`Outbound links (${outbound.length}):`]
      if (outbound.length === 0) lines.push('  (none)')
      for (const link of outbound) {
        lines.push(`  [[${link.title}]] ${link.resolved && link.path ? `-> ${link.path}` : '(unresolved)'}`)
      }
      lines.push('', `Inbound links (${inbound.length}):`)
      if (inbound.length === 0) lines.push('  (none)')
      for (const link of inbound) {
        lines.push(`  <- ${link.path} via [[${link.via}]]`)
      }
      return textResult(lines.join('\n'))
    } catch (err) {
      return textResult(`Error fetching links for "${args.path}": ${errorMessage(err)}`, true)
    }
  },
)

server.tool(
  'plumb_wiki_queue_edit',
  'Queue a wiki edit request for async processing. Immediately appends the fact to the wiki edit queue and returns — no latency added to your response. The background worker integrates the fact into the relevant wiki page(s) within 60 seconds.',
  {
    fact: z.string().describe('The fact or update to incorporate into the wiki, written in plain English. Include enough context for the wiki writer to place it correctly (e.g. "Jordan Lee left Northwind as of April 2026"). Maximum 10,000 characters after trimming.'),
  },
  async (args) => {
    try {
      const fact = args.fact.trim()
      if (fact.length === 0) return textResult('Error queuing edit: fact must not be blank', true)
      if (fact.length > 10_000) return textResult('Error queuing edit: fact must be 10,000 characters or fewer', true)
      // Byte-compatible with @getplumb/core appendToQueue.
      const item = { id: randomUUID(), fact, queued_at: new Date().toISOString(), status: 'pending' }
      await mkdir(dirname(QUEUE_PATH), { recursive: true })
      await appendFile(QUEUE_PATH, JSON.stringify(item) + '\n', 'utf8')
      return textResult(item.id)
    } catch (err) {
      return textResult(`Error queuing edit: ${errorMessage(err)}`, true)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[plumb-wiki-mcp] serving via ${SERVICE}, queue at ${QUEUE_PATH}`)
