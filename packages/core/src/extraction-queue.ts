import type { MessageExchange, Fact } from './types.js';

/**
 * Extraction function signature expected by ExtractionQueue.
 * Takes an exchange, userId, and sourceChunkId, returns extracted facts.
 * LocalStore binds extractFacts with its own store + llmConfig.
 * T-079: Added sourceChunkId to link extracted facts back to raw_log chunk.
 */
export type ExtractFn = (
  exchange: MessageExchange,
  userId: string,
  sourceChunkId: string
) => Promise<Fact[]>;

type QueueItem = {
  exchange: MessageExchange;
  userId: string;
  sourceChunkId: string;
};

export interface ExtractionQueueOptions {
  /** Drain interval in milliseconds. Defaults to PLUMB_EXTRACT_INTERVAL_MS env var or 300000 (5 min). */
  intervalMs?: number;
  /** Max queue size before early flush. Defaults to PLUMB_EXTRACT_BATCH_SIZE env var or 10. */
  batchSize?: number;
}

/**
 * ExtractionQueue — batched fact extraction queue.
 *
 * Replaces the immediate fire-and-forget extractFacts() call inside ingest() with
 * a deferred queue. Raw exchanges are buffered in memory; a background drain loop
 * flushes the queue periodically (default 5 min) or when batch size is reached (default 10).
 *
 * This is a pure cost optimization: one extractFacts() call per exchange, just deferred.
 *
 * Usage:
 *   const queue = new ExtractionQueue(extractFn, { intervalMs: 300_000, batchSize: 10 });
 *   queue.start();
 *   queue.enqueue(exchange, userId);
 *   // ... later
 *   await queue.stop(); // flushes remaining items
 *
 * @see T-071
 */
export class ExtractionQueue {
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private flushing = false; // Prevent concurrent flush() calls

  constructor(
    private readonly extractFn: ExtractFn,
    opts?: ExtractionQueueOptions,
  ) {
    this.intervalMs = opts?.intervalMs ?? Number(process.env.PLUMB_EXTRACT_INTERVAL_MS ?? 300_000);
    this.batchSize = opts?.batchSize ?? Number(process.env.PLUMB_EXTRACT_BATCH_SIZE ?? 10);
  }

  /**
   * Enqueue an exchange for fact extraction.
   * Triggers early flush if batch size threshold is reached.
   * T-079: Added sourceChunkId parameter to link extracted facts back to raw_log chunk.
   */
  enqueue(exchange: MessageExchange, userId: string, sourceChunkId: string): void {
    this.queue.push({ exchange, userId, sourceChunkId });
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Start the background drain loop.
   * Call this once after construction (e.g., in plugin activate()).
   */
  start(): void {
    if (this.timer !== null) return; // Already started
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  /**
   * Stop the background drain loop and flush remaining items.
   * Call this before shutdown (e.g., in plugin session_end or process exit).
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Flush the queue immediately: drain all pending items and call extractFn for each.
   * Uses Promise.allSettled() so one failed extraction doesn't drop others.
   * Safe to call concurrently — only one flush runs at a time.
   * T-079: Pass sourceChunkId to extractFn for processing state machine.
   */
  async flush(): Promise<void> {
    // Prevent concurrent flush() calls
    if (this.flushing) return;
    this.flushing = true;

    try {
      // Snapshot the queue and clear it atomically
      const batch = this.queue.splice(0);
      if (batch.length === 0) return;

      // Extract facts for each item in parallel (T-079: pass sourceChunkId)
      await Promise.allSettled(
        batch.map(item => this.extractFn(item.exchange, item.userId, item.sourceChunkId)),
      );
    } finally {
      this.flushing = false;
    }
  }
}
