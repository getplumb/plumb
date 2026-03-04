#!/usr/bin/env node
/**
 * End-to-end integration test for Plumb local MVP.
 *
 * Tests the full stack: MCP server, LocalStore, plugin hooks, fact extraction,
 * retrieval, and context building. Runs standalone with no OpenClaw dependency.
 *
 * Run: npx tsx integration-test.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocalStore, buildMemoryContext, formatContextBlock } from '@plumb/core';
import { plugin } from '@plumb/openclaw-plugin';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ─── Configuration ────────────────────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/plumb-integration-test.db';
const FACT_EXTRACTION_WAIT_MS = 3000;

// ─── Test harness ─────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function recordResult(name: string, passed: boolean, error?: string): void {
  results.push({ name, passed, error });
  if (passed) {
    console.log(`✅ Test ${results.length} — ${name}`);
  } else {
    console.error(`❌ Test ${results.length} — ${name}: ${error}`);
  }
}

async function cleanup(): Promise<void> {
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // Ignore errors if file doesn't exist
  }
}

// ─── Test 1: MCP server round trip ────────────────────────────────────────────

async function test1_mcpServerRoundTrip(): Promise<void> {
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [join(process.cwd(), 'packages/mcp-server/dist/index.js')],
      env: { ...process.env, PLUMB_DB_PATH: TEST_DB_PATH },
    });

    client = new Client(
      { name: 'plumb-integration-test', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    const result = await client.callTool(
      { name: 'memory_status', arguments: {} },
      undefined,
      { timeout: 5000 }
    );

    const content = (result as any).content?.[0]?.text;
    if (!content) {
      throw new Error('No content in memory_status response');
    }

    const parsed = JSON.parse(content);
    if (typeof parsed.factCount !== 'number' || typeof parsed.rawLogCount !== 'number') {
      throw new Error(`Missing expected fields: ${JSON.stringify(parsed)}`);
    }

    recordResult('MCP server round trip', true);
  } catch (err) {
    recordResult('MCP server round trip', false, String(err));
  } finally {
    if (client) {
      await client.close();
    }
  }
}

// ─── Test 2: Ingest + raw log retrieval ───────────────────────────────────────

async function test2_ingestAndRawLogRetrieval(): Promise<void> {
  let store: LocalStore | null = null;
  try {
    store = new LocalStore({ dbPath: TEST_DB_PATH });

    await store.ingest({
      userMessage: 'Tell me about your product',
      agentResponse: 'Clay is building a product called Plumb, an AI memory system that helps agents remember context across conversations.',
      timestamp: new Date(),
      source: 'openclaw',
      sessionId: 'test-session-1',
      sessionLabel: 'integration-test',
    });

    // Wait for async fact extraction to complete
    await new Promise((resolve) => setTimeout(resolve, FACT_EXTRACTION_WAIT_MS));

    const rawResults = await store.searchRawLog('Plumb AI memory');

    if (rawResults.length === 0) {
      throw new Error('No raw log results returned');
    }

    const hasPlumb = rawResults.some((r) => r.chunk_text.includes('Plumb'));
    if (!hasPlumb) {
      throw new Error('Raw log results do not contain "Plumb"');
    }

    recordResult('Ingest + raw log retrieval', true);
  } catch (err) {
    recordResult('Ingest + raw log retrieval', false, String(err));
  } finally {
    if (store) {
      store.close();
    }
  }
}

// ─── Test 3: Fact retrieval ───────────────────────────────────────────────────

async function test3_factRetrieval(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  Test 3 — Fact retrieval: SKIPPED (ANTHROPIC_API_KEY not set)');
    recordResult('Fact retrieval', true, 'SKIPPED (no API key)');
    return;
  }

  let store: LocalStore | null = null;
  try {
    store = new LocalStore({ dbPath: TEST_DB_PATH });

    const factResults = await store.search('Plumb product');

    if (factResults.length === 0) {
      throw new Error('No facts extracted about Plumb (check ANTHROPIC_API_KEY and network)');
    }

    recordResult('Fact retrieval', true);
  } catch (err) {
    recordResult('Fact retrieval', false, String(err));
  } finally {
    if (store) {
      store.close();
    }
  }
}

// ─── Test 4: Context builder ──────────────────────────────────────────────────

async function test4_contextBuilder(): Promise<void> {
  let store: LocalStore | null = null;
  try {
    store = new LocalStore({ dbPath: TEST_DB_PATH });

    const memoryContext = await buildMemoryContext('what is Clay building', store);

    const formattedBlock = formatContextBlock(memoryContext);

    // Should have content since we ingested data in previous tests
    if (!formattedBlock || formattedBlock.trim().length === 0) {
      throw new Error('formatContextBlock returned empty string');
    }

    if (!formattedBlock.includes('[MEMORY CONTEXT]')) {
      throw new Error('formatContextBlock missing [MEMORY CONTEXT] marker');
    }

    recordResult('Context builder', true);
  } catch (err) {
    recordResult('Context builder', false, String(err));
  } finally {
    if (store) {
      store.close();
    }
  }
}

// ─── Test 5: Plugin hook wiring ───────────────────────────────────────────────

async function test5_pluginHookWiring(): Promise<void> {
  try {
    const hooks: Record<string, Function> = {};
    const mockApi = {
      id: 'plumb',
      name: 'Plumb Memory',
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      on: (name: string, handler: Function) => {
        hooks[name] = handler;
      },
      pluginConfig: { dbPath: TEST_DB_PATH },
    };

    await plugin.activate?.(mockApi as any);

    if (!hooks['llm_output']) {
      throw new Error('llm_output hook not registered');
    }

    if (!hooks['before_prompt_build']) {
      throw new Error('before_prompt_build hook not registered');
    }

    recordResult('Plugin hook wiring', true);
  } catch (err) {
    recordResult('Plugin hook wiring', false, String(err));
  }
}

// ─── Test 6: Plugin ingest hook fires ─────────────────────────────────────────

async function test6_pluginIngestHookFires(): Promise<void> {
  let store: LocalStore | null = null;
  try {
    // Clean slate for this test
    await cleanup();

    store = new LocalStore({ dbPath: TEST_DB_PATH });

    const hooks: Record<string, Function> = {};
    const mockApi = {
      id: 'plumb',
      name: 'Plumb Memory',
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      on: (name: string, handler: Function) => {
        hooks[name] = handler;
      },
      pluginConfig: { dbPath: TEST_DB_PATH },
    };

    await plugin.activate?.(mockApi as any);

    const llmOutputEvent = {
      runId: 'test-run-1',
      sessionId: 'test-session-2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      assistantTexts: ['This is a test response about Plumb memory'],
      prompt: 'Tell me about memory systems',
    };

    const ctx = {
      sessionId: 'test-session-2',
      sessionKey: 'hook-test',
    };

    // Fire the hook
    await hooks['llm_output'](llmOutputEvent, ctx);

    // Wait for async ingest
    await new Promise((resolve) => setTimeout(resolve, FACT_EXTRACTION_WAIT_MS));

    const status = await store.status();

    if (status.rawLogCount === 0) {
      throw new Error('rawLogCount is 0 after hook fired');
    }

    recordResult('Plugin ingest hook fires', true);
  } catch (err) {
    recordResult('Plugin ingest hook fires', false, String(err));
  } finally {
    if (store) {
      store.close();
    }
  }
}

// ─── Test 7: Plugin injection hook returns memory ─────────────────────────────

async function test7_pluginInjectionHookReturnsMemory(): Promise<void> {
  let store: LocalStore | null = null;
  try {
    store = new LocalStore({ dbPath: TEST_DB_PATH });

    // Ensure we have data from previous test
    const status = await store.status();
    if (status.rawLogCount === 0) {
      throw new Error('No raw log data (Test 6 may have failed)');
    }

    const hooks: Record<string, Function> = {};
    const mockApi = {
      id: 'plumb',
      name: 'Plumb Memory',
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      on: (name: string, handler: Function) => {
        hooks[name] = handler;
      },
      pluginConfig: { dbPath: TEST_DB_PATH },
    };

    await plugin.activate?.(mockApi as any);

    const beforePromptEvent = {
      prompt: 'what is memory',
      messages: [],
    };

    const ctx = {
      sessionId: 'test-session-3',
    };

    const result = await hooks['before_prompt_build'](beforePromptEvent, ctx);

    if (!result || typeof result !== 'object') {
      throw new Error('before_prompt_build hook did not return an object');
    }

    if (!result.prependContext) {
      throw new Error('before_prompt_build hook did not return prependContext field');
    }

    if (!result.prependContext.includes('[PLUMB MEMORY]')) {
      throw new Error('prependContext does not contain [PLUMB MEMORY] marker');
    }

    recordResult('Plugin injection hook returns memory', true);
  } catch (err) {
    recordResult('Plugin injection hook returns memory', false, String(err));
  } finally {
    if (store) {
      store.close();
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting Plumb local MVP integration tests...\n');

  // Clean up any existing test DB
  await cleanup();

  // Run all tests sequentially
  await test1_mcpServerRoundTrip();
  await test2_ingestAndRawLogRetrieval();
  await test3_factRetrieval();
  await test4_contextBuilder();
  await test5_pluginHookWiring();
  await test6_pluginIngestHookFires();
  await test7_pluginInjectionHookReturnsMemory();

  // Clean up test DB
  await cleanup();

  // Print summary
  console.log('\n─────────────────────────────────────────────────');
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`PASSED ${passed}/${total} tests`);

  if (passed < total) {
    console.log('\nFailed tests:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  cleanup().finally(() => process.exit(1));
});
