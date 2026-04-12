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

    // Cap at 1000. The admin console is super-admin only, but even so
    // an unbounded scan + the downstream repo/session joins OOMs the
    // route as the customer list grows. 1000 is well above real tenancy
    // today; the search filter is applied client-side after.
    const orgs = await prisma.org.findMany({
      include: {
        users: { select: { id: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    // Gather session counts and total cost per org in bulk
    const orgIds = orgs.map((o) => o.id);

    // Same rationale as the orgs cap — and the session scan below
    // scales with this list, so cap hard.
    const repos = await prisma.repo.findMany({
      where: { orgId: { in: orgIds } },
      select: { id: true, orgId: true },
      take: 50_000,
    });

    const repoIdsByOrg = new Map<string, string[]>();
    for (const r of repos) {
      const list = repoIdsByOrg.get(r.orgId) ?? [];
      list.push(r.id);
      repoIdsByOrg.set(r.orgId, list);
    }

    // Get session stats grouped by org
    const allRepoIds = repos.map((r) => r.id);
    // Cap the session scan. Global aggregate over every session ever
    // created is unbounded; a 500k sample is still representative for
    // directional stats and keeps the admin console responsive.
    const sessions = await prisma.codingSession.findMany({
      where: { commit: { repoId: { in: allRepoIds } } },
      select: { costUsd: true, commit: { select: { repoId: true } } },
      take: 500_000,
      orderBy: { createdAt: 'desc' },
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

    // Cap at 5000 users. Unbounded global user scans OOM the admin
    // console as the product grows; 5000 comfortably covers today's
    // userbase with room to spare.
    const users = await prisma.user.findMany({
      include: {
        org: { select: { name: true, slug: true } },
        _count: { select: { sessions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    // Get last active (most recent session) per user. Cap the underlying
    // scan too — we only need enough rows to hit every listed user's
    // latest session once, and the dedupe loop below naturally ignores
    // older rows. 200k is generous for a 5k-user page.
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

    let result = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      orgName: u.org.name,
      orgSlug: u.org.slug,
      role: u.role,
      accountType: u.accountType,
      sessionCount: u._count.sessions,
      lastActive: lastActiveMap.get(u.id) ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
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

    // Wrap all deletes in a transaction so a mid-cascade failure doesn't
    // leave the org in a partially-deleted state (orphaned rows, broken FKs).
    await prisma.$transaction(async (tx) => {
      // Delete deepest leaves first
      if (sessionIds.length > 0) {
        await tx.promptChange.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.secretFinding.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sessionDiff.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sessionReview.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await tx.sharedSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
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
      if (userIds.length > 0) {
        await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
        await tx.sessionReview.deleteMany({ where: { userId: { in: userIds } } });
        await tx.sessionBookmark.deleteMany({ where: { userId: { in: userIds } } });
        await tx.authToken.deleteMany({ where: { userId: { in: userIds } } });
      }

      // Delete mid-level records
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
      await tx.user.deleteMany({ where: { orgId: id } });

      // Finally delete the org
      await tx.org.delete({ where: { id } });
    }, { timeout: 60_000 }); // generous timeout for large orgs
    res.status(204).end();
  } catch (err) {
    console.error('Admin DELETE /orgs/:id error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to delete organization';
    res.status(500).json({ error: msg });
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

    const user = await prisma.user.findUnique({ where: { id }, select: { orgId: true, accountType: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if this is the last user in the org
    const orgUserCount = await prisma.user.count({ where: { orgId: user.orgId } });

    // Wrap in transaction to avoid partial deletes on failure
    await prisma.$transaction(async (tx) => {
      // Clean up user-level FK references
      await tx.notification.deleteMany({ where: { userId: id } });
      await tx.sessionBookmark.deleteMany({ where: { userId: id } });
      await tx.authToken.deleteMany({ where: { userId: id } });
      await tx.sessionReview.deleteMany({ where: { userId: id } });
      await tx.auditLog.deleteMany({ where: { userId: id } });
      await tx.apiKey.deleteMany({ where: { userId: id } });
      await tx.codingSession.updateMany({ where: { userId: id }, data: { userId: null } });

      await tx.user.delete({ where: { id } });

      // If last user in org (solo user), clean up the entire org
      if (orgUserCount <= 1) {
        const orgId = user.orgId;
        // Delete org-level data in dependency order
        await tx.trailSession.deleteMany({ where: { trail: { orgId } } });
        await tx.trail.deleteMany({ where: { orgId } });
        await tx.sharedSession.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.promptChange.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.sessionDiff.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.sessionReview.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.codingSession.deleteMany({ where: { commit: { repo: { orgId } } } });
        await tx.commit.deleteMany({ where: { repo: { orgId } } });
        await tx.secretFinding.deleteMany({ where: { session: { commit: { repo: { orgId } } } } });
        await tx.pullRequest.deleteMany({ where: { repo: { orgId } } });
        await tx.webhook.deleteMany({ where: { repo: { orgId } } });
        await tx.apiKeyRepoScope.deleteMany({ where: { repo: { orgId } } });
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

// ---------------------------------------------------------------------------
// GET /check — verify super-admin status (used by frontend to show/hide nav)
// ---------------------------------------------------------------------------
router.get('/check', async (_req: AuthRequest, res: Response) => {
  res.json({ isSuperAdmin: true });
});

// POST /api/admin/fix-orphaned-keys — assign orphaned keys *in the same org
// as the target user* to that user. Even as a super-admin action, the old
// behavior — updateMany({where:{userId:null}}) — would sweep every orphaned
// key across *every* org onto one user, which is almost never what the
// operator wants and turns a routine cleanup into accidental cross-tenant
// data comingling. Scope by org of the target user.
router.post('/fix-orphaned-keys', async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId } = req.body as { targetUserId: string };
    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ error: 'targetUserId required' });
    }
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, orgId: true },
    });
    if (!targetUser) {
      return res.status(404).json({ error: 'target user not found' });
    }
    const result = await prisma.apiKey.updateMany({
      where: { userId: null, orgId: targetUser.orgId },
      data: { userId: targetUserId },
    });
    res.json({ updated: result.count, orgId: targetUser.orgId });
  } catch (err) {
    console.error('Admin fix-orphaned-keys error:', err);
    res.status(500).json({ error: 'Failed to fix orphaned keys' });
  }
});

export default router;
