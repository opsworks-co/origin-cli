import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — compute dashboard stats
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    // Get all repo IDs for this org
    const repos = await prisma.repo.findMany({
      where: { orgId },
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

    // Total coding sessions
    const totalSessions = await prisma.codingSession.count({
      where: { commit: { repoId: { in: repoIds } } },
    });

    // Active (running) sessions
    const activeSessions = await prisma.codingSession.count({
      where: { commit: { repoId: { in: repoIds } }, status: 'RUNNING' },
    });

    // Sessions this week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const sessionsThisWeek = await prisma.codingSession.count({
      where: {
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
      where: { commit: { repoId: { in: repoIds } } },
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
        commit: { repoId: { in: repoIds } },
        review: null,
      },
    });

    // Model breakdown + cost by model
    const modelGroups = await prisma.codingSession.groupBy({
      by: ['model'],
      where: { commit: { repoId: { in: repoIds } } },
      _count: true,
      _sum: { costUsd: true },
    });

    const modelBreakdown: Record<string, number> = {};
    const costByModel = modelGroups.map((g) => ({
      model: g.model,
      cost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
      count: g._count,
    }));
    for (const group of modelGroups) {
      modelBreakdown[group.model] = group._count;
    }

    // Date range filter (defaults to last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rangeFrom = req.query.from
      ? new Date(req.query.from as string)
      : thirtyDaysAgo;
    const rangeTo = req.query.to
      ? new Date(req.query.to as string)
      : new Date();

    const recentSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { createdAt: true, costUsd: true, tokensUsed: true, durationMs: true, linesAdded: true, linesRemoved: true },
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

    // AI authorship over time — deterministic based on actual daily data
    const totalCommitsByDay = await prisma.commit.findMany({
      where: {
        repoId: { in: repoIds },
        committedAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { committedAt: true },
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

    // Sessions by repo
    const commitRepos = await prisma.commit.findMany({
      where: { repoId: { in: repoIds }, session: { isNot: null } },
      select: { repoId: true },
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

    // Top engineers by AI usage
    const authorGroups = await prisma.commit.groupBy({
      by: ['author'],
      where: { repoId: { in: repoIds }, session: { isNot: null } },
      _count: true,
      orderBy: { _count: { author: 'desc' } },
      take: 5,
    });
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

    // Top contributors (from User model)
    const contributorAggs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
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
        session: { commit: { repoId: { in: repoIds } } },
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

    // Violations by policy type
    const violationEntries = await prisma.auditLog.findMany({
      where: { orgId, action: { contains: 'VIOLATION' } },
      select: { metadata: true },
    });

    const violationTypeCounts: Record<string, number> = {};
    for (const v of violationEntries) {
      try {
        const meta = JSON.parse(v.metadata);
        const type = meta.policyType || 'UNKNOWN';
        violationTypeCounts[type] = (violationTypeCounts[type] || 0) + 1;
      } catch {}
    }
    const violationsByType = Object.entries(violationTypeCounts).map(([type, count]) => ({ type, count }));

    // Session averages
    const sessionAvgs = await prisma.codingSession.aggregate({
      where: { commit: { repoId: { in: repoIds } } },
      _avg: { costUsd: true, durationMs: true, tokensUsed: true },
    });

    const avgSessionCost = parseFloat((sessionAvgs._avg.costUsd || 0).toFixed(4));
    const avgSessionDuration = Math.round(sessionAvgs._avg.durationMs || 0);
    const avgSessionTokens = Math.round(sessionAvgs._avg.tokensUsed || 0);

    // Cost by user
    const costByUserAggs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: {
        commit: { repoId: { in: repoIds } },
        userId: { not: null },
      },
      _sum: { costUsd: true },
    });

    const orgUsers = await prisma.user.findMany({
      where: { orgId },
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

    // ── New: Cost by repo ────────────────────────────────────────
    const costByRepoAggs = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: rangeFrom, lte: rangeTo },
      },
      select: { costUsd: true, commit: { select: { repoId: true } } },
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
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
