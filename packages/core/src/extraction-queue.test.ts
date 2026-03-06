import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ExtractionQueue, type ExtractFn } from './extraction-queue.js';
import type { MessageExchange, Fact } from './types.js';

describe('ExtractionQueue', () => {
  let mockExtractFn: ExtractFn & { calls: Array<{ exchange: MessageExchange; userId: string; sourceChunkId: string }> };
  let queue: ExtractionQueue | null;

  beforeEach(() => {
    // Mock extract function that returns empty array and tracks calls
    const calls: Array<{ exchange: MessageExchange; userId: string; sourceChunkId: string }> = [];
    mockExtractFn = Object.assign(
      async (exchange: MessageExchange, userId: string, sourceChunkId: string) => {
        calls.push({ exchange, userId, sourceChunkId });
        return [];
      },
      { calls }
    );
    queue = null;
  });

  afterEach(async () => {
    if (queue) await queue.stop();
    queue = null;
  });

  const createExchange = (msg: string): MessageExchange => ({
    userMessage: msg,
    agentResponse: 'test response',
    timestamp: new Date(),
    source: 'openclaw',
    sessionId: 'test-session',
  });

  describe('enqueue + flush', () => {
    it('should call extractFn once per enqueued exchange', async () => {
      queue = new ExtractionQueue(mockExtractFn);

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');
      queue.enqueue(createExchange('msg3'), 'user1', 'chunk-3');

      await queue.flush();

      assert.equal(mockExtractFn.calls.length, 3);
      assert.equal(mockExtractFn.calls[0]!.exchange.userMessage, 'msg1');
      assert.equal(mockExtractFn.calls[0]!.userId, 'user1');
      assert.equal(mockExtractFn.calls[0]!.sourceChunkId, 'chunk-1');
      assert.equal(mockExtractFn.calls[1]!.exchange.userMessage, 'msg2');
      assert.equal(mockExtractFn.calls[1]!.userId, 'user2');
      assert.equal(mockExtractFn.calls[1]!.sourceChunkId, 'chunk-2');
      assert.equal(mockExtractFn.calls[2]!.exchange.userMessage, 'msg3');
      assert.equal(mockExtractFn.calls[2]!.userId, 'user1');
      assert.equal(mockExtractFn.calls[2]!.sourceChunkId, 'chunk-3');
    });

    it('should not call extractFn if queue is empty', async () => {
      queue = new ExtractionQueue(mockExtractFn);
      await queue.flush();
      assert.equal(mockExtractFn.calls.length, 0);
    });

    it('should clear queue after flush', async () => {
      queue = new ExtractionQueue(mockExtractFn);
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      await queue.flush();
      assert.equal(mockExtractFn.calls.length, 1);

      // Second flush should not call extractFn again
      await queue.flush();
      assert.equal(mockExtractFn.calls.length, 1);
    });

    it('should handle extractFn failures gracefully via Promise.allSettled', async () => {
      const calls: Array<{ exchange: MessageExchange; userId: string; sourceChunkId: string }> = [];
      const failingExtractFn = Object.assign(
        async (exchange: MessageExchange, userId: string, sourceChunkId: string) => {
          calls.push({ exchange, userId, sourceChunkId });
          if (exchange.userMessage === 'fail') {
            throw new Error('extraction failed');
          }
          return [];
        },
        { calls }
      );

      queue = new ExtractionQueue(failingExtractFn);
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('fail'), 'user2', 'chunk-2');
      queue.enqueue(createExchange('msg3'), 'user1', 'chunk-3');

      // Should not throw
      await queue.flush();

      // All three should have been called despite the middle one failing
      assert.equal(failingExtractFn.calls.length, 3);
    });
  });

  describe('auto-drain on interval', () => {
    it('should flush queue on interval', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 50, batchSize: 100 });
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      assert.equal(mockExtractFn.calls.length, 0);

      // Wait for interval to fire
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.equal(mockExtractFn.calls.length, 1);
    });

    it('should flush queue multiple times on repeated intervals', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 30, batchSize: 100 });
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(mockExtractFn.calls.length, 1);

      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(mockExtractFn.calls.length, 2);
    });

    it('should not flush before interval if batch size not reached', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 200, batchSize: 10 });
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');

      // Wait but not long enough for interval
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not have flushed yet
      assert.equal(mockExtractFn.calls.length, 0);
    });
  });

  describe('early flush on batch size threshold', () => {
    it('should flush immediately when batch size is reached', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 10000, batchSize: 3 });
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');
      assert.equal(mockExtractFn.calls.length, 0);

      // Third item hits batch size threshold
      queue.enqueue(createExchange('msg3'), 'user1', 'chunk-3');

      // Wait for async flush to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      assert.equal(mockExtractFn.calls.length, 3);
    });

    it('should flush multiple batches when batch size is exceeded multiple times', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 10000, batchSize: 2 });
      queue.start();

      // First batch
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mockExtractFn.calls.length, 2);

      // Second batch
      queue.enqueue(createExchange('msg3'), 'user1', 'chunk-3');
      queue.enqueue(createExchange('msg4'), 'user2', 'chunk-4');
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mockExtractFn.calls.length, 4);
    });
  });

  describe('stop()', () => {
    it('should flush remaining items when stopped', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 10000, batchSize: 100 });
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');

      await queue.stop();

      assert.equal(mockExtractFn.calls.length, 2);
    });

    it('should stop the interval timer', async () => {
      queue = new ExtractionQueue(mockExtractFn, { intervalMs: 50, batchSize: 100 });
      queue.start();

      await queue.stop();

      // Enqueue after stop
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');

      // Wait past interval
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not auto-flush since timer is stopped
      assert.equal(mockExtractFn.calls.length, 0);
    });

    it('should be safe to call stop() multiple times', async () => {
      queue = new ExtractionQueue(mockExtractFn);
      queue.start();
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');

      await queue.stop();
      assert.equal(mockExtractFn.calls.length, 1);

      // Second stop should be a no-op
      await queue.stop();
      assert.equal(mockExtractFn.calls.length, 1);
    });
  });

  describe('config via env vars', () => {
    it('should use PLUMB_EXTRACT_INTERVAL_MS from env', async () => {
      process.env.PLUMB_EXTRACT_INTERVAL_MS = '50';
      queue = new ExtractionQueue(mockExtractFn);
      queue.start();

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.equal(mockExtractFn.calls.length, 1);

      delete process.env.PLUMB_EXTRACT_INTERVAL_MS;
    });

    it('should use PLUMB_EXTRACT_BATCH_SIZE from env', async () => {
      process.env.PLUMB_EXTRACT_BATCH_SIZE = '2';
      queue = new ExtractionQueue(mockExtractFn);

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');

      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mockExtractFn.calls.length, 2);

      delete process.env.PLUMB_EXTRACT_BATCH_SIZE;
    });

    it('should prefer explicit options over env vars', async () => {
      process.env.PLUMB_EXTRACT_BATCH_SIZE = '100';
      queue = new ExtractionQueue(mockExtractFn, { batchSize: 2 });

      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');
      queue.enqueue(createExchange('msg2'), 'user2', 'chunk-2');

      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mockExtractFn.calls.length, 2);

      delete process.env.PLUMB_EXTRACT_BATCH_SIZE;
    });
  });

  describe('concurrent flush protection', () => {
    it('should not run multiple flush operations concurrently', async () => {
      let extractCallCount = 0;
      const calls: Array<{ exchange: MessageExchange; userId: string; sourceChunkId: string }> = [];
      const slowExtractFn = Object.assign(
        async (exchange: MessageExchange, userId: string, sourceChunkId: string) => {
          extractCallCount++;
          calls.push({ exchange, userId, sourceChunkId });
          await new Promise(resolve => setTimeout(resolve, 50));
          return [];
        },
        { calls }
      );

      queue = new ExtractionQueue(slowExtractFn);
      queue.enqueue(createExchange('msg1'), 'user1', 'chunk-1');

      // Start two flush operations
      const flush1 = queue.flush();
      const flush2 = queue.flush();

      await Promise.all([flush1, flush2]);

      // Should only process once, not twice
      assert.equal(extractCallCount, 1);
    });
  });
});
