import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';
import { registerMemorySearch } from './tools/memory-search.js';
import { registerMemoryStatus } from './tools/memory-status.js';

export function createPlumbServer(store: LocalStore): McpServer {
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
        'Plumb memory server. Use memory_search to search conversation history, and memory_status for store statistics.',
    },
  );

  registerMemorySearch(server, store);
  registerMemoryStatus(server, store);

  return server;
}
