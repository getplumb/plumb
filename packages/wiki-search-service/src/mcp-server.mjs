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
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const SERVICE = process.env.PLUMB_WIKI_SERVICE_URL || 'http://127.0.0.1:18795'
const QUEUE_PATH = process.env.PLUMB_WIKI_QUEUE_PATH || join(homedir(), '.plumb', 'wiki-queue.jsonl')
const FETCH_DEADLINE_MS = Number(process.env.PLUMB_MCP_FETCH_DEADLINE_MS) || 5000

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

async function service(path) {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), FETCH_DEADLINE_MS)
  try {
    const response = await fetch(`${SERVICE}${path}`, { signal: controller.signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || `wiki-search service HTTP ${response.status}`)
    return body
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`wiki-search service timed out after ${FETCH_DEADLINE_MS}ms`)
    throw err
  } finally {
    clearTimeout(deadline)
  }
}

const server = new McpServer({ name: 'plumb-wiki', version: '0.2.0' }, {
  instructions: 'Plumb wiki server for Claude. Use plumb_wiki_search to search existing wiki search indexes (stale-page precheck/re-embedding is disabled for ordinary MCP search), plumb_wiki_read to read full wiki pages, plumb_wiki_list to browse immediate wiki children, plumb_wiki_links to inspect inbound/outbound wikilinks, and plumb_wiki_queue_edit to queue durable wiki updates. Retrieval is served by the local plumb-wiki-search service (the benchmarked engine shared with prompt injection). This MCP server only appends queue requests and does not run a wiki queue worker.',
})

server.tool(
  'plumb_wiki_search',
  'Search the Plumb wiki for pages relevant to a query. Uses hybrid vector + BM25 ranking (RRF fusion). Returns up to 10 results with page title, path, type, and a matching snippet.',
  {
    query: z.string().describe('Natural language search query, e.g. "Dylan Sellberg Samsara VP"'),
    topK: z.number().int().optional().describe('Maximum number of results to return (default: 5, max: 10)'),
  },
  async (args) => {
    try {
      const k = Math.max(1, Math.min(args.topK ?? 5, 10))
      const payload = await service(`/search?q=${encodeURIComponent(args.query)}&topK=${k}`)
      const results = payload.results ?? []
      if (results.length === 0) return textResult('No wiki pages found matching this query.')
      const lines = [`Wiki search results for "${args.query}":`, '']
      results.forEach((r, i) => {
        const section = r.section ? ` — ${r.section}` : ''
        lines.push(`${i + 1}. **${r.title}** (${r.path}) [${r.type}]${section} score: ${r.score.toFixed(4)}`)
        lines.push(`   ${String(r.snippet || '').replace(/\s+/g, ' ').trim()}`)
        lines.push('')
      })
      return textResult(lines.join('\n'))
    } catch (err) {
      return textResult(`Error searching wiki: ${errorMessage(err)}`, true)
    }
  },
)

server.tool(
  'plumb_wiki_read',
  'Read the full content of a Plumb wiki page. Provide the relative path (e.g. "people/dylan-sellberg.md" or "people/dylan-sellberg"). Returns the frontmatter and markdown body of the page.',
  {
    path: z.string().describe('Relative path to the wiki page from the wiki root, e.g. "people/dylan-sellberg.md"'),
  },
  async (args) => {
    try {
      const relPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`
      const page = await service(`/page?path=${encodeURIComponent(relPath)}`)
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
      const { tree } = await service('/tree')
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
  'Return the inbound and outbound [[wikilinks]] for a given wiki page. Outbound links are pages this page links to; inbound links are pages that link to this page. Provide the relative path (e.g. "people/dylan-sellberg.md").',
  {
    path: z.string().describe('Relative path to the wiki page from the wiki root, e.g. "people/dylan-sellberg.md"'),
  },
  async (args) => {
    try {
      const relPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`
      const { outbound, inbound } = await service(`/links?path=${encodeURIComponent(relPath)}`)
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
    fact: z.string().describe('The fact or update to incorporate into the wiki, written in plain English. Include enough context for the wiki writer to place it correctly (e.g. "Dylan Sellberg left Samsara as of April 2026"). Maximum 10,000 characters after trimming.'),
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
