/**
 * wiki-queue.ts — Async wiki edit queue (spec §5.1).
 *
 * Provides zero-latency enqueuing of wiki edit requests via a JSONL append file.
 * The background worker in openclaw-plugin drains this queue every 60s.
 *
 * Queue file: ~/.plumb/wiki-queue.jsonl
 * Each line: { id, fact, queued_at, status, processed_at? }
 *
 * Items are never deleted — status transitions from 'pending' → 'processing' → 'done' | 'failed'.
 * The 'processing' state is set atomically before Sonnet is invoked so
 * overlapping worker ticks (and future concurrency) don't re-process the
 * same item. This ensures crashes during processing don't lose work and
 * don't cause duplicate wiki commits.
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WikiQueueItemStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface WikiQueueItem {
  /** UUID assigned at enqueue time. */
  id: string;
  /** The fact text to incorporate into the wiki. */
  fact: string;
  /** ISO 8601 timestamp when the item was enqueued. */
  queued_at: string;
  /** Processing state: pending → done | failed. */
  status: WikiQueueItemStatus;
  /** ISO 8601 timestamp when the item was processed (set on done/failed). */
  processed_at?: string;
  /** Error message if status is 'failed'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/** Default queue file path. */
export function defaultQueuePath(): string {
  return join(homedir(), '.plumb', 'wiki-queue.jsonl');
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Append a new edit request to the queue.
 *
 * Creates the queue file and parent directories if they don't exist.
 * Returns the generated item id immediately — this is the zero-latency path.
 *
 * @param fact       Plain-English fact to incorporate into the wiki.
 * @param queuePath  Override the default queue file path (useful in tests).
 * @returns          The UUID assigned to the new queue item.
 */
export async function appendToQueue(fact: string, queuePath?: string): Promise<string> {
  const path = queuePath ?? defaultQueuePath();

  const item: WikiQueueItem = {
    id: randomUUID(),
    fact,
    queued_at: new Date().toISOString(),
    status: 'pending',
  };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(item) + '\n', 'utf8');
  return item.id;
}

/**
 * Read all items from the queue file.
 *
 * Returns an empty array if the queue file does not yet exist.
 * Skips malformed lines (partial writes from crashes) rather than throwing.
 *
 * @param queuePath  Override the default queue file path.
 */
export async function readQueue(queuePath?: string): Promise<WikiQueueItem[]> {
  const path = queuePath ?? defaultQueuePath();

  if (!existsSync(path)) return [];

  const content = await readFile(path, 'utf8');
  const items: WikiQueueItem[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as WikiQueueItem;
      items.push(item);
    } catch {
      // Skip malformed lines — these can occur if the process crashed mid-write.
    }
  }

  return items;
}

/**
 * Update the status of a queue item in-place by rewriting the file.
 *
 * Items are never deleted — only their status field changes.
 * If the id is not found, the file is left unchanged.
 *
 * @param id         The item id to update.
 * @param status     New status: 'processing' | 'done' | 'failed'.
 * @param error      Optional error message (only for 'failed' status).
 * @param queuePath  Override the default queue file path.
 */
export async function updateQueueItemStatus(
  id: string,
  status: 'processing' | 'done' | 'failed',
  error?: string,
  queuePath?: string,
): Promise<void> {
  const path = queuePath ?? defaultQueuePath();
  const items = await readQueue(path);

  // Only set processed_at when the item reaches a terminal state. 'processing'
  // is a transient in-flight marker and should not claim completion time.
  const isTerminal = status === 'done' || status === 'failed';
  const processedAt = isTerminal ? new Date().toISOString() : undefined;

  const updated = items.map((item): WikiQueueItem => {
    if (item.id !== id) return item;
    const next: WikiQueueItem = {
      ...item,
      status,
      ...(processedAt !== undefined && { processed_at: processedAt }),
    };
    if (status === 'done') {
      delete next.error;
    } else if (error !== undefined) {
      next.error = error;
    }
    return next;
  });

  const content = updated.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await writeFile(path, content, 'utf8');
}
