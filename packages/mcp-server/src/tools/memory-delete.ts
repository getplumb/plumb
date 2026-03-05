import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';

const inputSchema = {
  id: z.string().uuid().describe('The fact_id of the fact to delete'),
};

export function registerMemoryDelete(server: McpServer, store: LocalStore): void {
  server.tool(
    'memory_delete',
    'Soft-delete a fact from memory by its ID. The fact is marked deleted but not physically removed.',
    inputSchema,
    async (args) => {
      try {
        await store.delete(args.id);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true }),
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
