import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalStore } from '@getplumb/core';
import { registerMemorySearch } from './tools/memory-search.js';
import { registerMemoryStatus } from './tools/memory-status.js';
import {
  registerWikiList,
  registerWikiQueueEdit,
  registerWikiRead,
  registerWikiSearch,
  registerWikiTools,
  type WikiToolsConfig,
  type WikiToolsDeps,
} from './tools/wiki.js';

const defaultWikiConfig: WikiToolsConfig = {
  wikiRoot: join(homedir(), '.plumb', 'wiki'),
  wikiDbPath: join(homedir(), '.plumb', 'wiki.db'),
  wikiQueuePath: join(homedir(), '.plumb', 'wiki-queue.jsonl'),
};

export function createPlumbServer(
  store: LocalStore,
  wikiConfig: WikiToolsConfig = defaultWikiConfig,
  wikiDeps: WikiToolsDeps = {},
): McpServer {
  const server = new McpServer(
    {
      name: 'plumb',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Plumb memory and wiki server. Use memory_search to search conversation history, memory_status for store statistics, plumb_wiki_search to search existing wiki search indexes (stale-page precheck/re-embedding is disabled for ordinary MCP search), plumb_wiki_read to read full wiki pages, plumb_wiki_list to browse immediate wiki children, plumb_wiki_links to inspect inbound/outbound wikilinks from wiki.db, and plumb_wiki_queue_edit to queue durable wiki updates. The wiki DB adapter may apply compatible schema when opened for search or links; this MCP server only appends queue requests and does not run a wiki queue worker.',
    },
  );

  registerMemorySearch(server, store);
  registerMemoryStatus(server, store);
  registerWikiTools(server, wikiConfig, wikiDeps);

  return server;
}

export function createClaudeWikiServer(
  wikiConfig: WikiToolsConfig = defaultWikiConfig,
  wikiDeps: WikiToolsDeps = {},
): McpServer {
  const server = new McpServer(
    {
      name: 'plumb-claude-wiki',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Plumb wiki server for Claude. Use plumb_wiki_search to search existing wiki search indexes (stale-page precheck/re-embedding is disabled for ordinary MCP search), plumb_wiki_read to read full wiki pages, plumb_wiki_list to browse immediate wiki children, and plumb_wiki_queue_edit to queue durable wiki updates. This MCP server only appends queue requests and does not run a wiki queue worker.',
    },
  );

  registerWikiSearch(server, wikiConfig, wikiDeps);
  registerWikiRead(server, wikiConfig);
  registerWikiList(server, wikiConfig);
  registerWikiQueueEdit(server, wikiConfig);

  return server;
}
