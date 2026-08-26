/**
 * wiki-tools.ts — MCP tool definitions for Plumb wiki access.
 *
 * Registers four tools:
 *   - plumb_wiki_read(path)         — read a wiki page's full content
 *   - plumb_wiki_search(query)      — search wiki with hybrid vector+BM25 fusion
 *   - plumb_wiki_list(directory?)   — list pages and subdirectories
 *   - plumb_wiki_links(path)        — return inbound + outbound links for a page
 */

import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import {
  WikiSearch,
  WikiStore,
  readWikiPage,
  listWikiPages,
  getInboundLinks,
  getOutboundLinks,
} from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types (inline — not re-exported from openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

type AnyAgentTool = {
  name: string;
  description: string;
  parameters: object;
  execute: (...args: any[]) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WikiToolsOptions {
  /** Absolute path to the wiki root directory. Defaults to ~/.plumb/wiki */
  wikiRoot?: string;
  /** Absolute path to wiki.db. Defaults to ~/.plumb/wiki.db */
  wikiDbPath?: string;
}

// ---------------------------------------------------------------------------
// Lazy WikiSearch singleton
// ---------------------------------------------------------------------------

let _wikiSearch: WikiSearch | null = null;
let _wikiSearchDbPath: string | null = null;
let _wikiSearchWikiRoot: string | null = null;

/**
 * Return a shared WikiSearch instance (opened lazily on first call).
 * Re-opens if config paths change (unusual but safe).
 */
async function getWikiSearch(wikiRoot: string, wikiDbPath: string): Promise<WikiSearch> {
  if (
    _wikiSearch &&
    _wikiSearchDbPath === wikiDbPath &&
    _wikiSearchWikiRoot === wikiRoot
  ) {
    return _wikiSearch;
  }
  // Close stale instance if paths changed
  if (_wikiSearch) {
    try { _wikiSearch.close(); } catch { /* ignore */ }
    _wikiSearch = null;
  }
  _wikiSearch = await WikiSearch.create({ wikiRoot, dbPath: wikiDbPath });
  _wikiSearchDbPath = wikiDbPath;
  _wikiSearchWikiRoot = wikiRoot;
  return _wikiSearch;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Convert a wiki page path to its slug (remove .md extension).
 * e.g. "people/jordan-lee.md" → "people/jordan-lee"
 */
function pathToSlug(relPath: string): string {
  return relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;
}

/**
 * Normalize user-supplied path: strip leading slash, ensure .md extension only
 * when it's a clear file reference. Leaves directory paths as-is.
 */
function normalizePath(p: string): string {
  return p.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// Tool: plumb_wiki_read
// ---------------------------------------------------------------------------

function makeReadTool(wikiRoot: string): AnyAgentTool {
  return {
    name: 'plumb_wiki_read',
    description:
      'Read the full content of a Plumb wiki page. ' +
      'Provide the relative path (e.g. "people/jordan-lee.md" or "people/jordan-lee"). ' +
      'Returns the frontmatter and markdown body of the page.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path to the wiki page from the wiki root, e.g. "people/jordan-lee.md"',
        },
      },
      required: ['path'],
    },
    execute: async (_toolCallId: string, params: { path: string }) => {
      try {
        let relPath = normalizePath(params.path);
        // Auto-append .md if missing
        if (!relPath.endsWith('.md')) relPath = relPath + '.md';

        const page = await readWikiPage(wikiRoot, relPath);
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

        return lines.join('\n');
      } catch (err) {
        return `Error reading wiki page "${params.path}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: plumb_wiki_search
// ---------------------------------------------------------------------------

function makeSearchTool(wikiRoot: string, wikiDbPath: string): AnyAgentTool {
  return {
    name: 'plumb_wiki_search',
    description:
      'Search the Plumb wiki for pages relevant to a query. ' +
      'Uses hybrid vector + BM25 ranking (RRF fusion). ' +
      'Returns up to 10 results with page title, path, type, and a matching snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query, e.g. "Jordan Lee Northwind VP"',
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
    execute: async (_toolCallId: string, params: { query: string; topK?: number }) => {
      try {
        const search = await getWikiSearch(wikiRoot, wikiDbPath);
        const k = Math.min(params.topK ?? 5, 10);
        const results = await search.search(params.query, k);

        if (results.length === 0) {
          return 'No wiki pages found matching this query.';
        }

        const lines: string[] = [`Wiki search results for "${params.query}":`, ''];
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          lines.push(`${i + 1}. **${r.title}** (${r.path}) [${r.type}] score: ${r.score.toFixed(4)}`);
          const snippet = r.snippet.slice(0, 200).replace(/\n+/g, ' ');
          lines.push(`   ${snippet}`);
          lines.push('');
        }

        return lines.join('\n');
      } catch (err) {
        return `Error searching wiki: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: plumb_wiki_list
// ---------------------------------------------------------------------------

function makeListTool(wikiRoot: string): AnyAgentTool {
  return {
    name: 'plumb_wiki_list',
    description:
      'List wiki pages and subdirectories. ' +
      'If no directory is given, lists the wiki root. ' +
      'Returns immediate .md files and immediate subdirectories at that level.',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description:
            'Optional directory path relative to wiki root (e.g. "people"). Omit to list wiki root.',
        },
      },
      required: [],
    },
    execute: async (_toolCallId: string, params: { directory?: string }) => {
      try {
        const dirRel = params.directory ? normalizePath(params.directory) : '';
        const absDir = dirRel ? join(wikiRoot, dirRel) : wikiRoot;

        let entries: string[];
        try {
          entries = await readdir(absDir);
        } catch {
          return `Directory not found: "${params.directory ?? '(root)'}"`;
        }

        const files: string[] = [];
        const dirs: string[] = [];

        const SKIP_FILES = new Set(['SCHEMA.md', 'index.md', 'log.md', 'REVIEW.md', '_index.md']);

        for (const entry of entries.sort()) {
          const absEntry = join(absDir, entry);
          let s: { isDirectory(): boolean };
          try {
            s = await stat(absEntry);
          } catch {
            continue;
          }
          if (s.isDirectory()) {
            if (entry !== 'archive') dirs.push(entry + '/');
          } else if (extname(entry) === '.md' && !SKIP_FILES.has(basename(entry))) {
            files.push(dirRel ? join(dirRel, entry) : entry);
          }
        }

        const lines: string[] = [];
        const label = params.directory ? `"${params.directory}"` : 'wiki root';
        lines.push(`Wiki contents of ${label}:`);
        lines.push('');

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

        return lines.join('\n');
      } catch (err) {
        return `Error listing wiki: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: plumb_wiki_links
// ---------------------------------------------------------------------------

function makeLinksTool(wikiRoot: string, wikiDbPath: string): AnyAgentTool {
  return {
    name: 'plumb_wiki_links',
    description:
      'Return the inbound and outbound [[wikilinks]] for a given wiki page. ' +
      'Outbound links are pages this page links to; inbound links are pages that link to this page. ' +
      'Provide the relative path (e.g. "people/jordan-lee.md").',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path to the wiki page, e.g. "people/jordan-lee.md" or "people/jordan-lee"',
        },
      },
      required: ['path'],
    },
    execute: async (_toolCallId: string, params: { path: string }) => {
      try {
        let relPath = normalizePath(params.path);
        if (!relPath.endsWith('.md')) relPath = relPath + '.md';
        const slug = pathToSlug(relPath);

        const store = await WikiStore.create({ dbPath: wikiDbPath });
        let result: string;
        try {
          const db = store.db;

          const outbound = getOutboundLinks(db, slug);
          const inbound = getInboundLinks(db, slug);

          const lines: string[] = [`Wiki links for "${relPath}":`, ''];

          lines.push(`Outbound links (${outbound.length}):`);
          if (outbound.length === 0) {
            lines.push('  (none)');
          } else {
            for (const link of outbound) {
              const status = link.resolved ? `→ ${link.target_page_id}` : '(unresolved)';
              lines.push(`  [[${link.target_title}]] ${status}`);
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

          result = lines.join('\n');
        } finally {
          store.close();
        }

        return result;
      } catch (err) {
        return `Error fetching links for "${params.path}": ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: create all wiki tools
// ---------------------------------------------------------------------------

/**
 * Create the four wiki MCP tools.
 *
 * @param options  Wiki root and DB path configuration.
 * @returns        Array of tool objects ready for api.registerTool().
 */
export function createWikiTools(options: WikiToolsOptions = {}): AnyAgentTool[] {
  const wikiRoot = options.wikiRoot ?? join(homedir(), '.plumb', 'wiki');
  const wikiDbPath = options.wikiDbPath ?? join(homedir(), '.plumb', 'wiki.db');

  return [
    makeReadTool(wikiRoot),
    makeSearchTool(wikiRoot, wikiDbPath),
    makeListTool(wikiRoot),
    makeLinksTool(wikiRoot, wikiDbPath),
  ];
}
