import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopQueryServer: vi.fn(async () => undefined),
  stopWikiQueueWorker: vi.fn(() => undefined),
}));

vi.mock('./query-server.js', () => ({ stopQueryServer: mocks.stopQueryServer }));
vi.mock('./wiki-queue-worker.js', () => ({ stopWikiQueueWorker: mocks.stopWikiQueueWorker }));

import {
  __getLifecycleSnapshotForTests,
  __resetLifecycleForTests,
  acquireQueryServer,
  acquireWikiQueueWorker,
  registerProcessCleanup,
} from './lifecycle.js';

const baseQueryConfig = {
  host: '127.0.0.1',
  queryPort: 19901,
  dbPath: '/tmp/plumb-life/memory.db',
  wikiDbPath: '/tmp/plumb-life/wiki.db',
  wikiRoot: '/tmp/plumb-life/wiki',
  userId: 'default',
  wikiMode: 'v2-shadow',
  contextualRetrieval: { mode: 'active', parentTokenBudgets: [360, 260], maxParentTokens: 900 },
};

afterEach(() => {
  __resetLifecycleForTests();
  vi.clearAllMocks();
});

describe('process-global lifecycle registry', () => {
  it('refcounts compatible query and queue resources and stops only at zero', async () => {
    const queryResource = { close: vi.fn() } as any;
    const queueResource = {} as any;
    const startQuery = vi.fn(() => queryResource);
    const startQueue = vi.fn(() => queueResource);

    const q1 = acquireQueryServer(baseQueryConfig, startQuery);
    const q2 = acquireQueryServer(baseQueryConfig, startQuery);
    const w1 = acquireWikiQueueWorker({ wikiRoot: '/tmp/plumb-life/wiki', wikiDbPath: '/tmp/plumb-life/wiki.db', userId: 'default' }, startQueue);
    const w2 = acquireWikiQueueWorker({ wikiRoot: '/tmp/plumb-life/wiki', wikiDbPath: '/tmp/plumb-life/wiki.db', userId: 'default' }, startQueue);

    expect(startQuery).toHaveBeenCalledTimes(1);
    expect(startQueue).toHaveBeenCalledTimes(1);
    expect(q2.reused).toBe(true);
    expect(w2.reused).toBe(true);
    expect(__getLifecycleSnapshotForTests()).toMatchObject({
      queryEntries: [expect.objectContaining({ refCount: 2 })],
      wikiQueueEntries: [expect.objectContaining({ refCount: 2 })],
      cleanupTokens: 4,
    });

    await q1.token.release();
    await w1.token.release();
    expect(mocks.stopQueryServer).not.toHaveBeenCalled();
    expect(mocks.stopWikiQueueWorker).not.toHaveBeenCalled();

    await q2.token.release();
    await q2.token.release();
    await w2.token.release();
    await w2.token.release();
    expect(mocks.stopQueryServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopWikiQueueWorker).toHaveBeenCalledTimes(1);
    expect(__getLifecycleSnapshotForTests().queryEntries).toHaveLength(0);
    expect(__getLifecycleSnapshotForTests().wikiQueueEntries).toHaveLength(0);
  });

  it('reuses a start-in-flight query resource and release-before-listen is safe', async () => {
    let resolveStart!: (resource: any) => void;
    const pending = new Promise<any>((resolve) => { resolveStart = resolve; });
    const startQuery = vi.fn(() => pending);

    const q1 = acquireQueryServer(baseQueryConfig, startQuery);
    const q2 = acquireQueryServer(baseQueryConfig, startQuery);
    expect(startQuery).toHaveBeenCalledTimes(1);
    expect(__getLifecycleSnapshotForTests().queryEntries[0]).toMatchObject({ refCount: 2, hasResource: false });

    const release1 = q1.token.release();
    await Promise.resolve();
    expect(mocks.stopQueryServer).not.toHaveBeenCalled();
    expect(__getLifecycleSnapshotForTests().queryEntries[0]).toMatchObject({ refCount: 1 });

    const release2 = q2.token.release();
    await Promise.resolve();
    expect(mocks.stopQueryServer).not.toHaveBeenCalled();
    const resource = { close: vi.fn() } as any;
    resolveStart(resource);
    await Promise.all([release1, release2]);

    expect(mocks.stopQueryServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopQueryServer).toHaveBeenCalledWith(resource);
    expect(__getLifecycleSnapshotForTests().queryEntries).toHaveLength(0);
  });

  it('logs one same-port incompatible conflict and never calls the second starter', () => {
    const logger = { error: vi.fn() };
    const startA = vi.fn(() => ({ close: vi.fn() }) as any);
    const startB = vi.fn(() => ({ close: vi.fn() }) as any);

    acquireQueryServer(baseQueryConfig, startA, logger);
    const conflict1 = acquireQueryServer({ ...baseQueryConfig, dbPath: '/tmp/plumb-life/other.db' }, startB, logger);
    const conflict2 = acquireQueryServer({ ...baseQueryConfig, dbPath: '/tmp/plumb-life/other.db' }, startB, logger);

    expect(conflict1.conflict).toBe(true);
    expect(conflict2.conflict).toBe(true);
    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Lifecycle conflict for query 127.0.0.1:19901'));
  });

  it('registers process signal cleanup exactly once', () => {
    const baseline = process.listeners('SIGTERM');
    registerProcessCleanup({ info: vi.fn() });
    registerProcessCleanup({ info: vi.fn() });
    const added = process.listeners('SIGTERM').filter((listener) => !baseline.includes(listener));
    expect(added).toHaveLength(1);
  });
});
