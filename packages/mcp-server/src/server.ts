import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';
import { registerMemoryStore } from './tools/memory-store.js';
import { registerMemorySearch } from './tools/memory-search.js';
import { registerMemoryDelete } from './tools/memory-delete.js';
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
        'Plumb memory server. Use memory_store to save facts, memory_search to recall them, memory_delete to remove a fact by ID, and memory_status for store statistics.',
    },
  );

  registerMemoryStore(server, store);
  registerMemorySearch(server, store);
  registerMemoryDelete(server, store);
  registerMemoryStatus(server, store);

  return server;
}
