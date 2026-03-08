import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LocalStore, StoreStatus, RawLogSearchResult } from '@getplumb/core';
import { createPlumbServer } from './server.js';

// Minimal mock of LocalStore — only the methods used by MCP tools.
function makeMockStore(): LocalStore {
  const rawLogResult: RawLogSearchResult = {
    chunk_text: 'User asked about coffee preferences',
    session_id: 'sess-001',
    session_label: 'My Session',
    timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    final_score: 0.85,
  };

  const status: StoreStatus = {
    factCount: 5,
    rawLogCount: 3,
    lastIngestion: new Date('2026-01-15T00:00:00Z'),
    storageBytes: 102400,
  };

  return {
    searchRawLog: vi.fn().mockResolvedValue([rawLogResult]),
    searchMemoryFacts: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue(status),
    ingest: vi.fn().mockResolvedValue({ rawLogId: 'r1', factsExtracted: 0, factIds: [] }),
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
    it('returns array of results from raw log', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      expect(store.searchRawLog).toHaveBeenCalledWith('coffee', 20);
      const parsed = JSON.parse(result.content[0]!.text) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it('uses custom limit', async () => {
      await callTool(store, 'memory_search', { query: 'test', limit: 5 });
      expect(store.searchRawLog).toHaveBeenCalledWith('test', 5);
    });

    it('result items have required shape', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0]!.text) as Array<{
        text: string;
        score: number;
        age_in_days: number;
        session_label: string;
      }>;

      const first = parsed[0];
      expect(first).toBeDefined();
      if (first) {
        expect(typeof first.text).toBe('string');
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
        rawLogCount: number;
        lastIngestion: string | null;
        storageBytes: number;
      };

      expect(parsed.rawLogCount).toBe(3);
      expect(parsed.lastIngestion).toBe('2026-01-15T00:00:00.000Z');
      expect(parsed.storageBytes).toBe(102400);
    });
  });
});
