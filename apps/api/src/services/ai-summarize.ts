// AI-generated session titles. Reads the org's single LLM key — the same
// row backing the in-app Chat feature (IntegrationConfig with
// provider='llm'). One key, every LLM feature. When unset, callers fall
// back to the deterministic heuristic in routes/sessions.ts.
// Fire-and-forget: a failure here never blocks the read path.

import { prisma } from '../db.js';

interface PromptForSummary {
  promptText: string | null;
  filesChanged?: string[];
}

interface SummarizeInput {
  orgId: string;
  prompts: PromptForSummary[];
  firstCommitMessage: string | null;
  filesChanged: string[];
}

const SYSTEM_PROMPT =
  'You write very short titles for software-engineering coding sessions. ' +
  'Given the user prompts and files touched, return a single label of 4–8 words ' +
  'in title case (e.g. "Refactored auth middleware", "Added per-agent badge colors"). ' +
  'Plain text only — no markdown, no quotes, no trailing punctuation.';

function buildUserPrompt(input: SummarizeInput): string {
  const lines: string[] = [];
  if (input.prompts.length > 0) {
    lines.push('User prompts (in order):');
    for (const [i, p] of input.prompts.slice(0, 5).entries()) {
      const t = (p.promptText || '').trim().slice(0, 600);
      if (t) lines.push(`${i + 1}. ${t}`);
    }
  }
  if (input.firstCommitMessage) {
    lines.push('');
    lines.push(`First commit: ${input.firstCommitMessage.slice(0, 200)}`);
  }
  if (input.filesChanged.length > 0) {
    lines.push('');
    lines.push(`Files changed: ${input.filesChanged.slice(0, 12).join(', ')}`);
  }
  lines.push('');
  lines.push('Return only the title.');
  return lines.join('\n');
}

async function callAnthropic(apiKey: string, userPrompt: string): Promise<string | null> {
  // claude-haiku-4-5 — fast, cheap, plenty for one-line titles. Pricing
  // and model availability covered by Anthropic's standard /v1/messages.
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 60,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      console.error('[ai-summarize] anthropic non-200', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json() as any;
    const text = data?.content?.[0]?.text;
    return typeof text === 'string' ? text.trim() : null;
  } catch (err: any) {
    console.error('[ai-summarize] anthropic error', err?.message);
    return null;
  }
}

async function callOpenAI(apiKey: string, userPrompt: string): Promise<string | null> {
  // gpt-4o-mini — cheap, fast, fine for one-line titles. Standard
  // /v1/chat/completions endpoint, no Responses-API gymnastics.
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 60,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      console.error('[ai-summarize] openai non-200', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json() as any;
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : null;
  } catch (err: any) {
    console.error('[ai-summarize] openai error', err?.message);
    return null;
  }
}

function sanitizeTitle(raw: string): string {
  // Strip stray quotes / markdown / trailing punctuation that the model
  // sometimes produces despite instructions.
  let t = raw.trim().split('\n')[0].trim();
  t = t.replace(/^["'`*_#>]+|["'`*_#.!?]+$/g, '').trim();
  if (t.length > 80) t = t.slice(0, 77).trimEnd() + '…';
  return t;
}

/**
 * Generate an AI title for one session, persist it on the row, and
 * return it. Returns null when the org has no LLM key configured or the
 * upstream call fails — caller should fall back to the heuristic title.
 */
export async function generateSessionTitle(sessionId: string): Promise<string | null> {
  const session = await prisma.codingSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      prompt: true,
      filesChanged: true,
      promptChanges: { select: { promptText: true, filesChanged: true }, orderBy: { promptIndex: 'asc' }, take: 5 },
      commit: { select: { message: true, repo: { select: { orgId: true } } } },
    },
  });
  if (!session) return null;

  const orgId = session.commit?.repo?.orgId;
  if (!orgId) return null;

  // Read the org's canonical LLM key (the one configured for the Chat
  // feature in Settings → Integrations). Falls back to the env-var
  // ANTHROPIC_API_KEY when the org hasn't configured one — matches the
  // behaviour of /api/settings/chat/config.
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'llm' },
  });
  let provider: string | null = null;
  let apiKey: string | null = null;
  if (config?.token) {
    apiKey = config.token;
    try {
      const settings = JSON.parse(config.settings || '{}');
      provider = settings.llmProvider || 'anthropic';
    } catch { provider = 'anthropic'; }
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
    apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (!provider || !apiKey) return null;
  // The chat config supports 'google' too but we don't yet — fall back to
  // null so the heuristic is used. Wire when we add Gemini support here.
  if (provider !== 'anthropic' && provider !== 'openai') return null;

  const prompts: PromptForSummary[] = session.promptChanges?.length
    ? session.promptChanges.map((pc) => ({
        promptText: pc.promptText,
        filesChanged: (() => { try { return JSON.parse(pc.filesChanged || '[]'); } catch { return []; } })(),
      }))
    : [{ promptText: session.prompt, filesChanged: [] }];

  let filesChanged: string[] = [];
  try { filesChanged = JSON.parse(session.filesChanged || '[]'); } catch { /* ignore */ }

  const userPrompt = buildUserPrompt({
    orgId,
    prompts,
    firstCommitMessage: session.commit?.message || null,
    filesChanged,
  });

  let title: string | null = null;
  if (provider === 'anthropic') {
    title = await callAnthropic(apiKey, userPrompt);
  } else if (provider === 'openai') {
    title = await callOpenAI(apiKey, userPrompt);
  } else {
    return null;
  }
  if (!title) return null;

  const clean = sanitizeTitle(title);
  if (!clean) return null;

  try {
    await prisma.codingSession.update({
      where: { id: sessionId },
      data: { aiTitle: clean },
    });
  } catch (err: any) {
    console.error('[ai-summarize] persist title failed', err?.message);
  }
  return clean;
}
