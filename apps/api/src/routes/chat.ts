import { Router, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { getDocsContext, getOrgContext } from '../services/chat-context.js';
import { getOrgLLMKey, getOrgLLMModel, getOrgLLMProvider } from './settings.js';

const router = Router();

// ---------------------------------------------------------------------------
// Rate Limiting (in-memory, per IP, for public docs chat)
// ---------------------------------------------------------------------------

const chatLimits = new Map<string, { count: number; resetAt: number }>();
const MAX_CHAT_PER_WINDOW = 10;
const CHAT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkPublicRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = chatLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    chatLimits.set(ip, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_CHAT_PER_WINDOW) return false;
  entry.count++;
  return true;
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of chatLimits) {
    if (now > entry.resetAt) chatLimits.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Provider detection: figure out which provider a model belongs to
// ---------------------------------------------------------------------------

export type LLMProvider = 'anthropic' | 'openai' | 'google';

export function detectProvider(model: string): LLMProvider {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini-')) return 'google';
  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Helper: call LLM (multi-provider) and extract text response
// ---------------------------------------------------------------------------

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');
}

// Hard timeout for outbound LLM calls. Without this, a slow/misbehaving
// upstream (OpenAI, Google, etc.) can pin a request thread indefinitely,
// which is how "one flaky model endpoint" turns into "the whole API is
// hung". 60s is generous enough for long-form generations at maxTokens
// limits while still bounding worst-case latency.
const LLM_FETCH_TIMEOUT_MS = 60_000;
function llmFetchSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), LLM_FETCH_TIMEOUT_MS).unref();
  return controller.signal;
}

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
    signal: llmFetchSignal(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGoogle(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<string> {
  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal: llmFetchSignal(),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export async function callLLM(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 1024,
  opts?: { apiKey?: string; model?: string; provider?: LLMProvider },
): Promise<string> {
  const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('AI chat is not configured');
  }

  const model = opts?.model || 'claude-sonnet-4-20250514';
  const provider = opts?.provider || detectProvider(model);

  switch (provider) {
    case 'openai':
      return callOpenAI(apiKey, model, systemPrompt, messages, maxTokens);
    case 'google':
      return callGoogle(apiKey, model, systemPrompt, messages, maxTokens);
    case 'anthropic':
    default:
      return callAnthropic(apiKey, model, systemPrompt, messages, maxTokens);
  }
}

/** @deprecated Use callLLM instead. Kept for backward compatibility. */
export const callClaude = callLLM;

// ---------------------------------------------------------------------------
// POST /docs — Public docs chatbot (rate-limited, no auth required)
// ---------------------------------------------------------------------------

const DOCS_SYSTEM_PROMPT = `You are the Origin documentation assistant. You help users understand and set up the Origin AI Agent Governance Platform.

You have access to the complete Origin documentation below. Use it to answer questions accurately. Be concise and helpful. Format responses in markdown when useful (use code blocks for CLI commands, config examples, etc.).

If asked about something not covered in the docs, say so honestly rather than guessing.

`;

router.post('/docs', async (req: AuthRequest, res: Response) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkPublicRateLimit(ip)) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Try again in a few minutes.',
      });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // Trim to last 10 messages for public endpoint
    const trimmedMessages = messages.slice(-10);

    const docsContext = getDocsContext();
    const systemPrompt = DOCS_SYSTEM_PROMPT + docsContext;

    const responseText = await callClaude(systemPrompt, trimmedMessages, 1024);
    return res.json({ message: responseText });
  } catch (err: any) {
    console.error('[chat/docs] Error:', err.message);
    if (err.message === 'AI chat is not configured') {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Failed to generate response' });
  }
});

// ---------------------------------------------------------------------------
// POST /assistant — Authenticated in-app assistant
// ---------------------------------------------------------------------------

const ASSISTANT_SYSTEM_PROMPT = `You are the Origin AI Assistant, embedded inside the Origin governance platform dashboard.

You have access to the user's organization context below. Use it to answer questions about their sessions, policies, agents, costs, and help them write policies or understand flagged sessions.

You can help with:
- Writing governance policies (e.g., "block access to .env files", "require review for sessions over $5")
- Understanding why sessions were flagged or rejected
- Analyzing session costs, token usage, and trends
- Explaining audit log entries
- Suggesting policy improvements based on their current setup
- Answering platform questions

When helping write policies, provide the exact JSON condition format they need. Reference actual data from their org when relevant.

Be concise, specific, and actionable. Format responses in markdown when helpful.

`;

const assistantLimits = new Map<string, { count: number; resetAt: number }>();
const MAX_ASSISTANT_PER_WINDOW = 10;
const ASSISTANT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkAssistantRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = assistantLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    assistantLimits.set(userId, { count: 1, resetAt: now + ASSISTANT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ASSISTANT_PER_WINDOW) return false;
  entry.count++;
  return true;
}

// Clean up stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of assistantLimits) {
    if (now > entry.resetAt) assistantLimits.delete(key);
  }
}, 30 * 60 * 1000).unref();

router.post('/assistant', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    if (!checkAssistantRateLimit(userId)) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Try again in a few minutes.',
      });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const orgId = req.user!.orgId;
    // Allow longer conversations for authenticated users
    const trimmedMessages = messages.slice(-20);

    const orgContext = await getOrgContext(orgId);
    const systemPrompt = ASSISTANT_SYSTEM_PROMPT + orgContext;

    // Use org-level LLM config if available, fall back to env var
    const [orgKey, orgModel, orgProvider] = await Promise.all([
      getOrgLLMKey(orgId),
      getOrgLLMModel(orgId),
      getOrgLLMProvider(orgId),
    ]);

    const responseText = await callLLM(systemPrompt, trimmedMessages, 2048, {
      apiKey: orgKey || undefined,
      model: orgModel,
      provider: orgProvider,
    });
    return res.json({ message: responseText });
  } catch (err: any) {
    console.error('[chat/assistant] Error:', err.message);
    if (err.message === 'AI chat is not configured') {
      return res.status(503).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Failed to generate response' });
  }
});

export default router;
