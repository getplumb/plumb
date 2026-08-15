import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export type Logger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type LifecycleIdentityInput = {
  dbPath: string;
  userId: string;
  wikiMode: string;
  wikiRoot?: string;
  wikiDbPath?: string;
  queryHost?: string;
  queryPort: number;
  queuePath?: string;
  contextualRetrieval: unknown;
};

export type LifecycleIdentity = {
  dbPath: string;
  userId: string;
  wikiMode: string;
  wikiRoot: string | null;
  wikiDbPath: string | null;
  queryHost: string;
  queryPort: number;
  queuePath: string | null;
  contextualRetrieval: unknown;
};

export type LifecycleLeaseFile = {
  schemaVersion: 1;
  identityHash: string;
  ownerId: string;
  pid: number;
  ppid: number;
  hostname: string;
  startedAt: string;
  updatedAt: string;
  queryPort: number;
  healthUrl: string;
  identity: LifecycleIdentity;
};

export type LifecycleOwnership = {
  role: 'owner' | 'follower' | 'conflict' | 'degraded';
  identityHash: string;
  identity: LifecycleIdentity;
  ownerId: string | null;
  leasePath: string;
  healthUrl: string;
  release: () => Promise<void>;
  error?: string;
};

const SCHEMA_VERSION = 1 as const;
const STARTUP_GRACE_MS = 15_000;
const STALE_HEARTBEAT_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 500;

type HealthResponse = {
  service?: string;
  identityHash?: string;
  pid?: number;
  ownerId?: string;
  startedAt?: string;
  identity?: LifecycleIdentity;
};

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

function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(2));
  return p;
}

async function normalizePath(p: string | undefined): Promise<string | null> {
  if (!p) return null;
  const absolute = resolve(expandHome(p));
  try {
    return await realpath(absolute);
  } catch {
    try {
      const parent = await realpath(dirname(absolute));
      return join(parent, absolute.split('/').pop() ?? '');
    } catch {
      return absolute;
    }
  }
}

export async function buildLifecycleIdentity(input: LifecycleIdentityInput): Promise<{
  identity: LifecycleIdentity;
  identityHash: string;
  runDir: string;
  leasePath: string;
  healthUrl: string;
}> {
  const dbPath = (await normalizePath(input.dbPath)) ?? resolve(expandHome(input.dbPath));
  const queryHost = input.queryHost ?? '127.0.0.1';
  const identity: LifecycleIdentity = {
    dbPath,
    userId: input.userId,
    wikiMode: input.wikiMode,
    wikiRoot: await normalizePath(input.wikiRoot),
    wikiDbPath: await normalizePath(input.wikiDbPath),
    queryHost,
    queryPort: input.queryPort,
    queuePath: await normalizePath(input.queuePath),
    contextualRetrieval: stableNormalize(input.contextualRetrieval),
  };
  const identityHash = createHash('sha256').update(stableConfigString(identity)).digest('hex');
  const runDir = join(dirname(dbPath), 'run', 'openclaw-plugin');
  const portKey = `${queryHost.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${input.queryPort}`;
  const leasePath = join(runDir, `plumb-query-${portKey}.lock`);
  const healthUrl = `http://${queryHost}:${input.queryPort}/health`;
  return { identity, identityHash, runDir, leasePath, healthUrl };
}

async function writeLeaseFile(path: string, lease: LifecycleLeaseFile): Promise<void> {
  const tmp = join(dirname(path), `.lease-${lease.ownerId}-${Date.now()}.json.tmp`);
  await writeFile(tmp, JSON.stringify(lease, null, 2), { mode: 0o600 });
  await rename(tmp, join(path, 'lease.json'));
}

async function readLeaseFile(path: string): Promise<LifecycleLeaseFile | null> {
  try {
    return JSON.parse(await readFile(join(path, 'lease.json'), 'utf8')) as LifecycleLeaseFile;
  } catch {
    return null;
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

async function fetchHealth(healthUrl: string): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;
    return await res.json() as HealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForMatchingHealth(healthUrl: string, identityHash: string, deadlineMs: number): Promise<HealthResponse | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(healthUrl);
    if (health?.service === 'plumb-query' && health.identityHash === identityHash) return health;
    await sleep(200);
  }
  return null;
}

function freshUpdatedAt(lease: LifecycleLeaseFile | null, maxAgeMs: number): boolean {
  if (!lease?.updatedAt) return false;
  const t = Date.parse(lease.updatedAt);
  return Number.isFinite(t) && Date.now() - t <= maxAgeMs;
}

