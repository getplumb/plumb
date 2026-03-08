/**
 * Chunker — exchange formatting for indexing.
 */

import type { MessageExchange } from './types.js';

/**
 * Format a MessageExchange into its canonical chunk text.
 * Used by ingest() for the stored chunk_text column.
 */
export function formatExchange(exchange: MessageExchange): string {
  return `User: ${exchange.userMessage}\nAgent: ${exchange.agentResponse}`;
}
