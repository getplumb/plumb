import { LocalStore, embedQuery } from '@getplumb/core';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createPreResponseHook } from './hooks/pre-response.js';
import { startQueryServer, stopQueryServer } from './query-server.js';

/**
 * Ensure better-sqlite3 native binary is available.
 *
 * OpenClaw installs plugins with `npm install --ignore-scripts`, which means
 * better-sqlite3's own install script (`prebuild-install || node-gyp rebuild`)
 * never runs. We detect this at activation time and download the prebuilt
 * binary using prebuild-install (bundled as a dep of better-sqlite3).
 *
 * Falls back to source compilation (node-gyp) if prebuild-install fails.
 */
async function ensureSqliteBinary(logger: { info: (s: string) => void; warn: (s: string) => void; debug?: (s: string) => void }): Promise<void> {
  // Locate better-sqlite3 relative to this file's location in node_modules.
  // In the installed plugin, __dirname resolves to the dist/ folder, so
  // we walk up to find node_modules/better-sqlite3.
  const req = createRequire(import.meta.url);

  // Probe by actually instantiating a :memory: database — the native binary
  // loads lazily inside the Database() constructor, so require() alone is not enough.
  try {
    const Db = req('better-sqlite3') as any;
    const probe = new Db(':memory:');
    probe.close();
    return; // Binary works — nothing to do
  } catch (e) {
    logger.info(`[plumb] better-sqlite3 binary not ready (${String(e).split('\n')[0]}); attempting to download prebuilt...`);
    // Fall through to prebuild-install / source rebuild
  }

  // Resolve the better-sqlite3 directory.
  let sqliteDir: string;
  try {
    sqliteDir = dirname(req.resolve('better-sqlite3'));
    // resolve() returns the main entry file; go up to package root
    // e.g. .../better-sqlite3/lib/index.js → .../better-sqlite3
    while (!existsSync(join(sqliteDir, 'package.json'))) {
      const parent = join(sqliteDir, '..');
      if (parent === sqliteDir) throw new Error('Could not find better-sqlite3 package root');
      sqliteDir = parent;
    }
  } catch (e) {
    logger.warn(`[plumb] Could not locate better-sqlite3 package: ${e}`);
    return;
  }

  // Find prebuild-install (it's a dep of better-sqlite3, so nested or hoisted).
  const prebuildCandidates = [
    join(sqliteDir, 'node_modules', 'prebuild-install', 'bin.js'),
    join(sqliteDir, '..', 'prebuild-install', 'bin.js'),       // hoisted one level up (peer of better-sqlite3)
    join(sqliteDir, '..', '..', 'prebuild-install', 'bin.js'), // hoisted further up (plugin root)
  ];
  const prebuildScript = prebuildCandidates.find(p => existsSync(p)) ?? null;

  if (prebuildScript) {
    try {
      execSync(`node ${JSON.stringify(prebuildScript)}`, {
        cwd: sqliteDir,
        stdio: 'pipe',
        timeout: 90_000,
      });
      logger.info('[plumb] better-sqlite3 prebuilt binary downloaded successfully.');

      // Verify it loads now
      try { req('better-sqlite3'); return; } catch { /* fall through to rebuild */ }
    } catch (e) {
      const errLine = (e as any)?.stderr?.toString().trim().split('\n')[0] ?? String(e);
      logger.warn(`[plumb] prebuild-install failed (${errLine}), trying source build...`);
    }
  } else {
    logger.warn('[plumb] prebuild-install not found, trying source build...');
  }

  // Last resort: compile from source (requires build tools on the machine).
  const pluginDir = join(sqliteDir, '..');
  try {
    execSync('npm rebuild better-sqlite3', { cwd: pluginDir, stdio: 'pipe', timeout: 120_000 });
    logger.info('[plumb] better-sqlite3 built from source successfully.');
  } catch (e) {
    logger.warn('[plumb] Could not build better-sqlite3 from source — Plumb may fail to initialize.');
    logger.warn('[plumb] To fix manually: cd ' + pluginDir + ' && npm rebuild better-sqlite3');
  }
}

