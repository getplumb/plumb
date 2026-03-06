// Stub for @getplumb/core's llm-client module.
// LLM fact extraction is disabled in this MVP release of the OpenClaw plugin.
// This stub eliminates all process.env reads and network calls from the bundle.

export async function callLLM(_prompt: string): Promise<string> {
  return '[]';
}

export async function callLLMWithConfig(_prompt: string, _config: unknown): Promise<string> {
  return '[]';
}

export async function resolveAnthropicKey(): Promise<string> {
  return '';
}

export type LLMConfig = {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
};
