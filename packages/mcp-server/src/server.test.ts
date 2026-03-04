import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LocalStore, SearchResult, StoreStatus } from '@plumb/core';
import { DecayRate } from '@plumb/core';
import { createPlumbServer } from './server.js';

// Minimal mock of LocalStore — only the 4 methods used by our tools.
function makeMockStore(): LocalStore {
  const fact = {
    id: 'test-id',
    subject: 'user',
    predicate: 'likes',
    object: 'coffee',
    confidence: 0.9,
    decayRate: DecayRate.medium,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    sourceSessionId: 'sess-001',
    sourceSessionLabel: 'My Session',
  };

  const searchResult: SearchResult = {
    fact,
    score: 0.9,
    ageInDays: 62,
  };

  const status: StoreStatus = {
    factCount: 5,
    rawLogCount: 3,
    lastIngestion: new Date('2026-01-15T00:00:00Z'),
    storageBytes: 102400,
  };

  return {
    store: vi.fn().mockResolvedValue('new-fact-id'),
    search: vi.fn().mockResolvedValue([searchResult]),
    searchRawLog: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(status),
    ingest: vi.fn().mockResolvedValue({ rawLogId: 'r1', factsExtracted: 0, factIds: [] }),
    close: vi.fn(),
  } as unknown as LocalStore;
}

/**
 * Simulate a tool call through the MCP server's internal handler by
 * directly invoking the registered tool's callback via the server's
 * CallTool request handler.
 */
async function callTool(
  store: LocalStore,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // We exercise the tool by calling through the server's request handler.
  // Access the underlying Server's callRequestHandler.
  const mcpServer = createPlumbServer(store);
  const rawServer = mcpServer.server;

  // Build a mock CallTool request as the MCP protocol expects.
  const request = {
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  // Use the server's internal request handler directly.
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

  describe('memory_store', () => {
    it('returns fact_id on success', async () => {
      const result = await callTool(store, 'memory_store', {
        content: 'User prefers dark mode',
        source: 'sess-001',
      });

      expect(store.store).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('new-fact-id') }],
      });
    });

    it('includes fact_id key in JSON response', async () => {
      const result = await callTool(store, 'memory_store', {
        content: 'Test fact',
        source: 'sess-001',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0]!.text) as { fact_id: string };
      expect(parsed).toHaveProperty('fact_id');
      expect(typeof parsed.fact_id).toBe('string');
    });

    it('returns error response for missing required fields', async () => {
      // Missing 'content' and 'source' — should return isError or throw schema error.
      const result = await callTool(store, 'memory_store', {}) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      // The MCP SDK validates the schema and returns an error result.
      expect(result.isError).toBe(true);
    });
  });

  describe('memory_search', () => {
    it('returns array of results', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      expect(store.search).toHaveBeenCalledWith('coffee', 20);
      const parsed = JSON.parse(result.content[0]!.text) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('uses custom limit', async () => {
      await callTool(store, 'memory_search', { query: 'test', limit: 5 });
      expect(store.search).toHaveBeenCalledWith('test', 5);
    });

    it('calls both Layer 1 and Layer 2 in parallel', async () => {
      await callTool(store, 'memory_search', { query: 'anything' });
      expect(store.search).toHaveBeenCalledOnce();
      expect(store.searchRawLog).toHaveBeenCalledOnce();
    });

    it('result items have required shape', async () => {
      const result = await callTool(store, 'memory_search', {
        query: 'coffee',
      }) as { content: Array<{ type: string; text: string }> };

      const parsed = JSON.parse(result.content[0]!.text) as Array<{
        fact: string;
        confidence: number;
        age_in_days: number;
        source_session_label: string;
      }>;

      const first = parsed[0];
      expect(first).toBeDefined();
      if (first) {
        expect(typeof first.fact).toBe('string');
        expect(typeof first.confidence).toBe('number');
        expect(typeof first.age_in_days).toBe('number');
        expect(typeof first.source_session_label).toBe('string');
      }
    });
  });

  describe('memory_delete', () => {
    it('returns {ok: true} on success', async () => {
      const result = await callTool(store, 'memory_delete', {
        id: '550e8400-e29b-41d4-a716-446655440000',
      }) as { content: Array<{ type: string; text: string }> };

      expect(store.delete).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
      const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean };
      expect(parsed).toEqual({ ok: true });
    });

    it('returns error for non-UUID id', async () => {
      const result = await callTool(store, 'memory_delete', {
        id: 'not-a-uuid',
      }) as { isError?: boolean };
      expect(result.isError).toBe(true);
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
        rawLogCount: number;
        lastIngestion: string | null;
        storageBytes: number;
      };

      expect(parsed.factCount).toBe(5);
      expect(parsed.rawLogCount).toBe(3);
      expect(parsed.lastIngestion).toBe('2026-01-15T00:00:00.000Z');
      expect(parsed.storageBytes).toBe(102400);
    });
  });
});
