import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readPlumbConfig } from './plumb-config.js';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.plumb', 'config.json');
const CONFIG_DIR = join(homedir(), '.plumb');

// Save original console.warn to restore after tests
const originalWarn = console.warn;
let warnCalls: string[] = [];

describe('readPlumbConfig', () => {
  beforeEach(async () => {
    // Capture console.warn calls
    warnCalls = [];
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(' '));
    };

    // Ensure config directory exists
    await mkdir(CONFIG_DIR, { recursive: true });

    // Clean up any existing test config
    try {
      await unlink(CONFIG_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  afterEach(async () => {
    // Restore console.warn
    console.warn = originalWarn;

    // Clean up test config file
    try {
      await unlink(CONFIG_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  it('returns null when config file does not exist', async () => {
    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  it('returns valid config when file contains valid openai config', async () => {
    const testConfig = {
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'sk-test-key-12345',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toEqual({
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'sk-test-key-12345',
      llmBaseUrl: undefined,
    });
    expect(warnCalls).toHaveLength(0);
  });

  it('returns valid config when file contains valid anthropic config', async () => {
    const testConfig = {
      llmProvider: 'anthropic',
      llmApiKey: 'sk-ant-test-key',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toEqual({
      llmProvider: 'anthropic',
      llmModel: 'claude-haiku-4-5-20251001',
      llmApiKey: 'sk-ant-test-key',
      llmBaseUrl: undefined,
    });
    expect(warnCalls).toHaveLength(0);
  });

  it('uses default model when llmModel is not provided', async () => {
    const testConfig = {
      llmProvider: 'openai',
      llmApiKey: 'sk-test-key',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config?.llmModel).toBe('gpt-4o-mini');
  });

  it('returns valid config with llmBaseUrl for openai-compatible provider', async () => {
    const testConfig = {
      llmProvider: 'openai-compatible',
      llmApiKey: 'test-key',
      llmBaseUrl: 'https://api.together.xyz/v1',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toEqual({
      llmProvider: 'openai-compatible',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'test-key',
      llmBaseUrl: 'https://api.together.xyz/v1',
    });
  });

  it('returns null and warns when config is not a JSON object', async () => {
    await writeFile(CONFIG_PATH, '["array"]', 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls.some(w => w.includes('expected JSON object'))).toBe(true);
  });

  it('returns null and warns when llmProvider is missing', async () => {
    const testConfig = {
      llmApiKey: 'sk-test-key',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls.some(w => w.includes('llmProvider is required'))).toBe(true);
  });

  it('returns null and warns when llmApiKey is missing', async () => {
    const testConfig = {
      llmProvider: 'openai',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls.some(w => w.includes('llmApiKey is required'))).toBe(true);
  });

  it('returns null and warns when llmProvider is invalid', async () => {
    const testConfig = {
      llmProvider: 'invalid-provider',
      llmApiKey: 'sk-test-key',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls.some(w => w.includes('must be one of'))).toBe(true);
  });

  it('returns null and warns when JSON is malformed', async () => {
    await writeFile(CONFIG_PATH, '{invalid json', 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toBeNull();
    expect(warnCalls.some(w => w.includes('Error reading config'))).toBe(true);
  });

  it('supports all valid provider types', async () => {
    const providers = ['openai', 'anthropic', 'ollama', 'openai-compatible'];

    for (const provider of providers) {
      const testConfig = {
        llmProvider: provider,
        llmApiKey: 'test-key',
      };

      await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

      const config = await readPlumbConfig();
      expect(config?.llmProvider).toBe(provider);

      // Clean up for next iteration
      await unlink(CONFIG_PATH);
    }
  });

  it('handles llmModel override correctly', async () => {
    const testConfig = {
      llmProvider: 'openai',
      llmModel: 'gpt-4',
      llmApiKey: 'sk-test-key',
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config?.llmModel).toBe('gpt-4');
  });

  it('ignores extra fields in config', async () => {
    const testConfig = {
      llmProvider: 'openai',
      llmApiKey: 'sk-test-key',
      extraField: 'should-be-ignored',
      anotherField: 123,
    };

    await writeFile(CONFIG_PATH, JSON.stringify(testConfig), 'utf-8');

    const config = await readPlumbConfig();
    expect(config).toEqual({
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'sk-test-key',
      llmBaseUrl: undefined,
    });
  });
});
