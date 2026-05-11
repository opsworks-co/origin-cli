import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';
import { parseLimit, parseOffset } from '../utils/validate.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

/** Owners and admins see org-wide aggregates; everyone else sees only
 *  their own data. Mirrors the pattern in routes/sessions.ts so the
 *  Insights page on a member account can't reveal teammates' sessions. */
function isAdminUser(req: AuthRequest): boolean {
  const role = (req.activeRole || '').toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

/** Returns a Prisma where-fragment that pins the query to `userId = me`
 *  for non-admins, or an empty object (no extra filter) for admins.
 *  Spreadable into any CodingSession.where: `{ ...sessionUserScope(req), foo: 'bar' }`. */
function sessionUserScope(req: AuthRequest): { userId?: string } {
  return isAdminUser(req) ? {} : { userId: req.user!.id };
}

// GET /onboarding-debug — diagnostic snapshot for the "First Session"
// onboarding step. The plain `/me` endpoint only tells the UI whether the
// signed-in user has any sessions in their *currently active* org under
// their *own* userId — three independent filters that all have to line up
// for "totalSessions > 0" to flip. When it stays at 0, the user has no
// way to tell which condition failed (CLI never called in vs. session was
// created under a different user/org vs. repo wasn't auto-registered).
//
// This endpoint exposes each of those signals separately so the UI can
// render concrete guidance instead of a generic "still listening".
router.get('/onboarding-debug', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const [repoCount, apiKeyCount, sessionsForUser, sessionsInOrg, latestSession, latestApiKey] = await Promise.all([
      prisma.repo.count({ where: { orgId } }),
      prisma.apiKey.count({ where: { orgId } }),
      prisma.codingSession.count({ where: { userId, commit: { repo: { orgId } } } }),
      prisma.codingSession.count({ where: { commit: { repo: { orgId } } } }),
      prisma.codingSession.findFirst({
        where: { commit: { repo: { orgId } } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, model: true, createdAt: true, userId: true, status: true },
      }),
      prisma.apiKey.findFirst({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, userId: true, createdAt: true },
      }),
    ]);

    res.json({
      orgId,
      userId,
      repoCount,
      apiKeyCount,
      sessionsForUser,
      sessionsInOrg,
      // sessionsInOrg > sessionsForUser ⇒ session attribution mismatch
      // (CLI authenticated as a different user / membership than the one
      // currently logged into the dashboard).
      attributionMismatch: sessionsInOrg > sessionsForUser,
      latestSession: latestSession
        ? {
            id: latestSession.id,
            model: latestSession.model,
            status: latestSession.status,
            userId: latestSession.userId,
            createdAt: latestSession.createdAt,
          }
        : null,
      latestApiKey: latestApiKey
        ? {
            id: latestApiKey.id,
            name: latestApiKey.name,
            userId: latestApiKey.userId,
            createdAt: latestApiKey.createdAt,
          }
        : null,
    });
  } catch (err) {
    console.error('GET /stats/onboarding-debug error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET / — compute dashboard stats
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    // Get repo IDs — optionally filtered by repoName
    const repoWhere: any = { orgId };
    if (req.query.repoName) {
      repoWhere.name = req.query.repoName as string;
    }
    const repos = await prisma.repo.findMany({
      where: repoWhere,
      select: { id: true, name: true },
    });
    const repoIds = repos.map((r) => r.id);

    // Active agents
    const activeAgents = await prisma.agent.count({
      where: { orgId, status: 'ACTIVE' },
    });

    // Total commits across org
    const totalCommits = await prisma.commit.count({
      where: { repoId: { in: repoIds } },
    });

    // Total coding sessions — scoped to the caller for non-admins so a
    // member's Insights tab shows only their own work, not the whole team's.
    const totalSessions = await prisma.codingSession.count({
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
    });

    // Active (running) sessions
    const activeSessions = await prisma.codingSession.count({
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } }, status: 'RUNNING' },
    });

    // Sessions this week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const sessionsThisWeek = await prisma.codingSession.count({
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: weekAgo },
      },
    });

    // AI percentage — count commits with session OR heuristic detection
    const aiCommitCount = await prisma.commit.count({
      where: {
        repoId: { in: repoIds },
        OR: [
          { session: { isNot: null } },
          { aiToolDetected: { not: null } },
        ],
      },
    });
    const aiPercentage = totalCommits > 0
      ? parseFloat(((aiCommitCount / totalCommits) * 100).toFixed(1))
      : 0;

    // Aggregates
    const aggregates = await prisma.codingSession.aggregate({
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
      _sum: {
        tokensUsed: true,
        costUsd: true,
        linesAdded: true,
        linesRemoved: true,
      },
    });

    const tokensUsed = aggregates._sum.tokensUsed || 0;
    const costUsd = parseFloat((aggregates._sum.costUsd || 0).toFixed(2));
    const linesAdded = aggregates._sum.linesAdded || 0;
    const linesRemoved = aggregates._sum.linesRemoved || 0;

    // Cost this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthAggs = await prisma.codingSession.aggregate({
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: monthStart },
      },
      _sum: { costUsd: true, linesAdded: true },
    });
    const estimatedCostThisMonth = parseFloat((monthAggs._sum.costUsd || 0).toFixed(2));
    const linesWrittenThisMonth = monthAggs._sum.linesAdded || 0;

    // Unreviewed sessions
    const unreviewed = await prisma.codingSession.count({
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        review: null,
      },
    });

    // Model breakdown + cost + tokens by model.
    //
    // Two layers, merged: session-level groupBy gives the baseline (every
    // session, attributed to its session.model). Per-prompt groupBy then
    // adds the multi-model accuracy: for any prompt with per-prompt cost
    // data, we attribute that prompt's cost+tokens to its own pc.model
    // instead of the session's. We subtract those amounts from the
    // session-level totals first so they don't double-count.
    const modelGroups = await prisma.codingSession.groupBy({
      by: ['model'],
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
      _count: true,
      _sum: { costUsd: true, tokensUsed: true },
    });

    // Per-prompt groupBy — only rows where pc.model is set AND we have a
    // non-zero costUsd / token count. Sessions that pre-date per-prompt
    // tracking will have no rows here, so the session-level layer carries
    // them.
    const promptGroups = await prisma.promptChange.groupBy({
      by: ['model'],
      where: {
        session: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
        model: { not: null },
        OR: [
          { costUsd: { gt: 0 } },
          { inputTokens: { gt: 0 } },
          { outputTokens: { gt: 0 } },
        ],
      },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    });

    // Build a map of "amounts already attributed at the prompt level" so we
    // can subtract them from the session-level layer for matching models.
    // Without this, a session running 60% Opus + 40% Sonnet would be counted
    // once under session.model (Opus) at full cost AND once again under each
    // pc.model — doubling the spend.
    const promptModelData = new Map<string, { cost: number; tokens: number }>();
    for (const g of promptGroups) {
      if (!g.model) continue;
      promptModelData.set(g.model, {
        cost: g._sum.costUsd || 0,
        tokens: (g._sum.inputTokens || 0) + (g._sum.outputTokens || 0),
      });
    }
    // Total attribution at the prompt level — subtract from each
    // session-level row in proportion to its share. Cheap approximation:
    // since we don't know per-(session.model, pc.model) breakdown without
    // a heavier query, just subtract the prompt-level totals from the
    // matching pc.model row. session.model rows for sessions that switched
    // models stay overcounted slightly; refine if it becomes a real issue.
    const totalPromptCostByModel = new Map(
      Array.from(promptModelData.entries()).map(([m, v]) => [m, v.cost]),
    );
    const totalPromptTokensByModel = new Map(
      Array.from(promptModelData.entries()).map(([m, v]) => [m, v.tokens]),
    );

    const modelBreakdown: Record<string, number> = {};
    const merged = new Map<string, { cost: number; count: number; tokens: number }>();
    for (const g of modelGroups) {
      const sessionCost = g._sum.costUsd || 0;
      const sessionTokens = g._sum.tokensUsed || 0;
      // Subtract any prompt-level cost we'll add below for this model.
      const promptCost = totalPromptCostByModel.get(g.model) || 0;
      const promptTokens = totalPromptTokensByModel.get(g.model) || 0;
      merged.set(g.model, {
        cost: Math.max(0, sessionCost - promptCost),
        count: g._count,
        tokens: Math.max(0, sessionTokens - promptTokens),
      });
      modelBreakdown[g.model] = g._count;
    }
    // Add the prompt-level totals (these are the per-prompt-model accurate
    // attributions). Sessions counts come from the session layer above.
    for (const [model, data] of promptModelData) {
      const existing = merged.get(model) || { cost: 0, count: 0, tokens: 0 };
      merged.set(model, {
        cost: existing.cost + data.cost,
        count: existing.count,
        tokens: existing.tokens + data.tokens,
      });
    }
    const costByModel = Array.from(merged.entries()).map(([model, v]) => ({
      model,
      cost: parseFloat(v.cost.toFixed(2)),
      count: v.count,
      tokens: v.tokens,
    }));

    // Tokens by agent (separate from model — same model can run under multiple agents)
    const agentGroups = await prisma.codingSession.groupBy({
      by: ['agentId'],
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
      _count: true,
      _sum: { tokensUsed: true, costUsd: true },
    });
    const tokenAgentIds = agentGroups.map((a) => a.agentId).filter((a): a is string => !!a);
    const agentRecords = tokenAgentIds.length > 0
      ? await prisma.agent.findMany({ where: { id: { in: tokenAgentIds } }, select: { id: true, name: true, model: true } })
      : [];
    const agentById = new Map(agentRecords.map((a) => [a.id, a]));
    const tokensByAgent = agentGroups
      .filter((g) => g.agentId && agentById.has(g.agentId))
      .map((g) => {
        const a = agentById.get(g.agentId!)!;
        return {
          agentId: a.id,
          name: a.name,
          model: a.model,
          tokens: g._sum.tokensUsed || 0,
          cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
          count: g._count,
        };
      })
      .sort((a, b) => b.tokens - a.tokens);

    // Date range filter (defaults to last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    let rangeFrom = req.query.from
      ? new Date(req.query.from as string)
      : thirtyDaysAgo;
    if (isNaN(rangeFrom.getTime()) || rangeFrom < oneYearAgo) rangeFrom = thirtyDaysAgo;

    let rangeTo = req.query.to
      ? new Date(req.query.to as string)
      : new Date();
    if (isNaN(rangeTo.getTime()) || rangeTo > new Date()) rangeTo = new Date();

    const recentSessions = await prisma.codingSession.findMany({
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { createdAt: true, costUsd: true, tokensUsed: true, durationMs: true, linesAdded: true, linesRemoved: true },
      take: 500_000,
      orderBy: { createdAt: 'desc' },
    });

    const dayCounts: Record<string, number> = {};
    const dayCosts: Record<string, number> = {};
    const dayTokens: Record<string, number> = {};
    const dayLinesAdded: Record<string, number> = {};
    const dayLinesRemoved: Record<string, number> = {};
    const dayMs = 24 * 60 * 60 * 1000;
    for (let t = rangeFrom.getTime(); t <= rangeTo.getTime(); t += dayMs) {
      const key = new Date(t).toISOString().split('T')[0];
      dayCounts[key] = 0;
      dayCosts[key] = 0;
      dayTokens[key] = 0;
      dayLinesAdded[key] = 0;
      dayLinesRemoved[key] = 0;
    }
    const hourCounts = new Array(24).fill(0);
    for (const s of recentSessions) {
      const day = s.createdAt.toISOString().split('T')[0];
      if (dayCounts[day] !== undefined) {
        dayCounts[day]++;
        dayCosts[day] += s.costUsd;
        dayTokens[day] += s.tokensUsed;
        dayLinesAdded[day] += s.linesAdded;
        dayLinesRemoved[day] += s.linesRemoved;
      }
      hourCounts[s.createdAt.getHours()]++;
    }
    const sessionsByDay = Object.entries(dayCounts).map(([date, count]) => ({ date, count }));
    const costByDay = Object.entries(dayCosts).map(([date, cost]) => ({ date, cost: parseFloat(cost.toFixed(2)) }));
    const tokensByDay = Object.entries(dayTokens).map(([date, tokens]) => ({ date, tokens }));

    // Duration buckets
    const durationBuckets = [
      { bucket: '<1m', count: 0 },
      { bucket: '1-5m', count: 0 },
      { bucket: '5-15m', count: 0 },
      { bucket: '15m+', count: 0 },
    ];
    for (const s of recentSessions) {
      const mins = s.durationMs / 60000;
      if (mins < 1) durationBuckets[0].count++;
      else if (mins < 5) durationBuckets[1].count++;
      else if (mins < 15) durationBuckets[2].count++;
      else durationBuckets[3].count++;
    }

    // AI authorship over time — deterministic based on actual daily data.
    // Cap at 500k commits per window so huge monorepos can't OOM the API.
    // Accuracy degrades beyond this only for the authorship chart, which
    // is a coarse daily summary anyway.
    const totalCommitsByDay = await prisma.commit.findMany({
      where: {
        repoId: { in: repoIds },
        committedAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { committedAt: true },
      take: 500_000,
      orderBy: { committedAt: 'desc' },
    });

    const totalDayCounts: Record<string, number> = {};
    for (const key of Object.keys(dayCounts)) {
      totalDayCounts[key] = 0;
    }
    for (const c of totalCommitsByDay) {
      const day = c.committedAt.toISOString().split('T')[0];
      if (totalDayCounts[day] !== undefined) {
        totalDayCounts[day]++;
      }
    }

    const aiAuthorshipOverTime = sessionsByDay.map((d) => {
      const totalForDay = totalDayCounts[d.date] || 0;
      const percent = totalForDay > 0
        ? Math.round((d.count / totalForDay) * 100)
        : 0;
      return { date: d.date, percent: Math.min(100, percent) };
    });

    // Sessions by repo — cap at 500k for DoS defense on large tenants.
    const commitRepos = await prisma.commit.findMany({
      where: { repoId: { in: repoIds }, session: { isNot: null } },
      select: { repoId: true },
      take: 500_000,
      orderBy: { committedAt: 'desc' },
    });
    const sessionsByRepoMap: Record<string, number> = {};
    for (const cr of commitRepos) {
      sessionsByRepoMap[cr.repoId] = (sessionsByRepoMap[cr.repoId] || 0) + 1;
    }
    const repoMap = new Map(repos.map((r) => [r.id, r.name]));
    const sessionsByRepo = Object.entries(sessionsByRepoMap).map(([repoId, count]) => ({
      repo: repoMap.get(repoId) || 'Unknown',
      count,
    }));

    // Top 5 agents
    const topAgentGroups = await prisma.codingSession.groupBy({
      by: ['agentId'],
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        agentId: { not: null },
      },
      _count: true,
      orderBy: { _count: { agentId: 'desc' } },
      take: 5,
    });

    const agentIds = topAgentGroups
      .filter((g) => g.agentId !== null)
      .map((g) => g.agentId as string);

    const agentDetails = await prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true, model: true },
    });

    const agentMap = new Map(agentDetails.map((a) => [a.id, a]));
    const topAgents = topAgentGroups
      .filter((g) => g.agentId !== null)
      .map((g) => {
        const agent = agentMap.get(g.agentId as string);
        return {
          id: g.agentId,
          name: agent?.name || 'Unknown',
          model: agent?.model || 'unknown',
          count: g._count,
        };
      });

    // Top engineers by AI usage. For non-admins this is intentionally
    // hidden — exposing other members' commit authorship under
    // "top engineers" leaks the same info we just scoped out of sessions.
    const authorGroups = isAdminUser(req)
      ? await prisma.commit.groupBy({
          by: ['author'],
          where: { repoId: { in: repoIds }, session: { isNot: null } },
          _count: true,
          orderBy: { _count: { author: 'desc' } },
          take: 5,
        })
      : [];
    const topEngineers = authorGroups.map((g) => ({
      name: g.author,
      sessions: g._count,
    }));

    // Policy violations
    const policyViolations = await prisma.auditLog.count({
      where: {
        orgId,
        action: { contains: 'VIOLATION' },
      },
    });

    // ── New enriched fields ──────────────────────────────────────

    // Top contributors (from User model). Members only ever see themselves
    // here — the userId scope collapses the leaderboard to a single row.
    const contributorAggs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        userId: { not: null },
      },
      _count: true,
      _sum: { costUsd: true, linesAdded: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 5,
    });

    const contributorUserIds = contributorAggs
      .filter((g) => g.userId !== null)
      .map((g) => g.userId as string);

    const contributorDetails = await prisma.user.findMany({
      where: { id: { in: contributorUserIds } },
      select: { id: true, name: true },
    });
    const contributorMap = new Map(contributorDetails.map((u) => [u.id, u.name]));

    const topContributors = contributorAggs
      .filter((g) => g.userId !== null)
      .map((g) => ({
        id: g.userId,
        name: contributorMap.get(g.userId as string) || 'Unknown',
        sessions: g._count,
        cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
        lines: g._sum.linesAdded || 0,
      }));

    // Quality metrics
    const reviewStatusCounts = await prisma.sessionReview.groupBy({
      by: ['status'],
      where: {
        session: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
      },
      _count: true,
    });

    const qualityMetrics: Record<string, number> = {
      approved: 0,
      rejected: 0,
      flagged: 0,
      pending: unreviewed,
    };
    for (const g of reviewStatusCounts) {
      const key = g.status.toLowerCase();
      if (key in qualityMetrics && key !== 'pending') {
        qualityMetrics[key] = g._count;
      }
    }

    // Violations by policy type. Cap at 50k rows — the histogram is
    // directionally accurate well before that and auditLog grows
    // monotonically, so an unbounded scan OOMs the stats dashboard
    // for any org with a long violation history.
    const violationEntries = await prisma.auditLog.findMany({
      where: { orgId, action: { contains: 'VIOLATION' } },
      select: { metadata: true },
      take: 50_000,
      orderBy: { createdAt: 'desc' },
    });

    const violationTypeCounts: Record<string, number> = {};
    for (const v of violationEntries) {
      try {
        const meta = JSON.parse(v.metadata);
        const type = meta.policyType || 'UNKNOWN';
        violationTypeCounts[type] = (violationTypeCounts[type] || 0) + 1;
      } catch (err) {
        console.warn('[stats] malformed audit metadata JSON:', (err as Error).message);
        violationTypeCounts['UNKNOWN'] = (violationTypeCounts['UNKNOWN'] || 0) + 1;
      }
    }
    const violationsByType = Object.entries(violationTypeCounts).map(([type, count]) => ({ type, count }));

    // Session averages
    const sessionAvgs = await prisma.codingSession.aggregate({
      where: { ...sessionUserScope(req), commit: { repoId: { in: repoIds } } },
      _avg: { costUsd: true, durationMs: true, tokensUsed: true },
    });

    const avgSessionCost = parseFloat((sessionAvgs._avg.costUsd || 0).toFixed(4));
    const avgSessionDuration = Math.round(sessionAvgs._avg.durationMs || 0);
    const avgSessionTokens = Math.round(sessionAvgs._avg.tokensUsed || 0);

    // Cost by user
    const costByUserAggs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        userId: { not: null },
      },
      _sum: { costUsd: true },
    });

    const orgUsers = await prisma.user.findMany({
      where: { memberships: { some: { orgId } } },
      select: { id: true, name: true },
    });
    const orgUserMap = new Map(orgUsers.map((u) => [u.id, u.name]));

    const costByUser = costByUserAggs
      .filter((g) => g.userId !== null)
      .map((g) => ({
        userId: g.userId,
        name: orgUserMap.get(g.userId as string) || 'Unknown',
        cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
      }));

    // ── New: Cost by repo (cap 500k) ─────────────────────────────
    const costByRepoAggs = await prisma.codingSession.findMany({
      where: {
        ...sessionUserScope(req),
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { costUsd: true, commit: { select: { repoId: true } } },
      take: 500_000,
      orderBy: { createdAt: 'desc' },
    });

    const costByRepoMap: Record<string, { cost: number; sessions: number }> = {};
    for (const s of costByRepoAggs) {
      const rid = s.commit.repoId;
      if (!costByRepoMap[rid]) costByRepoMap[rid] = { cost: 0, sessions: 0 };
      costByRepoMap[rid].cost += s.costUsd;
      costByRepoMap[rid].sessions++;
    }
    const costByRepo = Object.entries(costByRepoMap).map(([repoId, data]) => ({
      repo: repoMap.get(repoId) || 'Unknown',
      cost: parseFloat(data.cost.toFixed(2)),
      sessions: data.sessions,
    }));

    // ── New: Lines by day ────────────────────────────────────────
    const linesByDay = Object.entries(dayLinesAdded).map(([date]) => ({
      date,
      added: dayLinesAdded[date],
      removed: dayLinesRemoved[date],
    }));

    // ── New: Sessions by hour ────────────────────────────────────
    const sessionsByHour = hourCounts.map((count: number, hour: number) => ({ hour, count }));

    // ── New: Secret findings by type ─────────────────────────────
    const secretsByType = await prisma.secretFinding.groupBy({
      by: ['type'],
      where: {
        session: {
          commit: { repoId: { in: repoIds } },
          createdAt: { gte: rangeFrom, lte: rangeTo },
        },
      },
      _count: true,
    });

    const totalSecretFindings = secretsByType.reduce((s, g) => s + g._count, 0);

    // ── Cost Forecasting via Linear Regression ──────────────────
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();

    // Linear regression on costByDay data
    const costDays = Object.entries(dayCosts).filter(([_, v]) => v > 0);
    let projectedMonthlyCost = estimatedCostThisMonth;
    let dailyCostTrend = 0;

    if (costDays.length >= 3) {
      const n = costDays.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      costDays.forEach(([_, cost], i) => {
        sumX += i;
        sumY += cost;
        sumXY += i * cost;
        sumX2 += i * i;
      });
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      dailyCostTrend = parseFloat(slope.toFixed(4));
      const avgDaily = sumY / n;
      projectedMonthlyCost = parseFloat((avgDaily * daysInMonth).toFixed(2));
    }

    res.json({
      totalSessions,
      activeSessions,
      activeAgents,
      sessionsThisWeek,
      aiPercentage,
      tokensUsed,
      costUsd,
      estimatedCostThisMonth,
      linesWrittenThisMonth,
      unreviewed,
      modelBreakdown,
      costByModel,
      tokensByAgent,
      sessionsByDay,
      sessionsByRepo,
      aiAuthorshipOverTime,
      topAgents,
      topEngineers,
      policyViolations,
      linesAdded,
      linesRemoved,
      // Enriched fields
      costByDay,
      tokensByDay,
      durationBuckets,
      topContributors,
      qualityMetrics,
      violationsByType,
      avgSessionCost,
      avgSessionDuration,
      avgSessionTokens,
      costByUser,
      // New analytics fields
      costByRepo,
      linesByDay,
      sessionsByHour,
      secretsByType: secretsByType.map((g) => ({ type: g.type, count: g._count })),
      totalSecretFindings,
      // Cost forecasting
      projectedMonthlyCost,
      dailyCostTrend,
      daysInMonth,
      daysElapsed,
      // Onboarding
      totalRepos: repos.length,
      totalUsers: orgUsers.length,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me — personal developer stats ──────────────────────────────────────

router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const baseWhere = {
      userId,
      commit: { repoId: { in: repoIds } },
    };

    // ── All-time aggregates ─────────────────────────────────────
    const [totalSessions, allTimeAgg] = await Promise.all([
      prisma.codingSession.count({ where: baseWhere }),
      prisma.codingSession.aggregate({
        where: baseWhere,
        _sum: {
          tokensUsed: true,
          costUsd: true,
          linesAdded: true,
          linesRemoved: true,
          toolCalls: true,
        },
      }),
    ]);

    // ── This week vs last week ─────────────────────────────────
    const now = new Date();
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(now.getDate() - now.getDay());
    thisWeekStart.setHours(0, 0, 0, 0);

    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const [thisWeekAgg, lastWeekAgg] = await Promise.all([
      prisma.codingSession.aggregate({
        where: { ...baseWhere, createdAt: { gte: thisWeekStart } },
        _count: true,
        _sum: { costUsd: true, tokensUsed: true },
      }),
      prisma.codingSession.aggregate({
        where: { ...baseWhere, createdAt: { gte: lastWeekStart, lt: thisWeekStart } },
        _count: true,
        _sum: { costUsd: true, tokensUsed: true },
      }),
    ]);

    // ── Agent breakdown ─────────────────────────────────────────
    const agentGroups = await prisma.codingSession.groupBy({
      by: ['agentId'],
      where: baseWhere,
      _count: true,
      _sum: { costUsd: true, tokensUsed: true, linesAdded: true, linesRemoved: true },
    });
    const agentIds = agentGroups.filter((g) => g.agentId).map((g) => g.agentId as string);
    const agents = await prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a.name]));

    const agentBreakdown = agentGroups.map((g) => ({
      agentId: g.agentId,
      agentName: agentMap.get(g.agentId || '') || g.agentId || 'Unknown',
      sessions: g._count,
      cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
      tokens: g._sum.tokensUsed || 0,
      linesAdded: g._sum.linesAdded || 0,
      linesRemoved: g._sum.linesRemoved || 0,
    }));

    // ── Most modified files (top 10) ────────────────────────────
    // Pull repoId alongside filesChanged so the dashboard can deep-link each
    // row into its repo's file viewer instead of just a sessions filter.
    const recentSessions = await prisma.codingSession.findMany({
      where: baseWhere,
      select: { filesChanged: true, commit: { select: { repoId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const fileCounts: Record<string, { count: number; repoId: string | null }> = {};
    for (const s of recentSessions) {
      if (!s.filesChanged) continue;
      // filesChanged is stored as a JSON-stringified array (e.g.
      // `["utils.py","test_utils.py"]`). Comma-splitting that produced
      // fragments like `["utils.py"` and `"test_utils.py"]` that ended up
      // rendered raw in the dashboard. Try JSON first, fall back to
      // comma-split for legacy raw-string values, then strip stray
      // quotes/brackets either way.
      let files: string[] = [];
      const raw = s.filesChanged.trim();
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) files = parsed.filter((x): x is string => typeof x === 'string');
        } catch {
          // Malformed JSON — fall through to legacy split.
        }
      }
      if (files.length === 0) {
        files = raw.split(',').map((f) => f.trim()).filter(Boolean);
      }
      const repoId = s.commit?.repoId ?? null;
      for (const f of files) {
        const clean = f.replace(/^["[\]]+|["[\]]+$/g, '').trim();
        if (!clean) continue;
        const cur = fileCounts[clean];
        if (cur) {
          cur.count++;
          // Keep the most-recent repoId (recentSessions is desc by createdAt
          // so the first hit wins; later sessions may belong to other repos).
          if (!cur.repoId && repoId) cur.repoId = repoId;
        } else {
          fileCounts[clean] = { count: 1, repoId };
        }
      }
    }
    const topFiles = Object.entries(fileCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([file, { count, repoId }]) => ({ file, count, repoId }));

    // ── Activity heatmap (last 365 days) ────────────────────────
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    // Cap heatmap at 200k sessions over 365 days — that's ~550/day,
    // well above anything a single user could plausibly generate.
    const heatmapSessions = await prisma.codingSession.findMany({
      where: { ...baseWhere, createdAt: { gte: yearAgo } },
      select: { createdAt: true },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const heatmap: Record<string, number> = {};
    for (const s of heatmapSessions) {
      const day = s.createdAt.toISOString().split('T')[0];
      heatmap[day] = (heatmap[day] || 0) + 1;
    }

    // ── Repo breakdown ──────────────────────────────────────────
    const repoGroups = await prisma.codingSession.groupBy({
      by: ['commitId'],
      where: baseWhere,
      _count: true,
    });
    // Resolve repo names from commits
    const commitIds = repoGroups.map((g) => g.commitId);
    const commits = await prisma.commit.findMany({
      where: { id: { in: commitIds } },
      select: { id: true, repoId: true, repo: { select: { name: true } } },
    });
    const commitRepoMap = new Map(commits.map((c) => [c.id, { repoId: c.repoId, name: c.repo.name }]));

    const repoSessionCounts: Record<string, { name: string; sessions: number }> = {};
    for (const g of repoGroups) {
      const repo = commitRepoMap.get(g.commitId);
      if (!repo) continue;
      if (!repoSessionCounts[repo.repoId]) {
        repoSessionCounts[repo.repoId] = { name: repo.name, sessions: 0 };
      }
      repoSessionCounts[repo.repoId].sessions += g._count;
    }
    const sessionsByRepo = Object.entries(repoSessionCounts)
      .map(([repoId, v]) => ({ repoId, repoName: v.name, sessions: v.sessions }))
      .sort((a, b) => b.sessions - a.sessions);

    // ── Model breakdown ─────────────────────────────────────────
    const modelGroups = await prisma.codingSession.groupBy({
      by: ['model'],
      where: baseWhere,
      _count: true,
      _sum: { costUsd: true },
    });
    const modelBreakdown = modelGroups.map((g) => ({
      model: g.model,
      sessions: g._count,
      cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
    }));

    // ── Streak ──────────────────────────────────────────────────
    let streak = 0;
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    // Start from today if it has activity, otherwise from yesterday
    let checkDate = heatmap[today] ? today : yesterdayStr;
    for (let i = 0; i < 365; i++) {
      if (heatmap[checkDate]) {
        streak++;
      } else {
        break;
      }
      // Move to previous day
      const d = new Date(checkDate);
      d.setDate(d.getDate() - 1);
      checkDate = d.toISOString().split('T')[0];
    }

    res.json({
      totalSessions,
      totalTokens: allTimeAgg._sum.tokensUsed || 0,
      totalCost: parseFloat((allTimeAgg._sum.costUsd || 0).toFixed(2)),
      totalLinesAdded: allTimeAgg._sum.linesAdded || 0,
      totalLinesRemoved: allTimeAgg._sum.linesRemoved || 0,
      totalToolCalls: allTimeAgg._sum.toolCalls || 0,
      thisWeek: {
        sessions: thisWeekAgg._count,
        cost: parseFloat((thisWeekAgg._sum.costUsd || 0).toFixed(2)),
        tokens: thisWeekAgg._sum.tokensUsed || 0,
      },
      lastWeek: {
        sessions: lastWeekAgg._count,
        cost: parseFloat((lastWeekAgg._sum.costUsd || 0).toFixed(2)),
        tokens: lastWeekAgg._sum.tokensUsed || 0,
      },
      agentBreakdown,
      modelBreakdown,
      topFiles,
      sessionsByRepo,
      heatmap,
      streak,
    });
  } catch (err) {
    console.error('Personal stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me/agents — per-agent cards for developer dashboard ───────────────

router.get('/me/agents', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({
        where: { orgId },
        select: { id: true },
        take: 5000,
      })
    ).map((r) => r.id);

    const baseWhere = {
      userId,
      commit: { repoId: { in: repoIds } },
    };

    // ── All sessions for this user (cap 100k for DoS defense) ─────
    const sessions = await prisma.codingSession.findMany({
      where: baseWhere,
      select: {
        agentId: true,
        model: true,
        costUsd: true,
        tokensUsed: true,
        durationMs: true,
        linesAdded: true,
        linesRemoved: true,
        createdAt: true,
      },
      take: 100_000,
      orderBy: { createdAt: 'desc' },
    });

    // ── Group by agentId ───────────────────────────────────────
    const agentGroupMap = new Map<
      string | null,
      {
        totalSessions: number;
        totalCost: number;
        totalTokens: number;
        totalDuration: number;
        linesAdded: number;
        linesRemoved: number;
        costThisMonth: number;
        sessionsThisMonth: number;
        lastActive: Date | null;
        modelCounts: Record<string, number>;
      }
    >();

    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);

    for (const s of sessions) {
      const key = s.agentId;
      if (!agentGroupMap.has(key)) {
        agentGroupMap.set(key, {
          totalSessions: 0,
          totalCost: 0,
          totalTokens: 0,
          totalDuration: 0,
          linesAdded: 0,
          linesRemoved: 0,
          costThisMonth: 0,
          sessionsThisMonth: 0,
          lastActive: null,
          modelCounts: {},
        });
      }
      const g = agentGroupMap.get(key)!;
      g.totalSessions++;
      g.totalCost += s.costUsd;
      g.totalTokens += s.tokensUsed;
      g.totalDuration += s.durationMs;
      g.linesAdded += s.linesAdded;
      g.linesRemoved += s.linesRemoved;
      g.modelCounts[s.model] = (g.modelCounts[s.model] || 0) + 1;

      if (s.createdAt >= firstOfMonth) {
        g.costThisMonth += s.costUsd;
        g.sessionsThisMonth++;
      }

      if (!g.lastActive || s.createdAt > g.lastActive) {
        g.lastActive = s.createdAt;
      }
    }

    // ── Resolve agent names ────────────────────────────────────
    const agentIds = [...agentGroupMap.keys()].filter((id): id is string => id !== null);
    const agentDetails = await prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, name: true },
    });
    const agentNameMap = new Map(agentDetails.map((a) => [a.id, a.name]));

    // ── Build response ─────────────────────────────────────────
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const agents = [...agentGroupMap.entries()].map(([agentId, g]) => {
      // Most-used model (mode)
      let model = 'unknown';
      let maxCount = 0;
      for (const [m, count] of Object.entries(g.modelCounts)) {
        if (count > maxCount) {
          maxCount = count;
          model = m;
        }
      }

      const lastActive = g.lastActive ? g.lastActive.toISOString() : null;
      const status: 'active' | 'inactive' =
        g.lastActive && g.lastActive >= sevenDaysAgo ? 'active' : 'inactive';

      return {
        agentId,
        agentName: agentNameMap.get(agentId || '') || agentId || 'Unknown',
        model,
        totalSessions: g.totalSessions,
        totalCost: parseFloat(g.totalCost.toFixed(2)),
        totalTokens: g.totalTokens,
        costThisMonth: parseFloat(g.costThisMonth.toFixed(2)),
        sessionsThisMonth: g.sessionsThisMonth,
        lastActive,
        status,
        avgSessionDuration: g.totalSessions > 0 ? Math.round(g.totalDuration / g.totalSessions) : 0,
        linesAdded: g.linesAdded,
        linesRemoved: g.linesRemoved,
      };
    });

    res.json({ agents });
  } catch (err) {
    console.error('Personal agent stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me/patterns — coding patterns (hour-of-day, day-of-week) ────────────

router.get('/me/patterns', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({
        where: { orgId },
        select: { id: true },
        take: 5000,
      })
    ).map((r) => r.id);

    const baseWhere = {
      userId,
      commit: { repoId: { in: repoIds } },
    };

    const sessions = await prisma.codingSession.findMany({
      where: baseWhere,
      select: { createdAt: true, durationMs: true, tokensUsed: true, costUsd: true },
      take: 100_000,
      orderBy: { createdAt: 'desc' },
    });

    // Hourly distribution (24 buckets)
    const hourly = new Array(24).fill(0);
    // Daily distribution (7 buckets, Sun=0 .. Sat=6)
    const daily = new Array(7).fill(0);

    let totalDuration = 0;
    let totalTokens = 0;
    let totalCost = 0;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    let sessionsThisMonth = 0;
    let costThisMonth = 0;

    for (const s of sessions) {
      const hour = s.createdAt.getHours();
      const day = s.createdAt.getDay();
      hourly[hour]++;
      daily[day]++;
      totalDuration += s.durationMs;
      totalTokens += s.tokensUsed;
      totalCost += s.costUsd;

      if (s.createdAt >= monthStart) {
        sessionsThisMonth++;
        costThisMonth += s.costUsd;
      }
    }

    const count = sessions.length || 1;
    const avgSessionDuration = Math.round(totalDuration / count);
    const avgTokensPerSession = Math.round(totalTokens / count);
    const avgCostPerSession = parseFloat((totalCost / count).toFixed(4));

    const peakHour = hourly.indexOf(Math.max(...hourly));
    const peakDayIndex = daily.indexOf(Math.max(...daily));
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const peakDay = dayNames[peakDayIndex];

    res.json({
      hourly,
      daily,
      avgSessionDuration,
      avgTokensPerSession,
      avgCostPerSession,
      peakHour,
      peakDay,
      sessionsThisMonth,
      costThisMonth: parseFloat(costThisMonth.toFixed(2)),
    });
  } catch (err) {
    console.error('Patterns stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me/efficiency — cost efficiency metrics ─────────────────────────────

router.get('/me/efficiency', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const baseWhere = {
      userId,
      commit: { repoId: { in: repoIds } },
    };

    const agg = await prisma.codingSession.aggregate({
      where: baseWhere,
      _sum: {
        tokensUsed: true,
        costUsd: true,
        linesAdded: true,
        toolCalls: true,
      },
      _count: true,
    });

    const totalTokens = agg._sum.tokensUsed || 0;
    const totalCost = agg._sum.costUsd || 0;
    const totalLines = agg._sum.linesAdded || 0;
    const totalToolCalls = agg._sum.toolCalls || 0;
    const sessionCount = agg._count || 1;

    const tokensPerLine = totalLines > 0
      ? parseFloat((totalTokens / totalLines).toFixed(1))
      : 0;

    const costPerSession = parseFloat((totalCost / sessionCount).toFixed(4));
    const avgLinesPerSession = Math.round(totalLines / sessionCount);

    // Commits linked to user's sessions
    const commitCount = await prisma.commit.count({
      where: {
        repoId: { in: repoIds },
        session: { userId },
      },
    });

    // Also count commits via sessionCommits relation
    const linkedCommitCount = await prisma.commit.count({
      where: {
        repoId: { in: repoIds },
        codingSession: { userId },
      },
    });

    const totalCommits = commitCount + linkedCommitCount;
    const costPerCommit = totalCommits > 0
      ? parseFloat((totalCost / totalCommits).toFixed(4))
      : 0;
    const commitsPerSession = totalCommits > 0
      ? parseFloat((totalCommits / sessionCount).toFixed(1))
      : 0;

    // Avg files per commit
    const commitsWithFiles = await prisma.commit.findMany({
      where: {
        repoId: { in: repoIds },
        OR: [
          { session: { userId } },
          { codingSession: { userId } },
        ],
      },
      select: { filesChanged: true },
      take: 100_000,
      orderBy: { committedAt: 'desc' },
    });

    let totalFilesChanged = 0;
    for (const c of commitsWithFiles) {
      try {
        const files = JSON.parse(c.filesChanged);
        totalFilesChanged += Array.isArray(files) ? files.length : 0;
      } catch {
        // filesChanged might be comma-separated or empty
      }
    }
    const avgFilesPerCommit = commitsWithFiles.length > 0
      ? parseFloat((totalFilesChanged / commitsWithFiles.length).toFixed(1))
      : 0;

    res.json({
      tokensPerLine,
      costPerCommit,
      costPerSession,
      avgLinesPerSession,
      cacheTokens: { read: 0, created: 0 }, // No cache token fields in schema
      toolCallBreakdown: totalToolCalls, // Simplified: total count (transcript parsing deferred)
      commitStats: {
        totalCommits,
        commitsPerSession,
        avgFilesPerCommit,
      },
    });
  } catch (err) {
    console.error('Efficiency stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me/prompts — recent prompts with file changes ───────────────────────

router.get('/me/prompts', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const limit = parseLimit(req.query.limit, 50, 200);
    const offset = parseOffset(req.query.offset);

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const q = (req.query.q as string)?.trim();

    const baseWhere: any = {
      session: {
        userId,
        commit: { repoId: { in: repoIds } },
      },
      ...(q ? { promptText: { contains: q } } : {}),
    };

    const [prompts, total] = await Promise.all([
      prisma.promptChange.findMany({
        where: baseWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          sessionId: true,
          promptIndex: true,
          promptText: true,
          filesChanged: true,
          diff: true,
          createdAt: true,
          session: {
            select: {
              agent: { select: { name: true } },
            },
          },
        },
      }),
      prisma.promptChange.count({ where: baseWhere }),
    ]);

    res.json({
      prompts: prompts.map((p) => ({
        sessionId: p.sessionId,
        agentName: p.session.agent?.name || 'Unknown',
        promptIndex: p.promptIndex,
        promptText: p.promptText,
        filesChanged: (() => {
          try { return JSON.parse(p.filesChanged); } catch { return p.filesChanged; }
        })(),
        diff: p.diff,
        createdAt: p.createdAt.toISOString(),
      })),
      total,
    });
  } catch (err) {
    console.error('Prompts stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /me/commits — personal commits with AI attribution ──────────────
router.get('/me/commits', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.activeOrgId!;

    const limit = parseLimit(req.query.limit, 50, 200);
    const offset = parseOffset(req.query.offset);
    const sort = (req.query.sort as string) || 'date';

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    // Find commits linked to this user's sessions.
    // Exclude placeholder rows that the MCP session-start flow creates
    // (random SHA + empty message) — they aren't real commits yet.
    const baseWhere: any = {
      repoId: { in: repoIds },
      OR: [
        { codingSession: { userId } },
        { session: { userId } },
      ],
      message: { not: '' },
    };

    // Sort options
    let orderBy: any = { committedAt: 'desc' };
    if (sort === 'repo') orderBy = [{ repo: { name: 'asc' } }, { committedAt: 'desc' }];
    if (sort === 'cost') orderBy = [{ codingSession: { costUsd: 'desc' } }, { committedAt: 'desc' }];

    const sessionSelect = {
      id: true,
      model: true,
      branch: true,
      agent: { select: { name: true } },
      costUsd: true,
      tokensUsed: true,
      linesAdded: true,
      linesRemoved: true,
      filesChanged: true,
      sessionDiff: { select: { diff: true, linesAdded: true, linesRemoved: true } },
      promptChanges: {
        select: {
          promptIndex: true,
          promptText: true,
          filesChanged: true,
          diff: true,
          createdAt: true,
        },
        orderBy: { promptIndex: 'asc' as const },
      },
    };

    const [commits, total] = await Promise.all([
      prisma.commit.findMany({
        where: baseWhere,
        orderBy,
        take: limit,
        skip: offset,
        select: {
          id: true,
          sha: true,
          message: true,
          author: true,
          aiToolDetected: true,
          aiDetectionMethod: true,
          branch: true,
          filesChanged: true,
          committedAt: true,
          sessionId: true,
          repo: { select: { name: true } },
          codingSession: { select: sessionSelect },
          session: { select: sessionSelect },
        },
      }),
      prisma.commit.count({ where: baseWhere }),
    ]);

    res.json({
      commits: commits.map((c) => {
        const linkedSession = c.codingSession || c.session;
        let files: string[] = [];
        try { files = JSON.parse(c.filesChanged); } catch { /* ignore */ }
        return {
          id: c.id,
          sha: c.sha,
          message: c.message,
          author: c.author,
          aiToolDetected: c.aiToolDetected,
          aiDetectionMethod: c.aiDetectionMethod,
          branch: c.branch || linkedSession?.branch || null,
          filesChanged: files,
          committedAt: c.committedAt.toISOString(),
          repoName: c.repo.name,
          sessionId: linkedSession?.id || null,
          sessionModel: linkedSession?.model || null,
          sessionAgent: linkedSession?.agent?.name || null,
          sessionCost: linkedSession?.costUsd || 0,
          sessionTokens: linkedSession?.tokensUsed || 0,
          sessionLinesAdded: linkedSession?.linesAdded || 0,
          sessionLinesRemoved: linkedSession?.linesRemoved || 0,
          diff: linkedSession?.sessionDiff?.diff || null,
          prompts: linkedSession?.promptChanges?.map((pc: any) => ({
            promptIndex: pc.promptIndex,
            promptText: pc.promptText,
            filesChanged: (() => { try { return JSON.parse(pc.filesChanged); } catch { return []; } })(),
            createdAt: pc.createdAt?.toISOString(),
          })) || [],
        };
      }),
      total,
    });
  } catch (err) {
    console.error('Commits stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /team/prompts — org-wide prompt search ─────────────────────────────
//
// Mirrors /me/prompts but scoped to the whole org and surfaces the engineer
// who wrote the prompt, so teams can search across institutional knowledge.

router.get('/team/prompts', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const limit = parseLimit(req.query.limit, 50, 200);
    const offset = parseOffset(req.query.offset);

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const q = (req.query.q as string)?.trim();
    const userIdFilter = (req.query.userId as string)?.trim();
    const repoIdFilter = (req.query.repoId as string)?.trim();
    const agentIdFilter = (req.query.agentId as string)?.trim();
    const modelFilter = (req.query.model as string)?.trim();

    const baseWhere: any = {
      session: {
        commit: { repoId: { in: repoIds } },
        ...(userIdFilter ? { userId: userIdFilter } : {}),
        ...(agentIdFilter ? { agentId: agentIdFilter } : {}),
        ...(modelFilter ? { model: modelFilter } : {}),
        ...(repoIdFilter ? { commit: { repoId: repoIdFilter } } : {}),
      },
      ...(q ? { promptText: { contains: q } } : {}),
    };

    const [prompts, total] = await Promise.all([
      prisma.promptChange.findMany({
        where: baseWhere,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          sessionId: true,
          promptIndex: true,
          promptText: true,
          filesChanged: true,
          createdAt: true,
          session: {
            select: {
              agent: { select: { name: true } },
              user: { select: { id: true, name: true } },
              commit: { select: { repo: { select: { id: true, name: true } } } },
            },
          },
        },
      }),
      prisma.promptChange.count({ where: baseWhere }),
    ]);

    res.json({
      prompts: prompts.map((p) => ({
        sessionId: p.sessionId,
        agentName: p.session.agent?.name || 'Unknown',
        userId: p.session.user?.id || null,
        userName: p.session.user?.name || 'Unknown',
        repoId: p.session.commit?.repo?.id || null,
        repoName: p.session.commit?.repo?.name || null,
        promptIndex: p.promptIndex,
        promptText: p.promptText,
        filesChanged: (() => {
          try { return JSON.parse(p.filesChanged); } catch { return []; }
        })(),
        createdAt: p.createdAt.toISOString(),
      })),
      total,
    });
  } catch (err) {
    console.error('Team prompts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /team/efficiency — org-wide cost/efficiency metrics ────────────────

router.get('/team/efficiency', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const baseWhere = {
      commit: { repoId: { in: repoIds } },
    };

    const [agg, sessionsByUser, totalCommits, sampleCommits] = await Promise.all([
      prisma.codingSession.aggregate({
        where: baseWhere,
        _sum: { tokensUsed: true, costUsd: true, linesAdded: true, linesRemoved: true, durationMs: true },
        _count: true,
      }),
      prisma.codingSession.groupBy({
        by: ['userId'],
        where: baseWhere,
        _sum: { tokensUsed: true, costUsd: true, linesAdded: true },
        _count: true,
      }),
      prisma.commit.count({
        where: { repoId: { in: repoIds }, message: { not: '' } },
      }),
      prisma.commit.findMany({
        where: { repoId: { in: repoIds }, message: { not: '' } },
        select: { filesChanged: true },
        take: 5_000,
        orderBy: { committedAt: 'desc' },
      }),
    ]);

    const totalTokens = agg._sum.tokensUsed || 0;
    const totalCost = agg._sum.costUsd || 0;
    const totalLines = agg._sum.linesAdded || 0;
    const sessionCount = agg._count || 1;

    const tokensPerLine = totalLines > 0 ? parseFloat((totalTokens / totalLines).toFixed(1)) : 0;
    const costPerSession = parseFloat((totalCost / sessionCount).toFixed(4));
    const avgLinesPerSession = Math.round(totalLines / sessionCount);
    const costPerCommit = totalCommits > 0 ? parseFloat((totalCost / totalCommits).toFixed(4)) : 0;
    const commitsPerSession = sessionCount > 0 ? parseFloat((totalCommits / sessionCount).toFixed(1)) : 0;

    let totalFiles = 0;
    for (const c of sampleCommits) {
      try {
        const files = JSON.parse(c.filesChanged);
        totalFiles += Array.isArray(files) ? files.length : 0;
      } catch { /* ignore */ }
    }
    const avgFilesPerCommit = sampleCommits.length > 0
      ? parseFloat((totalFiles / sampleCommits.length).toFixed(1))
      : 0;

    // Per-engineer efficiency rows so the UI can highlight outliers.
    const userIds = sessionsByUser.map((u) => u.userId).filter((u): u is string => !!u);
    const users = userIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u.name]));

    const byEngineer = sessionsByUser
      .filter((u) => u.userId)
      .map((u) => {
        const tokens = u._sum.tokensUsed || 0;
        const cost = u._sum.costUsd || 0;
        const lines = u._sum.linesAdded || 0;
        const sessions = u._count || 1;
        return {
          userId: u.userId!,
          name: userById.get(u.userId!) || 'Unknown',
          sessions,
          cost: parseFloat(cost.toFixed(2)),
          tokensPerLine: lines > 0 ? parseFloat((tokens / lines).toFixed(1)) : 0,
          costPerSession: parseFloat((cost / sessions).toFixed(4)),
        };
      })
      .sort((a, b) => b.cost - a.cost);

    res.json({
      tokensPerLine,
      costPerSession,
      costPerCommit,
      avgLinesPerSession,
      avgFilesPerCommit,
      commitsPerSession,
      totalSessions: sessionCount,
      totalCommits,
      totalCost: parseFloat(totalCost.toFixed(2)),
      byEngineer,
    });
  } catch (err) {
    console.error('Team efficiency error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /team/adoption — adoption + new-adopter signals ────────────────────

router.get('/team/adoption', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const repoIds = (
      await prisma.repo.findMany({ where: { orgId }, select: { id: true } })
    ).map((r) => r.id);

    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - now.getDay());
    startOfThisWeek.setHours(0, 0, 0, 0);
    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const [totalEngineers, sessionsThisWeek, sessionsLastWeek, allEngineerActivity] = await Promise.all([
      prisma.user.count({ where: { memberships: { some: { orgId } } } }),
      prisma.codingSession.findMany({
        where: { commit: { repoId: { in: repoIds } }, createdAt: { gte: startOfThisWeek } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      prisma.codingSession.findMany({
        where: {
          commit: { repoId: { in: repoIds } },
          createdAt: { gte: startOfLastWeek, lt: startOfThisWeek },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      // First session per engineer — used to compute new adopters this week.
      prisma.codingSession.groupBy({
        by: ['userId'],
        where: { commit: { repoId: { in: repoIds } } },
        _min: { createdAt: true },
      }),
    ]);

    const activeThisWeek = sessionsThisWeek.map((s) => s.userId).filter((u): u is string => !!u);
    const activeLastWeek = sessionsLastWeek.map((s) => s.userId).filter((u): u is string => !!u);
    const newAdopters = allEngineerActivity.filter(
      (e) => e._min.createdAt && e._min.createdAt >= startOfThisWeek,
    ).length;

    res.json({
      totalEngineers,
      activeThisWeek: activeThisWeek.length,
      activeLastWeek: activeLastWeek.length,
      newAdopters,
      adoptionPct: totalEngineers > 0
        ? Math.round((activeThisWeek.length / totalEngineers) * 100)
        : 0,
    });
  } catch (err) {
    console.error('Team adoption error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
