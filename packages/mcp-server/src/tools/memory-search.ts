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
    'Search long-term memory for relevant facts. Returns ranked results from curated memory facts.',
    inputSchema,
    async (args) => {
      try {
        const limit = args.limit ?? 20;

        // Search memory facts
        const memoryFactResults = await store.searchMemoryFacts(args.query, limit);

        const output = memoryFactResults.map((r) => ({
          content: r.content,
          score: r.final_score,
          age_in_days:
            Math.round(
              ((Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)) * 10,
            ) / 10,
          session_label: r.source_session_label ?? r.source_session_id,
          tags: r.tags,
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
