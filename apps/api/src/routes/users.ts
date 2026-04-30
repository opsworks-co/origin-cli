import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

const VALID_ROLES = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];

// All endpoints below operate on org members — i.e. rows in `Membership`
// joined with `User`. With multi-org, "remove member" detaches the user
// from this org rather than deleting the user; "list members" enumerates
// memberships rather than users-by-orgId; role lives on Membership.

// GET / — list org members with activity stats
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const memberships = await prisma.membership.findMany({
      where: { orgId },
      select: {
        role: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            createdAt: true,
            apiKeys: {
              where: { orgId },
              select: { keyPrefix: true },
              take: 1,
              orderBy: { createdAt: 'desc' },
            },
            _count: { select: { reviews: true, sessions: true } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
      take: 5000,
    });

    const userIds = memberships.map((m) => m.user.id);

    const [costAggs, lastSessions] = await Promise.all([
      prisma.codingSession.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _sum: { costUsd: true, linesAdded: true },
      }),
      prisma.codingSession.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _max: { createdAt: true },
      }),
    ]);
    const costMap = new Map(costAggs.map((c) => [c.userId, c]));
    const lastSessionMap = new Map(lastSessions.map((s) => [s.userId, s._max.createdAt]));

    const members = memberships.map((m) => {
      const u = m.user;
      const costs = costMap.get(u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: m.role,
        createdAt: u.createdAt,
        joinedAt: m.joinedAt,
        sessions: u._count.sessions,
        reviews: u._count.reviews,
        totalCost: parseFloat((costs?._sum.costUsd || 0).toFixed(2)),
        linesAdded: costs?._sum.linesAdded || 0,
        lastActive: lastSessionMap.get(u.id) || u.createdAt,
        keyPrefix: u.apiKeys[0]?.keyPrefix || null,
      };
    });

    res.json({ users: members });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/access — every repo + agent in the active org with the
