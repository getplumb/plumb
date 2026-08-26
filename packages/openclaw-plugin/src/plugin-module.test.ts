import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const never = () => new Promise<never>(() => {});
  return {
    localStoreCreate: vi.fn(never),
    embedQuery: vi.fn(() => Promise.resolve([])),
    normalizeContextualConfig: vi.fn((input?: any) => ({
      mode: input?.mode ?? 'off',
      model: input?.model ?? 'Xenova/bge-small-en-v1.5',
      parentTokenBudgets: input?.parentTokenBudgets ?? [360, 260, 100, 50, 25],
      maxParentTokens: input?.maxParentTokens ?? 900,
    })),
    createWikiTools: vi.fn(() => [
      'plumb_wiki_read',
      'plumb_wiki_search',
      'plumb_wiki_list',
      'plumb_wiki_links',
    ].map((name) => ({
      name,
      description: `${name} description`,
      parameters: { type: 'object' },
      execute: vi.fn(async () => ''),
    }))),
    createWikiInjectionHook: vi.fn((options: any) => {
      const handler = vi.fn(async () => undefined);
      (handler as any).__wikiOptions = options;
      return handler;
    }),
    startWikiQueueWorker: vi.fn(() => ({ __interval: true } as any)),
    stopWikiQueueWorker: vi.fn(() => undefined),
    appendToQueue: vi.fn(async () => 'queued-id'),
    startQueryServer: vi.fn(() => ({ close: vi.fn() })),
    stopQueryServer: vi.fn(async () => undefined),
    createPreResponseHook: vi.fn(() => vi.fn(async () => undefined)),
    fireTelemetry: vi.fn(async () => undefined),
    sanitizeWikiTelemetryEvent: vi.fn((event: unknown) => ({ sanitized: true, event })),
    defaultQueuePath: vi.fn(() => '/tmp/plumb-life/wiki-queue.jsonl'),
    acquireLifecycleOwnership: vi.fn(async (input: any) => ({
      role: 'owner',
      identityHash: 'test-identity-hash',
      identity: { ...input, queryHost: input.queryHost ?? '127.0.0.1' },
      ownerId: 'test-owner',
      leasePath: '/tmp/plumb-life/run/openclaw-plugin/plumb-query.lock',
      healthUrl: `http://127.0.0.1:${input.queryPort}/health`,
      release: vi.fn(async () => undefined),
    })),
  };
});

vi.mock('@getplumb/core', () => ({
  LocalStore: { create: mocks.localStoreCreate },
  embedQuery: mocks.embedQuery,
  normalizeContextualConfig: mocks.normalizeContextualConfig,
  defaultQueuePath: mocks.defaultQueuePath,
}));

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  class FakeBetterSqlite3 {
    constructor(_path: string) {}
    close() {}
  }
  return {
    ...actual,
    createRequire: vi.fn(() => {
      const req = vi.fn((id: string) => {
        if (id === 'better-sqlite3') return FakeBetterSqlite3;
        throw new Error(`Unexpected require: ${id}`);
      });
      (req as any).resolve = vi.fn(() => '/tmp/fake-better-sqlite3/lib/index.js');
      return req;
    }),
  };
});

vi.mock('./wiki-tools.js', () => ({ createWikiTools: mocks.createWikiTools }));
vi.mock('./wiki-injection.js', () => ({ createWikiInjectionHook: mocks.createWikiInjectionHook }));
vi.mock('./wiki-queue-worker.js', () => ({
  appendToQueue: mocks.appendToQueue,
  startWikiQueueWorker: mocks.startWikiQueueWorker,
  stopWikiQueueWorker: mocks.stopWikiQueueWorker,
}));
vi.mock('./query-server.js', () => ({
  startQueryServer: mocks.startQueryServer,
  stopQueryServer: mocks.stopQueryServer,
}));
vi.mock('./hooks/pre-response.js', () => ({ createPreResponseHook: mocks.createPreResponseHook }));
vi.mock('./telemetry.js', () => ({ fireTelemetry: mocks.fireTelemetry }));
vi.mock('./wiki-telemetry.js', () => ({ sanitizeWikiTelemetryEvent: mocks.sanitizeWikiTelemetryEvent }));
vi.mock('./lifecycle-lease.js', () => ({ acquireLifecycleOwnership: mocks.acquireLifecycleOwnership }));

import { plugin } from './plugin-module.js';
import { __getLifecycleSnapshotForTests, __resetLifecycleForTests } from './lifecycle.js';

const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'beforeExit', 'exit'] as const;
let processListenerBaseline: Partial<Record<(typeof PROCESS_EVENTS)[number], Function[]>> = {};

function captureProcessListeners() {
  processListenerBaseline = Object.fromEntries(
    PROCESS_EVENTS.map((event) => [event, process.listeners(event)]),
  ) as Partial<Record<(typeof PROCESS_EVENTS)[number], Function[]>>;
}

