import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getBudgetConfig, saveBudgetConfig, getMonthlySpend, getDailySpend, getSpendByModel, getSpendByUser } from '../services/budget.js';

const router = Router();
router.use(requireAuth);

interface AuthRequest extends Request {
  user?: { id: string; orgId: string; role: string };
}

// GET /api/settings/api-keys
router.get('/api-keys', async (req: AuthRequest, res: Response) => {
  try {
    const keys = await prisma.apiKey.findMany({
      where: { orgId: req.user!.orgId },
      select: {
        id: true, name: true, keyPrefix: true, createdAt: true,
        userId: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(keys);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/api-keys
router.post('/api-keys', async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;
    const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 14);

    const key = await prisma.apiKey.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        name: name || 'API Key',
        keyHash,
        keyPrefix,
      },
    });

    res.json({ id: key.id, name: key.name, keyPrefix: key.keyPrefix, key: rawKey, createdAt: key.createdAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/settings/api-keys/:id
router.delete('/api-keys/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.apiKey.deleteMany({
      where: { id, orgId: req.user!.orgId },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Budget / Cost Controls ──────────────────────────────────────────────────

// GET /api/settings/budget — get budget config + current spend
router.get('/budget', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const [config, spent, dailySpend, spendByModel, spendByUser] = await Promise.all([
      getBudgetConfig(orgId),
      getMonthlySpend(orgId),
      getDailySpend(orgId),
      getSpendByModel(orgId),
      getSpendByUser(orgId),
    ]);

    const percentage = config.monthlyLimit > 0 ? (spent / config.monthlyLimit) * 100 : 0;

    res.json({
      config,
      currentSpend: {
        monthly: spent,
        percentage,
        dailySpend,
        byModel: spendByModel,
        byUser: spendByUser,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/budget — update budget config
router.put('/budget', async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { monthlyLimit, alertThresholds, blockOnExceed } = req.body;
    const config = await saveBudgetConfig(req.user!.orgId, {
      ...(monthlyLimit !== undefined && { monthlyLimit }),
      ...(alertThresholds !== undefined && { alertThresholds }),
      ...(blockOnExceed !== undefined && { blockOnExceed }),
      alertedAt: [], // Reset alerts when config changes
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'BUDGET_UPDATED',
        resource: 'budget',
        metadata: JSON.stringify({ monthlyLimit, alertThresholds, blockOnExceed }),
      },
    });

    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Organization Settings ───────────────────────────────────────────────────

// GET /api/settings/org — get org details
router.get('/org', async (req: AuthRequest, res: Response) => {
  try {
    const org = await prisma.org.findUnique({
      where: { id: req.user!.orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { users: true, repos: true, agents: true, policies: true } },
      },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ org });
  } catch (err) {
    console.error('Get org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/org — update org settings (admin/owner only)
router.put('/org', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { name, slug } = req.body;

    if (!name && !slug) {
      return res.status(400).json({ error: 'At least one field (name or slug) is required' });
    }

    // Validate slug format
    if (slug) {
      const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
      if (slug.length < 2 || slug.length > 48 || !slugRegex.test(slug)) {
        return res.status(400).json({
          error: 'Slug must be 2-48 characters, lowercase alphanumeric with hyphens, and cannot start/end with a hyphen',
        });
      }

      // Check slug uniqueness (exclude current org)
      const existing = await prisma.org.findFirst({
        where: { slug, id: { not: orgId } },
      });
      if (existing) {
        return res.status(409).json({ error: 'This slug is already taken' });
      }
    }

    // Validate name
    if (name && (name.length < 1 || name.length > 100)) {
      return res.status(400).json({ error: 'Organization name must be 1-100 characters' });
    }

    const updateData: any = {};
    if (name) updateData.name = name.trim();
    if (slug) updateData.slug = slug.trim().toLowerCase();

    const org = await prisma.org.update({
      where: { id: orgId },
      data: updateData,
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'ORG_UPDATED',
        resource: 'org',
        metadata: JSON.stringify({ name: org.name, slug: org.slug }),
      },
    });

    res.json({ org });
  } catch (err) {
    console.error('Update org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
