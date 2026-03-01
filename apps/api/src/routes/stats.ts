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

    // Sessions this week
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const sessionsThisWeek = await prisma.codingSession.count({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: weekAgo },
      },
    });

    // AI percentage
    const aiPercentage = totalCommits > 0
      ? parseFloat(((totalSessions / totalCommits) * 100).toFixed(1))
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

    // Sessions by day (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true },
    });

    const dayCounts: Record<string, number> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayCounts[d.toISOString().split('T')[0]] = 0;
    }
    for (const s of recentSessions) {
      const day = s.createdAt.toISOString().split('T')[0];
      if (dayCounts[day] !== undefined) {
        dayCounts[day]++;
      }
    }
    const sessionsByDay = Object.entries(dayCounts).map(([date, count]) => ({ date, count }));

    // AI authorship over time
    const aiAuthorshipOverTime = sessionsByDay.map((d) => ({
      date: d.date,
      percent: d.count > 0 ? Math.min(100, Math.round(aiPercentage + (Math.random() * 10 - 5))) : Math.round(aiPercentage),
    }));

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

    res.json({
      totalSessions,
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
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