function removeAddedProcessListeners() {
  for (const event of PROCESS_EVENTS) {
    const baseline = processListenerBaseline[event] ?? [];
    for (const listener of process.listeners(event)) {
      if (!baseline.includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
  processListenerBaseline = {};
}

function createApi(pluginConfig: Record<string, unknown>) {
  const registeredTools: Array<{ tool: unknown; opts?: { name?: string } }> = [];
  const hooks: Array<{ hookName: string; handler: unknown; opts?: unknown }> = [];
  const api = {
    id: 'plumb',
    name: 'Plumb Memory',
    pluginConfig,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: unknown, opts?: unknown) => {
      hooks.push({ hookName, handler, opts });
    }),
    registerTool: vi.fn((tool: unknown, opts?: { name?: string }) => {
      registeredTools.push({ tool, opts });
    }),
  };
  return { api, registeredTools, hooks };
}

afterEach(() => {
  __resetLifecycleForTests();
  removeAddedProcessListeners();
  vi.clearAllMocks();
  mocks.localStoreCreate.mockImplementation(() => new Promise<never>(() => {}));
  mocks.acquireLifecycleOwnership.mockImplementation(async (input: any) => ({
    role: 'owner',
    identityHash: 'test-identity-hash',
    identity: { ...input, queryHost: input.queryHost ?? '127.0.0.1' },
    ownerId: 'test-owner',
    leasePath: '/tmp/plumb-life/run/openclaw-plugin/plumb-query.lock',
    healthUrl: `http://127.0.0.1:${input.queryPort}/health`,
    release: vi.fn(async () => undefined),
  }));
});

describe('plugin activation', () => {
  it.each(['v2', 'v2-shadow'] as const)(
    'registers %s wiki tools and wiki injection synchronously before async setup resolves',
    async (wikiMode) => {
      captureProcessListeners();
      const { api, registeredTools, hooks } = createApi({
        wikiMode,
        wikiRoot: '/tmp/plumb-test/wiki',
        wikiDbPath: '/tmp/plumb-test/wiki.db',
        wikiInjectionTelemetry: true,
        contextualRetrieval: {
          mode: 'active',
          parentTokenBudgets: [1000, 500, 250],
          maxParentTokens: 1000,
        },
      });

      plugin.activate?.(api as any);

      expect(mocks.localStoreCreate).not.toHaveBeenCalled();
      expect(mocks.startWikiQueueWorker).not.toHaveBeenCalled();
      expect(registeredTools.map((entry) => entry.opts?.name)).toEqual([
        'plumb_wiki_read',
        'plumb_wiki_search',
        'plumb_wiki_list',
        'plumb_wiki_links',
        'plumb_wiki_queue_edit',
      ]);
      expect(hooks.filter((hook) => hook.hookName === 'before_prompt_build')).toHaveLength(1);
      expect(mocks.createWikiTools).toHaveBeenCalledWith({
        wikiRoot: '/tmp/plumb-test/wiki',
        wikiDbPath: '/tmp/plumb-test/wiki.db',
      });
      expect(mocks.createWikiInjectionHook).toHaveBeenCalledWith(expect.objectContaining({
        wikiMode,
        wikiRoot: '/tmp/plumb-test/wiki',
        wikiDbPath: '/tmp/plumb-test/wiki.db',
        contextualRetrieval: {
          mode: 'active',
          model: 'Xenova/bge-small-en-v1.5',
          parentTokenBudgets: [1000, 500, 250],
          maxParentTokens: 1000,
        },
        onTelemetry: expect.any(Function),
      }));

      await Promise.resolve();

      expect(mocks.localStoreCreate).toHaveBeenCalledWith({
        dbPath: expect.any(String),
        userId: 'default',
      });
      expect(mocks.startWikiQueueWorker).not.toHaveBeenCalled();
      expect(registeredTools.map((entry) => entry.opts?.name)).toEqual([
        'plumb_wiki_read',
        'plumb_wiki_search',
        'plumb_wiki_list',
        'plumb_wiki_links',
        'plumb_wiki_queue_edit',
      ]);
    },
  );

  it('reuses process-global lifecycle resources across duplicate compatible activations while registering local tools/hooks twice', async () => {
    captureProcessListeners();
    const makeStore = () => ({
      status: vi.fn(async () => ({ factCount: 1 })),
      ingestMemoryFact: vi.fn(async () => ({ factId: 'fact' })),
      startBacklogProcessor: vi.fn(),
      searchMemoryFacts: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    });
    const stores = [makeStore(), makeStore()];
    mocks.localStoreCreate
      .mockResolvedValueOnce(stores[0] as any)
      .mockResolvedValueOnce(stores[1] as any);

    const config = {
      wikiMode: 'v2-shadow',
      dbPath: '/tmp/plumb-life/memory.db',
      wikiRoot: '/tmp/plumb-life/wiki',
      wikiDbPath: '/tmp/plumb-life/wiki.db',
      userId: 'default',
      queryPort: 19876,
      contextualRetrieval: { mode: 'active', maxParentTokens: 900 },
    };
    mocks.acquireLifecycleOwnership
      .mockResolvedValueOnce({
        role: 'owner', identityHash: 'same-hash', identity: config, ownerId: 'owner-a', leasePath: '/tmp/lease', healthUrl: 'http://127.0.0.1:19876/health', release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        role: 'follower', identityHash: 'same-hash', identity: config, ownerId: 'owner-a', leasePath: '/tmp/lease', healthUrl: 'http://127.0.0.1:19876/health', release: vi.fn(async () => undefined),
      });

    const apiA = createApi(config);
    const apiB = createApi(config);

    plugin.activate?.(apiA.api as any);
    plugin.activate?.(apiB.api as any);

    expect(apiA.registeredTools.map((entry) => entry.opts?.name)).toContain('plumb_wiki_queue_edit');
    expect(apiB.registeredTools.map((entry) => entry.opts?.name)).toContain('plumb_wiki_queue_edit');
    expect(apiA.hooks.filter((hook) => hook.hookName === 'before_prompt_build')).toHaveLength(1);
    expect(apiB.hooks.filter((hook) => hook.hookName === 'before_prompt_build')).toHaveLength(1);

    await vi.waitFor(() => expect(mocks.startQueryServer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.startWikiQueueWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(apiA.hooks.filter((hook) => hook.hookName === 'before_prompt_build')).toHaveLength(2));
    await vi.waitFor(() => expect(apiB.hooks.filter((hook) => hook.hookName === 'before_prompt_build')).toHaveLength(2));

    expect(process.listeners('SIGTERM').filter((listener) => !processListenerBaseline.SIGTERM?.includes(listener))).toHaveLength(1);
    expect(__getLifecycleSnapshotForTests()).toMatchObject({
      signalHandlersRegistered: true,
    });

    const stopA = apiA.hooks.find((hook) => hook.hookName === 'gateway_stop')?.handler as () => Promise<void>;
    const stopB = apiB.hooks.find((hook) => hook.hookName === 'gateway_stop')?.handler as () => Promise<void>;
    await stopA();
    expect(mocks.stopQueryServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopWikiQueueWorker).toHaveBeenCalledTimes(1);

    await stopB();
    await stopB();
    expect(mocks.stopQueryServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopWikiQueueWorker).toHaveBeenCalledTimes(1);
    expect(stores[0].close).toHaveBeenCalledTimes(1);
    expect(stores[1].close).toHaveBeenCalledTimes(1);
    expect(__getLifecycleSnapshotForTests().queryEntries).toHaveLength(0);
    expect(__getLifecycleSnapshotForTests().wikiQueueEntries).toHaveLength(0);
  });

  it('logs one incompatible same-port conflict and does not attempt a second bind', async () => {
    captureProcessListeners();
    mocks.localStoreCreate.mockImplementation(async () => ({
      status: vi.fn(async () => ({ factCount: 1 })),
      ingestMemoryFact: vi.fn(async () => ({ factId: 'fact' })),
      startBacklogProcessor: vi.fn(),
      searchMemoryFacts: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    }) as any);

    mocks.acquireLifecycleOwnership
      .mockResolvedValueOnce({ role: 'owner', identityHash: 'a', identity: {}, ownerId: 'owner-a', leasePath: '/tmp/lease', healthUrl: 'http://127.0.0.1:19877/health', release: vi.fn(async () => undefined) })
      .mockResolvedValueOnce({ role: 'conflict', identityHash: 'b', identity: {}, ownerId: 'owner-a', leasePath: '/tmp/lease', healthUrl: 'http://127.0.0.1:19877/health', error: 'Lifecycle conflict for query 127.0.0.1:19877', release: vi.fn(async () => undefined) });

    const base = { wikiMode: 'v1', queryPort: 19877, userId: 'default' };
    const apiA = createApi({ ...base, dbPath: '/tmp/plumb-life/a.db' });
    const apiB = createApi({ ...base, dbPath: '/tmp/plumb-life/b.db' });

    plugin.activate?.(apiA.api as any);
    plugin.activate?.(apiB.api as any);

    await vi.waitFor(() => expect(mocks.localStoreCreate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.startQueryServer).toHaveBeenCalledTimes(1));
    expect(apiB.api.logger.error).toHaveBeenCalledWith(expect.stringContaining('Lifecycle conflict for query 127.0.0.1:19877'));
    expect(__getLifecycleSnapshotForTests().queryEntries).toHaveLength(0);
  });
});
