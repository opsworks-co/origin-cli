import { loadConfig } from './config.js';

/**
 * Shared LLM utility for CLI features that need AI calls.
 * Uses ANTHROPIC_API_KEY env var or origin config.
 */

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function getAnthropicKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const config = loadConfig();
  if (config && (config as any).anthropicApiKey) return (config as any).anthropicApiKey;
  return null;
}

export async function callLLM(
  system: string,
  messages: LLMMessage[],
  opts?: { maxTokens?: number; model?: string },
): Promise<string> {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    throw new Error('No Anthropic API key. Set ANTHROPIC_API_KEY or run `origin config set anthropicApiKey <key>`.');
  }

  const body = {
    model: opts?.model || 'claude-sonnet-4-20250514',
    max_tokens: opts?.maxTokens || 1024,
    system,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  return data.content?.[0]?.text || '(no response)';
}
