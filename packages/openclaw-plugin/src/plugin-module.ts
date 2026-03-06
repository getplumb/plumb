import {
  LocalStore,
  ExtractionQueue,
  embedQuery,
  extractFacts,
  callLLMWithConfig,
  type LLMConfig
} from '@getplumb/core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPostExchangeHook } from './hooks/post-exchange.js';
import { createPreResponseHook } from './hooks/pre-response.js';
import { NudgeManager } from './nudge.js';
import { readPlumbConfig, checkConfigPermissions } from './plumb-config.js';

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

  activate(api: OpenClawPluginApi) {
    void (async () => {
    const dbPath = (api.pluginConfig?.dbPath as string | undefined) ?? DEFAULT_DB_PATH;
    const userId = (api.pluginConfig?.userId as string | undefined) ?? 'default';
    const shadowMode = (api.pluginConfig?.shadowMode as boolean | undefined) ?? false;
    api.logger.info(
      `[plumb] Activating with dbPath=${dbPath}, userId=${userId}, shadowMode=${shadowMode}`
    );

    // Fact extraction is opt-in via ~/.plumb/config.json
    // Read the config to determine if fact extraction should be enabled
    const plumbConfig = await readPlumbConfig();
    await checkConfigPermissions();

    let extractionQueue: ExtractionQueue;
    let store: LocalStore;

    if (plumbConfig) {
      // Config found — enable fact extraction with real LLM calls
      const llmConfig: LLMConfig = {
        provider: plumbConfig.llmProvider,
        apiKey: plumbConfig.llmApiKey,
      };

      // Only set optional properties if they have values (exactOptionalPropertyTypes requirement)
      if (plumbConfig.llmModel) {
        llmConfig.model = plumbConfig.llmModel;
      }

      if (plumbConfig.llmBaseUrl) {
        llmConfig.baseUrl = plumbConfig.llmBaseUrl;
      }

      // Create an extraction function that calls extractFacts with the LLM config
      // The closure captures 'store' by reference; it will be assigned before the queue starts
      const extractFn = async (exchange: any, userId: string) => {
        const llmFn = (prompt: string) => callLLMWithConfig(prompt, llmConfig);
        return extractFacts(exchange, userId, store, llmFn);
      };

      extractionQueue = new ExtractionQueue(extractFn);

      const modelDisplay = plumbConfig.llmModel ?? 'default';
      api.logger.info(
        `[plumb] Fact extraction enabled (provider: ${plumbConfig.llmProvider}, model: ${modelDisplay})`
      );
      api.logger.info(
        '[plumb] Security note: Ensure ~/.plumb/config.json is chmod 0600 to protect your API key'
      );
    } else {
      // No config found — use no-op queue (zero network calls, zero env var reads)
      extractionQueue = new ExtractionQueue(async (_exchange, _userId) => []);
      api.logger.info(
        '[plumb] Fact extraction disabled -- create ~/.plumb/config.json to enable. Example: {"llmProvider":"google","llmModel":"gemini-2.0-flash","llmApiKey":"YOUR_KEY"}'
      );
    }

    const storeOptions: Parameters<typeof LocalStore.create>[0] = {
      dbPath,
      userId,
      extractionQueue,
    };
    if (plumbConfig) {
      storeOptions.llmConfig = {
        provider: plumbConfig.llmProvider,
        apiKey: plumbConfig.llmApiKey,
        ...(plumbConfig.llmModel ? { model: plumbConfig.llmModel } : {}),
        ...(plumbConfig.llmBaseUrl ? { baseUrl: plumbConfig.llmBaseUrl } : {}),
      };
    }
    store = await LocalStore.create(storeOptions);
    const nudgeManager = new NudgeManager();

    // Start the extraction queue background drain loop (T-071)
    store.extractionQueue.start();
    api.logger.debug?.('[plumb] Extraction queue started');

    // Start the backlog processor (T-087)
    store.startBacklogProcessor();
    api.logger.debug?.('[plumb] Backlog processor started');

    // Pre-warm the embedding pipeline in the background so the first
    // before_prompt_build hook doesn't time out waiting for model load.
    embedQuery('warm').catch(() => {
      api.logger.debug?.('[plumb] Embedding pipeline warm-up skipped (model unavailable)');
    });

    // Shared state map for threading user prompts from before_prompt_build to llm_output
    // Key: sessionId, Value: user message prompt
    const pendingPrompts = new Map<string, string>();

    // Register the llm_output hook for auto-ingest
    api.on('llm_output', createPostExchangeHook(store, userId, pendingPrompts, dbPath));

    // Register the before_prompt_build hook for memory injection
    api.on('before_prompt_build', createPreResponseHook(store, nudgeManager, shadowMode, pendingPrompts));

    // Clean up on session end — stop queue and flush before closing store
    api.on('session_end', async () => {
      try {
        await store.extractionQueue.stop();
        api.logger.debug?.('[plumb] Extraction queue stopped and flushed on session_end');
        await store.stopBacklogProcessor();
        api.logger.debug?.('[plumb] Backlog processor stopped on session_end');
        store.close();
        api.logger.debug?.('[plumb] Store closed on session_end');
      } catch (e) {
        api.logger.debug?.(`[plumb] Error during session_end cleanup: ${e}`);
      }
    });

    // Safety net: flush queue on process exit
    const exitHandler = async () => {
      try {
        await store.extractionQueue.stop();
        api.logger.debug?.('[plumb] Extraction queue stopped on process exit');
        await store.stopBacklogProcessor();
        api.logger.debug?.('[plumb] Backlog processor stopped on process exit');
      } catch (e) {
        api.logger.debug?.(`[plumb] Error stopping queue on exit: ${e}`);
      }
    };

    process.on('exit', () => {
      // Note: process 'exit' is synchronous and cannot await promises.
      // This is a best-effort attempt. The session_end hook is the primary cleanup path.
      void exitHandler();
    });

    api.logger.info('[plumb] Plugin activated');
    })();
  },
};
