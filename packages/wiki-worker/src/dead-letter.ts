/**
 * dead-letter.ts — Dead-letter queue management.
 *
 * Queue items that fail 3 consecutive times are moved to the dead-letter queue
 * at ~/.plumb/wiki-queue-dead.jsonl so they don't block future runs.
 *
 * Dead-letter items are surfaced by the lint phase (T-213) in the next
 * lint report. They are never automatically retried — human intervention
 * (or a future recovery tool) is required.
 *
 * File format: one JSON object per line
 *   { ...original_item, dead_lettered_at, final_error, retry_count }
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { WikiQueueItem } from '@getplumb/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeadLetterEntry extends WikiQueueItem {
  /** ISO 8601 timestamp when the item was moved to dead letter */
  dead_lettered_at: string;
  /** The error message from the final failed attempt */
  final_error: string;
  /** How many times the item was retried before being dead-lettered */
  retry_count: number;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/** Default dead-letter queue file path. */
export function defaultDeadLetterPath(): string {
  return join(homedir(), '.plumb', 'wiki-queue-dead.jsonl');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Append a queue item to the dead-letter queue.
 *
 * Creates the dead-letter file and parent directories if they don't exist.
 * The original queue item is left in wiki-queue.jsonl with status 'failed'.
 *
 * @param item         The queue item that exhausted its retries
 * @param finalError   Error message from the last failed attempt
 * @param retryCount   How many retries were attempted (should be 3)
 * @param deadLetterPath  Override the default path (useful in tests)
 */
export async function appendDeadLetter(
  item: WikiQueueItem,
  finalError: string,
  retryCount: number,
  deadLetterPath?: string,
): Promise<void> {
  const path = deadLetterPath ?? defaultDeadLetterPath();

  const entry: DeadLetterEntry = {
    ...item,
    dead_lettered_at: new Date().toISOString(),
    final_error: finalError,
    retry_count: retryCount,
  };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Read all entries from the dead-letter queue.
 *
 * Returns an empty array if the file does not exist.
 * Skips malformed lines.
 *
 * @param deadLetterPath  Override the default path (useful in tests)
 */
export async function readDeadLetters(deadLetterPath?: string): Promise<DeadLetterEntry[]> {
  const path = deadLetterPath ?? defaultDeadLetterPath();

  if (!existsSync(path)) return [];

  const content = await readFile(path, 'utf8');
  const entries: DeadLetterEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as DeadLetterEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}
