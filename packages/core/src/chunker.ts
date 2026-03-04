/**
 * Chunker — splits a MessageExchange into overlapping text chunks for indexing.
 *
 * Design (T-004):
 *   - Each exchange is formatted as "User: {msg}\nAgent: {response}"
 *   - Short exchanges (≤ CHUNK_WORDS words) produce one chunk
 *   - Long exchanges are split with OVERLAP_WORDS word overlap to preserve
 *     context at chunk boundaries
 *
 * Word-based splitting is used (not token-based) to avoid a tokenizer
 * dependency at ingest time. At 384-dim bge-small, 300 words ≈ 400 tokens
 * which is within the model's 512-token limit.
 */

import type { MessageExchange } from './types.js';

export const CHUNK_WORDS = 300;
export const OVERLAP_WORDS = 50;

export interface Chunk {
  /** Full formatted text of this chunk. */
  readonly text: string;
  /** 0-based index within this exchange's chunk sequence. */
  readonly chunkIndex: number;
  /** Total chunks produced from this exchange. */
  readonly totalChunks: number;
}

/**
 * Format a MessageExchange into its canonical chunk text.
 * Used both by the chunker and by ingest() for the stored chunk_text column.
 */
export function formatExchange(exchange: MessageExchange): string {
  return `User: ${exchange.userMessage}\nAgent: ${exchange.agentResponse}`;
}

/**
 * Split a MessageExchange into one or more overlapping text chunks.
 * Returns at least one chunk (even for empty exchanges).
 */
export function chunkExchange(exchange: MessageExchange): Chunk[] {
  const text = formatExchange(exchange);
  const words = text.split(/\s+/).filter((w) => w.length > 0);

  if (words.length <= CHUNK_WORDS) {
    return [{ text, chunkIndex: 0, totalChunks: 1 }];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + CHUNK_WORDS, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    start += CHUNK_WORDS - OVERLAP_WORDS;
  }

  const totalChunks = chunks.length;
  return chunks.map((chunkText, chunkIndex) => ({ text: chunkText, chunkIndex, totalChunks }));
}
