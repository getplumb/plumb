import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  WikiSearch,
  WikiStore,
  appendToQueue,
  extractTitle,
  getInboundLinks,
  getOutboundLinks,
  parseFrontmatter,
  type WikiContextualSearchTelemetry,
  type WikiSearchOptions,
} from '@getplumb/core';
import { basename, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, stat, appendFile } from 'node:fs/promises';
import { assembleContextualSnippet, CONTEXTUAL_MAX_TOTAL_TOKENS } from '../contextual-assembly.js';

const TRAFFIC_TELEMETRY_PATH =
  process.env.PLUMB_TRAFFIC_TELEMETRY_PATH ?? '/home/openclaw-host/.plumb/telemetry/claude-code-traffic.jsonl';
const TRAFFIC_TELEMETRY_DIR = '/home/openclaw-host/.plumb/telemetry';

// Counts/timings only — never persist query text, page titles, or paths here.
async function recordSearchTelemetry(event: {
  status: 'ok' | 'error';
  resultCount: number;
  topK: number;
  elapsedMs: number;
}): Promise<void> {
  try {
    await mkdir(TRAFFIC_TELEMETRY_DIR, { recursive: true });
    await appendFile(
      TRAFFIC_TELEMETRY_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'plumb.wiki_search',
        status: event.status,
        resultCount: event.resultCount,
        topK: event.topK,
        elapsedMs: event.elapsedMs,
      }) + '\n',
    );
  } catch {
    // Fail open — telemetry must never affect the tool call.
  }
}

// Surfaces WikiSearch's contextual-vs-plain-fallback status, previously
// dropped silently on this MCP surface (unlike packages/openclaw-plugin/src/
// wiki-injection.ts, which already wires this). Root-caused 2026-08-08: a
// whole-wiki contextual-coverage gap downgraded every query to a lower-
// quality fallback ranking with no visible signal. Deliberately omits
// `query`, `coverage` page-level detail beyond counts, and result content —
// counts/timings/reason only, same discipline as recordSearchTelemetry above.
async function recordContextualTelemetry(event: WikiContextualSearchTelemetry): Promise<void> {
  try {
    await mkdir(TRAFFIC_TELEMETRY_DIR, { recursive: true });
    await appendFile(
      TRAFFIC_TELEMETRY_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'plumb.wiki_contextual_search',
        mode: event.mode,
        status: event.status,
        ...(event.reason && { reason: event.reason }),
        ...(event.coverage && { coverage: event.coverage }),
        plainResultCount: event.plainResultCount,
        contextualResultCount: event.contextualResultCount,
        elapsedMs: event.elapsedMs,
      }) + '\n',
    );
  } catch {
    // Fail open — telemetry must never affect the tool call.
  }
}

/**
 * Matches the live OpenClaw production config for the plumb plugin
 * (openclaw.json plugins.entries.plumb.config.contextualRetrieval) so Claude
 * Code sees the same retrieval quality as Terra Chat's [PLUMB WIKI] block.
 */
const CLAUDE_WIKI_CONTEXTUAL_RETRIEVAL = {
  mode: 'active' as const,
  model: 'Xenova/bge-small-en-v1.5',
  parentTokenBudgets: [400, 300, 125, 100, 75],
  maxParentTokens: CONTEXTUAL_MAX_TOTAL_TOKENS,
};

export interface WikiToolsConfig {
  readonly wikiRoot: string;
  readonly wikiDbPath: string;
  readonly wikiQueuePath: string;
}

type WikiSearchHandle = Pick<WikiSearch, 'search' | 'close'>;

export interface WikiToolsDeps {
  readonly createWikiSearch?: (options: WikiSearchOptions) => Promise<WikiSearchHandle>;
}

const metadataFilenames = new Set(['SCHEMA.md', 'index.md', 'log.md', 'REVIEW.md', '_index.md']);
const metadataPrefixes = ['AUDIT_', 'EVAL_', 'REPORT_'];

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateRelativePath(input: string, label: string): string {
  if (input.includes('\0')) {
    throw new Error(`${label} must not contain null bytes`);
  }
  if (isAbsolute(input) || win32.isAbsolute(input)) {
    throw new Error(`${label} must be relative to the wiki root`);
  }

  const parts = input.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('..')) {
    throw new Error(`${label} must not contain ".." path traversal`);
  }

  return parts.join('/');
}

function ensureMarkdownPath(input: string): string {
  const relPath = validateRelativePath(input, 'path');
  return relPath.endsWith('.md') ? relPath : `${relPath}.md`;
}

function pathToSlug(relPath: string): string {
  return relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;
}

function isInside(rootRealPath: string, childRealPath: string): boolean {
  const rel = relative(rootRealPath, childRealPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !win32.isAbsolute(rel));
}

async function confinedExistingPath(wikiRoot: string, relPath: string): Promise<string> {
  const rootRealPath = await realpath(wikiRoot);
  const candidate = resolve(rootRealPath, relPath.split('/').join(sep));
  const candidateRealPath = await realpath(candidate);

  if (!isInside(rootRealPath, candidateRealPath)) {
    throw new Error('path escapes wiki root');
  }

  return candidateRealPath;
}

