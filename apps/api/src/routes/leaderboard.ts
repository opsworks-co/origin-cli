import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';
import { pickAllowed } from '../utils/validate.js';

const LEADERBOARD_PERIODS = ['week', 'month', 'quarter', 'all'] as const;
const LEADERBOARD_SORTS = ['sessions', 'cost', 'tokens', 'lines', 'quality'] as const;

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// GET / — Leaderboard rankings
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const period = pickAllowed(req.query.period, LEADERBOARD_PERIODS, 'month');
    const sortBy = pickAllowed(req.query.sortBy, LEADERBOARD_SORTS, 'sessions');

    // 1. Get repoIds for org (cap — see prompts.ts rationale).
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
    });
    const repoIds = repos.map((r) => r.id);

    if (repoIds.length === 0) {
      return res.json({ entries: [], period, sortBy });
    }

    // 2. Compute date range from period
    const now = new Date();
    let dateFrom: Date;
    switch (period) {
      case 'week':
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'quarter':
        dateFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case 'all':
        dateFrom = new Date(0);
        break;
      case 'month':
      default:
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
    }

    // 3. Get sessions in range. Cap at 100k rows — the leaderboard is a
    // group-by-user histogram, so a partial scan still produces a
    // directionally accurate ranking. Unbounded scans on large tenants
    // would OOM the route; prefer pre-aggregated counters if the cap
    // becomes a fidelity problem.
    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: { in: repoIds } },
        createdAt: { gte: dateFrom },
        userId: { not: null },
      },
      select: {
        id: true,
        userId: true,
        costUsd: true,
        linesAdded: true,
        linesRemoved: true,
        tokensUsed: true,
        createdAt: true,
        review: { select: { status: true } },
      },
      take: 100_000,
      orderBy: { createdAt: 'desc' },
    });

    // 4. Group by userId
    const userMap = new Map<
      string,
      {
        sessions: number;
        lines: number;
        cost: number;
        approved: number;
        rejected: number;
        flagged: number;
        reviewed: number;
        total: number;
        violations: number;
        dates: Map<string, number>;
      }
    >();

    for (const s of sessions) {
      const uid = s.userId!;
      if (!userMap.has(uid)) {
        userMap.set(uid, {
          sessions: 0,
          lines: 0,
          cost: 0,
          approved: 0,
          rejected: 0,
          flagged: 0,
          reviewed: 0,
          total: 0,
          violations: 0,
          dates: new Map(),
        });
      }

      const entry = userMap.get(uid)!;
      entry.sessions++;
      entry.lines += s.linesAdded + s.linesRemoved;
      entry.cost += s.costUsd;
      entry.total++;

      if (s.review) {
        entry.reviewed++;
        if (s.review.status === 'APPROVED') entry.approved++;
        else if (s.review.status === 'REJECTED') entry.rejected++;
        else if (s.review.status === 'FLAGGED') entry.flagged++;
      }

      // Activity grid data
      const dateKey = s.createdAt.toISOString().split('T')[0];
      entry.dates.set(dateKey, (entry.dates.get(dateKey) || 0) + 1);
    }

    // 5. Compute metrics per user
    const userIds = Array.from(userMap.keys());

    // Get violation counts per user from audit log. Cap at 50k —
    // unbounded scans over the auditLog table OOM this route as it
    // grows, and leaderboard ranking only needs a directional
    // per-user count.
    const violationLogs = await prisma.auditLog.findMany({
      where: {
        orgId,
        action: { contains: 'VIOLATION' },
        createdAt: { gte: dateFrom },
        userId: { in: userIds },
      },
      select: { userId: true },
      take: 50_000,
      orderBy: { createdAt: 'desc' },
    });

    for (const v of violationLogs) {
      if (v.userId && userMap.has(v.userId)) {
        userMap.get(v.userId)!.violations++;
      }
    }

    // 6. Build entries
    const entries: Array<{
      userId: string;
      name: string;
      email: string;
      sessions: number;
      lines: number;
      cost: number;
      approvalRate: number;
      qualityScore: number;
      activityGrid: Array<{ date: string; count: number }>;
    }> = [];

    for (const [userId, data] of userMap) {
      // Approval rate
      const reviewedWithDecision = data.approved + data.rejected + data.flagged;
      const approvalRate =
        reviewedWithDecision > 0
          ? parseFloat(((data.approved / reviewedWithDecision) * 100).toFixed(1))
          : 0;

      // Review coverage
      const reviewCoverage = data.total > 0 ? data.reviewed / data.total : 0;

      // Violation rate
      const violationRate = data.total > 0 ? data.violations / data.total : 0;

      // Quality score (0–100)
      const qualityScore = parseFloat(
        (
          ((approvalRate / 100) * 0.4 +
          reviewCoverage * 0.3 +
          (1 - violationRate) * 0.2 +
          0.1) * 100
        ).toFixed(0)
      );

      // Activity grid: last 365 days
      const activityGrid: Array<{ date: string; count: number }> = [];
      const dayMs = 24 * 60 * 60 * 1000;
      const gridStart = new Date(now.getTime() - 365 * dayMs);
      for (let t = gridStart.getTime(); t <= now.getTime(); t += dayMs) {
        const dateKey = new Date(t).toISOString().split('T')[0];
        const count = data.dates.get(dateKey) || 0;
        if (count > 0) {
          activityGrid.push({ date: dateKey, count });
        }
      }

      entries.push({
        userId,
        name: '', // filled below
        email: '', // filled below
        sessions: data.sessions,
        lines: data.lines,
        cost: parseFloat(data.cost.toFixed(2)),
        approvalRate,
        qualityScore,
        activityGrid,
      });
    }

    // 7. Sort
    switch (sortBy) {
      case 'lines':
        entries.sort((a, b) => b.lines - a.lines);
        break;
      case 'cost':
        entries.sort((a, b) => b.cost - a.cost);
        break;
      case 'quality':
        entries.sort((a, b) => b.qualityScore - a.qualityScore);
        break;
      case 'sessions':
      default:
        entries.sort((a, b) => b.sessions - a.sessions);
        break;
    }

    // 8. Get user details
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const userDetailMap = new Map(users.map((u) => [u.id, u]));

    for (const entry of entries) {
      const user = userDetailMap.get(entry.userId);
      entry.name = user?.name || 'Unknown';
      entry.email = user?.email || '';
    }

    res.json({ entries, period, sortBy });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
