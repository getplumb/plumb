import OpenAI from 'openai';

/**
 * Default models per provider
 * Recommended: google/gemini-2.5-flash-lite (extremely cheap and fast)
 */
const DEFAULT_MODELS: Record<string, string> = {
  google: 'gemini-2.5-flash-lite',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  ollama: 'llama3.1',
  'openai-compatible': 'gpt-4o-mini',
};

/**
 * LLM configuration that can be passed directly instead of relying on environment variables.
 * When provided, these values take precedence over env vars.
 */
export interface LLMConfig {
  /** Provider: 'google' (recommended) | 'openai' | 'anthropic' | 'ollama' | 'openai-compatible'. Defaults to 'openai'. */
  provider?: string;
  /** Model ID. Defaults to provider-specific default. */
  model?: string;
  /** API key. Takes precedence over env var for the given provider. */
  apiKey?: string;
  /** Base URL for 'openai-compatible' or 'ollama' providers. */
  baseUrl?: string;
}

/**
 * Resolve the OpenAI API key from environment variables.
 * Returns the key if found, otherwise throws a clear error.
 *
 * Set OPENAI_API_KEY in your environment before using Plumb with the OpenAI provider.
 *
 * @throws Error if no key is found
 */
export function resolveOpenAIKey(): string {
  const envKey = process.env['OPENAI_API_KEY'];
  if (envKey) return envKey;

  throw new Error(
    'Plumb fact extraction requires OPENAI_API_KEY. ' +
    'Set the OPENAI_API_KEY environment variable and try again.'
  );
}

/**
 * Resolve the Anthropic API key from environment variables.
 * Returns the key if found, otherwise throws a clear error.
 *
 * Set ANTHROPIC_API_KEY in your environment before using Plumb with the Anthropic provider.
 *
 * @throws Error if no key is found
 */
export function resolveAnthropicKey(): string {
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey) return envKey;

  throw new Error(
    'Plumb fact extraction requires ANTHROPIC_API_KEY. ' +
    'Set the ANTHROPIC_API_KEY environment variable and try again.'
  );
}

/**
 * Resolve the Gemini API key from environment variables.
 * Returns the key if found, otherwise throws a clear error.
 *
 * Set GEMINI_API_KEY in your environment before using Plumb with the Google provider.
 *
 * @throws Error if no key is found
 */
export function resolveGeminiKey(): string {
  const envKey = process.env['GEMINI_API_KEY'];
  if (envKey) return envKey;

  throw new Error(
    'Plumb fact extraction requires GEMINI_API_KEY. ' +
    'Set the GEMINI_API_KEY environment variable and try again.'
  );
}

/**
 * Calls the configured LLM with the given prompt and returns the text response.
 * Provider and model are configurable via env:
 *   PLUMB_LLM_PROVIDER — 'openai' (default), 'anthropic', 'ollama', 'openai-compatible', 'google'
 *   PLUMB_LLM_MODEL    — model ID, defaults vary per provider
 *   PLUMB_LLM_BASE_URL — for 'openai-compatible' provider
 *   OLLAMA_HOST        — for 'ollama' provider (default: http://localhost:11434/v1)
 */
export async function callLLM(prompt: string): Promise<string> {
  const provider = process.env['PLUMB_LLM_PROVIDER'] ?? 'openai';
  const model = process.env['PLUMB_LLM_MODEL'] ?? DEFAULT_MODELS[provider] ?? 'gpt-4o-mini';

  if (provider === 'openai') {
    const apiKey = resolveOpenAIKey();
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'anthropic') {
    // Dynamic import to handle optional dependency
    let Anthropic: typeof import('@anthropic-ai/sdk').default;
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    } catch {
      throw new Error(
        'Anthropic provider requires @anthropic-ai/sdk. Install it with: npm install @anthropic-ai/sdk'
      );
    }

    const apiKey = resolveAnthropicKey();
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    if (block === undefined || block.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic LLM');
    }
    return block.text;
  }

  if (provider === 'ollama') {
    // Ollama provides an OpenAI-compatible API
    const baseURL = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434/v1';
    const client = new OpenAI({
      baseURL,
      apiKey: 'ollama', // Required by openai package but ignored by Ollama
    });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'google') {
    // Google Gemini via OpenAI-compatible endpoint
    const apiKey = resolveGeminiKey();
    const client = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey,
    });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'openai-compatible') {
    const baseURL = process.env['PLUMB_LLM_BASE_URL'];
    if (!baseURL) {
      throw new Error(
        'PLUMB_LLM_BASE_URL is required for openai-compatible provider. ' +
        'Example: export PLUMB_LLM_BASE_URL=https://api.together.xyz/v1'
      );
    }
    const apiKey = resolveOpenAIKey();
    const client = new OpenAI({ baseURL, apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  throw new Error(
    `Unsupported PLUMB_LLM_PROVIDER: ${provider}. Supported: openai, anthropic, ollama, google, openai-compatible`
  );
}

/**
 * Calls the LLM using explicitly provided config rather than environment variables.
 * Falls back to env vars for any values not provided in config.
 *
 * Use this when you want to pass LLM credentials programmatically (e.g. from plugin config)
 * without mutating process.env.
 */
export async function callLLMWithConfig(prompt: string, config: LLMConfig): Promise<string> {
  const provider = config.provider ?? process.env['PLUMB_LLM_PROVIDER'] ?? 'openai';
  const model = config.model ?? process.env['PLUMB_LLM_MODEL'] ?? DEFAULT_MODELS[provider] ?? 'gpt-4o-mini';

  if (provider === 'openai') {
    const apiKey = config.apiKey ?? resolveOpenAIKey();
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'anthropic') {
    let Anthropic: typeof import('@anthropic-ai/sdk').default;
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    } catch {
      throw new Error(
        'Anthropic provider requires @anthropic-ai/sdk. Install it with: npm install @anthropic-ai/sdk'
      );
    }
    const apiKey = config.apiKey ?? resolveAnthropicKey();
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    if (block === undefined || block.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic LLM');
    }
    return block.text;
  }

  if (provider === 'ollama') {
    const baseURL = config.baseUrl ?? process.env['OLLAMA_HOST'] ?? 'http://localhost:11434/v1';
    const client = new OpenAI({ baseURL, apiKey: 'ollama' });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'google') {
    const apiKey = config.apiKey ?? resolveGeminiKey();
    const client = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey,
    });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  if (provider === 'openai-compatible') {
    const baseURL = config.baseUrl ?? process.env['PLUMB_LLM_BASE_URL'];
    if (!baseURL) {
      throw new Error(
        'PLUMB_LLM_BASE_URL is required for openai-compatible provider. ' +
        'Example: export PLUMB_LLM_BASE_URL=https://api.together.xyz/v1'
      );
    }
    const apiKey = config.apiKey ?? resolveOpenAIKey();
    const client = new OpenAI({ baseURL, apiKey });
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  throw new Error(
    `Unsupported provider: ${provider}. Supported: openai, anthropic, ollama, google, openai-compatible`
  );
}
