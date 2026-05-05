// Today's brief — LLM-generated narrative summary of an org's AI session
// activity for the current calendar day. Powers the "What did AI write
// today?" banner on the dashboards.
//
// Caches per-org for 1h in-memory so the banner doesn't pay the LLM round
// trip on every page load — a fresh result is regenerated lazily the next
// time someone hits the endpoint after the TTL.

import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';
import { callLLM } from './chat.js';
import { getOrgLLMKey, getOrgLLMModel, getOrgLLMProvider } from './settings.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

interface BriefSection {
  title: string;
  bullets: string[];
}

interface Brief {
  headline: string;
  sections: BriefSection[];
}

interface CacheEntry {
  brief: Brief;
  generatedAt: number;
  sessionCount: number;
  totalCost: number;
  // Hash of the underlying session set so we invalidate when sessions land
  // mid-window — without this, a brief generated at 9am stays through new
  // 10am sessions until the 1h TTL expires, which feels stale to anyone
  // refreshing the page after just shipping work.
  fingerprint: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const briefCache = new Map<string, CacheEntry>();

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const since = startOfTodayUtc();

    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId } },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        model: true,
        agent: { select: { name: true, slug: true } },
        costUsd: true,
        tokensUsed: true,
        linesAdded: true,
        linesRemoved: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
        commit: {
          select: {
            message: true,
            repo: { select: { id: true, name: true, path: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const sessionCount = sessions.length;
    const totalCost = sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0);
    const totalTokens = sessions.reduce((sum, s) => sum + (s.tokensUsed || 0), 0);
    const totalLinesAdded = sessions.reduce((sum, s) => sum + (s.linesAdded || 0), 0);
    const totalLinesRemoved = sessions.reduce((sum, s) => sum + (s.linesRemoved || 0), 0);

    // Fingerprint = session ids in order. Cheap and changes the moment
    // a new session lands.
    const fingerprint = sessions.map((s) => s.id).join(',');

    if (sessionCount === 0) {
      return res.json({
        brief: null,
        generatedAt: new Date().toISOString(),
        fromCache: false,
        sessionCount: 0,
        totalCost: 0,
      });
    }

    const cached = briefCache.get(orgId);
    const isFresh = cached
      && cached.fingerprint === fingerprint
      && Date.now() - cached.generatedAt < CACHE_TTL_MS;
    if (isFresh && cached) {
      return res.json({
        brief: cached.brief,
        generatedAt: new Date(cached.generatedAt).toISOString(),
        fromCache: true,
        sessionCount: cached.sessionCount,
        totalCost: cached.totalCost,
      });
    }

    // ── Aggregations for the prompt ──────────────────────────────────────
    type UserAgg = { name: string; sessions: number; cost: number; linesAdded: number; repos: Set<string> };
    type RepoAgg = { name: string; sessions: number; cost: number; linesAdded: number; users: Set<string> };
    type AgentAgg = { agent: string; model: string; sessions: number; cost: number; tokens: number };

    const byUser = new Map<string, UserAgg>();
    const byRepo = new Map<string, RepoAgg>();
    const byAgent = new Map<string, AgentAgg>();

    for (const s of sessions) {
      const userName = s.user?.name || s.user?.email || 'Unknown';
      const repoName = s.commit?.repo?.name || '(no repo)';
      const agentLabel = s.agent?.name || s.agent?.slug || 'unknown-agent';
      const model = s.model || 'unknown-model';

      const u = byUser.get(userName) || { name: userName, sessions: 0, cost: 0, linesAdded: 0, repos: new Set() };
      u.sessions += 1;
      u.cost += s.costUsd || 0;
      u.linesAdded += s.linesAdded || 0;
      u.repos.add(repoName);
      byUser.set(userName, u);

      const r = byRepo.get(repoName) || { name: repoName, sessions: 0, cost: 0, linesAdded: 0, users: new Set() };
      r.sessions += 1;
      r.cost += s.costUsd || 0;
      r.linesAdded += s.linesAdded || 0;
      r.users.add(userName);
      byRepo.set(repoName, r);

      const aKey = `${agentLabel}::${model}`;
      const a = byAgent.get(aKey) || { agent: agentLabel, model, sessions: 0, cost: 0, tokens: 0 };
      a.sessions += 1;
      a.cost += s.costUsd || 0;
      a.tokens += s.tokensUsed || 0;
      byAgent.set(aKey, a);
    }

    // Pull a sample of prompt summaries to ground the narrative — without
    // this, the LLM can only guess what each session did from the commit
    // message + raw counts, which yields generic copy.
    const sessionIds = sessions.map((s) => s.id);
    const promptSamples = await prisma.promptChange.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, promptText: true },
      orderBy: { promptIndex: 'asc' },
      take: 60,
    });
    const promptsBySession = new Map<string, string[]>();
    for (const p of promptSamples) {
      const list = promptsBySession.get(p.sessionId) || [];
      const text = (p.promptText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (text) list.push(text);
      promptsBySession.set(p.sessionId, list);
    }

    const promptDigest = sessions.slice(0, 30).map((s) => {
      const prompts = (promptsBySession.get(s.id) || []).slice(0, 2).join(' | ');
      return {
        user: s.user?.name || s.user?.email || 'Unknown',
        repo: s.commit?.repo?.name || '(no repo)',
        agent: s.agent?.name || s.agent?.slug || 'unknown',
        model: s.model || 'unknown',
        cost: Number((s.costUsd || 0).toFixed(2)),
        linesAdded: s.linesAdded || 0,
        commitMsg: (s.commit?.message || '').slice(0, 120),
        prompts,
      };
    });

    const aggSummary = {
      totals: {
        sessionCount,
        totalCost: Number(totalCost.toFixed(2)),
        totalTokens,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
      },
      users: Array.from(byUser.values())
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 10)
        .map((u) => ({
          name: u.name,
          sessions: u.sessions,
          cost: Number(u.cost.toFixed(2)),
          linesAdded: u.linesAdded,
          repos: Array.from(u.repos).slice(0, 5),
        })),
      repos: Array.from(byRepo.values())
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, 10)
        .map((r) => ({
          name: r.name,
          sessions: r.sessions,
          cost: Number(r.cost.toFixed(2)),
          linesAdded: r.linesAdded,
          contributors: r.users.size,
        })),
      agents: Array.from(byAgent.values())
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10)
        .map((a) => ({
          agent: a.agent,
          model: a.model,
          sessions: a.sessions,
          cost: Number(a.cost.toFixed(2)),
          tokens: a.tokens,
        })),
    };

    // ── LLM call ─────────────────────────────────────────────────────────
    const apiKey = (await getOrgLLMKey(orgId)) || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'AI brief unavailable: no LLM key configured. Set one in Settings → AI.',
      });
    }
    const model = await getOrgLLMModel(orgId);
    const provider = await getOrgLLMProvider(orgId);

    const systemPrompt = `You are a concise newsroom-style summariser writing the daily "Origin Dispatch" — a brief recap of the team's AI coding activity today.

Output STRICT JSON only, no markdown fences, matching this schema:
{
  "headline": "<one short punchy sentence — past tense, factual, no fluff>",
  "sections": [
    { "title": "Engineers", "bullets": ["<who did what, where>", ...] },
    { "title": "Repos", "bullets": ["<repo: what shipped there>", ...] },
    { "title": "Agents & spend", "bullets": ["<which agent burned the most>", ...] }
  ]
}

Rules:
- Each bullet under 140 chars. No emojis. No markdown bold/italic.
- Use the actual user names, repo names, agent names from the data.
- Reference specific work from the prompt digest where possible — paraphrase, don't quote.
- 3–6 bullets per section, scaled to the volume of activity.
- "Agents & spend" must call out the top-cost agent and total spend in dollars.
- If only one engineer / one repo / one agent, the section has just one bullet.
- Headline: pattern like "Team shipped N sessions across M repos for $X.XX" — adapt to data.`;

    const userPayload = JSON.stringify({ aggregations: aggSummary, promptDigest }, null, 2);

    let raw = '';
    try {
      raw = await callLLM(systemPrompt, [{ role: 'user', content: userPayload }], 1024, {
        apiKey,
        model,
        provider,
      });
    } catch (err: any) {
      console.error('[today-brief] LLM call failed:', err?.message || err);
      return res.status(502).json({ error: 'Failed to generate brief from LLM provider' });
    }

    // Strip code fences in case the model wraps the JSON despite the
    // system prompt — common with Claude on shorter outputs.
    const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let parsed: Brief;
    try {
      parsed = JSON.parse(trimmed);
      if (!parsed.headline || !Array.isArray(parsed.sections)) throw new Error('missing fields');
    } catch (err: any) {
      console.error('[today-brief] Bad LLM JSON:', trimmed.slice(0, 300));
      return res.status(502).json({ error: 'LLM returned malformed brief' });
    }

    briefCache.set(orgId, {
      brief: parsed,
      generatedAt: Date.now(),
      sessionCount,
      totalCost,
      fingerprint,
    });

    res.json({
      brief: parsed,
      generatedAt: new Date().toISOString(),
      fromCache: false,
      sessionCount,
      totalCost,
    });
  } catch (err) {
    console.error('Today brief error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
