import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Calls the configured LLM with the given prompt and returns the text response.
 * Provider and model are configurable via env:
 *   PLUMB_LLM_PROVIDER — 'anthropic' (default, only supported value now)
 *   PLUMB_LLM_MODEL    — model ID, default: claude-haiku-4-5-20251001
 */
export async function callLLM(prompt: string): Promise<string> {
  const provider = process.env['PLUMB_LLM_PROVIDER'] ?? 'anthropic';
  const model = process.env['PLUMB_LLM_MODEL'] ?? DEFAULT_MODEL;

  if (provider === 'anthropic') {
    const client = new Anthropic();
    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = message.content[0];
    if (block === undefined || block.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic LLM');
    }
    return block.text;
  }

  throw new Error(`Unsupported PLUMB_LLM_PROVIDER: ${provider}. Only 'anthropic' is supported.`);
}