// Define types inline since they aren't re-exported from openclaw/plugin-sdk
type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type PluginHookHandlerMap = {
  session_end: (event: any, ctx: any) => Promise<void> | void;
  before_prompt_build: (event: any, ctx: any) => Promise<any> | void;
  [key: string]: any;
};

type AnyAgentTool = {
  name: string;
  description: string;
  parameters: object;
  execute: (params: any) => Promise<string>;
};

type OpenClawPluginToolContext = {
  agentId?: string;
  sessionId?: string;
  [key: string]: any;
};

type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

type OpenClawPluginToolOptions = {
  [key: string]: any;
};

type OpenClawPluginApi = {
  id: string;
  name: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  on: <K extends keyof PluginHookHandlerMap>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number }
  ) => void;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions
  ) => void;
};

type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  version?: string;
  kind?: 'memory';
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

const DEFAULT_DB_PATH = join(homedir(), '.plumb', 'memory.db');

/**
 * One-shot seeding of memory_facts from existing workspace memory files.
 * Runs only when the store has zero facts (first activation).
 * Splits each .md file on ## headings and ingests each section as a fact.
 * Tagged with source:memory-file and the filename date.
 * Confidence 0.85 (slightly below fresh agent-written facts at 0.95), decay slow.
 */
async function seedFromMemoryFiles(
  store: LocalStore,
  userId: string,
  api: OpenClawPluginApi
): Promise<void> {
  const status = await store.status();
  if (status.factCount > 0) {
    api.logger.debug?.('[plumb] Skipping memory file seed — store already has facts');
    return;
  }

  // Candidate directories for memory files (workspace root / memory/)
  const candidates = [
    join(homedir(), '.openclaw', 'workspace', 'memory'),
    join(homedir(), 'workspace', 'memory'),
  ];

  // Also check MEMORY.md in workspace root
  const memoryMdCandidates = [
    join(homedir(), '.openclaw', 'workspace', 'MEMORY.md'),
    join(homedir(), 'workspace', 'MEMORY.md'),
  ];

  let totalIngested = 0;

  // Seed MEMORY.md (hard invariants file) first, with higher confidence
  for (const mdPath of memoryMdCandidates) {
    if (!existsSync(mdPath)) continue;
    try {
      const content = await readFile(mdPath, 'utf-8');
      const sections = splitOnHeadings(content);
      for (const section of sections) {
        if (section.trim().length < 20) continue;
        await store.ingestMemoryFact({
          content: section.trim(),
          sourceSessionId: 'seed:MEMORY.md',
          tags: ['source:memory-file', 'source:MEMORY.md'],
          confidence: 0.9,
          decayRate: 'slow',
        });
        totalIngested++;
      }
    } catch (err) {
      api.logger.warn?.(`[plumb] Could not seed ${mdPath}: ${err}`);
    }
    break; // Use first found
  }

  // Seed daily memory files
  for (const memDir of candidates) {
    if (!existsSync(memDir)) continue;
    try {
      const files = await readdir(memDir);
      const mdFiles = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();

      for (const filename of mdFiles) {
        const date = filename.replace('.md', '');
        try {
          const content = await readFile(join(memDir, filename), 'utf-8');
          const sections = splitOnHeadings(content);
          for (const section of sections) {
            if (section.trim().length < 20) continue;
            await store.ingestMemoryFact({
              content: section.trim(),
              sourceSessionId: `seed:${filename}`,
              tags: ['source:memory-file', `date:${date}`],
              confidence: 0.85,
              decayRate: 'slow',
            });
            totalIngested++;
          }
        } catch (err) {
          api.logger.warn?.(`[plumb] Could not seed ${filename}: ${err}`);
        }
      }
    } catch (err) {
      api.logger.warn?.(`[plumb] Could not read memory dir ${memDir}: ${err}`);
    }
    break; // Use first found directory
  }

  if (totalIngested > 0) {
    api.logger.info(`[plumb] Seeded ${totalIngested} facts from existing memory files`);
  }
}

