import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { describeCondition, describeAction, policyTypeLabel } from '../utils/policy-descriptions.js';

const router = Router();

// GET /:orgSlug — public policy summary (no auth required)
router.get('/:orgSlug', async (req: Request, res: Response) => {
  try {
    const orgSlug = req.params.orgSlug as string;

    const org = await prisma.org.findUnique({
      where: { slug: orgSlug },
      select: { id: true, name: true, slug: true },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const policies = await prisma.policy.findMany({
      where: { orgId: org.id, active: true },
      include: { rules: true },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = policies.map((p) => ({
      name: p.name,
      description: p.description,
      type: p.type,
      typeLabel: policyTypeLabel(p.type),
      rules: p.rules.map((r) => {
        const desc = describeCondition(p.type, r.condition);
        return {
          summary: desc.summary,
          fixHint: desc.fixHint,
          action: r.action,
          actionLabel: describeAction(r.action),
          severity: r.severity,
        };
      }),
    }));

    res.json({
      orgName: org.name,
      orgSlug: org.slug,
      policies: formatted,
    });
  } catch (err) {
    console.error('Public policies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
