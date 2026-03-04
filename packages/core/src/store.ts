import type { Fact, IngestResult, MessageExchange, SearchResult, StoreStatus } from './types.js';

export interface MemoryStore {
  /**
   * Write a fact to the store. The store generates and returns the id.
   */
  store(fact: Omit<Fact, 'id'>): Promise<string>;

  /**
   * Search for facts matching the query. Returns ranked results with score and age.
   */
  search(query: string, limit?: number): Promise<readonly SearchResult[]>;

  /**
   * Delete a fact by id.
   */
  delete(id: string): Promise<void>;

  /**
   * Return current store statistics.
   */
  status(): Promise<StoreStatus>;

  /**
   * High-level entry point for ingesting a conversation exchange.
   * Triggers both Layer 1 (raw log) and Layer 2 (fact extraction) writes.
   */
  ingest(exchange: MessageExchange): Promise<IngestResult>;
}
