import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { periodStart } from '../services/budget.js';

// /api/me/* — federated personal view.
//
// These endpoints intentionally do NOT use `resolveOrgContext`. Instead,
// they aggregate across every Org the authenticated user is a Member of.
// That's what makes a single team API key power the user's personal
// dashboard without dual-writes: the server federates on read.
//
// Security model: each query is constrained to (a) `userId = req.user.id`
// AND (b) `orgId IN userMemberOrgIds`. The membership filter is the
// authority — a user can never see an org's data unless they have an
// explicit Membership row, regardless of what the session's userId column
// says.
const router = Router();
router.use(requireAuth);

// Resolve the orgs a user belongs to, once per request. Cached on the
// request object so multiple downstream uses don't re-query.
async function getMemberOrgIds(req: AuthRequest): Promise<string[]> {
  const cached = (req as any)._memberOrgIds as string[] | undefined;
  if (cached) return cached;
  const memberships = await prisma.membership.findMany({
    where: { userId: req.user!.id },
    select: { orgId: true },
  });
  const ids = memberships.map((m) => m.orgId);
  (req as any)._memberOrgIds = ids;
  return ids;
}

// Mirror the shape that /api/sessions returns (apps/web reads it via the
// `Session` type in MyDashboard/utils.ts) so the dashboard's renderers
// keep working with no per-field rewiring. Additionally returns an `org`
// chip so the federated view can show "Brigada LTD · feature/foo" inline.
function mapMeSession(s: any) {
  return {
    id: s.id,
    org: s.commit?.repo?.org
      ? { id: s.commit.repo.org.id, name: s.commit.repo.org.name }
      : null,
    repoId: s.commit?.repo?.id || null,
    repoName: s.commit?.repo?.name || null,
    branch: s.branch || null,
    commitSha: s.commit?.sha || null,
    commitMessage: s.commit?.message || null,
    model: s.model,
    agentName: s.agent?.name || null,
    prompt: s.prompt,
    aiTitle: s.aiTitle || null,
    durationMs: s.durationMs,
    costUsd: s.costUsd,
    tokensUsed: s.tokensUsed,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: (s as any).cacheReadTokens ?? 0,
    cacheCreationTokens: (s as any).cacheCreationTokens ?? 0,
    linesAdded: s.linesAdded ?? 0,
    linesRemoved: s.linesRemoved ?? 0,
    filesChanged: s.filesChanged ?? '',
    toolCalls: s.toolCalls ?? 0,
    status: s.status,
    review: s.review ? { status: s.review.status, score: s.review.score ?? null } : null,
    mergedFrom: null,
    mergedInto: s.mergedInto || null,
    parentSessionId: s.parentSessionId || null,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
    createdAt: s.createdAt,
  };
}

