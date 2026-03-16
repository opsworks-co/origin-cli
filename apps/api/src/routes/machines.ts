import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list machines for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const machines = await prisma.machine.findMany({
      where: { orgId: req.user!.orgId },
      orderBy: { lastSeenAt: 'desc' },
    });
    res.json(machines);
  } catch (err) {
    console.error('List machines error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single machine detail
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const machine = await prisma.machine.findFirst({
      where: { id: req.params.id as string, orgId: req.user!.orgId },
      include: {
        policyRules: {
          include: {
            policy: { select: { id: true, name: true, type: true, active: true } },
          },
        },
      },
    });
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    res.json(machine);
  } catch (err) {
    console.error('Get machine error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — register a machine (upsert by machineId)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { hostname, machineId, detectedTools } = req.body;

    if (!hostname || !machineId) {
      return res.status(400).json({ error: 'Missing required fields: hostname, machineId' });
    }

    const machine = await prisma.machine.upsert({
      where: { machineId },
      create: {
        orgId: req.user!.orgId,
        hostname,
        machineId,
        detectedTools: detectedTools ? JSON.stringify(detectedTools) : '[]',
        lastSeenAt: new Date(),
      },
      update: {
        hostname,
        detectedTools: detectedTools ? JSON.stringify(detectedTools) : '[]',
        lastSeenAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'MACHINE_REGISTERED',
        resource: machine.id,
        metadata: JSON.stringify({ hostname, machineId }),
      },
    });

    res.json(machine);
  } catch (err) {
    console.error('Register machine error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete a machine
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const machine = await prisma.machine.findFirst({
      where: { id: req.params.id as string, orgId: req.user!.orgId },
    });
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    await prisma.machine.delete({ where: { id: machine.id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'MACHINE_DELETED',
        resource: machine.id,
        metadata: JSON.stringify({ hostname: machine.hostname, machineId: machine.machineId }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete machine error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
