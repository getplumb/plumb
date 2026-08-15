import type { Server } from 'node:http';
import { stopQueryServer } from './query-server.js';
import { stopWikiQueueWorker } from './wiki-queue-worker.js';

type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type QueryResource = Server;
type QueueResource = ReturnType<typeof setInterval>;

type LifecycleEntry<T> = {
  key: string;
  kind: 'query' | 'wikiQueue';
  compatibility: string;
  resource: T | null;
  starter?: Promise<T>;
  refCount: number;
  stopping?: Promise<void>;
  conflictLogged: Set<string>;
};

type CleanupToken = {
  released: boolean;
  release: () => Promise<void>;
};

type LifecycleRegistry = {
  queries: Map<string, LifecycleEntry<QueryResource>>;
  wikiQueues: Map<string, LifecycleEntry<QueueResource>>;
  cleanupTokens: Set<CleanupToken>;
  signalHandlersRegistered: boolean;
  shuttingDown: boolean;
  shutdownPromise?: Promise<void>;
  signalHandler?: (signal?: NodeJS.Signals | string) => void;
  beforeExitHandler?: () => void;
};

const LIFECYCLE_SYMBOL = Symbol.for('@getplumb/plumb.lifecycle.v1');

type GlobalWithLifecycle = typeof globalThis & { [LIFECYCLE_SYMBOL]?: LifecycleRegistry };

function stableNormalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableNormalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stableNormalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function stableConfigString(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function registry(): LifecycleRegistry {
  const g = globalThis as GlobalWithLifecycle;
  if (!g[LIFECYCLE_SYMBOL]) {
    g[LIFECYCLE_SYMBOL] = {
      queries: new Map(),
      wikiQueues: new Map(),
      cleanupTokens: new Set(),
      signalHandlersRegistered: false,
      shuttingDown: false,
    };
  }
  return g[LIFECYCLE_SYMBOL]!;
}

function logConflict(
  entry: LifecycleEntry<unknown>,
  requestedCompatibility: string,
  logger?: Logger,
): void {
  if (entry.conflictLogged.has(requestedCompatibility)) return;
  entry.conflictLogged.add(requestedCompatibility);
  logger?.error?.(
    `[plumb] Lifecycle conflict for ${entry.kind} ${entry.key}: resource already exists with incompatible configuration; ` +
    'not starting another process-global resource. Configure a different queryPort or align dbPath/wikiDbPath/wikiRoot/userId/wikiMode/contextualRetrieval.',
  );
}

async function releaseEntry<T>(
  map: Map<string, LifecycleEntry<T>>,
  entry: LifecycleEntry<T>,
  stop: (resource: T) => Promise<void>,
  logger?: Logger,
): Promise<void> {
  if (entry.refCount > 0) entry.refCount -= 1;
  if (entry.refCount > 0) return;
  if (entry.stopping) {
    await entry.stopping;
    return;
  }

  entry.stopping = (async () => {
    try {
      let resource = entry.resource;
      if (!resource && entry.starter) {
        try {
          resource = await entry.starter;
        } catch (err) {
          logger?.debug?.(`[plumb] ${entry.kind} ${entry.key} start failed before release: ${err}`);
          return;
        }
      }
      if (resource) await stop(resource);
    } finally {
      map.delete(entry.key);
    }
  })();

  await entry.stopping;
}

function makeToken(release: () => Promise<void>): CleanupToken {
  return {
    released: false,
    release: async function releaseOnce() {
      if (this.released) return;
      this.released = true;
      registry().cleanupTokens.delete(this);
      await release();
    },
  };
}

export type QueryLifecycleConfig = {
  host?: string;
  queryPort: number;
  dbPath: string;
  wikiDbPath?: string;
  wikiRoot?: string;
  userId: string;
  wikiMode: string;
  contextualRetrieval: unknown;
};

export type WikiQueueLifecycleConfig = {
  wikiRoot: string;
  wikiDbPath: string;
  queuePath?: string;
  userId: string;
  intervalMs?: number;
};

export type LifecycleHandle<T> = {
  token: CleanupToken;
  resource: T | null;
  reused: boolean;
  conflict: boolean;
};

export function acquireQueryServer(
  config: QueryLifecycleConfig,
  start: () => QueryResource | Promise<QueryResource>,
  logger?: Logger,
): LifecycleHandle<QueryResource> {
  const reg = registry();
  const host = config.host ?? '127.0.0.1';
  const key = `${host}:${config.queryPort}`;
  const compatibility = stableConfigString({
    queryPort: config.queryPort,
    dbPath: config.dbPath,
    wikiDbPath: config.wikiDbPath,
    wikiRoot: config.wikiRoot,
    userId: config.userId,
    wikiMode: config.wikiMode,
    contextualRetrieval: config.contextualRetrieval,
  });

  const existing = reg.queries.get(key);
  if (existing) {
    if (existing.compatibility !== compatibility) {
      logConflict(existing, compatibility, logger);
      return { token: makeToken(async () => undefined), resource: null, reused: true, conflict: true };
    }
    existing.refCount += 1;
    const token = makeToken(() => releaseEntry(reg.queries, existing, stopQueryServer, logger));
    reg.cleanupTokens.add(token);
    return { token, resource: existing.resource, reused: true, conflict: false };
  }

  const entry: LifecycleEntry<QueryResource> = {
    key,
    kind: 'query',
    compatibility,
    resource: null,
    refCount: 1,
    conflictLogged: new Set(),
  };
  reg.queries.set(key, entry);
  try {
    const started = start();
    if (started && typeof (started as Promise<QueryResource>).then === 'function') {
      entry.starter = (started as Promise<QueryResource>).then((resource) => {
        entry.resource = resource;
        return resource;
      });
    } else {
      entry.resource = started as QueryResource;
    }
  } catch (err) {
    reg.queries.delete(key);
    throw err;
  }

  const token = makeToken(() => releaseEntry(reg.queries, entry, stopQueryServer, logger));
  reg.cleanupTokens.add(token);
  return { token, resource: entry.resource, reused: false, conflict: false };
}

export function acquireWikiQueueWorker(
  config: WikiQueueLifecycleConfig,
  start: () => QueueResource | Promise<QueueResource>,
  logger?: Logger,
): LifecycleHandle<QueueResource> {
  const reg = registry();
  const key = stableConfigString({
    wikiRoot: config.wikiRoot,
    wikiDbPath: config.wikiDbPath,
    userId: config.userId,
  });
  const compatibility = stableConfigString(config);

  const existing = reg.wikiQueues.get(key);
  if (existing) {
    if (existing.compatibility !== compatibility) {
      logConflict(existing, compatibility, logger);
      return { token: makeToken(async () => undefined), resource: null, reused: true, conflict: true };
    }
    existing.refCount += 1;
    const token = makeToken(() => releaseEntry(reg.wikiQueues, existing, async (r) => stopWikiQueueWorker(r), logger));
    reg.cleanupTokens.add(token);
    return { token, resource: existing.resource, reused: true, conflict: false };
  }

  const entry: LifecycleEntry<QueueResource> = {
    key,
    kind: 'wikiQueue',
    compatibility,
    resource: null,
    refCount: 1,
    conflictLogged: new Set(),
  };
  reg.wikiQueues.set(key, entry);
  try {
    const started = start();
    if (started && typeof (started as Promise<QueueResource>).then === 'function') {
      entry.starter = (started as Promise<QueueResource>).then((resource) => {
        entry.resource = resource;
        return resource;
      });
    } else {
      entry.resource = started as QueueResource;
    }
  } catch (err) {
    reg.wikiQueues.delete(key);
    throw err;
  }

  const token = makeToken(() => releaseEntry(reg.wikiQueues, entry, async (r) => stopWikiQueueWorker(r), logger));
  reg.cleanupTokens.add(token);
  return { token, resource: entry.resource, reused: false, conflict: false };
}

export function registerActivationCleanup(release: () => Promise<void>): CleanupToken {
  const token = makeToken(release);
  registry().cleanupTokens.add(token);
  return token;
}

export function registerProcessCleanup(logger?: Logger): void {
  const reg = registry();
  if (reg.signalHandlersRegistered) return;

  reg.signalHandler = (signal?: NodeJS.Signals | string) => {
    logger?.info?.(`[plumb] Received shutdown signal${signal ? ` (${signal})` : ''}, cleaning up...`);
    void shutdownAll(logger);
  };
  reg.beforeExitHandler = () => { void shutdownAll(logger); };
  process.on('SIGTERM', reg.signalHandler);
  process.on('SIGINT', reg.signalHandler);
  process.on('beforeExit', reg.beforeExitHandler);
  reg.signalHandlersRegistered = true;
}

export async function shutdownAll(logger?: Logger): Promise<void> {
  const reg = registry();
  if (reg.shutdownPromise) return reg.shutdownPromise;
  reg.shuttingDown = true;
  reg.shutdownPromise = (async () => {
    const tokens = Array.from(reg.cleanupTokens);
    for (const token of tokens) {
      try {
        await token.release();
      } catch (err) {
        logger?.error?.(`[plumb] Cleanup error: ${err}`);
      }
    }
  })();
  await reg.shutdownPromise;
}

export function __getLifecycleSnapshotForTests() {
  const reg = registry();
  return {
    queryEntries: Array.from(reg.queries.entries()).map(([key, entry]) => ({ key, refCount: entry.refCount, compatibility: entry.compatibility, hasResource: Boolean(entry.resource) })),
    wikiQueueEntries: Array.from(reg.wikiQueues.entries()).map(([key, entry]) => ({ key, refCount: entry.refCount, compatibility: entry.compatibility, hasResource: Boolean(entry.resource) })),
    cleanupTokens: reg.cleanupTokens.size,
    signalHandlersRegistered: reg.signalHandlersRegistered,
    shuttingDown: reg.shuttingDown,
  };
}

export function __resetLifecycleForTests(): void {
  const g = globalThis as GlobalWithLifecycle;
  const reg = g[LIFECYCLE_SYMBOL];
  if (reg) {
    if (reg.signalHandler) {
      process.removeListener('SIGTERM', reg.signalHandler);
      process.removeListener('SIGINT', reg.signalHandler);
    }
    if (reg.beforeExitHandler) process.removeListener('beforeExit', reg.beforeExitHandler);
  }
  delete g[LIFECYCLE_SYMBOL];
}
