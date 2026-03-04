import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@plumb/core';

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
    'Search long-term memory for relevant facts. Returns ranked results from Layer 1 (raw log) and Layer 2 (extracted facts) in parallel.',
    inputSchema,
    async (args) => {
      try {
        const limit = args.limit ?? 20;

        // TODO T-008: upgrade to the full tiered context builder (semantic re-ranking,
        // decay-weighted scoring, cross-encoder rerank across both layers).
        // For now: call Layer 1 (raw log search) and Layer 2 (fact search) in parallel.
        const [factResults, rawLogResults] = await Promise.all([
          store.search(args.query, limit),
          store.searchRawLog(args.query, Math.ceil(limit / 2)),
        ]);

        const output = factResults.map((r) => ({
          fact: `${r.fact.subject} ${r.fact.predicate} ${r.fact.object}`,
          confidence: r.fact.confidence,
          age_in_days: Math.round(r.ageInDays * 10) / 10,
          source_session_label: r.fact.sourceSessionLabel ?? r.fact.sourceSessionId,
          layer: 'facts',
        }));

        // Append raw log hits (Layer 1) with a distinct shape so callers can distinguish.
        const rawOutput = rawLogResults.map((r) => ({
          fact: r.chunk_text,
          confidence: r.final_score,
          age_in_days:
            Math.round(
              ((Date.now() - new Date(r.timestamp).getTime()) / (1000 * 60 * 60 * 24)) * 10,
            ) / 10,
          source_session_label: r.session_label ?? r.session_id,
          layer: 'raw_log',
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify([...output, ...rawOutput]),
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
