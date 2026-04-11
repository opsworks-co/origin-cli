import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getSpendByUser } from '../services/budget.js';
import { safeParseObject } from '../utils/safe-json.js';

const router = Router();
router.use(requireAuth);

interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

// ---------------------------------------------------------------------------
// GET /api/budget/agents — per-agent spend + limits (grouped by Origin agent, not model)
// ---------------------------------------------------------------------------
router.get('/agents', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get all registered agents for this org
    const agents = await prisma.agent.findMany({
      where: { orgId },
      select: { id: true, name: true, slug: true },
      take: 500,
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    // Get sessions this month (with and without agentId). Cap at 200k —
    // histogram by agent is directionally accurate well before that;
    // unbounded scans OOM the budget view for big tenants.
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
      },
      select: { agentId: true, model: true, costUsd: true },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    // Group by registered agent. For sessions without agentId, infer agent from model name.
    const spendByAgent: Record<string, { cost: number; sessions: number }> = {};

    for (const s of sessions) {
      let agentId = s.agentId;

      // If no agentId, try to map model → agent
      if (!agentId) {
        const model = (s.model || '').toLowerCase();
        const matched = agents.find((a) => {
          const slug = a.slug.toLowerCase();
          const name = a.name.toLowerCase();
          return model.includes(slug) || model.includes(name)
            || (slug === 'codex' && model.includes('codex'))
            || (slug === 'claude' && (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('haiku')))
            || (slug === 'gemini' && (model.includes('gemini') || model.includes('gemini-pro') || model.includes('flash')))
            || (slug === 'cursor' && (model === 'cursor' || model === 'default'));
        });
        if (matched) agentId = matched.id;
      }

      if (!agentId) {
        // Last resort: group as "Other"
        agentId = '__other__';
      }

      if (!spendByAgent[agentId]) spendByAgent[agentId] = { cost: 0, sessions: 0 };
      spendByAgent[agentId].cost += s.costUsd;
      spendByAgent[agentId].sessions++;
    }

    // Load per-agent monthly limits
    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_agent_limits' },
    });
    const agentLimits: Record<string, number> = limitsConfig
      ? safeParseObject<Record<string, number>>(limitsConfig.settings, 'budget_agent_limits.settings')
      : {};

    // Build result: one row per registered agent
    const result = agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      slug: a.slug,
      monthlyLimit: agentLimits[a.id] || 0,
      currentSpend: spendByAgent[a.id]?.cost || 0,
      sessions: spendByAgent[a.id]?.sessions || 0,
    }));

    // Add "Other" bucket if there are unmatched sessions
    if (spendByAgent['__other__']) {
      result.push({
        agentId: '__other__',
        agentName: 'Other',
        slug: 'other',
        monthlyLimit: 0,
        currentSpend: spendByAgent['__other__'].cost,
        sessions: spendByAgent['__other__'].sessions,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Budget agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/budget/agents/:id — set per-agent monthly limit
// ---------------------------------------------------------------------------
router.put('/agents/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const agentId = req.params.id as string;
    const { monthlyLimit } = req.body;

    // IDOR fix: previously an admin in org A could PUT a budget limit
    // keyed by any agentId — including agents belonging to other orgs —
    // because the handler never verified the agent was in the caller's
    // org before writing it into the JSON blob. The blob was then read
    // back by cross-org budget-agent-limits config in a subtle way via
    // any future code that reuses this map. Enforce ownership here.
    const ownedAgent = await prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!ownedAgent) {
      return res.status(404).json({ error: 'Agent not found in your organization' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_agent_limits' },
    });

    const limits = existing
      ? safeParseObject<Record<string, number>>(existing.settings, 'budget_agent_limits.settings')
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[agentId] = monthlyLimit;
    } else {
      delete limits[agentId];
    }

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: JSON.stringify(limits) },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'budget_agent_limits', token: '', settings: JSON.stringify(limits) },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Budget agent limit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget/users — per-developer spend + limits for current month
// ---------------------------------------------------------------------------
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const byUser = await getSpendByUser(orgId);

    // Get user emails
    const userIds = byUser.map((u) => u.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Load per-user monthly limits
    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_user_limits' },
    });
    const userLimits: Record<string, number> = limitsConfig
      ? safeParseObject<Record<string, number>>(limitsConfig.settings, 'budget_user_limits.settings')
      : {};

    const result = byUser.map((u) => ({
      userId: u.userId,
      name: u.name,
      email: userMap.get(u.userId)?.email || '',
      monthlyLimit: userLimits[u.userId] || 0,
      currentSpend: u.cost,
      sessions: u.sessions,
    }));

    res.json(result);
  } catch (err) {
    console.error('Budget users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/budget/users/:id — set per-developer monthly limit
// ---------------------------------------------------------------------------
router.put('/users/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const userId = req.params.id as string;
    const { monthlyLimit } = req.body;

    // Same IDOR shape as budget/agents/:id — verify the target user
    // actually belongs to this org before writing a limit keyed by
    // their UUID into the settings blob.
    const ownedUser = await prisma.user.findFirst({
      where: { id: userId, orgId },
      select: { id: true },
    });
    if (!ownedUser) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_user_limits' },
    });

    const limits = existing
      ? safeParseObject<Record<string, number>>(existing.settings, 'budget_user_limits.settings')
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[userId] = monthlyLimit;
    } else {
      delete limits[userId];
    }

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: JSON.stringify(limits) },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'budget_user_limits', token: '', settings: JSON.stringify(limits) },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Budget user limit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget/anomalies — sessions with unusually high cost (>10x avg)
// ---------------------------------------------------------------------------
router.get('/anomalies', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get sessions this month with cost > 0. Cap at 50k — the anomaly
    // detector only uses the top-cost tail, which orderBy: costUsd desc
    // already surfaces; a bounded sample is still correct.
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
        costUsd: { gt: 0 },
      },
      select: {
        id: true,
        model: true,
        costUsd: true,
        createdAt: true,
        user: { select: { name: true } },
      },
      orderBy: { costUsd: 'desc' },
      take: 50_000,
    });

    if (sessions.length < 3) {
      return res.json([]);
    }

    // Calculate average cost (excluding top 2 to avoid skewing)
    const sorted = [...sessions].sort((a, b) => a.costUsd - b.costUsd);
    const trimmed = sorted.slice(0, Math.max(sorted.length - 2, 1));
    const avgCost = trimmed.reduce((sum, s) => sum + s.costUsd, 0) / trimmed.length;

    if (avgCost <= 0) return res.json([]);

    // Find anomalies: sessions > 10x average
    const threshold = avgCost * 10;
    const anomalies = sessions
      .filter((s) => s.costUsd > threshold)
      .slice(0, 20) // max 20
      .map((s) => ({
        sessionId: s.id,
        model: s.model,
        user: s.user?.name || 'Unknown',
        cost: s.costUsd,
        avgCost,
        multiplier: s.costUsd / avgCost,
        createdAt: s.createdAt.toISOString(),
      }));

    res.json(anomalies);
  } catch (err) {
    console.error('Budget anomalies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget/pr-costs — AI cost per pull request
// ---------------------------------------------------------------------------
router.get('/pr-costs', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days

    // Get sessions with branch info that have matching PRs. Cap at
    // 100k — the downstream grouping is a per-PR histogram, so a
    // bounded sample still matches the top PRs correctly.
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: since },
        commit: { repo: { orgId } },
        costUsd: { gt: 0 },
        branch: { not: null },
      },
      select: {
        id: true,
        branch: true,
        costUsd: true,
        commit: {
          select: {
            repo: { select: { name: true } },
          },
        },
      },
      take: 100_000,
      orderBy: { createdAt: 'desc' },
    });

    // Get PRs from last 30 days. Cap at 10k — the matcher only uses
    // branch+repo as a key, and 10k PRs in 30 days is already well
    // past the point where a single response is meaningful.
    const prs = await prisma.pullRequest.findMany({
      where: {
        createdAt: { gte: since },
        repo: { orgId },
      },
      select: {
        number: true,
        title: true,
        headBranch: true,
        repo: { select: { name: true } },
      },
      take: 10_000,
      orderBy: { createdAt: 'desc' },
    });

    // Match sessions to PRs by branch + repo
    const prMap = new Map<string, { prNumber: number; title: string; repo: string; branch: string; totalCost: number; sessions: number }>();

    for (const pr of prs) {
      const key = `${pr.repo.name}:${pr.headBranch}`;
      prMap.set(key, {
        prNumber: pr.number,
        title: pr.title,
        repo: pr.repo.name,
        branch: pr.headBranch || '',
        totalCost: 0,
        sessions: 0,
      });
    }

    for (const s of sessions) {
      if (!s.branch || !s.commit?.repo?.name) continue;
      const key = `${s.commit.repo.name}:${s.branch}`;
      const pr = prMap.get(key);
      if (pr) {
        pr.totalCost += s.costUsd;
        pr.sessions++;
      }
    }

    const result = Array.from(prMap.values())
      .filter((pr) => pr.sessions > 0)
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 50);

    res.json(result);
  } catch (err) {
    console.error('Budget PR costs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
