import { LocalStore } from '@plumb/core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPostExchangeHook } from './hooks/post-exchange.js';
import { createPreResponseHook } from './hooks/pre-response.js';

// Define types inline since they aren't re-exported from openclaw/plugin-sdk
type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type PluginHookHandlerMap = {
  llm_output: (event: any, ctx: any) => Promise<void> | void;
  session_end: (event: any, ctx: any) => Promise<void> | void;
  before_prompt_build: (event: any, ctx: any) => Promise<any> | void;
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
 * Plumb OpenClaw plugin entry point.
 *
 * Automatically ingests every LLM exchange into the local memory store via the
 * llm_output hook. Runs fire-and-forget so it never blocks the agent pipeline.
 */
export const plugin: OpenClawPluginDefinition = {
  id: 'plumb',
  name: 'Plumb Memory',
  version: '0.1.0',
  kind: 'memory',

  async activate(api: OpenClawPluginApi) {
    const dbPath = (api.pluginConfig?.dbPath as string | undefined) ?? DEFAULT_DB_PATH;
    const userId = (api.pluginConfig?.userId as string | undefined) ?? 'default';
    const shadowMode = (api.pluginConfig?.shadowMode as boolean | undefined) ?? false;

    api.logger.info(
      `[plumb] Activating with dbPath=${dbPath}, userId=${userId}, shadowMode=${shadowMode}`
    );

    const store = new LocalStore({ dbPath, userId });

    // Register the llm_output hook for auto-ingest
    api.on('llm_output', createPostExchangeHook(store, userId));

    // Register the before_prompt_build hook for memory injection
    api.on('before_prompt_build', createPreResponseHook(store, shadowMode));

    // Clean up on session end
    api.on('session_end', async () => {
      try {
        store.close();
        api.logger.debug?.('[plumb] Store closed on session_end');
      } catch (e) {
        api.logger.debug?.(`[plumb] Error closing store: ${e}`);
      }
    });

    api.logger.info('[plumb] Plugin activated');
  },
};
