import { Router, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { getDocsContext, getOrgContext } from '../services/chat-context.js';
import { getOrgLLMKey, getOrgLLMModel } from './settings.js';

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
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Helper: call Claude and extract text response
// ---------------------------------------------------------------------------

export async function callClaude(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 1024,
  opts?: { apiKey?: string; model?: string },
): Promise<string> {
  const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('AI chat is not configured');
  }

  const model = opts?.model || 'claude-sonnet-4-20250514';
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

router.post('/assistant', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
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
    const [orgKey, orgModel] = await Promise.all([
      getOrgLLMKey(orgId),
      getOrgLLMModel(orgId),
    ]);

    const responseText = await callClaude(systemPrompt, trimmedMessages, 2048, {
      apiKey: orgKey || undefined,
      model: orgModel,
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
