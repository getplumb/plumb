import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';

const inputSchema = {
  query: z.string().describe('Natural language query to search memory'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of results to return (default: 20)'),
};

export function registerMemorySearch(server: McpServer, store: LocalStore): void {
  server.tool(
    'memory_search',
    'Search long-term memory for relevant conversations. Returns ranked results from raw conversation log.',
    inputSchema,
    async (args) => {
      try {
        const limit = args.limit ?? 20;

        // Search raw conversation log
        const rawLogResults = await store.searchRawLog(args.query, limit);

        const output = rawLogResults.map((r) => ({
          text: r.chunk_text,
          score: r.final_score,
          age_in_days:
            Math.round(
              ((Date.now() - new Date(r.timestamp).getTime()) / (1000 * 60 * 60 * 24)) * 10,
            ) / 10,
          session_label: r.session_label ?? r.session_id,
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output),
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
