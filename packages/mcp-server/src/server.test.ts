import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LocalStore, StoreStatus, MemoryFactSearchResult } from '@getplumb/core';
import { createPlumbServer } from './server.js';

// Minimal mock of LocalStore — only the methods used by MCP tools.
function makeMockStore(): LocalStore {
  const memoryFactResult: MemoryFactSearchResult = {
    fact_id: 'fact-001',
    content: 'User asked about coffee preferences',
    source_session_id: 'sess-001',
    source_session_label: 'My Session',
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    tags: null,
    confidence: 0.95,
    final_score: 0.85,
  };

  const status: StoreStatus = {
    factCount: 5,
    lastIngestion: new Date('2026-01-15T00:00:00Z'),
    storageBytes: 102400,
  };

  return {
    searchMemoryFacts: vi.fn().mockResolvedValue([memoryFactResult]),
    status: vi.fn().mockResolvedValue(status),
    ingestMemoryFact: vi.fn().mockResolvedValue({ factId: 'f1' }),
    delete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as LocalStore;
}

/**
 * Invoke a registered tool through the MCP server's internal handler.
 */
async function callTool(
  store: LocalStore,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const mcpServer = createPlumbServer(store);
  const rawServer = mcpServer.server;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (rawServer as any)._requestHandlers
    .get('tools/call')
    ?.({ method: 'tools/call', params: { name: toolName, arguments: args } }, {});

  return result;
}

describe('MCP server tool schemas and responses', () => {
  let store: LocalStore;

  beforeEach(() => {
    store = makeMockStore();
  });

  describe('memory_search', () => {
    it('returns array of results from memory facts', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      expect(store.searchMemoryFacts).toHaveBeenCalledWith('coffee', 20);
      const parsed = JSON.parse(result.content[0]!.text) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('uses custom limit', async () => {
      await callTool(store, 'memory_search', { query: 'test', limit: 5 });
      expect(store.searchMemoryFacts).toHaveBeenCalledWith('test', 5);
    });

    it('result items have required shape', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0]!.text) as Array<{
        content: string;
        score: number;
        age_in_days: number;
        session_label: string;
      }>;

      const first = parsed[0];
      expect(first).toBeDefined();
      if (first) {
        expect(typeof first.content).toBe('string');
        expect(typeof first.score).toBe('number');
        expect(typeof first.age_in_days).toBe('number');
        expect(typeof first.session_label).toBe('string');
      }
    });
  });

  describe('memory_status', () => {
    it('returns StoreStatus fields', async () => {
      const result = await callTool(store, 'memory_status', {}) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(store.status).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0]!.text) as {
        factCount: number;
        lastIngestion: string | null;
        storageBytes: number;
      };

      expect(parsed.factCount).toBe(5);
      expect(parsed.lastIngestion).toBe('2026-01-15T00:00:00.000Z');
      expect(parsed.storageBytes).toBe(102400);
    });
  });
});
