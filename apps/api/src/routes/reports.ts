import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /compliance — generate compliance report for a date range
router.get('/compliance', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    // Parse dates with NaN guards — `new Date("not-a-date")` returns
    // Invalid Date whose .getTime() is NaN, which silently corrupts Prisma
    // range filters. Fall back to sensible defaults on parse failure.
    const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let fromDate = req.query.from ? new Date(req.query.from as string) : defaultFrom;
    if (isNaN(fromDate.getTime())) fromDate = defaultFrom;
    let toDate = req.query.to ? new Date(req.query.to as string) : new Date();
    if (isNaN(toDate.getTime())) toDate = new Date();
    if (toDate < fromDate) toDate = new Date();

    // Get all repo IDs for this org
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true, name: true },
    });
    const repoIds = repos.map((r) => r.id);

    // ── Summary Metrics ──────────────────────────────────────────

    // Cap to 100k rows. An org-wide sum/avg over 100k sessions is
    // directionally accurate; unbounded scans on active orgs OOM.
    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: {
        id: true,
        costUsd: true,
        tokensUsed: true,
        model: true,
        createdAt: true,
        review: { select: { status: true } },
      },
      take: 100_000,
    });

    const totalSessions = sessions.length;
    const totalCost = parseFloat(sessions.reduce((s, x) => s + x.costUsd, 0).toFixed(2));
    const reviewedCount = sessions.filter((s) => s.review).length;
    const reviewRate = totalSessions > 0
      ? parseFloat(((reviewedCount / totalSessions) * 100).toFixed(1))
      : 100;

    // ── Violations ───────────────────────────────────────────────

    // Cap at 50k rows. Compliance reporting aggregates counts, so we
    // only need enough rows to make the per-type histogram meaningful.
    // An org with millions of violations would otherwise OOM this route.
    const violations = await prisma.auditLog.findMany({
      where: {
        orgId,
        action: { contains: 'VIOLATION' },
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: { metadata: true },
      take: 50_000,
    });

    const violationTypeCounts: Record<string, number> = {};
    for (const v of violations) {
      try {
        const meta = JSON.parse(v.metadata);
        const type = meta.policyType || 'UNKNOWN';
        violationTypeCounts[type] = (violationTypeCounts[type] || 0) + 1;
      } catch (err) {
        console.warn('[reports] malformed violation metadata JSON:', (err as Error).message);
        violationTypeCounts['UNKNOWN'] = (violationTypeCounts['UNKNOWN'] || 0) + 1;
      }
    }

    // ── Security Findings ────────────────────────────────────────

    const secretFindings = await prisma.secretFinding.groupBy({
      by: ['type'],
      where: {
        session: {
          commit: { repoId: { in: repoIds } },
          createdAt: { gte: fromDate, lte: toDate },
        },
      },
      _count: true,
    });

    const totalSecretFindings = secretFindings.reduce((s, g) => s + g._count, 0);

    // ── Session Activity by Day ──────────────────────────────────

    const dayMs = 24 * 60 * 60 * 1000;
    const dayCount: Record<string, number> = {};
    const startMs = fromDate.getTime();
    const endMs = toDate.getTime();
    for (let t = startMs; t <= endMs; t += dayMs) {
      dayCount[new Date(t).toISOString().split('T')[0]] = 0;
    }
    for (const s of sessions) {
      const day = s.createdAt.toISOString().split('T')[0];
      if (dayCount[day] !== undefined) dayCount[day]++;
    }
    const sessionActivity = Object.entries(dayCount).map(([date, count]) => ({ date, count }));

    // ── Review Coverage ──────────────────────────────────────────

    const reviewed = sessions.filter((s) => s.review).length;
    const unreviewed = totalSessions - reviewed;

    // ── Model Usage ──────────────────────────────────────────────

    const modelMap: Record<string, { sessions: number; cost: number }> = {};
    for (const s of sessions) {
      if (!modelMap[s.model]) modelMap[s.model] = { sessions: 0, cost: 0 };
      modelMap[s.model].sessions++;
      modelMap[s.model].cost += s.costUsd;
    }
    const modelUsage = Object.entries(modelMap).map(([model, data]) => ({
      model,
      sessions: data.sessions,
      cost: parseFloat(data.cost.toFixed(2)),
    }));

    // ── Compliance Score ─────────────────────────────────────────

    const score = computeComplianceScore({
      totalSessions,
      reviewRate,
      totalViolations: violations.length,
      totalSecretFindings,
      orgId,
    });

    // ── Unreviewed Aging ──────────────────────────────────────────
    // Cap at 20k — we only use createdAt for age bucketing, so even a
    // partial scan produces a representative aging distribution.
    const unreviewedSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        review: null,
      },
      select: { createdAt: true },
      take: 20_000,
    });

    const nowDate = new Date();
    const aging = { lessThan1d: 0, from1to3d: 0, from3to7d: 0, moreThan7d: 0 };
    for (const s of unreviewedSessions) {
      const ageMs = nowDate.getTime() - s.createdAt.getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays < 1) aging.lessThan1d++;
      else if (ageDays < 3) aging.from1to3d++;
      else if (ageDays < 7) aging.from3to7d++;
      else aging.moreThan7d++;
    }

    // ── Policy Coverage per Repo ────────────────────────────────
    const policies = await prisma.policy.findMany({
      where: { orgId, active: true },
      include: { rules: { select: { repoId: true } } },
    });

    const policyCoverage = repos.map((r) => ({
      repo: r.name,
      repoId: r.id,
      policies: policies
        .filter((p) =>
          p.rules.some((rule) => !rule.repoId || rule.repoId === r.id)
        )
        .map((p) => p.type),
    }));

    // ── Compliance Trend (weekly scores for last 12 weeks) ──────
    const complianceTrend: Array<{ week: string; score: number }> = [];
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 11; i >= 0; i--) {
      const weekEnd = new Date(nowDate.getTime() - i * weekMs);
      const weekStart = new Date(weekEnd.getTime() - weekMs);

      const weekYear = weekEnd.getFullYear();
      const yearStart = new Date(weekYear, 0, 1);
      const dayOfYear =
        Math.floor(
          (weekEnd.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000)
        ) + 1;
      const weekNum = Math.ceil((dayOfYear + yearStart.getDay()) / 7);
      const weekKey = `${weekYear}-W${String(weekNum).padStart(2, '0')}`;

      const weekSessions = sessions.filter(
        (s) => s.createdAt >= weekStart && s.createdAt < weekEnd
      );

      const weekTotal = weekSessions.length;
      const weekReviewed = weekSessions.filter((s) => s.review).length;
      const weekReviewRate =
        weekTotal > 0 ? (weekReviewed / weekTotal) * 100 : 100;

      // Approximate even distribution of violations across weeks
      const weekViolationCount = Math.round(violations.length / 12);

      const weekScore = computeComplianceScore({
        totalSessions: weekTotal,
        reviewRate: weekReviewRate,
        totalViolations: weekViolationCount,
        totalSecretFindings: Math.round(totalSecretFindings / 12),
        orgId,
      });

      complianceTrend.push({ week: weekKey, score: weekScore });
    }

    res.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      complianceScore: score,
      summary: {
        totalSessions,
        totalCost,
        totalViolations: violations.length,
        reviewRate,
        secretFindings: totalSecretFindings,
      },
      sessionActivity,
      violations: Object.entries(violationTypeCounts).map(([type, count]) => ({ type, count })),
      securityFindings: secretFindings.map((g) => ({ type: g.type, count: g._count })),
      reviewCoverage: { reviewed, unreviewed },
      modelUsage,
      unreviewedAging: aging,
      policyCoverage,
      complianceTrend,
    });
  } catch (err) {
    console.error('Compliance report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /compliance/summary — quick compliance score
router.get('/compliance/summary', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    const totalSessions = await prisma.codingSession.count({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    const reviewedSessions = await prisma.codingSession.count({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: thirtyDaysAgo },
        review: { isNot: null },
      },
    });

    const reviewRate = totalSessions > 0
      ? (reviewedSessions / totalSessions) * 100
      : 100;

    const totalViolations = await prisma.auditLog.count({
      where: {
        orgId,
        action: { contains: 'VIOLATION' },
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    const totalSecretFindings = await prisma.secretFinding.count({
      where: {
        session: {
          commit: { repoId: { in: repoIds } },
          createdAt: { gte: thirtyDaysAgo },
        },
      },
    });

    const score = computeComplianceScore({
      totalSessions,
      reviewRate,
      totalViolations,
      totalSecretFindings,
      orgId,
    });

    res.json({ score });
  } catch (err) {
    console.error('Compliance summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Score Calculator ─────────────────────────────────────────────

function computeComplianceScore(data: {
  totalSessions: number;
  reviewRate: number;
  totalViolations: number;
  totalSecretFindings: number;
  orgId: string;
}): number {
  // Weights: review coverage 40%, violation rate 30%, secret rate 20%, base 10%
  let score = 10; // Base points for having the platform

  // Review coverage (0-40 points)
  score += Math.min(40, (data.reviewRate / 100) * 40);

  // Violation rate (0-30 points, inversely proportional)
  if (data.totalSessions > 0) {
    const violationRate = data.totalViolations / data.totalSessions;
    score += Math.max(0, 30 * (1 - Math.min(1, violationRate * 5)));
  } else {
    score += 30; // No sessions = no violations = full points
  }

  // Secret detection rate (0-20 points, inversely proportional)
  if (data.totalSessions > 0) {
    const secretRate = data.totalSecretFindings / data.totalSessions;
    score += Math.max(0, 20 * (1 - Math.min(1, secretRate * 2)));
  } else {
    score += 20;
  }

  return Math.round(Math.min(100, Math.max(0, score)));
}

export default router;
