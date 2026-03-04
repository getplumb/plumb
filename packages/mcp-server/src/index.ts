#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LocalStore } from '@plumb/core';
import { createPlumbServer } from './server.js';

async function main(): Promise<void> {
  const store = new LocalStore();
  const server = createPlumbServer(store);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Ensure the DB is closed on exit.
  const shutdown = (): void => {
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[plumb/mcp-server] Fatal:', err);
  process.exit(1);
});
