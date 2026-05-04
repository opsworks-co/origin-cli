import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { getSpendByUser, periodStart, type BudgetPeriod } from '../services/budget.js';
import { safeParseObject } from '../utils/safe-json.js';

// Per-(agent|user) limits used to be { [id]: number } (a single monthly cap);
// they're now { [id]: { limit: number; period: BudgetPeriod } } so an admin
// can cap a specific agent or developer at, say, $5/day instead of having to
// pick a monthly equivalent that happens to land under their daily blast
// radius. Old number-shape entries are still read as monthly for backward
// compatibility — the helpers below normalise to the new shape on write.
type LimitEntry = { limit: number; period: BudgetPeriod };
type LimitMap = Record<string, LimitEntry>;
const VALID_PERIODS: BudgetPeriod[] = ['daily', 'weekly', 'monthly'];

function normalizePeriod(p: unknown): BudgetPeriod {
  return p === 'daily' || p === 'weekly' ? p : 'monthly';
}

function readLimits(raw: unknown): LimitMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: LimitMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && v > 0) {
      out[k] = { limit: v, period: 'monthly' };
    } else if (v && typeof v === 'object' && typeof (v as any).limit === 'number' && (v as any).limit > 0) {
      out[k] = { limit: (v as any).limit, period: normalizePeriod((v as any).period) };
    }
  }
  return out;
}

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);



