import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list agents for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { orgId: req.user!.orgId },
      include: { _count: { select: { sessions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(agents);
  } catch (err) {
    console.error('List agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create agent (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug, description, model } = req.body;

    if (!name || !slug || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, model' });
    }

    const agent = await prisma.agent.create({
      data: {
        orgId: req.user!.orgId,
        name,
        slug,
        description: description || null,
        model,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'AGENT_CREATED',
        resource: agent.id,
        metadata: JSON.stringify({ name, slug, model }),
      },
    });

    res.status(201).json(agent);
  } catch (err) {
    console.error('Create agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single agent with recent sessions
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const agent = await prisma.agent.findFirst({
      where: { id, orgId: req.user!.orgId },
      include: {
        sessions: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { commit: true },
        },
      },
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json(agent);
  } catch (err) {
    console.error('Get agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update agent (MEMBER+)
router.put('/:id', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, model, status } = req.body;

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = await prisma.agent.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(model !== undefined && { model }),
        ...(status !== undefined && { status }),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'AGENT_UPDATED',
        resource: id,
        metadata: JSON.stringify({ name, description, model, status }),
      },
    });

    res.json(agent);
  } catch (err) {
    console.error('Update agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete agent (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.user!.orgId },
      include: { _count: { select: { sessions: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Unlink sessions from this agent (don't delete them)
    await prisma.codingSession.updateMany({
      where: { agentId: id },
      data: { agentId: null },
    });

    // Remove agent from policy rules
    await prisma.policyRule.updateMany({
      where: { agentId: id },
      data: { agentId: null },
    });

    await prisma.agent.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'AGENT_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name, sessionsUnlinked: existing._count.sessions }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
