import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import vm from 'node:vm';
import { acquireLifecycleOwnership, __removeLifecycleLeaseForTests, type LifecycleIdentityInput } from './lifecycle-lease.js';
import { startQueryServer, stopQueryServer } from './query-server.js';

const children: ChildProcess[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const cleanup of cleanupFns.splice(0).reverse()) await cleanup();
});

function fakeStore() {
  return {
    searchMemoryFacts: async () => [],
  } as any;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') reject(new Error('No port'));
      else server.close(() => resolve(addr.port));
    });
  });
}

async function baseConfig(port?: number): Promise<{ dir: string; config: LifecycleIdentityInput }> {
  const dir = await mkdtemp(join(tmpdir(), 'plumb-lease-'));
  const queryPort = port ?? await getFreePort();
  const config: LifecycleIdentityInput = {
    queryHost: '127.0.0.1',
    queryPort,
    dbPath: join(dir, 'memory.db'),
    wikiDbPath: join(dir, 'wiki.db'),
    wikiRoot: join(dir, 'wiki'),
    queuePath: join(dir, 'wiki-queue.jsonl'),
    userId: 'default',
    wikiMode: 'v2-shadow',
    contextualRetrieval: { mode: 'active', maxParentTokens: 900 },
  };
  cleanupFns.push(async () => {
    await __removeLifecycleLeaseForTests(config);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, config };
}

async function waitForHealth(port: number, identityHash: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json() as any;
      if (data.service === 'plumb-query' && data.identityHash === identityHash) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('health did not become ready');
}

describe('filesystem lifecycle lease', () => {
  it('dedupes isolated activations on one fixed port and follower cleanup cannot stop owner', async () => {
    const { config } = await baseConfig();
    const owner = await acquireLifecycleOwnership(config);
    expect(owner.role).toBe('owner');
    const server = startQueryServer(fakeStore(), config.queryPort, undefined, {
      identityHash: owner.identityHash,
      ownerId: owner.ownerId!,
      startedAt: new Date().toISOString(),
      identity: owner.identity,
    });
    cleanupFns.push(async () => { await stopQueryServer(server); await owner.release(); });
    await waitForHealth(config.queryPort, owner.identityHash);

    const follower = await acquireLifecycleOwnership(config);
    expect(follower.role).toBe('follower');
    expect(follower.ownerId).toBe(owner.ownerId);

    await follower.release();
    const stillHealthy = await fetch(`http://127.0.0.1:${config.queryPort}/health`).then((r) => r.json()) as any;
    expect(stillHealthy.ownerId).toBe(owner.ownerId);

    await stopQueryServer(server);
    await owner.release();
    await owner.release();
    await expect(fetch(`http://127.0.0.1:${config.queryPort}/health`)).rejects.toThrow();
  });

  it('fails closed on live conflicting identity using the same port', async () => {
    const { config } = await baseConfig();
    const owner = await acquireLifecycleOwnership(config);
    expect(owner.role).toBe('owner');
    const server = startQueryServer(fakeStore(), config.queryPort, undefined, {
      identityHash: owner.identityHash,
      ownerId: owner.ownerId!,
      startedAt: new Date().toISOString(),
      identity: owner.identity,
    });
    cleanupFns.push(async () => { await stopQueryServer(server); await owner.release(); });
    await waitForHealth(config.queryPort, owner.identityHash);

    const conflict = await acquireLifecycleOwnership({ ...config, dbPath: `${config.dbPath}.other` });
    expect(conflict.role).toBe('conflict');
  });

  it('recovers after owner crash leaves a stale lease', async () => {
    const { config } = await baseConfig();
    const owner = await acquireLifecycleOwnership(config);
    expect(owner.role).toBe('owner');
    await owner.release(); // remove first clean lease

    const fakeDeadConfig = { ...config };
    const staleOwner = await acquireLifecycleOwnership(fakeDeadConfig);
    expect(staleOwner.role).toBe('owner');
    // Simulate a crash by leaving the lease directory but stopping heartbeat through process exit semantics
    // available to the next contender as a dead PID: mutate lease to an impossible PID.
    const leaseJson = join(staleOwner.leasePath, 'lease.json');
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(leaseJson, 'utf8'));
    raw.pid = 99999999;
    raw.updatedAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(leaseJson, JSON.stringify(raw));

    const recovered = await acquireLifecycleOwnership(config);
    expect(recovered.role).toBe('owner');
    await recovered.release();
  });

  it('waits through startup race and attaches to owner health instead of rebinding', async () => {
    const { config } = await baseConfig();
    const owner = await acquireLifecycleOwnership(config);
    expect(owner.role).toBe('owner');

    const followerPromise = acquireLifecycleOwnership(config);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const server = startQueryServer(fakeStore(), config.queryPort, undefined, {
      identityHash: owner.identityHash,
      ownerId: owner.ownerId!,
      startedAt: new Date().toISOString(),
      identity: owner.identity,
    });
    cleanupFns.push(async () => { await stopQueryServer(server); await owner.release(); });

    const follower = await followerPromise;
    expect(follower.role).toBe('follower');
    expect(follower.ownerId).toBe(owner.ownerId);
  });

  it('vm contexts prove globalThis isolation while filesystem lease dedupes', async () => {
    const a = vm.createContext({});
    const b = vm.createContext({});
    vm.runInContext('globalThis.__plumbQueryServers = new Map([["x", 1]])', a);
    vm.runInContext('globalThis.__plumbQueryServers = new Map([["x", 2]])', b);
    expect(vm.runInContext('globalThis.__plumbQueryServers.get("x")', a)).toBe(1);
    expect(vm.runInContext('globalThis.__plumbQueryServers.get("x")', b)).toBe(2);

    const { config } = await baseConfig();
    const owner = await acquireLifecycleOwnership(config);
    const server = startQueryServer(fakeStore(), config.queryPort, undefined, {
      identityHash: owner.identityHash,
      ownerId: owner.ownerId!,
      startedAt: new Date().toISOString(),
      identity: owner.identity,
    });
    cleanupFns.push(async () => { await stopQueryServer(server); await owner.release(); });
    const follower = await acquireLifecycleOwnership(config);
    expect([owner.role, follower.role]).toEqual(['owner', 'follower']);
  });

  it('two child processes competing for the same identity produce one owner and one follower with no EADDRINUSE', async () => {
    const { config, dir } = await baseConfig();
    const script = join(dir, 'lease-child.mjs');
    await writeFile(script, `
      import { acquireLifecycleOwnership } from ${JSON.stringify(new URL('./lifecycle-lease.ts', import.meta.url).href)};
      import { startQueryServer } from ${JSON.stringify(new URL('./query-server.ts', import.meta.url).href)};
      const config = JSON.parse(process.env.PLUMB_TEST_CONFIG);
      const delay = Number(process.env.PLUMB_TEST_DELAY || '0');
      const lease = await acquireLifecycleOwnership(config, { info: (m) => console.error(m), error: (m) => console.error(m), debug: () => {} });
      if (lease.role === 'owner') {
        setTimeout(() => {
          startQueryServer({ searchMemoryFacts: async () => [] }, config.queryPort, { info: (m) => console.error(m) }, {
            identityHash: lease.identityHash,
            ownerId: lease.ownerId,
            startedAt: new Date().toISOString(),
            identity: lease.identity,
          });
        }, delay);
      }
      console.log(JSON.stringify({ role: lease.role, ownerId: lease.ownerId, identityHash: lease.identityHash }));
      setTimeout(() => {}, 30_000);
    `);

    const runChild = (delay: number) => new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        env: { ...process.env, PLUMB_TEST_CONFIG: JSON.stringify(config), PLUMB_TEST_DELAY: String(delay) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d) => {
        stdout += d.toString();
        const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
      child.stderr!.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', (code) => {
        if (code !== null && code !== 0 && !stdout) reject(new Error(`child failed ${code}: ${stderr}`));
      });
    });

    const first = runChild(500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = runChild(0);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.role).sort()).toEqual(['follower', 'owner']);
  }, 20_000);
});
