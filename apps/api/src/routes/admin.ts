import { Router, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';

const router = Router();

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
router.use(resolveOrgContext);
router.use(requireSuperAdmin);

// GET /orgs — list all organizations with aggregate stats
router.get('/orgs', async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.search as string) ?? '').toLowerCase();

    const orgs = await prisma.org.findMany({
      include: {
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    const orgIds = orgs.map((o) => o.id);

    const repos = await prisma.repo.findMany({
      where: { orgId: { in: orgIds } },
      select: { id: true, orgId: true },
      take: 50_000,
    });

    const allRepoIds = repos.map((r) => r.id);
    const sessions = await prisma.codingSession.findMany({
      where: { commit: { repoId: { in: allRepoIds } } },
      select: { costUsd: true, commit: { select: { repoId: true } } },
      take: 500_000,
      orderBy: { createdAt: 'desc' },
    });

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
        type: o.type,
        memberCount: o._count.memberships,
        sessionCount: stats.sessionCount,
        totalCost: Math.round(stats.totalCost * 100) / 100,
        createdAt: o.createdAt,
      };
    });

    if (search) {
      result = result.filter(
        (o) => o.name.toLowerCase().includes(search) || o.slug.toLowerCase().includes(search),
      );
    }

    res.json(result);
  } catch (err) {
    console.error('Admin /orgs error:', err);
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// GET /users — list users + their memberships (for super-admin overview).
// A user with multiple orgs will appear with multiple membership entries.
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const search = ((req.query.search as string) ?? '').toLowerCase();

    const users = await prisma.user.findMany({
      include: {
        memberships: {
          include: { org: { select: { name: true, slug: true } } },
        },
        _count: { select: { sessions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const userIds = users.map((u) => u.id);
    const latestSessions = await prisma.codingSession.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200_000,
    });

    const lastActiveMap = new Map<string, Date>();
    for (const s of latestSessions) {
      if (s.userId && !lastActiveMap.has(s.userId)) {
        lastActiveMap.set(s.userId, s.createdAt);
      }
    }

    let result = users.map((u) => {
      const orgs = u.memberships.map((m) => ({
        orgId: m.orgId,
        orgName: m.org.name,
        orgSlug: m.org.slug,
        role: m.role,
      }));
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        // Legacy fields kept for the admin UI's existing columns. Pick the
        // first org as the "primary" — multi-org admins can drill into the
        // user detail page to see all memberships.
        orgName: orgs[0]?.orgName || '(no org)',
        orgSlug: orgs[0]?.orgSlug || '',
        role: orgs[0]?.role || '—',
        accountType: u.accountType,
        memberships: orgs,
        sessionCount: u._count.sessions,
        lastActive: lastActiveMap.get(u.id) ?? null,
        lastLoginAt: u.lastLoginAt ?? null,
        createdAt: u.createdAt,
      };
    });

    if (search) {
      result = result.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search) ||
          u.orgName.toLowerCase().includes(search) ||
          u.memberships.some((m) => m.orgName.toLowerCase().includes(search)),
      );
    }

    res.json(result);
  } catch (err) {
    console.error('Admin /users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.put('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
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

router.delete('/orgs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repos = await prisma.repo.findMany({ where: { orgId: id }, select: { id: true } });
    const repoIds = repos.map((r) => r.id);
    const agents = await prisma.agent.findMany({ where: { orgId: id }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);
    const policies = await prisma.policy.findMany({ where: { orgId: id }, select: { id: true } });
    const policyIds = policies.map((p) => p.id);
    const trails = await prisma.trail.findMany({ where: { orgId: id }, select: { id: true } });
    const trailIds = trails.map((t) => t.id);
    const apiKeys = await prisma.apiKey.findMany({ where: { orgId: id }, select: { id: true } });
    const apiKeyIds = apiKeys.map((k) => k.id);

    const commits = repoIds.length > 0
      ? await prisma.commit.findMany({ where: { repoId: { in: repoIds } }, select: { id: true } })
      : [];
    const commitIds = commits.map((c) => c.id);
    const sessions = commitIds.length > 0
      ? await prisma.codingSession.findMany({ where: { commitId: { in: commitIds } }, select: { id: true } })
      : [];
    const sessionIds = sessions.map((s) => s.id);

    await prisma.$transaction(async (tx) => {
      if (sessionIds.length > 0) {
        await tx.promptChange.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.secretFinding.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sessionDiff.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sessionReview.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sharedSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.issueSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.codingSession.deleteMany({ where: { id: { in: sessionIds } } });
      }
      if (trailIds.length > 0) {
        await tx.trailSession.deleteMany({ where: { trailId: { in: trailIds } } });
      }
      if (repoIds.length > 0) {
        await tx.commit.deleteMany({ where: { repoId: { in: repoIds } } });
        await tx.pullRequest.deleteMany({ where: { repoId: { in: repoIds } } });
        await tx.webhook.deleteMany({ where: { repoId: { in: repoIds } } });
      }
      if (agentIds.length > 0) {
        await tx.agentVersion.deleteMany({ where: { agentId: { in: agentIds } } });
      }
      if (policyIds.length > 0) {
        await tx.policyRule.deleteMany({ where: { policyId: { in: policyIds } } });
        await tx.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
        await tx.policyAssignment.deleteMany({ where: { policyId: { in: policyIds } } });
      }
      if (apiKeyIds.length > 0) {
        await tx.apiKeyAgentScope.deleteMany({ where: { apiKeyId: { in: apiKeyIds } } });
        await tx.apiKeyRepoScope.deleteMany({ where: { apiKeyId: { in: apiKeyIds } } });
      }
      // Drop memberships in this org. Users themselves stay — they may
      // be in other orgs. (Super-admin who really wants to wipe the user
      // can use DELETE /users/:id afterward.)
      await tx.membership.deleteMany({ where: { orgId: id } });

      await tx.trail.deleteMany({ where: { orgId: id } });
      await tx.apiKey.deleteMany({ where: { orgId: id } });
      await tx.agent.deleteMany({ where: { orgId: id } });
      await tx.policy.deleteMany({ where: { orgId: id } });
      await tx.repo.deleteMany({ where: { orgId: id } });
      await tx.machine.deleteMany({ where: { orgId: id } });
      await tx.invitation.deleteMany({ where: { orgId: id } });
      await tx.integrationConfig.deleteMany({ where: { orgId: id } });
      await tx.auditLog.deleteMany({ where: { orgId: id } });
      await tx.notification.deleteMany({ where: { orgId: id } });

      await tx.org.delete({ where: { id } });
    }, { timeout: 60_000 });
    res.status(204).end();
  } catch (err) {
    console.error('Admin DELETE /orgs/:id error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to delete organization';
    res.status(500).json({ error: msg });
  }
});

// PUT /users/:id/role — super-admin role override. With multi-org, role is
// per-org, so the body now requires `orgId` to disambiguate which
// membership to update.
router.put('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { role, orgId } = req.body as { role?: string; orgId?: string };
    if (!role) return res.status(400).json({ error: 'Role is required' });
    if (!orgId) return res.status(400).json({ error: 'orgId is required (role is per-org now)' });
    const validRoles = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    if (!validRoles.includes(role.toUpperCase())) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const updated = await prisma.membership.update({
      where: { userId_orgId: { userId: id, orgId } },
      data: { role: role.toUpperCase() },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    res.json({
      ...updated.user,
      role: updated.role,
      orgId: updated.orgId,
    });
  } catch (err) {
    console.error('Admin PUT /users/:id/role error:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// DELETE /users/:id — fully delete a user. With multi-org, we drop all of
// the user's memberships first; their personal org (if it has no other
// owners) is also wiped.
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        accountType: true,
        memberships: { select: { orgId: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userOrgIds = user.memberships.map((m) => m.orgId);

    // Identify orgs that would be left ownerless after this user is gone.
    // For solo (personal) workspaces this is always the user's own org.
    const orgsToWipe: string[] = [];
    for (const orgId of userOrgIds) {
      const otherOwners = await prisma.membership.count({
        where: { orgId, role: 'OWNER', userId: { not: id } },
      });
      if (otherOwners === 0) {
        orgsToWipe.push(orgId);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.notification.deleteMany({ where: { userId: id } });
      await tx.sessionBookmark.deleteMany({ where: { userId: id } });
      await tx.authToken.deleteMany({ where: { userId: id } });
      await tx.sessionReview.deleteMany({ where: { userId: id } });
      await tx.auditLog.deleteMany({ where: { userId: id } });
      await tx.apiKey.deleteMany({ where: { userId: id } });
      await tx.codingSession.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.membership.deleteMany({ where: { userId: id } });

      await tx.user.delete({ where: { id } });

      for (const orgId of orgsToWipe) {
        await tx.trailSession.deleteMany({ where: { trail: { orgId } } });
        await tx.trail.deleteMany({ where: { orgId } });
        await tx.sharedSession.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.promptChange.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.sessionDiff.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.sessionReview.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.secretFinding.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.issueSession.deleteMany({ where: { issue: { repo: { orgId } } } });
        await tx.sessionBookmark.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.codingSession.deleteMany({ where: { commit: { repo: { orgId } } } });
        await tx.commit.deleteMany({ where: { repo: { orgId } } });
        await tx.pullRequest.deleteMany({ where: { repo: { orgId } } });
        await tx.webhook.deleteMany({ where: { repo: { orgId } } });
        await tx.apiKeyRepoScope.deleteMany({ where: { repo: { orgId } } });
        await tx.issue.deleteMany({ where: { repo: { orgId } } });
        await tx.repo.deleteMany({ where: { orgId } });
        await tx.policyAssignment.deleteMany({ where: { policy: { orgId } } });
        await tx.policyRule.deleteMany({ where: { policy: { orgId } } });
        await tx.policyVersion.deleteMany({ where: { policy: { orgId } } });
        await tx.policy.deleteMany({ where: { orgId } });
        await tx.apiKeyAgentScope.deleteMany({ where: { agent: { orgId } } });
        await tx.agentVersion.deleteMany({ where: { agent: { orgId } } });
        await tx.agent.deleteMany({ where: { orgId } });
        await tx.machine.deleteMany({ where: { orgId } });
        await tx.integrationConfig.deleteMany({ where: { orgId } });
        await tx.invitation.deleteMany({ where: { orgId } });
        await tx.notification.deleteMany({ where: { orgId } });
        await tx.auditLog.deleteMany({ where: { orgId } });
        await tx.apiKey.deleteMany({ where: { orgId } });
        await tx.membership.deleteMany({ where: { orgId } });
        await tx.org.delete({ where: { id: orgId } });
      }
    }, { timeout: 60_000 });

    res.status(204).end();
  } catch (err) {
    console.error('Admin DELETE /users/:id error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to delete user';
    res.status(500).json({ error: msg });
  }
});

router.get('/check', async (_req: AuthRequest, res: Response) => {
  res.json({ isSuperAdmin: true });
});

// POST /api/admin/fix-orphaned-keys — assign orphaned API keys (no userId)
// to a target user, scoped to one of the user's orgs. The target user must
// already be a member of the org the keys belong to.
router.post('/fix-orphaned-keys', async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId, orgId } = req.body as { targetUserId?: string; orgId?: string };
    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ error: 'targetUserId required' });
    }
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ error: 'orgId required (which org to claim keys in)' });
    }
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      select: { userId: true },
    });
    if (!membership) {
      return res.status(404).json({ error: 'User is not a member of that org' });
    }
    const result = await prisma.apiKey.updateMany({
      where: { userId: null, orgId },
      data: { userId: targetUserId },
    });
    res.json({ updated: result.count, orgId });
  } catch (err) {
    console.error('Admin fix-orphaned-keys error:', err);
    res.status(500).json({ error: 'Failed to fix orphaned keys' });
  }
});

export default router;
