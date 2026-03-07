import { readFile, access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Plumb LLM configuration schema.
 * Read from ~/.plumb/config.json at plugin activation time.
 */
export interface PlumbLLMConfig {
  /** LLM provider: 'google' (recommended), 'openai', 'anthropic', 'ollama', 'openai-compatible' */
  llmProvider: 'openai' | 'anthropic' | 'ollama' | 'openai-compatible' | 'google';
  /** LLM model ID. Optional — defaults vary by provider. Recommended: 'gemini-2.5-flash-lite' for google. */
  llmModel?: string;
  /** API key for the LLM provider. Required. Never logged. */
  llmApiKey: string;
  /** Base URL for openai-compatible or ollama providers. Optional. */
  llmBaseUrl?: string;
}

/**
 * Default model IDs per provider.
 * Matches the core package defaults in llm-client.ts.
 * Recommended: google/gemini-2.5-flash-lite (extremely cheap and fast).
 */
const DEFAULT_MODELS: Record<string, string> = {
  google: 'gemini-2.5-flash-lite',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  ollama: 'llama3.1',
  'openai-compatible': 'gpt-4o-mini',
};

const CONFIG_PATH = join(homedir(), '.plumb', 'config.json');

/**
 * Read and validate ~/.plumb/config.json.
 * Returns null if the file is missing or invalid.
 * Logs warnings for invalid config but never throws.
 */
export async function readPlumbConfig(): Promise<PlumbLLMConfig | null> {
  try {
    const content = await readFile(CONFIG_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[plumb] Invalid config: expected JSON object');
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate required fields
    if (typeof obj.llmProvider !== 'string' || !obj.llmProvider) {
      console.warn('[plumb] Invalid config: llmProvider is required (string)');
      return null;
    }

    if (typeof obj.llmApiKey !== 'string' || !obj.llmApiKey) {
      console.warn('[plumb] Invalid config: llmApiKey is required (string)');
      return null;
    }

    // Validate provider is one of the supported values
    const validProviders = ['openai', 'anthropic', 'ollama', 'openai-compatible', 'google'];
    if (!validProviders.includes(obj.llmProvider)) {
      console.warn(
        `[plumb] Invalid config: llmProvider must be one of ${validProviders.join(', ')}`
      );
      return null;
    }

    const provider = obj.llmProvider as PlumbLLMConfig['llmProvider'];
    const model = typeof obj.llmModel === 'string' ? obj.llmModel : (DEFAULT_MODELS[provider] ?? 'gpt-4o-mini');

    const config: PlumbLLMConfig = {
      llmProvider: provider,
      llmModel: model,
      llmApiKey: obj.llmApiKey,
    };

    if (typeof obj.llmBaseUrl === 'string') {
      config.llmBaseUrl = obj.llmBaseUrl;
    }

    return config;
  } catch (err) {
    // File doesn't exist or can't be read — this is expected for users who haven't set up fact extraction
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    // Other errors (parse errors, permission errors) should be logged but not crash the plugin
    console.warn(`[plumb] Error reading config from ${CONFIG_PATH}:`, err);
    return null;
  }
}

/**
 * Check if the config file exists and warn if it's world-readable.
 * Does not throw — returns silently if file doesn't exist or can't be accessed.
 *
 * NOTE: File permission enforcement is not implemented — this is a best-effort warning only.
 * Users should manually run: chmod 0600 ~/.plumb/config.json
 */
export async function checkConfigPermissions(): Promise<void> {
  try {
    await access(CONFIG_PATH, constants.R_OK);

    // Note: Checking file permissions (mode & 0o077) requires fs.stat() which may not be
    // portable across all platforms. For now, we document the requirement in the activation log.
    // Future enhancement: add platform-specific permission checks.
  } catch {
    // File doesn't exist or can't be accessed — nothing to warn about
  }
}