// ---------------------------------------------------------------------------
// GET /api/budget/agents — per-agent spend + limits (grouped by Origin agent, not model)
// ---------------------------------------------------------------------------
router.get('/agents', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    // Get all registered agents for this org
    const agents = await prisma.agent.findMany({
      where: { orgId },
      select: { id: true, name: true, slug: true },
      take: 500,
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    // Load per-agent monthly limits up-front so we can pick the right
    // window per agent (daily/weekly/monthly).
    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_agent_limits' },
    });
    const agentLimits: LimitMap = limitsConfig
      ? readLimits(safeParseObject<Record<string, unknown>>(limitsConfig.settings, 'budget_agent_limits.settings'))
      : {};

    // We aggregate spend over the longest needed window (start of month)
    // and then re-bucket by each agent's configured period in memory —
    // one DB scan instead of one-per-agent. Cap at 200k for tenant safety.
    const startOfMonth = periodStart('monthly');
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
      },
      select: { agentId: true, model: true, costUsd: true, createdAt: true },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const dailyStart = periodStart('daily').getTime();
    const weeklyStart = periodStart('weekly').getTime();

    // Group by registered agent. For sessions without agentId, infer agent from model name.
    const spendByAgent: Record<string, { daily: number; weekly: number; monthly: number; sessions: number }> = {};

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

      if (!spendByAgent[agentId]) spendByAgent[agentId] = { daily: 0, weekly: 0, monthly: 0, sessions: 0 };
      const bucket = spendByAgent[agentId];
      bucket.monthly += s.costUsd;
      bucket.sessions++;
      const t = s.createdAt.getTime();
      if (t >= weeklyStart) bucket.weekly += s.costUsd;
      if (t >= dailyStart) bucket.daily += s.costUsd;
    }

    const pickSpend = (b: { daily: number; weekly: number; monthly: number } | undefined, period: BudgetPeriod) => {
      if (!b) return 0;
      return period === 'daily' ? b.daily : period === 'weekly' ? b.weekly : b.monthly;
    };

    // Build result: one row per registered agent. Spend is reported for
    // the agent's configured period so the UI can render the matching bar.
    const result = agents.map((a) => {
      const entry = agentLimits[a.id];
      const period: BudgetPeriod = entry?.period ?? 'monthly';
      return {
        agentId: a.id,
        agentName: a.name,
        slug: a.slug,
        monthlyLimit: entry?.limit ?? 0,
        period,
        currentSpend: pickSpend(spendByAgent[a.id], period),
        sessions: spendByAgent[a.id]?.sessions || 0,
      };
    });

    // Add "Other" bucket if there are unmatched sessions
    if (spendByAgent['__other__']) {
      result.push({
        agentId: '__other__',
        agentName: 'Other',
        slug: 'other',
        monthlyLimit: 0,
        period: 'monthly' as BudgetPeriod,
        currentSpend: spendByAgent['__other__'].monthly,
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
    const orgId = req.activeOrgId!;
    const agentId = req.params.id as string;
    const { monthlyLimit, period } = req.body;

    // IDOR fix: verify the agent is in the caller's org before writing a
    // limit keyed by its UUID into the settings blob.
    const ownedAgent = await prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!ownedAgent) {
      return res.status(404).json({ error: 'Agent not found in your organization' });
    }

    if (period !== undefined && !VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_agent_limits' },
    });

    const limits: LimitMap = existing
      ? readLimits(safeParseObject<Record<string, unknown>>(existing.settings, 'budget_agent_limits.settings'))
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[agentId] = {
        limit: monthlyLimit,
        period: normalizePeriod(period ?? limits[agentId]?.period ?? 'monthly'),
      };
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
    const orgId = req.activeOrgId!;

    // Load limits first so we know which periods we need to bucket against.
    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_user_limits' },
    });
    const userLimits: LimitMap = limitsConfig
      ? readLimits(safeParseObject<Record<string, unknown>>(limitsConfig.settings, 'budget_user_limits.settings'))
      : {};

    // One scan over the longest window (start of month), then re-bucket
    // per period. Same pattern as /agents.
    const startOfMonth = periodStart('monthly');
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
        userId: { not: null },
      },
      select: { userId: true, costUsd: true, createdAt: true, user: { select: { name: true } } },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const dailyStart = periodStart('daily').getTime();
    const weeklyStart = periodStart('weekly').getTime();
    const byUser: Record<string, { name: string; daily: number; weekly: number; monthly: number; sessions: number }> = {};
    for (const s of sessions) {
      const uid = s.userId!;
      if (!byUser[uid]) byUser[uid] = { name: s.user?.name || 'Unknown', daily: 0, weekly: 0, monthly: 0, sessions: 0 };
      const bucket = byUser[uid];
      bucket.monthly += s.costUsd;
      bucket.sessions++;
      const t = s.createdAt.getTime();
      if (t >= weeklyStart) bucket.weekly += s.costUsd;
      if (t >= dailyStart) bucket.daily += s.costUsd;
    }

    // Get user emails for the active rows
    const userIds = Object.keys(byUser);
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const result = userIds.map((userId) => {
      const data = byUser[userId];
      const entry = userLimits[userId];
      const period: BudgetPeriod = entry?.period ?? 'monthly';
      const currentSpend = period === 'daily' ? data.daily : period === 'weekly' ? data.weekly : data.monthly;
      return {
        userId,
        name: data.name,
        email: userMap.get(userId)?.email || '',
        monthlyLimit: entry?.limit ?? 0,
        period,
        currentSpend,
        sessions: data.sessions,
      };
    });

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
    const orgId = req.activeOrgId!;
    const userId = req.params.id as string;
    const { monthlyLimit, period } = req.body;

    // Same IDOR shape as budget/agents/:id — verify the target user
    // actually belongs to this org before writing a limit keyed by
    // their UUID into the settings blob.
    const ownedUser = await prisma.user.findFirst({
      where: { id: userId, memberships: { some: { orgId } } },
      select: { id: true },
    });
    if (!ownedUser) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }

    if (period !== undefined && !VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_user_limits' },
    });

    const limits: LimitMap = existing
      ? readLimits(safeParseObject<Record<string, unknown>>(existing.settings, 'budget_user_limits.settings'))
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[userId] = {
        limit: monthlyLimit,
        period: normalizePeriod(period ?? limits[userId]?.period ?? 'monthly'),
      };
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
// GET /api/budget/repos — per-repo spend + flat dollar caps. Same JSON-blob
// pattern as /agents and /users; lets admins set "$50/mo on the dolobanko-test
// repo" without having to enumerate every model that touches it. Per-(repo,
// model) overrides remain available via /api/repos/:id/models for the rare
// case where a single model on a single repo needs its own ceiling.
router.get('/repos', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const repos = await prisma.repo.findMany({
      where: { orgId, archived: false },
      select: { id: true, name: true },
      take: 500,
    });

    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_repo_limits' },
    });
    const repoLimits: LimitMap = limitsConfig
      ? readLimits(safeParseObject<Record<string, unknown>>(limitsConfig.settings, 'budget_repo_limits.settings'))
      : {};

    const startOfMonth = periodStart('monthly');
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
      },
      select: { commit: { select: { repoId: true } }, costUsd: true, createdAt: true },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const dailyStart = periodStart('daily').getTime();
    const weeklyStart = periodStart('weekly').getTime();
    const spendByRepo: Record<string, { daily: number; weekly: number; monthly: number; sessions: number }> = {};
    for (const s of sessions) {
      const repoId = s.commit.repoId;
      if (!spendByRepo[repoId]) spendByRepo[repoId] = { daily: 0, weekly: 0, monthly: 0, sessions: 0 };
      const bucket = spendByRepo[repoId];
      bucket.monthly += s.costUsd;
      bucket.sessions++;
      const t = s.createdAt.getTime();
      if (t >= weeklyStart) bucket.weekly += s.costUsd;
      if (t >= dailyStart) bucket.daily += s.costUsd;
    }

    const pickSpend = (b: { daily: number; weekly: number; monthly: number } | undefined, period: BudgetPeriod) => {
      if (!b) return 0;
      return period === 'daily' ? b.daily : period === 'weekly' ? b.weekly : b.monthly;
    };

    const result = repos.map((r) => {
      const entry = repoLimits[r.id];
      const period: BudgetPeriod = entry?.period ?? 'monthly';
      return {
        repoId: r.id,
        repoName: r.name,
        monthlyLimit: entry?.limit ?? 0,
        period,
        currentSpend: pickSpend(spendByRepo[r.id], period),
        sessions: spendByRepo[r.id]?.sessions || 0,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Budget repos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/budget/repos/:id — set per-repo flat cap + period
// ---------------------------------------------------------------------------
router.put('/repos/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const repoId = req.params.id as string;
    const { monthlyLimit, period } = req.body;

    // IDOR fix: verify the repo is in the caller's org before writing a
    // limit keyed by its UUID into the settings blob.
    const ownedRepo = await prisma.repo.findFirst({
      where: { id: repoId, orgId },
      select: { id: true },
    });
    if (!ownedRepo) {
      return res.status(404).json({ error: 'Repo not found in your organization' });
    }

    if (period !== undefined && !VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_repo_limits' },
    });

    const limits: LimitMap = existing
      ? readLimits(safeParseObject<Record<string, unknown>>(existing.settings, 'budget_repo_limits.settings'))
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[repoId] = {
        limit: monthlyLimit,
        period: normalizePeriod(period ?? limits[repoId]?.period ?? 'monthly'),
      };
    } else {
      delete limits[repoId];
    }

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: JSON.stringify(limits) },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'budget_repo_limits', token: '', settings: JSON.stringify(limits) },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Budget repo limit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget/models — per-(model) spend + org-wide model caps. Sibling
// of /agents and /users — same JSON-blob storage pattern, just keyed by
// model string. The dashboard surfaces "this model burned $X across N
// sessions, capped at $Y/period" so admins can tighten an Opus blast
// radius without chasing every agent/user pair that uses it.
router.get('/models', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    // Load limits up-front so we know which periods to bucket each model
    // against. Same shape as /agents and /users — readLimits() handles
    // both legacy `{model: number}` and new `{model: {limit, period}}`.
    const limitsConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_model_limits' },
    });
    const modelLimits: LimitMap = limitsConfig
      ? readLimits(safeParseObject<Record<string, unknown>>(limitsConfig.settings, 'budget_model_limits.settings'))
      : {};

    const startOfMonth = periodStart('monthly');
    const sessions = await prisma.codingSession.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        commit: { repo: { orgId } },
      },
      select: { model: true, costUsd: true, createdAt: true },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const dailyStart = periodStart('daily').getTime();
    const weeklyStart = periodStart('weekly').getTime();
    const byModel: Record<string, { daily: number; weekly: number; monthly: number; sessions: number }> = {};
    for (const s of sessions) {
      const m = s.model || 'unknown';
      if (!byModel[m]) byModel[m] = { daily: 0, weekly: 0, monthly: 0, sessions: 0 };
      const bucket = byModel[m];
      bucket.monthly += s.costUsd;
      bucket.sessions++;
      const t = s.createdAt.getTime();
      if (t >= weeklyStart) bucket.weekly += s.costUsd;
      if (t >= dailyStart) bucket.daily += s.costUsd;
    }

    // Make sure every model that has a configured cap shows up even when
    // it hasn't burned anything yet — admins want to verify their caps,
    // not just see "active" rows.
    for (const m of Object.keys(modelLimits)) {
      if (!byModel[m]) byModel[m] = { daily: 0, weekly: 0, monthly: 0, sessions: 0 };
    }

    const result = Object.entries(byModel).map(([model, data]) => {
      const entry = modelLimits[model];
      const period: BudgetPeriod = entry?.period ?? 'monthly';
      const currentSpend = period === 'daily' ? data.daily : period === 'weekly' ? data.weekly : data.monthly;
      return {
        model,
        monthlyLimit: entry?.limit ?? 0,
        period,
        currentSpend,
        sessions: data.sessions,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Budget models error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/budget/models/:model — set org-wide cap for a model. The model
// key arrives URL-encoded (e.g. claude-opus-4-7) and is decoded before
// being used as the JSON-blob key.
router.put('/models/:model', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const model = decodeURIComponent(req.params.model as string);
    const { monthlyLimit, period } = req.body;

    if (!model || typeof model !== 'string' || model.length > 200) {
      return res.status(400).json({ error: 'invalid model key' });
    }
    if (period !== undefined && !VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'budget_model_limits' },
    });

    const limits: LimitMap = existing
      ? readLimits(safeParseObject<Record<string, unknown>>(existing.settings, 'budget_model_limits.settings'))
      : {};
    if (typeof monthlyLimit === 'number' && monthlyLimit > 0) {
      limits[model] = {
        limit: monthlyLimit,
        period: normalizePeriod(period ?? limits[model]?.period ?? 'monthly'),
      };
    } else {
      delete limits[model];
    }

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: JSON.stringify(limits) },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'budget_model_limits', token: '', settings: JSON.stringify(limits) },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Budget model limit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget/anomalies — sessions with unusually high cost (>10x avg)
// ---------------------------------------------------------------------------
router.get('/anomalies', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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
    const orgId = req.activeOrgId!;
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
