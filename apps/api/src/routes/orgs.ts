import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { seedCatalogForOrg } from '../services/seed-catalog.js';
import { sendEmail } from '../services/email.js';
import { buildWelcomeEmailHTML } from '../services/email-templates.js';

const router = Router();

// Endpoints below operate on the *user's set of orgs* — listing, creating,
// leaving, and picking a default. They are intentionally NOT scoped to any
// single active org (no resolveOrgContext); each one is gated by membership
// of the affected org instead.
//
// requireAuth is attached per-route rather than via router.use(...), because
// this router is mounted at the API root (so it can own /me/* and /orgs/*
// directly). A router-wide requireAuth would otherwise swallow every other
// /api/* request before its real router could see it.

// GET /api/me/memberships — full list of orgs the user belongs to.
router.get('/me/memberships', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.id },
      select: {
        role: true,
        joinedAt: true,
        org: { select: { id: true, name: true, slug: true, type: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    res.json(
      memberships.map((m) => ({
        orgId: m.org.id,
        name: m.org.name,
        slug: m.org.slug,
        type: m.org.type,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    );
  } catch (err) {
    console.error('List memberships error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/me/active-org — update the sticky default org for this user.
// Pure UX hint; every request still validates membership independently.
router.post('/me/active-org', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = req.body as { orgId?: string };
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ error: 'orgId is required' });
    }
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user!.id, orgId } },
      select: { orgId: true },
    });
    if (!membership) return res.status(403).json({ error: 'Not a member of that org' });

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { lastOrgId: orgId },
    });
    res.json({ activeOrgId: orgId });
  } catch (err) {
    console.error('Set active org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/orgs — create a new team org and make caller its OWNER.
router.post('/orgs', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug } = req.body as { name?: string; slug?: string };
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Slug: derive from name if not provided. Suffix with random hex on
    // collision rather than rejecting — keeps the create path single-shot.
    const baseSlug = (slug && /^[a-z0-9-]+$/.test(slug.trim())
      ? slug.trim()
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org');
    let finalSlug = baseSlug;
    let attempt = 0;
    while (await prisma.org.findUnique({ where: { slug: finalSlug } })) {
      attempt++;
      finalSlug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;
      if (attempt > 5) {
        return res.status(409).json({ error: 'Could not allocate a unique slug; please pass one explicitly' });
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const org = await tx.org.create({
        data: { name: name.trim(), slug: finalSlug, type: 'team' },
      });
      await tx.membership.create({
        data: { userId: req.user!.id, orgId: org.id, role: 'OWNER' },
      });
      // Bump accountType — once a developer creates a team org, they're a
      // multi-org user and should see the team-style layout when on it.
      await tx.user.update({
        where: { id: req.user!.id },
        data: { accountType: 'org', lastOrgId: org.id },
      });
      await seedCatalogForOrg(org.id, tx);
      return org;
    });

    // Welcome email — fire-and-forget. Confirms the new workspace is
    // ready and surfaces the dashboard link from inbox. Never blocks the
    // create response.
    const fresh = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, name: true },
    });
    if (fresh?.email) {
      sendEmail(
        fresh.email,
        `New workspace ready — ${created.name}`,
        buildWelcomeEmailHTML({ name: fresh.name || 'there', orgName: created.name, kind: 'extra-org' }),
      ).catch((e) => console.error('[create-org] welcome email failed:', e?.message || e));
    }

    res.status(201).json({
      orgId: created.id,
      name: created.name,
      slug: created.slug,
      type: created.type,
      role: 'OWNER',
    });
  } catch (err) {
    console.error('Create org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/orgs/:id/leave — drop the caller's membership in the given org.
// Refused for the last OWNER (org would be ownerless) and for personal orgs
// (the user's own workspace shouldn't be detachable; deleting the user
// account handles that path instead).
router.post('/orgs/:id/leave', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.params.id as string;
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: req.user!.id, orgId } },
      include: { org: { select: { type: true } } },
    });
    if (!membership) return res.status(404).json({ error: 'Not a member of that org' });

    if (membership.org.type === 'personal') {
      return res.status(400).json({ error: 'Cannot leave your personal workspace' });
    }

    if (membership.role === 'OWNER') {
      const otherOwners = await prisma.membership.count({
        where: { orgId, role: 'OWNER', userId: { not: req.user!.id } },
      });
      if (otherOwners === 0) {
        return res.status(400).json({ error: 'Promote another owner before leaving' });
      }
    }

    await prisma.membership.delete({
      where: { userId_orgId: { userId: req.user!.id, orgId } },
    });

    // If the user was sitting on this org as their lastOrgId, clear it so
    // the next request picks any other membership.
    await prisma.user.updateMany({
      where: { id: req.user!.id, lastOrgId: orgId },
      data: { lastOrgId: null },
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'MEMBER_LEFT',
        resource: req.user!.id,
        metadata: JSON.stringify({}),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Leave org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
