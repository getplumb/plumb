import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default models per provider
 */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  ollama: 'llama3.1',
  'openai-compatible': 'gpt-4o-mini',
};

/**
 * Resolve the OpenAI API key from environment or OpenClaw auth-profiles.json.
 * Returns the key if found, otherwise throws a clear error.
 *
 * Resolution order:
 * 1. OPENAI_API_KEY environment variable
 * 2. ~/.openclaw/agents/main/agent/auth-profiles.json (profiles['openai:default'].key)
 *
 * @throws Error if no key is found in either location
 */
export function resolveOpenAIKey(): string {
  // 1. Try environment variable first
  const envKey = process.env['OPENAI_API_KEY'];
  if (envKey) return envKey;

  // 2. Try OpenClaw auth-profiles.json
  try {
    const authProfilesPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    const fileContent = readFileSync(authProfilesPath, 'utf-8');
    const data = JSON.parse(fileContent);

    // Navigate to profiles['openai:default'].key
    const key = data?.profiles?.['openai:default']?.key;
    if (typeof key === 'string' && key.startsWith('sk-')) {
      return key;
    }
  } catch {
    // Silent fallthrough — file doesn't exist or parse failed
  }

  // 3. Neither source provided a key — throw clear error
  throw new Error(
    'Plumb fact extraction requires OPENAI_API_KEY or an OpenClaw agent with an OpenAI key configured. ' +
    'Set OPENAI_API_KEY environment variable or configure OpenClaw with an OpenAI API key.'
  );
}

/**
 * Resolve the Anthropic API key from environment or OpenClaw auth-profiles.json.
 * Returns the key if found, otherwise throws a clear error.
 *
 * Resolution order:
 * 1. ANTHROPIC_API_KEY environment variable
 * 2. ~/.openclaw/agents/main/agent/auth-profiles.json (profiles['anthropic:default'].key)
 *
 * @throws Error if no key is found in either location
 */
export function resolveAnthropicKey(): string {
  // 1. Try environment variable first
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey) return envKey;

  // 2. Try OpenClaw auth-profiles.json
  try {
    const authProfilesPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    const fileContent = readFileSync(authProfilesPath, 'utf-8');
    const data = JSON.parse(fileContent);

    // Navigate to profiles['anthropic:default'].key
    const key = data?.profiles?.['anthropic:default']?.key;
    if (typeof key === 'string' && key.startsWith('sk-ant-')) {
      return key;
    }
  } catch {
    // Silent fallthrough — file doesn't exist or parse failed
  }

  // 3. Neither source provided a key — throw clear error
  throw new Error(
    'Plumb fact extraction requires ANTHROPIC_API_KEY or an OpenClaw agent with an Anthropic key configured. ' +
    'Set ANTHROPIC_API_KEY environment variable or configure OpenClaw with an Anthropic API key.'
  );
}

/**
 * Calls the configured LLM with the given prompt and returns the text response.
 * Provider and model are configurable via env:
 *   PLUMB_LLM_PROVIDER — 'openai' (default), 'anthropic', 'ollama', 'openai-compatible'
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
    } catch (error) {
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
    `Unsupported PLUMB_LLM_PROVIDER: ${provider}. Supported: openai, anthropic, ollama, openai-compatible`
  );
}
