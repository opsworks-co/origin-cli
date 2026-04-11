import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /comparison — Model comparison stats
router.get('/comparison', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    // 1. Get repoIds for org. Cap at 5000 — see identical rationale in
    // routes/stats.ts and routes/prompts.ts. An org with more repos than
    // this is already past the point where a single-page comparison
    // scales, and materializing the full list every call is a DoS vector.
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
    });
    const repoIds = repos.map((r) => r.id);

    if (repoIds.length === 0) {
      return res.json({ models: [], trend: [] });
    }

    // 2. GroupBy model on CodingSession
    const modelGroups = await prisma.codingSession.groupBy({
      by: ['model'],
      where: { commit: { repoId: { in: repoIds } } },
      _count: true,
      _sum: { costUsd: true, linesAdded: true },
      _avg: { costUsd: true, durationMs: true, tokensUsed: true, linesAdded: true },
    });

    // 3. For each model: compute approval rate
    const allModels = modelGroups.map((g) => g.model);

    // Get review data per model (cap 200k — approval rate is a ratio so
    // a large-sample cap is fine without meaningfully skewing accuracy).
    const sessionsWithReviews = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        model: { in: allModels },
        review: { isNot: null },
      },
      select: {
        model: true,
        review: { select: { status: true } },
      },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    const reviewMap = new Map<
      string,
      { total: number; approved: number }
    >();

    for (const s of sessionsWithReviews) {
      if (!reviewMap.has(s.model)) {
        reviewMap.set(s.model, { total: 0, approved: 0 });
      }
      const entry = reviewMap.get(s.model)!;
      entry.total++;
      if (s.review?.status === 'APPROVED') {
        entry.approved++;
      }
    }

    const models = modelGroups.map((g) => {
      const reviewData = reviewMap.get(g.model);
      const approvalRate =
        reviewData && reviewData.total > 0
          ? parseFloat(
              ((reviewData.approved / reviewData.total) * 100).toFixed(1)
            )
          : 0;

      return {
        model: g.model,
        sessions: g._count,
        avgCost: parseFloat((g._avg.costUsd || 0).toFixed(4)),
        totalCost: parseFloat((g._sum.costUsd || 0).toFixed(2)),
        avgDuration: Math.round(g._avg.durationMs || 0),
        avgTokens: Math.round(g._avg.tokensUsed || 0),
        avgLines: Math.round(g._avg.linesAdded || 0),
        approvalRate,
      };
    });

    // Sort by session count descending
    models.sort((a, b) => b.sessions - a.sessions);

    // 4. Usage trend: last 12 weeks
    const now = new Date();
    const twelveWeeksAgo = new Date(
      now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000
    );

    const trendSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: twelveWeeksAgo },
      },
      select: {
        model: true,
        createdAt: true,
      },
      take: 200_000,
      orderBy: { createdAt: 'desc' },
    });

    // Build week buckets
    const weekBuckets = new Map<string, Map<string, number>>();

    for (const s of trendSessions) {
      const date = s.createdAt;
      // Get ISO week string YYYY-WW
      const yearStart = new Date(date.getFullYear(), 0, 1);
      const dayOfYear =
        Math.floor(
          (date.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000)
        ) + 1;
      const weekNum = Math.ceil(
        (dayOfYear + yearStart.getDay()) / 7
      );
      const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

      if (!weekBuckets.has(weekKey)) {
        weekBuckets.set(weekKey, new Map());
      }

      const weekModels = weekBuckets.get(weekKey)!;
      weekModels.set(s.model, (weekModels.get(s.model) || 0) + 1);
    }

    // Convert to sorted array
    const trend = Array.from(weekBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, modelCounts]) => ({
        week,
        models: Object.fromEntries(modelCounts),
      }));

    res.json({ models, trend });
  } catch (err) {
    console.error('Model comparison error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
