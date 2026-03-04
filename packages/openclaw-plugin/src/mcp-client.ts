import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StoreStatus } from '@plumb/core';

/** A single search result returned by the MCP server's memory_search tool. */
export interface MemorySearchResult {
  readonly fact: string;
  readonly confidence: number;
  readonly age_in_days: number;
  readonly source_session_label?: string;
  readonly layer: 'facts' | 'raw_log';
}

/** Result of a memory_store call. */
export interface MemoryStoreResult {
  readonly fact_id: string;
}

/** Status shape returned by the MCP server (ISO string for dates). */
export interface MemoryStatusResult {
  readonly factCount: number;
  readonly rawLogCount: number;
  readonly lastIngestion: string | null;
  readonly storageBytes: number;
}

/**
 * Thin wrapper around the MCP SDK Client that spawns the plumb MCP server
 * as a child process via stdio and exposes typed helpers for the memory tools.
 */
export class PlumbMcpClient {
  private client: Client;
  private transport: StdioClientTransport;
  private _connected = false;

  constructor(mcpServerPath: string) {
    this.client = new Client(
      { name: 'plumb-openclaw-plugin', version: '0.1.0' },
    );

    this.transport = new StdioClientTransport({
      command: mcpServerPath,
      stderr: 'pipe',
    });
  }

  /** Spawn the MCP server and complete the handshake. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this._connected = true;
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Search memory for relevant facts / raw log entries. */
  async search(query: string, limit?: number): Promise<MemorySearchResult[]> {
    const args: Record<string, unknown> = { query };
    if (limit !== undefined) args.limit = limit;

    const result = await this.client.callTool({ name: 'memory_search', arguments: args });
    const text = extractText(result);
    return JSON.parse(text) as MemorySearchResult[];
  }

  /** Store a new piece of content in the memory layer. */
  async store(content: string, source: string): Promise<MemoryStoreResult> {
    const result = await this.client.callTool({
      name: 'memory_store',
      arguments: { content, source },
    });
    const text = extractText(result);
    return JSON.parse(text) as MemoryStoreResult;
  }

  /** Get memory store statistics. */
  async status(): Promise<MemoryStatusResult> {
    const result = await this.client.callTool({ name: 'memory_status', arguments: {} });
    const text = extractText(result);
    return JSON.parse(text) as MemoryStatusResult;
  }

  /** Disconnect from the MCP server and kill the child process. */
  async close(): Promise<void> {
    this._connected = false;
    await this.transport.close();
  }
}

/** Extract the first text content block from an MCP tool result. */
function extractText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === 'text');
  if (!block?.text) throw new Error('MCP tool returned no text content');
  return block.text;
}
