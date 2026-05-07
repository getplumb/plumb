import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface OpenClawChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

function gatewayUrl(): string {
  const raw = process.env['OPENCLAW_GATEWAY_URL'] ?? 'http://127.0.0.1:18789';
  return raw.replace(/\/$/, '');
}

function gatewayToken(): string | undefined {
  const envToken = process.env['OPENCLAW_GATEWAY_TOKEN'] || process.env['CLAWDBOT_GATEWAY_TOKEN'];
  if (envToken) return envToken;

  // Cron shell commands do not always inherit gateway auth env. For local-only
  // maintenance workflows, read the configured gateway token directly without
  // ever printing it.
  const configPath = process.env['OPENCLAW_CONFIG'] ?? join(homedir(), '.openclaw', 'openclaw.json');
  try {
    if (!existsSync(configPath)) return undefined;
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { gateway?: { auth?: { token?: unknown } } };
    return typeof parsed.gateway?.auth?.token === 'string' ? parsed.gateway.auth.token : undefined;
  } catch {
    return undefined;
  }
}

function modelOverride(): string {
  return process.env['PLUMB_DREAM_MODEL'] ?? 'openai-codex/gpt-5.5';
}

function extractText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' || typeof part.text === 'string') ? part.text ?? '' : '')
      .join('')
      .trim();
  }
  return '';
}
export async function callOpenClawChat(
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<OpenClawChatResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-openclaw-model': modelOverride(),
    'x-openclaw-message-channel': 'cron',
  };
  const token = gatewayToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const response = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'openclaw/default',
      stream: false,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenClaw chat request failed: HTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`);
  }

  const json = await response.json() as OpenAIChatResponse;
  const text = extractText(json.choices?.[0]?.message?.content);
  if (!text) throw new Error('OpenClaw chat returned empty response');

  const usage = json.usage ?? {};
  return {
    text,
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}