// target user's effective level on each. Org OWNER/ADMIN show as
// `inherited: true` on every row. Used by the IAM "Manage access" page
// so an admin can see the full access matrix in one shot.
router.get('/:id/access', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const id = req.params.id as string;

    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: id, orgId } },
      select: { role: true },
    });
    if (!membership) return res.status(404).json({ error: 'User not found in this org' });

    const inheritsAll = membership.role === 'OWNER' || membership.role === 'ADMIN';

    const [repos, agents, repoGrants, agentGrants] = await Promise.all([
      prisma.repo.findMany({
        where: { orgId, archived: false },
        select: { id: true, name: true, path: true, provider: true },
        orderBy: { name: 'asc' },
      }),
      prisma.agent.findMany({
        where: { orgId },
        select: { id: true, name: true, slug: true, model: true },
        orderBy: { name: 'asc' },
      }),
      prisma.repoMember.findMany({
        where: { userId: id, repo: { orgId } },
        select: { repoId: true, level: true },
      }),
      prisma.agentMember.findMany({
        where: { userId: id, agent: { orgId } },
        select: { agentId: true, level: true },
      }),
    ]);

    const repoLevelById = new Map(repoGrants.map((g) => [g.repoId, g.level]));
    const agentLevelById = new Map(agentGrants.map((g) => [g.agentId, g.level]));

    res.json({
      orgRole: membership.role,
      inheritsAll,
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        provider: r.provider,
        level: inheritsAll ? 'admin' : (repoLevelById.get(r.id) ?? null),
        inherited: inheritsAll,
      })),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        model: a.model,
        level: inheritsAll ? 'admin' : (agentLevelById.get(a.id) ?? null),
        inherited: inheritsAll,
      })),
    });
  } catch (err) {
    console.error('Get user access error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — user detail with recent sessions, reviews, audit
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const id = req.params.id as string;

    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: id, orgId } },
      select: {
        role: true,
        user: {
          select: {
            id: true, name: true, email: true, createdAt: true,
          },
        },
      },
    });
    if (!membership) return res.status(404).json({ error: 'User not found' });

    const [sessionCount, reviewCount, costAgg] = await Promise.all([
      prisma.codingSession.count({ where: { userId: id } }),
      prisma.sessionReview.count({ where: { userId: id } }),
      prisma.codingSession.aggregate({
        where: { userId: id },
        _sum: { costUsd: true, linesAdded: true, linesRemoved: true, tokensUsed: true },
      }),
    ]);

    const recentSessions = await prisma.codingSession.findMany({
      where: { userId: id },
      include: {
        commit: { include: { repo: true } },
        agent: true,
        review: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const recentReviews = await prisma.sessionReview.findMany({
      where: { userId: id },
      include: {
        session: { include: { commit: { include: { repo: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const recentAudit = await prisma.auditLog.findMany({
      where: { userId: id, orgId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({
      user: {
        ...membership.user,
        role: membership.role,
        stats: {
          sessions: sessionCount,
          reviews: reviewCount,
          totalCost: parseFloat((costAgg._sum.costUsd || 0).toFixed(2)),
          linesAdded: costAgg._sum.linesAdded || 0,
          linesRemoved: costAgg._sum.linesRemoved || 0,
          tokensUsed: costAgg._sum.tokensUsed || 0,
        },
      },
      sessions: recentSessions.map((s) => ({
        id: s.id,
        model: s.model,
        repoName: s.commit?.repo?.name || null,
        commitMessage: s.commit?.message || null,
        costUsd: s.costUsd,
        tokensUsed: s.tokensUsed,
        linesAdded: s.linesAdded,
        createdAt: s.createdAt,
        review: s.review ? { status: s.review.status, note: s.review.note } : null,
      })),
      reviews: recentReviews.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        status: r.status,
        note: r.note,
        repoName: r.session?.commit?.repo?.name || null,
        commitMessage: r.session?.commit?.message || null,
        createdAt: r.createdAt,
      })),
      audit: recentAudit.map((a) => ({
        id: a.id,
        action: a.action,
        resource: a.resource,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /:id/role — update a member's role in the active org.
router.patch('/:id/role', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const targetId = req.params.id as string;
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid role. Must be VIEWER, MEMBER, ADMIN, or OWNER' });
    }
    if (targetId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const target = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetId, orgId } },
      include: { user: { select: { email: true } } },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'OWNER' && role.toUpperCase() !== 'OWNER') {
      const ownerCount = await prisma.membership.count({ where: { orgId, role: 'OWNER' } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last owner' });
      }
    }

    await prisma.membership.update({
      where: { userId_orgId: { userId: targetId, orgId } },
      data: { role: role.toUpperCase() },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_ROLE_CHANGED',
        resource: targetId,
        metadata: JSON.stringify({ from: target.role, to: role.toUpperCase(), targetEmail: target.user.email }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — remove member from this org. Does NOT delete the user; they
// may be a member of other orgs. Cleans up only this-org-scoped resources
// (api keys, audit log entries) and unlinks sessions in this org.
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const targetId = req.params.id as string;

    if (targetId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    const target = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetId, orgId } },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.role === 'OWNER') {
      const ownerCount = await prisma.membership.count({ where: { orgId, role: 'OWNER' } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner' });
      }
    }

    // Org-scoped cleanup: drop their API keys for this org, drop the
    // membership row. Do NOT touch User, AuthToken, SessionBookmark, or
    // sessions/reviews — those may belong to other orgs the user is in.
    await prisma.apiKey.deleteMany({ where: { userId: targetId, orgId } });
    await prisma.membership.delete({
      where: { userId_orgId: { userId: targetId, orgId } },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_REMOVED',
        resource: targetId,
        metadata: JSON.stringify({ email: target.user.email, name: target.user.name, role: target.role }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /add-member — direct creation: User (if new) + Membership + API key.
router.post('/add-member', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const { name, email, role, repoIds, agentIds } = req.body;

    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const memberRole = (role || 'MEMBER').toUpperCase();
    if (!['VIEWER', 'MEMBER', 'ADMIN'].includes(memberRole)) {
      return res.status(400).json({ error: 'Invalid role. Must be VIEWER, MEMBER, or ADMIN.' });
    }

    if (repoIds && Array.isArray(repoIds) && repoIds.length > 0) {
      const validRepos = await prisma.repo.findMany({
        where: { orgId, id: { in: repoIds } },
        select: { id: true },
      });
      if (validRepos.length !== repoIds.length) {
        return res.status(400).json({ error: 'One or more repos do not belong to your organization' });
      }
    }
    if (agentIds && Array.isArray(agentIds) && agentIds.length > 0) {
      const validAgents = await prisma.agent.findMany({
        where: { orgId, id: { in: agentIds } },
        select: { id: true },
      });
      if (validAgents.length !== agentIds.length) {
        return res.status(400).json({ error: 'One or more agents do not belong to your organization' });
      }
    }

    let userId: string;
    let userCreated = false;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // User exists globally — just create the membership if they're not
      // already in this org. This is the multi-org happy path: an admin
      // adds a teammate who already has an Origin account elsewhere.
      const existingMembership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: existing.id, orgId } },
      });
      if (existingMembership) {
        return res.status(409).json({ error: 'User with this email is already a member' });
      }
      userId = existing.id;
      await prisma.membership.create({
        data: { userId, orgId, role: memberRole },
      });
    } else {
      // New user — create with placeholder password (they'll log in via
      // API key or be invited to set a password later).
      const placeholderHash = crypto.randomBytes(32).toString('hex');
      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { name, email, passwordHash: placeholderHash, accountType: 'org' },
        });
        await tx.membership.create({
          data: { userId: u.id, orgId, role: memberRole },
        });
        return u;
      });
      userId = created.id;
      userCreated = true;
    }

    const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 14);

    const repoScopeIds: string[] = (repoIds && Array.isArray(repoIds)) ? repoIds : [];
    const agentScopeIds: string[] = (agentIds && Array.isArray(agentIds)) ? agentIds : [];

    await prisma.apiKey.create({
      data: {
        orgId,
        userId,
        name: `${name}'s key`,
        keyHash,
        keyPrefix,
        role: null,
        repoScopes: { create: repoScopeIds.map((repoId: string) => ({ repoId })) },
        agentScopes: { create: agentScopeIds.map((agentId: string) => ({ agentId })) },
      },
    });

    // Beyond the API-key scoping above, also create RepoMember/AgentMember
    // rows so the new user has actual *human* access to the same set of
    // resources their key can talk to. Org OWNER/ADMIN don't need rows
    // (they inherit), so we only write them for MEMBER/VIEWER.
    if (memberRole !== 'OWNER' && memberRole !== 'ADMIN') {
      const repoLevel = (typeof req.body.repoLevel === 'string' && ['read', 'write', 'admin'].includes(req.body.repoLevel))
        ? req.body.repoLevel
        : 'write';
      const agentLevel = (typeof req.body.agentLevel === 'string' && ['use', 'admin'].includes(req.body.agentLevel))
        ? req.body.agentLevel
        : 'use';
      for (const repoId of repoScopeIds) {
        try {
          await prisma.repoMember.upsert({
            where: { userId_repoId: { userId, repoId } },
            update: { level: repoLevel, grantedBy: req.user!.id },
            create: { userId, repoId, level: repoLevel, grantedBy: req.user!.id },
          });
        } catch { /* skip on race */ }
      }
      for (const agentId of agentScopeIds) {
        try {
          await prisma.agentMember.upsert({
            where: { userId_agentId: { userId, agentId } },
            update: { level: agentLevel, grantedBy: req.user!.id },
            create: { userId, agentId, level: agentLevel, grantedBy: req.user!.id },
          });
        } catch { /* skip on race */ }
      }
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_ADDED',
        resource: userId,
        metadata: JSON.stringify({
          email, name, role: memberRole, userCreated,
          repos: repoScopeIds.length, agents: agentScopeIds.length,
        }),
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    res.status(201).json({
      user: { ...user, role: memberRole },
      apiKey: rawKey,
      keyPrefix,
    });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/regenerate-key', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const targetId = req.params.id as string;

    const target = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetId, orgId } },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    await prisma.apiKey.deleteMany({ where: { userId: targetId, orgId } });

    const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 14);

    const allRepos = await prisma.repo.findMany({ where: { orgId }, select: { id: true } });
    const allAgents = await prisma.agent.findMany({ where: { orgId }, select: { id: true } });

    await prisma.apiKey.create({
      data: {
        orgId,
        userId: targetId,
        name: `${target.user.name}'s key`,
        keyHash,
        keyPrefix,
        role: null,
        repoScopes: { create: allRepos.map((r) => ({ repoId: r.id })) },
        agentScopes: { create: allAgents.map((a) => ({ agentId: a.id })) },
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_KEY_REGENERATED',
        resource: targetId,
        metadata: JSON.stringify({ email: target.user.email, name: target.user.name }),
      },
    });

    res.json({ apiKey: rawKey, keyPrefix });
  } catch (err) {
    console.error('Regenerate key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/revoke-key', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const targetId = req.params.id as string;

    const target = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetId, orgId } },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    await prisma.apiKey.deleteMany({ where: { userId: targetId, orgId } });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_KEY_REVOKED',
        resource: targetId,
        metadata: JSON.stringify({ email: target.user.email, name: target.user.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Revoke key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Invitations ─────────────────────────────────────────────

router.post('/invite', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const { email, role } = req.body;
    const inviteRole = (role || 'MEMBER').toUpperCase();

    if (!VALID_ROLES.includes(inviteRole)) return res.status(400).json({ error: 'Invalid role' });
    if (inviteRole === 'OWNER') {
      return res.status(400).json({ error: 'Cannot invite as owner. Invite as admin and promote later.' });
    }

    if (email) {
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        const existingMembership = await prisma.membership.findUnique({
          where: { userId_orgId: { userId: existingUser.id, orgId } },
        });
        if (existingMembership) {
          return res.status(409).json({ error: 'User with this email is already a member' });
        }
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await prisma.invitation.create({
      data: {
        orgId,
        email: email || null,
        role: inviteRole,
        token,
        createdBy: req.user!.id,
        expiresAt,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'INVITATION_CREATED',
        resource: invitation.id,
        metadata: JSON.stringify({ email, role: inviteRole }),
      },
    });

    res.status(201).json({
      id: invitation.id,
      token,
      role: inviteRole,
      email: email || null,
      expiresAt,
    });
  } catch (err) {
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/invites', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const invites = await prisma.invitation.findMany({
      where: {
        orgId: req.activeOrgId!,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      invites: invites.map((i) => ({
        id: i.id, token: i.token, email: i.email, role: i.role,
        createdAt: i.createdAt, expiresAt: i.expiresAt,
      })),
    });
  } catch (err) {
    console.error('List invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/invites/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const invite = await prisma.invitation.findFirst({
      where: { id, orgId: req.activeOrgId!, usedAt: null },
    });
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    const { count } = await prisma.invitation.deleteMany({
      where: { id, orgId: req.activeOrgId! },
    });
    if (count === 0) return res.status(404).json({ error: 'Invitation not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('Cancel invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Per-(user, model) budget overrides ─────────────────────────────────────
// Membership-scoped target validation: a user belongs to the active org iff
// a Membership row exists for (userId, orgId). Same IDOR-safe pattern as
// before.

async function isMemberOfActiveOrg(userId: string, orgId: string): Promise<boolean> {
  const m = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  return !!m;
}

router.get('/:id/models', async (req: AuthRequest, res: Response) => {
  try {
    if (!await isMemberOfActiveOrg(req.params.id as string, req.activeOrgId!)) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }
    const models = await prisma.userModelLimit.findMany({
      where: { userId: req.params.id as string },
      orderBy: { model: 'asc' },
    });
    res.json(models);
  } catch (err) {
    console.error('List user models error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/models', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    if (!await isMemberOfActiveOrg(req.params.id as string, req.activeOrgId!)) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }
    const { model, monthlyLimit, tokenLimit, maxCostPerSession, maxTokensPerSession } = req.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'model is required' });
    }
    if (model.length > 200) return res.status(413).json({ error: 'model exceeds max length of 200' });
    try {
      const created = await prisma.userModelLimit.create({
        data: {
          userId: req.params.id as string,
          model: model.trim(),
          monthlyLimit: typeof monthlyLimit === 'number' && monthlyLimit > 0 ? monthlyLimit : null,
          tokenLimit: typeof tokenLimit === 'number' && tokenLimit > 0 ? tokenLimit : null,
          maxCostPerSession: typeof maxCostPerSession === 'number' && maxCostPerSession > 0 ? maxCostPerSession : null,
          maxTokensPerSession: typeof maxTokensPerSession === 'number' && maxTokensPerSession > 0 ? maxTokensPerSession : null,
        },
      });
      res.json(created);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return res.status(409).json({ error: 'Model already configured for this user. PUT to update.' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Create user model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    if (!await isMemberOfActiveOrg(req.params.id as string, req.activeOrgId!)) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }
    const model = decodeURIComponent(req.params.modelKey as string);
    const data: Record<string, unknown> = {};
    const body = req.body || {};
    for (const key of ['monthlyLimit', 'tokenLimit', 'maxCostPerSession', 'maxTokensPerSession'] as const) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const v = body[key];
        data[key] = typeof v === 'number' && v > 0 ? v : null;
      }
    }
    try {
      const updated = await prisma.userModelLimit.update({
        where: { userId_model: { userId: req.params.id as string, model } },
        data,
      });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === 'P2025') return res.status(404).json({ error: 'Model not configured for this user' });
      throw e;
    }
  } catch (err) {
    console.error('Update user model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    if (!await isMemberOfActiveOrg(req.params.id as string, req.activeOrgId!)) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }
    const model = decodeURIComponent(req.params.modelKey as string);
    try {
      await prisma.userModelLimit.delete({
        where: { userId_model: { userId: req.params.id as string, model } },
      });
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.code === 'P2025') return res.status(404).json({ error: 'Model not configured for this user' });
      throw e;
    }
  } catch (err) {
    console.error('Delete user model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
