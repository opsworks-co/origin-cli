import { Router, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Super-admin middleware
// Checks that the authenticated user's email is in the SUPER_ADMINS env var
// (comma-separated list of emails, e.g. "alice@example.com,bob@example.com").
// ---------------------------------------------------------------------------
async function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const superAdmins = (process.env.SUPER_ADMINS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (superAdmins.length === 0) {
    return res.status(403).json({ error: 'No super-admins configured' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
    if (!user || !superAdmins.includes(user.email.toLowerCase())) {
      return res.status(403).json({ error: 'Forbidden: super-admin access required' });
    }
    next();
  } catch {
    return res.status(500).json({ error: 'Failed to verify super-admin status' });
  }
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
// PUT /orgs/:id — update organization name
// ---------------------------------------------------------------------------
router.put('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const org = await prisma.org.update({
      where: { id },
      data: { name: name.trim() },
    });
    res.json({ id: org.id, name: org.name, slug: org.slug });
  } catch (err) {
    console.error('Admin PUT /orgs/:id error:', err);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /orgs/:id — delete an organization and all related data
// ---------------------------------------------------------------------------
router.delete('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    // Collect IDs for cascading deletes
    const repos = await prisma.repo.findMany({ where: { orgId: id }, select: { id: true } });
    const repoIds = repos.map(r => r.id);
    const agents = await prisma.agent.findMany({ where: { orgId: id }, select: { id: true } });
    const agentIds = agents.map(a => a.id);
    const policies = await prisma.policy.findMany({ where: { orgId: id }, select: { id: true } });
    const policyIds = policies.map(p => p.id);
    const trails = await prisma.trail.findMany({ where: { orgId: id }, select: { id: true } });
    const trailIds = trails.map(t => t.id);
    const users = await prisma.user.findMany({ where: { orgId: id }, select: { id: true } });
    const userIds = users.map(u => u.id);
    const apiKeys = await prisma.apiKey.findMany({ where: { orgId: id }, select: { id: true } });
    const apiKeyIds = apiKeys.map(k => k.id);

    // Sessions are linked via commits -> repos, or via agentId/userId
    const commits = repoIds.length > 0
      ? await prisma.commit.findMany({ where: { repoId: { in: repoIds } }, select: { id: true } })
      : [];
    const commitIds = commits.map(c => c.id);
    const sessions = commitIds.length > 0
      ? await prisma.codingSession.findMany({ where: { commitId: { in: commitIds } }, select: { id: true } })
      : [];
    const sessionIds = sessions.map(s => s.id);

    // Delete deepest leaves first
    if (sessionIds.length > 0) {
      await prisma.promptChange.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.secretFinding.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.sessionDiff.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.sessionReview.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.sharedSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await prisma.codingSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    if (trailIds.length > 0) {
      await prisma.trailSession.deleteMany({ where: { trailId: { in: trailIds } } });
    }
    if (repoIds.length > 0) {
      // Delete commits that aren't primary for any session (those sessions are already deleted)
      await prisma.commit.deleteMany({ where: { repoId: { in: repoIds } } });
      await prisma.pullRequest.deleteMany({ where: { repoId: { in: repoIds } } });
      await prisma.webhook.deleteMany({ where: { repoId: { in: repoIds } } });
    }
    if (agentIds.length > 0) {
      await prisma.agentVersion.deleteMany({ where: { agentId: { in: agentIds } } });
    }
    if (policyIds.length > 0) {
      await prisma.policyRule.deleteMany({ where: { policyId: { in: policyIds } } });
      await prisma.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
      await prisma.policyAssignment.deleteMany({ where: { policyId: { in: policyIds } } });
    }
    if (apiKeyIds.length > 0) {
      await prisma.apiKeyAgentScope.deleteMany({ where: { apiKeyId: { in: apiKeyIds } } });
      await prisma.apiKeyRepoScope.deleteMany({ where: { apiKeyId: { in: apiKeyIds } } });
    }
    if (userIds.length > 0) {
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.sessionReview.deleteMany({ where: { userId: { in: userIds } } });
    }

    // Delete mid-level records
    await prisma.trail.deleteMany({ where: { orgId: id } });
    await prisma.apiKey.deleteMany({ where: { orgId: id } });
    await prisma.agent.deleteMany({ where: { orgId: id } });
    await prisma.policy.deleteMany({ where: { orgId: id } });
    await prisma.repo.deleteMany({ where: { orgId: id } });
    await prisma.machine.deleteMany({ where: { orgId: id } });
    await prisma.invitation.deleteMany({ where: { orgId: id } });
    await prisma.integrationConfig.deleteMany({ where: { orgId: id } });
    await prisma.auditLog.deleteMany({ where: { orgId: id } });
    await prisma.notification.deleteMany({ where: { orgId: id } });
    await prisma.user.deleteMany({ where: { orgId: id } });

    // Finally delete the org
    await prisma.org.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    console.error('Admin DELETE /orgs/:id error:', err);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

// ---------------------------------------------------------------------------
// PUT /users/:id/role — update a user's role (super-admin level)
// ---------------------------------------------------------------------------
router.put('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { role } = req.body as { role?: string };
    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }
    const validRoles = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    if (!validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }
    const user = await prisma.user.update({
      where: { id },
      data: { role: role.toUpperCase() },
      select: { id: true, name: true, email: true, role: true },
    });
    res.json(user);
  } catch (err) {
    console.error('Admin PUT /users/:id/role error:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /users/:id — delete a user (super-admin level)
// ---------------------------------------------------------------------------
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    // Clean up all foreign key references before deleting
    await prisma.notification.deleteMany({ where: { userId: id } });
    await prisma.apiKey.deleteMany({ where: { userId: id } });
    await prisma.sessionReview.deleteMany({ where: { userId: id } });
    await prisma.auditLog.deleteMany({ where: { userId: id } });
    await prisma.codingSession.updateMany({ where: { userId: id }, data: { userId: null } });
    await prisma.user.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    console.error('Admin DELETE /users/:id error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ---------------------------------------------------------------------------
// GET /check — verify super-admin status (used by frontend to show/hide nav)
// ---------------------------------------------------------------------------
router.get('/check', async (_req: AuthRequest, res: Response) => {
  res.json({ isSuperAdmin: true });
});

// POST /api/admin/fix-orphaned-keys — assign all userId-null keys to a target user
router.post('/fix-orphaned-keys', async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId } = req.body as { targetUserId: string };
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
    const result = await prisma.apiKey.updateMany({
      where: { userId: null },
      data: { userId: targetUserId },
    });
    res.json({ updated: result.count });
  } catch (err) {
    console.error('Admin fix-orphaned-keys error:', err);
    res.status(500).json({ error: 'Failed to fix orphaned keys' });
  }
});

export default router;
