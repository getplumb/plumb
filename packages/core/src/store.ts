import type { StoreStatus } from './types.js';

export interface MemoryStore {
  /**
   * Return current store statistics.
   */
  status(): Promise<StoreStatus>;
}
