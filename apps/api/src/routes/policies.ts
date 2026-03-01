import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list policies for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const policies = await prisma.policy.findMany({
      where: { orgId: req.user!.orgId },
      include: {
        rules: { include: { agent: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(policies);
  } catch (err) {
    console.error('List policies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create policy (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Missing required fields: name, type' });
    }

    const policy = await prisma.policy.create({
      data: {
        orgId: req.user!.orgId,
        name,
        description: description || null,
        type,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_CREATED',
        resource: policy.id,
        metadata: JSON.stringify({ name, type }),
      },
    });

    res.status(201).json(policy);
  } catch (err) {
    console.error('Create policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update policy (MEMBER+)
router.put('/:id', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, type, active } = req.body;

    const existing = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(type !== undefined && { type }),
        ...(active !== undefined && { active }),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_UPDATED',
        resource: id,
        metadata: JSON.stringify({ name, description, type, active }),
      },
    });

    res.json(policy);
  } catch (err) {
    console.error('Update policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete policy and its rules (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Delete rules first, then policy
    await prisma.policyRule.deleteMany({ where: { policyId: id } });
    await prisma.policy.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/rules — create rule for policy (MEMBER+)
router.post('/:id/rules', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { agentId, condition, action, severity } = req.body;

    if (!condition || !action) {
      return res.status(400).json({ error: 'Missing required fields: condition, action' });
    }

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const rule = await prisma.policyRule.create({
      data: {
        policyId: id,
        agentId: agentId || null,
        condition,
        action,
        severity: severity || 'MEDIUM',
      },
    });

    res.status(201).json(rule);
  } catch (err) {
    console.error('Create rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/rules/:ruleId — delete a single rule (ADMIN+)
router.delete('/:id/rules/:ruleId', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const ruleId = (req.params as any).ruleId as string;

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const rule = await prisma.policyRule.findFirst({
      where: { id: ruleId, policyId: id },
    });

    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await prisma.policyRule.delete({ where: { id: ruleId } });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
