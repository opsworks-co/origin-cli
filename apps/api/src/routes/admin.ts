import { Router, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Super-admin middleware
// Checks that the authenticated user's email is in the SUPER_ADMINS env var
// (comma-separated list of emails, e.g. "alice@example.com,bob@example.com").
// ---------------------------------------------------------------------------
function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const superAdmins = (process.env.SUPER_ADMINS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (superAdmins.length === 0) {
    return res.status(403).json({ error: 'No super-admins configured' });
  }

  // Look up the user's email from the DB (the JWT only contains id/orgId/role)
  prisma.user
    .findUnique({ where: { id: req.user.id }, select: { email: true } })
    .then((user) => {
      if (!user || !superAdmins.includes(user.email.toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden: super-admin access required' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'Failed to verify super-admin status' }));
}

router.use(requireAuth);
router.use(requireSuperAdmin);

// ---------------------------------------------------------------------------
// GET /orgs — list all organizations with aggregate stats
// ---------------------------------------------------------------------------
router.get('/orgs', async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.search as string) ?? '').toLowerCase();

    const orgs = await prisma.org.findMany({
      include: {
        users: { select: { id: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Gather session counts and total cost per org in bulk
    const orgIds = orgs.map((o) => o.id);

    // Get repo IDs per org for session lookups
    const repos = await prisma.repo.findMany({
      where: { orgId: { in: orgIds } },
      select: { id: true, orgId: true },
    });

    const repoIdsByOrg = new Map<string, string[]>();
    for (const r of repos) {
      const list = repoIdsByOrg.get(r.orgId) ?? [];
      list.push(r.id);
      repoIdsByOrg.set(r.orgId, list);
    }

    // Get session stats grouped by org
    const allRepoIds = repos.map((r) => r.id);
    const sessions = await prisma.codingSession.findMany({
      where: { commit: { repoId: { in: allRepoIds } } },
      select: { costUsd: true, commit: { select: { repoId: true } } },
    });

    // Build a map: orgId -> { sessionCount, totalCost }
    const repoToOrg = new Map<string, string>();
    for (const r of repos) repoToOrg.set(r.id, r.orgId);

    const orgStats = new Map<string, { sessionCount: number; totalCost: number }>();
    for (const s of sessions) {
      const oId = repoToOrg.get(s.commit.repoId);
      if (!oId) continue;
      const stats = orgStats.get(oId) ?? { sessionCount: 0, totalCost: 0 };
      stats.sessionCount++;
      stats.totalCost += s.costUsd;
      orgStats.set(oId, stats);
    }

    let result = orgs.map((o) => {
      const stats = orgStats.get(o.id) ?? { sessionCount: 0, totalCost: 0 };
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        memberCount: o._count.users,
        sessionCount: stats.sessionCount,
        totalCost: Math.round(stats.totalCost * 100) / 100,
        createdAt: o.createdAt,
      };
    });

    if (search) {
      result = result.filter(
        (o) =>
          o.name.toLowerCase().includes(search) ||
          o.slug.toLowerCase().includes(search),
      );
    }

    res.json(result);
  } catch (err) {
    console.error('Admin /orgs error:', err);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// ---------------------------------------------------------------------------
// GET /users — list all users with aggregate stats
// ---------------------------------------------------------------------------
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.search as string) ?? '').toLowerCase();

    const users = await prisma.user.findMany({
      include: {
        org: { select: { name: true, slug: true } },
        _count: { select: { sessions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get last active (most recent session) per user
    const userIds = users.map((u) => u.id);
    const latestSessions = await prisma.codingSession.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const lastActiveMap = new Map<string, Date>();
    for (const s of latestSessions) {
      if (s.userId && !lastActiveMap.has(s.userId)) {
        lastActiveMap.set(s.userId, s.createdAt);
      }
    }

    let result = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      orgName: u.org.name,
      orgSlug: u.org.slug,
      role: u.role,
      sessionCount: u._count.sessions,
      lastActive: lastActiveMap.get(u.id) ?? null,
      createdAt: u.createdAt,
    }));

    if (search) {
      result = result.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search) ||
          u.orgName.toLowerCase().includes(search),
      );
    }

    res.json(result);
  } catch (err) {
    console.error('Admin /users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ---------------------------------------------------------------------------
// GET /check — verify super-admin status (used by frontend to show/hide nav)
// ---------------------------------------------------------------------------
router.get('/check', async (_req: AuthRequest, res: Response) => {
  res.json({ isSuperAdmin: true });
});

export default router;
