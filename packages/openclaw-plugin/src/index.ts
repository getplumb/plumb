export { PlumbPluginConfig, DEFAULT_CONFIG } from './config.js';
export {
  PlumbMcpClient,
  MemorySearchResult,
  MemoryStoreResult,
  MemoryStatusResult,
} from './mcp-client.js';
export { plugin } from './plugin-module.js';
export { createPostExchangeHook } from './hooks/post-exchange.js';

import type { PlumbPluginConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import { PlumbMcpClient } from './mcp-client.js';

/**
 * Main entry point for the Plumb OpenClaw plugin.
 *
 * Manages the lifecycle of the MCP client connection to the local
 * plumb memory server. Pipeline hooks (ingest after exchange, inject
 * before response) are implemented via plugin-module.ts (T-010) and
 * will be enhanced in T-011.
 */
export class PlumbPlugin {
  readonly config: PlumbPluginConfig;
  private mcpClient: PlumbMcpClient | null = null;

  constructor(config?: Partial<PlumbPluginConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Connect to the MCP server. No-op if disabled. */
  async start(): Promise<void> {
    if (!this.config.enabled) return;
    this.mcpClient = new PlumbMcpClient(this.config.mcpServerPath);
    await this.mcpClient.connect();
  }

  /** Get the underlying MCP client (null if not started or disabled). */
  get client(): PlumbMcpClient | null {
    return this.mcpClient;
  }

  /** Disconnect and clean up. */
  async stop(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }
  }
}