async function recoverStaleLease(leasePath: string, ownerId: string, logger?: Logger): Promise<void> {
  const stalePath = `${leasePath}.stale-${process.pid}-${ownerId}-${Date.now()}`;
  try {
    await rename(leasePath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
  } catch (err) {
    logger?.debug?.(`[plumb] Stale lease recovery race for ${leasePath}: ${err}`);
  }
}

export async function acquireLifecycleOwnership(
  input: LifecycleIdentityInput,
  logger?: Logger,
): Promise<LifecycleOwnership> {
  const built = await buildLifecycleIdentity(input);
  await mkdir(built.runDir, { recursive: true, mode: 0o700 });
  const localOwnerId = randomUUID();

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await mkdir(built.leasePath, { mode: 0o700 });
      const now = new Date().toISOString();
      let lease: LifecycleLeaseFile = {
        schemaVersion: SCHEMA_VERSION,
        identityHash: built.identityHash,
        ownerId: localOwnerId,
        pid: process.pid,
        ppid: process.ppid,
        hostname: hostname(),
        startedAt: now,
        updatedAt: now,
        queryPort: input.queryPort,
        healthUrl: built.healthUrl,
        identity: built.identity,
      };
      await writeLeaseFile(built.leasePath, lease);
      const heartbeat = setInterval(() => {
        lease = { ...lease, updatedAt: new Date().toISOString(), ppid: process.ppid };
        writeLeaseFile(built.leasePath, lease).catch((err) => {
          logger?.debug?.(`[plumb] Lease heartbeat failed: ${err}`);
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      let released = false;
      return {
        role: 'owner',
        identityHash: built.identityHash,
        identity: built.identity,
        ownerId: localOwnerId,
        leasePath: built.leasePath,
        healthUrl: built.healthUrl,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          const current = await readLeaseFile(built.leasePath);
          if (current?.ownerId === localOwnerId) await rm(built.leasePath, { recursive: true, force: true });
        },
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const lease = await readLeaseFile(built.leasePath);
    if (!lease) {
      await recoverStaleLease(built.leasePath, localOwnerId, logger);
      continue;
    }

    const health = await fetchHealth(lease.healthUrl || built.healthUrl);
    const healthMatches = health?.service === 'plumb-query' && health.identityHash === built.identityHash;
    const healthConflicts = health?.service === 'plumb-query' && health.identityHash !== undefined && health.identityHash !== built.identityHash;
    const sameIdentity = lease.identityHash === built.identityHash;
    const alive = pidAlive(lease.pid);
    const fresh = freshUpdatedAt(lease, STARTUP_GRACE_MS);
    const stale = !freshUpdatedAt(lease, STALE_HEARTBEAT_MS);

    if (healthMatches) {
      logger?.info?.(`[plumb] Lifecycle follower attached to owner ${health.ownerId ?? lease.ownerId} on ${built.healthUrl}`);
      return {
        role: 'follower',
        identityHash: built.identityHash,
        identity: built.identity,
        ownerId: health.ownerId ?? lease.ownerId,
        leasePath: built.leasePath,
        healthUrl: built.healthUrl,
        release: async () => undefined,
      };
    }

    if (!sameIdentity && (alive || healthConflicts || fresh)) {
      const message = `Lifecycle conflict for query ${built.identity.queryHost}:${built.identity.queryPort}: live owner has incompatible identity; not starting another process-global resource.`;
      logger?.error?.(`[plumb] ${message}`);
      return {
        role: 'conflict',
        identityHash: built.identityHash,
        identity: built.identity,
        ownerId: lease.ownerId,
        leasePath: built.leasePath,
        healthUrl: built.healthUrl,
        error: message,
        release: async () => undefined,
      };
    }

    if (sameIdentity && alive && (fresh || !stale)) {
      const waited = await waitForMatchingHealth(lease.healthUrl || built.healthUrl, built.identityHash, STARTUP_GRACE_MS);
      if (waited) {
        logger?.info?.(`[plumb] Lifecycle follower attached to owner ${waited.ownerId ?? lease.ownerId} on ${built.healthUrl}`);
        return {
          role: 'follower',
          identityHash: built.identityHash,
          identity: built.identity,
          ownerId: waited.ownerId ?? lease.ownerId,
          leasePath: built.leasePath,
          healthUrl: built.healthUrl,
          release: async () => undefined,
        };
      }
      const message = `Lifecycle follower degraded: owner ${lease.ownerId} did not become healthy at ${lease.healthUrl || built.healthUrl}; not attempting second bind.`;
      logger?.error?.(`[plumb] ${message}`);
      return {
        role: 'degraded',
        identityHash: built.identityHash,
        identity: built.identity,
        ownerId: lease.ownerId,
        leasePath: built.leasePath,
        healthUrl: built.healthUrl,
        error: message,
        release: async () => undefined,
      };
    }

    if (!alive || (stale && !health)) {
      await recoverStaleLease(built.leasePath, lease.ownerId, logger);
      continue;
    }

    const message = `Lifecycle follower degraded: unable to validate owner ${lease.ownerId}; not attempting second bind.`;
    logger?.error?.(`[plumb] ${message}`);
    return {
      role: 'degraded',
      identityHash: built.identityHash,
      identity: built.identity,
      ownerId: lease.ownerId,
      leasePath: built.leasePath,
      healthUrl: built.healthUrl,
      error: message,
      release: async () => undefined,
    };
  }

  const message = `Lifecycle ownership acquisition exhausted retries for ${built.leasePath}`;
  logger?.error?.(`[plumb] ${message}`);
  return {
    role: 'degraded',
    identityHash: built.identityHash,
    identity: built.identity,
    ownerId: null,
    leasePath: built.leasePath,
    healthUrl: built.healthUrl,
    error: message,
    release: async () => undefined,
  };
}

export async function __removeLifecycleLeaseForTests(input: LifecycleIdentityInput): Promise<void> {
  const built = await buildLifecycleIdentity(input);
  await rm(built.leasePath, { recursive: true, force: true });
  if (existsSync(built.runDir)) {
    try {
      const s = await stat(built.runDir);
      if (!s.isDirectory()) return;
    } catch {
      return;
    }
  }
}
