import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalStore } from '@getplumb/core';
import { DecayRate } from '@getplumb/core';

const inputSchema = {
  content: z.string().describe('The fact or information to store'),
  source: z.string().describe('Session ID or label for the source of this fact'),
  metadata: z
    .object({
      subject: z.string().optional(),
      predicate: z.string().optional(),
      object: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      decayRate: z.enum(['slow', 'medium', 'fast']).optional(),
      context: z.string().optional(),
    })
    .optional()
    .describe('Optional structured metadata for the fact'),
};

export function registerMemoryStore(server: McpServer, store: LocalStore): void {
  server.tool(
    'memory_store',
    'Explicitly store a fact or piece of information in long-term memory.',
    inputSchema,
    async (args) => {
      try {
        const id = await store.store({
          subject: args.metadata?.subject ?? 'user',
          predicate: args.metadata?.predicate ?? 'stated',
          object: args.metadata?.object ?? args.content,
          confidence: args.metadata?.confidence ?? 1.0,
          decayRate: (args.metadata?.decayRate as DecayRate | undefined) ?? DecayRate.medium,
          timestamp: new Date(),
          sourceSessionId: args.source,
          context: args.metadata?.context ?? args.content,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ fact_id: id }),
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
