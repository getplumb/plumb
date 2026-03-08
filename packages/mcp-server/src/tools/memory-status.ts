import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';

// Empty object schema — no inputs required.
const inputSchema: Record<string, z.ZodTypeAny> = {};

export function registerMemoryStatus(server: McpServer, store: LocalStore): void {
  server.tool(
    'memory_status',
    'Return current memory store statistics: memory fact count, last ingestion time, and storage size.',
    inputSchema,
    async (_args) => {
      try {
        const status = await store.status();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                factCount: status.factCount,
                lastIngestion: status.lastIngestion?.toISOString() ?? null,
                storageBytes: status.storageBytes,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: String(err) }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