/**
 * Split markdown content on ## headings.
 * Returns one string per section (including the heading).
 * Falls back to the full content as a single chunk if no headings found.
 */
function splitOnHeadings(content: string): string[] {
  const sections = content.split(/^##\s+/m);
  if (sections.length <= 1) return [content];
  // Re-attach the ## prefix that was consumed by split
  return sections.slice(1).map((s) => `## ${s}`);
}

/**
 * Plumb OpenClaw plugin entry point.
 *
 * Injects memory context via before_prompt_build hook and provides
 * plumb_remember and plumb_search tools for agent-driven memory management.
 */
export const plugin: OpenClawPluginDefinition = {
  id: 'plumb',
  name: 'Plumb Memory',
  version: '0.1.0',
  kind: 'memory',

  activate(api: OpenClawPluginApi) {
    // FIX 1: Shared cleanup state - accessible before async setup completes
    let store: LocalStore;
    let queryServer: any;
    const dbPath = (api.pluginConfig?.dbPath as string | undefined) ?? DEFAULT_DB_PATH;
    const userId = (api.pluginConfig?.userId as string | undefined) ?? 'default';
    const shadowMode = (api.pluginConfig?.shadowMode as boolean | undefined) ?? false;

    // FIX 1: Register cleanup handlers IMMEDIATELY (synchronously) before async work
    let storeInitialized = false;
    const cleanup = async () => {
      if (!storeInitialized) {
        api.logger.debug?.('[plumb] Cleanup called but store not initialized');
        return;
      }
      try {
        if (queryServer) {
          await stopQueryServer(queryServer);
          api.logger.debug?.('[plumb] Query server stopped');
        }
        await store.stopBacklogProcessor();
        api.logger.debug?.('[plumb] Backlog processor stopped');
        store.close();
        api.logger.debug?.('[plumb] Store closed');
      } catch (e) {
        api.logger.error(`[plumb] Cleanup error: ${e}`);
      }
    };

    // Register session_end handler BEFORE async work starts (critical for graceful shutdown)
    api.on('session_end', cleanup);

    // Process-level signal handlers (critical for SIGTERM/SIGINT when systemd stops service)
    const signalHandler = () => {
      api.logger.info('[plumb] Received shutdown signal, cleaning up...');
      void cleanup();
    };
    process.on('SIGTERM', signalHandler);
    process.on('SIGINT', signalHandler);
    process.on('beforeExit', () => void cleanup());

    // Now start async setup
    void (async () => {
    try {
    api.logger.info(
      `[plumb] Activating with dbPath=${dbPath}, userId=${userId}, shadowMode=${shadowMode}`
    );

    // Ensure native SQLite binary is present (OpenClaw installs with --ignore-scripts,
    // so better-sqlite3's own install script never runs — we compensate here).
    await ensureSqliteBinary(api.logger);

    const storeOptions: Parameters<typeof LocalStore.create>[0] = {
      dbPath,
      userId,
    };
    store = await LocalStore.create(storeOptions);
    storeInitialized = true;

    // Auto-seed from existing memory files on first activation (Gap 3)
    void seedFromMemoryFiles(store, userId, api).catch((err) => {
      api.logger.warn?.(`[plumb] Memory file seeding failed: ${err}`);
    });

    // Start the backlog processor (T-087: embed drain loop only)
    store.startBacklogProcessor();
    api.logger.debug?.('[plumb] Backlog processor started');

    // Pre-warm the embedding pipeline in the background so the first
    // before_prompt_build hook doesn't time out waiting for model load.
    embedQuery('warm').catch(() => {
      api.logger.debug?.('[plumb] Embedding pipeline warm-up skipped (model unavailable)');
    });

    // Start the query server (T-110)
    const queryPort = (api.pluginConfig?.queryPort as number | undefined) ??
                      Number(process.env.PLUMB_QUERY_PORT || '18791');
    queryServer = startQueryServer(store, queryPort, api.logger);

    // Register the plumb_remember tool for agent-driven memory writes
    api.registerTool((toolCtx) => ({
      name: 'plumb_remember',
      description: 'Store a discrete fact or piece of information in Plumb memory. Use this whenever you learn something worth remembering across sessions — user preferences, decisions, important context. Write facts in plain English, one idea per call.',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'The fact or memory to store, written in plain English (e.g. "Clay prefers dark mode in all editors")'
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'How confident you are in this fact. Default: high'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional topic tags for better retrieval (e.g. ["preferences", "ui"])'
          },
          decay: {
            type: 'string',
            enum: ['slow', 'medium', 'fast'],
            description: 'How quickly this fact should decay in relevance. Use slow for stable facts, fast for ephemeral context. Default: slow'
          }
        },
        required: ['fact']
      },
      execute: async (params: { fact: string; confidence?: string; tags?: string[]; decay?: string }) => {
        const confidenceMap: Record<string, number> = {
          high: 0.95,
          medium: 0.75,
          low: 0.5,
        };
        const confidence = confidenceMap[params.confidence ?? 'high'] ?? 0.95;
        const decayRate = (params.decay ?? 'slow') as 'slow' | 'medium' | 'fast';
        const sessionId = (toolCtx as any)?.sessionId ?? 'unknown';

        try {
          const { factId } = await store.ingestMemoryFact({
            content: params.fact,
            sourceSessionId: sessionId,
            ...(params.tags !== undefined && { tags: params.tags }),
            confidence,
            decayRate,
          });
          return `Remembered: "${params.fact.slice(0, 80)}${params.fact.length > 80 ? '...' : ''}" (id: ${factId})`;
        } catch (err) {
          return `Error storing memory: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }));

    // Register the plumb_search tool for mid-reasoning RAG lookups (T-116)
    api.registerTool(() => ({
      name: 'plumb_search',
      description: 'Search Plumb memory for relevant context about a specific topic or subtopic. Use this when the initial memory context does not cover something specific you need to reason about.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find relevant memory context'
          },
          topK: {
            type: 'number',
            description: 'Number of results to return (optional, defaults to 5)'
          }
        },
        required: ['query']
      },
      execute: async (params: { query: string; topK?: number }) => {
        try {
          const response = await fetch(`http://127.0.0.1:${queryPort}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: params.query, topK: params.topK ?? 5 })
          });

          if (!response.ok) {
            return `Error: Query server returned ${response.status} ${response.statusText}`;
          }

          const data = await response.json() as {
            results?: Array<{
              content: string;
              source_session_id: string;
              source_session_label: string | null;
              created_at: string;
              tags: readonly string[] | null;
              final_score: number;
            }>;
            latencyMs?: number;
          };

          if (!data.results || data.results.length === 0) {
            return 'No relevant memory found for this query.';
          }

          // Format results as a readable string
          const lines = ['Search results from Plumb memory:', ''];
          for (const result of data.results) {
            const excerpt = result.content.slice(0, 200);
            const sessionLabel = result.source_session_label ?? result.source_session_id;
            const timestamp = new Date(result.created_at).toLocaleString();
            const tagsStr = result.tags && result.tags.length > 0 ? ` [${result.tags.join(', ')}]` : '';
            lines.push(`- [${sessionLabel}]${tagsStr} ${timestamp}:`);
            lines.push(`  "${excerpt}"`);
            lines.push('');
          }

          return lines.join('\n');
        } catch (err) {
          return `Error querying Plumb memory: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }));

    // Register the before_prompt_build hook for memory injection
    api.on('before_prompt_build', createPreResponseHook(store, shadowMode, dbPath));

    api.logger.info('[plumb] Plugin activated');
    } catch (error) {
      api.logger.error(`[plumb] Activation failed: ${error}`);
      // Ensure cleanup runs even if activation fails
      await cleanup();
    }
    })();
  },
};
