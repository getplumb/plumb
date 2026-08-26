#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config.js';
import { createClaudeWikiServer } from './server.js';

async function main(): Promise<void> {
  const config = resolveConfig();
  console.error(
    `[plumb] Starting Claude wiki MCP server with wikiRoot=${config.wikiRoot}, wikiDbPath=${config.wikiDbPath}, wikiQueuePath=${config.wikiQueuePath}`,
  );

  const server = createClaudeWikiServer({
    wikiRoot: config.wikiRoot,
    wikiDbPath: config.wikiDbPath,
    wikiQueuePath: config.wikiQueuePath,
  });
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('[plumb/claude-wiki-mcp-server] Fatal:', err);
  process.exit(1);
});