function isMetadataMarkdownFile(entry: string): boolean {
  return (
    extname(entry) === '.md' &&
    !metadataFilenames.has(basename(entry)) &&
    !metadataPrefixes.some((prefix) => entry.startsWith(prefix))
  );
}

export function registerWikiTools(server: McpServer, config: WikiToolsConfig, deps: WikiToolsDeps = {}): void {
  registerWikiRead(server, config);
  registerWikiSearch(server, config, deps);
  registerWikiList(server, config);
  registerWikiLinks(server, config);
  registerWikiQueueEdit(server, config);
}

export function registerWikiRead(server: McpServer, config: WikiToolsConfig): void {
  server.tool(
    'plumb_wiki_read',
    'Read the full content of a Plumb wiki page. Provide the relative path (e.g. "people/jordan-lee.md" or "people/jordan-lee"). Returns the frontmatter and markdown body of the page.',
    {
      path: z
        .string()
        .describe('Relative path to the wiki page from the wiki root, e.g. "people/jordan-lee.md"'),
    },
    async (args) => {
      try {
        const relPath = ensureMarkdownPath(args.path);
        const safeAbsPath = await confinedExistingPath(config.wikiRoot, relPath);
        const raw = await readFile(safeAbsPath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(raw);
        const page = { path: relPath, frontmatter, title: extractTitle(body), body };
        const fm = page.frontmatter;

        const lines: string[] = [];
        lines.push(`# ${page.title ?? relPath}`);
        lines.push('');
        lines.push(`**Path:** ${page.path}`);
        lines.push(`**Type:** ${fm.type}`);
        lines.push(`**Confidence:** ${fm.confidence}`);
        lines.push(`**Updated:** ${fm.updated}`);
        if (fm.tags && fm.tags.length > 0) {
          lines.push(`**Tags:** ${fm.tags.join(', ')}`);
        }
        if (fm.source_refs && fm.source_refs.length > 0) {
          lines.push(`**Source refs:** ${fm.source_refs.join(', ')}`);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(page.body.trim());

        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error reading wiki page "${args.path}": ${errorMessage(err)}`, true);
      }
    },
  );
}

export function registerWikiSearch(server: McpServer, config: WikiToolsConfig, deps: WikiToolsDeps = {}): void {
  server.tool(
    'plumb_wiki_search',
    'Search the Plumb wiki for pages relevant to a query. Uses hybrid vector + BM25 ranking (RRF fusion). Returns up to 10 results with page title, path, type, and a matching snippet.',
    {
      query: z.string().describe('Natural language search query, e.g. "Jordan Lee Samsara VP"'),
      topK: z
        .number()
        .int()
        .optional()
        .describe('Maximum number of results to return (default: 5, max: 10)'),
    },
    async (args) => {
      let search: WikiSearchHandle | null = null;
      const startedAt = Date.now();
      try {
        const k = Math.max(1, Math.min(args.topK ?? 5, 10));
        const createWikiSearch = deps.createWikiSearch ?? WikiSearch.create;
        search = await createWikiSearch({
          wikiRoot: config.wikiRoot,
          dbPath: config.wikiDbPath,
          preCheck: false,
          contextualRetrieval: CLAUDE_WIKI_CONTEXTUAL_RETRIEVAL,
          onContextualTelemetry: (event) => void recordContextualTelemetry(event),
        });
        const results = await search.search(args.query, k);
        void recordSearchTelemetry({
          status: 'ok',
          resultCount: results.length,
          topK: k,
          elapsedMs: Date.now() - startedAt,
        });

        if (results.length === 0) {
          return textResult('No wiki pages found matching this query.');
        }

        const lines: string[] = [`Wiki search results for "${args.query}":`, ''];
        let usedTokens = 0;
        let rank = 0;
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          let snippet: string;
          if (r.retrievalSource === 'contextual') {
            const remaining = Math.max(0, CONTEXTUAL_MAX_TOTAL_TOKENS - usedTokens);
            const assembled = assembleContextualSnippet(r, rank, remaining, args.query);
            if (!assembled) continue;
            snippet = assembled.snippet;
            usedTokens += assembled.tokens;
            rank++;
          } else {
            snippet = r.snippet.slice(0, 200).replace(/\n+/g, ' ');
          }
          lines.push(`${i + 1}. **${r.title}** (${r.path}) [${r.type}] score: ${r.score.toFixed(4)}`);
          lines.push(`   ${snippet}`);
          lines.push('');
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        void recordSearchTelemetry({
          status: 'error',
          resultCount: 0,
          topK: Math.max(1, Math.min(args.topK ?? 5, 10)),
          elapsedMs: Date.now() - startedAt,
        });
        return textResult(`Error searching wiki: ${errorMessage(err)}`, true);
      } finally {
        if (search) {
          try {
            search.close();
          } catch {
            // Ignore close failures; the search result/error is more useful to the caller.
          }
        }
      }
    },
  );
}

export function registerWikiList(server: McpServer, config: WikiToolsConfig): void {
  server.tool(
    'plumb_wiki_list',
    'List wiki pages and subdirectories. If no directory is given, lists the wiki root. Returns immediate .md files and immediate subdirectories at that level.',
    {
      directory: z
        .string()
        .optional()
        .describe('Optional directory path relative to wiki root (e.g. "people"). Omit to list wiki root.'),
    },
    async (args) => {
      try {
        const dirRel = args.directory ? validateRelativePath(args.directory, 'directory') : '';
        const absDir = await confinedExistingPath(config.wikiRoot, dirRel);

        let entries: string[];
        try {
          entries = await readdir(absDir);
        } catch {
          return textResult(`Directory not found: "${args.directory ?? '(root)'}"`, true);
        }

        const rootRealPath = await realpath(config.wikiRoot);
        const files: string[] = [];
        const dirs: string[] = [];

        for (const entry of entries.sort()) {
          const absEntry = join(absDir, entry);
          let entryRealPath: string;
          try {
            entryRealPath = await realpath(absEntry);
          } catch {
            continue;
          }
          if (!isInside(rootRealPath, entryRealPath)) continue;

          try {
            const linkStat = await lstat(absEntry);
            const s = linkStat.isSymbolicLink() ? await stat(absEntry) : linkStat;
            if (s.isDirectory()) {
              if (entry !== 'archive') dirs.push(`${entry}/`);
            } else if (s.isFile() && isMetadataMarkdownFile(entry)) {
              files.push(dirRel ? join(dirRel, entry) : entry);
            }
          } catch {
            continue;
          }
        }

        const label = args.directory ? `"${args.directory}"` : 'wiki root';
        const lines: string[] = [`Wiki contents of ${label}:`, ''];

        if (dirs.length > 0) {
          lines.push('Subdirectories:');
          for (const d of dirs) lines.push(`  ${d}`);
          lines.push('');
        }

        if (files.length > 0) {
          lines.push('Pages:');
          for (const f of files) lines.push(`  ${f}`);
        } else {
          lines.push('(no pages)');
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error listing wiki: ${errorMessage(err)}`, true);
      }
    },
  );
}

export function registerWikiLinks(server: McpServer, config: WikiToolsConfig): void {
  server.tool(
    'plumb_wiki_links',
    'Return the inbound and outbound [[wikilinks]] for a given wiki page. Outbound links are pages this page links to; inbound links are pages that link to this page. Provide the relative path (e.g. "people/jordan-lee.md").',
    {
      path: z
        .string()
        .describe('Relative path to the wiki page, e.g. "people/jordan-lee.md" or "people/jordan-lee"'),
    },
    async (args) => {
      let store: WikiStore | null = null;
      try {
        const relPath = ensureMarkdownPath(args.path);
        const slug = pathToSlug(relPath);

        store = await WikiStore.create({ dbPath: config.wikiDbPath });
        const db = store.db;
        const outbound = getOutboundLinks(db, slug);
        const inbound = getInboundLinks(db, slug);

        const lines: string[] = [`Wiki links for "${relPath}":`, ''];

        lines.push(`Outbound links (${outbound.length}):`);
        if (outbound.length === 0) {
          lines.push('  (none)');
        } else {
          for (const link of outbound) {
            const statusText = link.resolved ? `→ ${link.target_page_id}` : '(unresolved)';
            lines.push(`  [[${link.target_title}]] ${statusText}`);
          }
        }

        lines.push('');
        lines.push(`Inbound links (${inbound.length}):`);
        if (inbound.length === 0) {
          lines.push('  (none)');
        } else {
          for (const link of inbound) {
            lines.push(`  ← ${link.source_page_id} via [[${link.target_title}]]`);
          }
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error fetching links for "${args.path}": ${errorMessage(err)}`, true);
      } finally {
        if (store) {
          try {
            store.close();
          } catch {
            // Ignore close failures.
          }
        }
      }
    },
  );
}

export function registerWikiQueueEdit(server: McpServer, config: WikiToolsConfig): void {
  server.tool(
    'plumb_wiki_queue_edit',
    'Queue a wiki edit request for async processing. Immediately appends the fact to the wiki edit queue and returns — no latency added to your response. The background worker integrates the fact into the relevant wiki page(s) within 60 seconds.',
    {
      fact: z
        .string()
        .describe('The fact or update to incorporate into the wiki, written in plain English. Include enough context for the wiki writer to place it correctly (e.g. "Jordan Lee left Samsara as of April 2026"). Maximum 10,000 characters after trimming.'),
    },
    async (args) => {
      try {
        const fact = args.fact.trim();
        if (fact.length === 0) {
          return textResult('Error queuing edit: fact must not be blank', true);
        }
        if (fact.length > 10_000) {
          return textResult('Error queuing edit: fact must be 10,000 characters or fewer', true);
        }

        const id = await appendToQueue(fact, config.wikiQueuePath);
        return textResult(id);
      } catch (err) {
        return textResult(`Error queuing edit: ${errorMessage(err)}`, true);
      }
    },
  );
}
