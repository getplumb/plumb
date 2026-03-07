import type { IngestResult, MessageExchange, StoreStatus } from './types.js';

export interface MemoryStore {
  /**
   * Return current store statistics.
   */
  status(): Promise<StoreStatus>;

  /**
   * High-level entry point for ingesting a conversation exchange.
   * Writes to raw_log table and enqueues embedding.
   */
  ingest(exchange: MessageExchange): Promise<IngestResult>;
}
