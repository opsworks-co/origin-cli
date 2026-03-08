import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const VALID_ROLES = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];

// GET / — list org members with activity stats
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    const users = await prisma.user.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            reviews: true,
            sessions: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Get cost and last active per user
    const userIds = users.map((u) => u.id);

    const costAggs = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _sum: { costUsd: true, linesAdded: true },
    });
    const costMap = new Map(costAggs.map((c) => [c.userId, c]));

    // Last session date per user
    const lastSessions = await prisma.codingSession.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _max: { createdAt: true },
    });
    const lastSessionMap = new Map(lastSessions.map((s) => [s.userId, s._max.createdAt]));

    const members = users.map((u) => {
      const costs = costMap.get(u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
        sessions: u._count.sessions,
        reviews: u._count.reviews,
        totalCost: parseFloat((costs?._sum.costUsd || 0).toFixed(2)),
        linesAdded: costs?._sum.linesAdded || 0,
        lastActive: lastSessionMap.get(u.id) || u.createdAt,
      };
    });

    res.json({ users: members });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — user detail with recent sessions, reviews, audit
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;

    const user = await prisma.user.findFirst({
      where: { id, orgId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Stats
    const [sessionCount, reviewCount, costAgg] = await Promise.all([
      prisma.codingSession.count({ where: { userId: id } }),
      prisma.sessionReview.count({ where: { userId: id } }),
      prisma.codingSession.aggregate({
        where: { userId: id },
        _sum: { costUsd: true, linesAdded: true, linesRemoved: true, tokensUsed: true },
      }),
    ]);

    // Recent sessions
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

    // Recent reviews
    const recentReviews = await prisma.sessionReview.findMany({
      where: { userId: id },
      include: {
        session: {
          include: { commit: { include: { repo: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Recent audit activity
    const recentAudit = await prisma.auditLog.findMany({
      where: { userId: id, orgId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({
      user: {
        ...user,
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
        review: s.review
          ? { status: s.review.status, note: s.review.note }
          : null,
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

// ── Team Management ─────────────────────────────────────────

// PATCH /:id/role — update member role
router.patch('/:id/role', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const targetId = req.params.id as string;
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid role. Must be VIEWER, MEMBER, ADMIN, or OWNER' });
    }

    // Can't change own role
    if (targetId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const target = await prisma.user.findFirst({ where: { id: targetId, orgId } });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Can't demote the last OWNER
    if (target.role === 'OWNER' && role.toUpperCase() !== 'OWNER') {
      const ownerCount = await prisma.user.count({ where: { orgId, role: 'OWNER' } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last owner' });
      }
    }

    await prisma.user.update({
      where: { id: targetId },
      data: { role: role.toUpperCase() },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_ROLE_CHANGED',
        resource: targetId,
        metadata: JSON.stringify({ from: target.role, to: role.toUpperCase(), targetEmail: target.email }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — remove member
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const targetId = req.params.id as string;

    if (targetId === req.user!.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    const target = await prisma.user.findFirst({ where: { id: targetId, orgId } });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.role === 'OWNER') {
      const ownerCount = await prisma.user.count({ where: { orgId, role: 'OWNER' } });
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner' });
      }
    }

    // Clean up related records before deleting user
    await prisma.notification.deleteMany({ where: { userId: targetId } });
    await prisma.apiKey.deleteMany({ where: { userId: targetId } });
    await prisma.sessionReview.deleteMany({ where: { userId: targetId } });
    await prisma.auditLog.deleteMany({ where: { userId: targetId } });
    // Unlink sessions (keep them, just remove user reference)
    await prisma.codingSession.updateMany({ where: { userId: targetId }, data: { userId: null } });

    await prisma.user.delete({ where: { id: targetId } });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_REMOVED',
        resource: targetId,
        metadata: JSON.stringify({ email: target.email, name: target.name, role: target.role }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Invitations ─────────────────────────────────────────────

// POST /invite — create invitation link
router.post('/invite', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { email, role } = req.body;
    const inviteRole = (role || 'MEMBER').toUpperCase();

    if (!VALID_ROLES.includes(inviteRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Don't allow inviting as OWNER
    if (inviteRole === 'OWNER') {
      return res.status(400).json({ error: 'Cannot invite as owner. Invite as admin and promote later.' });
    }

    // Check if email already exists in org
    if (email) {
      const existing = await prisma.user.findFirst({ where: { email, orgId } });
      if (existing) {
        return res.status(409).json({ error: 'User with this email is already a member' });
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

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

// GET /invites — list pending invitations
router.get('/invites', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const invites = await prisma.invitation.findMany({
      where: {
        orgId: req.user!.orgId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      invites: invites.map((i) => ({
        id: i.id,
        token: i.token,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      })),
    });
  } catch (err) {
    console.error('List invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /invites/:id — cancel invitation
router.delete('/invites/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const invite = await prisma.invitation.findFirst({
      where: { id, orgId: req.user!.orgId, usedAt: null },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    await prisma.invitation.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) {
    console.error('Cancel invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