// GET /api/me/sessions — federated session list across all member orgs.
router.get('/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const orgIds = await getMemberOrgIds(req);
    if (orgIds.length === 0) {
      return res.json({ sessions: [], total: 0 });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = {
      userId: req.user!.id,
      commit: { repo: { orgId: { in: orgIds } } },
      archived: req.query.archived === 'true' ? true : false,
      mergedInto: null,
    };
    if (req.query.orgId) where.commit.repo.orgId = req.query.orgId as string;
    if (req.query.repoId) where.commit.repoId = req.query.repoId as string;
    if (req.query.model) where.model = req.query.model as string;

    const [sessions, total] = await Promise.all([
      prisma.codingSession.findMany({
        where,
        include: {
          commit: { include: { repo: { include: { org: { select: { id: true, name: true } } } } } },
          agent: true,
          review: true,
        },
        orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.codingSession.count({ where }),
    ]);

    res.json({
      sessions: sessions.map(mapMeSession),
      total,
    });
  } catch (err) {
    console.error('[me/sessions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/me/repos — federated repo list across all member orgs. The UI
// uses this to show "every repo this user has touched or has access to,
// with org context inline." Includes session count so the dashboard can
// rank by activity.
router.get('/repos', async (req: AuthRequest, res: Response) => {
  try {
    const orgIds = await getMemberOrgIds(req);
    if (orgIds.length === 0) {
      return res.json({ repos: [] });
    }

    // For each org, also resolve the user's role + repo-scope restrictions.
    // OWNER/ADMIN see all org repos; MEMBER/REVIEWER are restricted to
    // repos they have an explicit RepoMember row for. Mirrors the access
    // logic in /api/repos so the personal view never shows a repo the
    // user couldn't reach via the org-scoped endpoint.
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.id },
      select: { orgId: true, role: true },
    });
    const adminOrgIds = memberships
      .filter((m) => m.role === 'OWNER' || m.role === 'ADMIN')
      .map((m) => m.orgId);
    const memberOrgIds = memberships
      .filter((m) => m.role !== 'OWNER' && m.role !== 'ADMIN')
      .map((m) => m.orgId);

    // Repos the user can see in non-admin orgs — only those with an
    // explicit membership row.
    const restrictedRepoIds = memberOrgIds.length === 0 ? [] : (
      await prisma.repoMember.findMany({
        where: { userId: req.user!.id, repo: { orgId: { in: memberOrgIds } } },
        select: { repoId: true },
      })
    ).map((rm) => rm.repoId);

    const where: any = {
      OR: [
        ...(adminOrgIds.length > 0 ? [{ orgId: { in: adminOrgIds } }] : []),
        ...(restrictedRepoIds.length > 0 ? [{ id: { in: restrictedRepoIds } }] : []),
      ],
    };
    if (where.OR.length === 0) {
      return res.json({ repos: [] });
    }

    const repos = await prisma.repo.findMany({
      where,
      include: {
        org: { select: { id: true, name: true } },
        // No direct Repo→Session relation in schema (sessions go via
        // commits). _count.commits is cheap and is a reasonable proxy
        // for "activity"; UI can call /api/me/sessions?repoId= for an
        // exact session count when needed.
        _count: { select: { commits: true } },
      },
      orderBy: [{ syncedAt: 'desc' }, { name: 'asc' }],
    });

    res.json({
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        provider: r.provider,
        org: r.org ? { id: r.org.id, name: r.org.name } : null,
        archived: r.archived,
        syncedAt: r.syncedAt,
        commitCount: (r as any)._count?.commits ?? 0,
      })),
    });
  } catch (err) {
    console.error('[me/repos]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/me/spend — daily/weekly/monthly rollup of THIS user's spend
// across every org they belong to, plus a per-org breakdown. This is the
// personal-view counterpart to the org-scoped /api/settings/budget. No
// caps live here — caps belong to the org; the personal view just shows
// "what did you spend".
router.get('/spend', async (req: AuthRequest, res: Response) => {
  try {
    const orgIds = await getMemberOrgIds(req);
    if (orgIds.length === 0) {
      return res.json({
        byPeriod: { daily: 0, weekly: 0, monthly: 0 },
        byOrg: [],
        dailySpend: [],
      });
    }

    const baseWhere = {
      userId: req.user!.id,
      commit: { repo: { orgId: { in: orgIds } } },
    };

    // Three period totals — single agg per window.
    const [dailyAgg, weeklyAgg, monthlyAgg] = await Promise.all([
      prisma.codingSession.aggregate({
        _sum: { costUsd: true },
        where: { ...baseWhere, createdAt: { gte: periodStart('daily') } },
      }),
      prisma.codingSession.aggregate({
        _sum: { costUsd: true },
        where: { ...baseWhere, createdAt: { gte: periodStart('weekly') } },
      }),
      prisma.codingSession.aggregate({
        _sum: { costUsd: true },
        where: { ...baseWhere, createdAt: { gte: periodStart('monthly') } },
      }),
    ]);

    // Per-org breakdown for the active monthly window — answers
    // "where did my month's spend go?" with org names alongside totals.
    // We can't groupBy through the commit→repo→org join in Prisma, so we
    // fetch the rows once and reduce in JS. Capped at 50k for safety on
    // very active users.
    const monthlyRows = await prisma.codingSession.findMany({
      where: { ...baseWhere, createdAt: { gte: periodStart('monthly') } },
      select: {
        costUsd: true,
        commit: { select: { repo: { select: { orgId: true, org: { select: { name: true } } } } } },
      },
      take: 50_000,
    });
    const orgRollup = new Map<string, { orgId: string; orgName: string; cost: number; sessions: number }>();
    for (const r of monthlyRows) {
      const orgId = r.commit?.repo?.orgId;
      const orgName = r.commit?.repo?.org?.name;
      if (!orgId || !orgName) continue;
      const cur = orgRollup.get(orgId) ?? { orgId, orgName, cost: 0, sessions: 0 };
      cur.cost += r.costUsd ?? 0;
      cur.sessions += 1;
      orgRollup.set(orgId, cur);
    }
    const byOrg = Array.from(orgRollup.values()).sort((a, b) => b.cost - a.cost);

    // 30-day daily series — used by the dashboard sparkline.
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const dailyRows = await prisma.codingSession.findMany({
      where: { ...baseWhere, createdAt: { gte: since } },
      select: { costUsd: true, createdAt: true },
      take: 200_000,
      orderBy: { createdAt: 'asc' },
    });
    const byDay: Record<string, number> = {};
    for (const r of dailyRows) {
      const day = r.createdAt.toISOString().split('T')[0];
      byDay[day] = (byDay[day] || 0) + (r.costUsd ?? 0);
    }
    const dailySpend = Object.entries(byDay).map(([date, cost]) => ({ date, cost }));

    res.json({
      byPeriod: {
        daily: dailyAgg._sum.costUsd ?? 0,
        weekly: weeklyAgg._sum.costUsd ?? 0,
        monthly: monthlyAgg._sum.costUsd ?? 0,
      },
      byOrg,
      dailySpend,
    });
  } catch (err) {
    console.error('[me/spend]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
