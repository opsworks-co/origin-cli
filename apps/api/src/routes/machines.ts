import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list machines for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const machines = await prisma.machine.findMany({
      where: { orgId: req.user!.orgId },
      orderBy: { lastSeenAt: 'desc' },
      take: 500,
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

    // Dedup: find existing machines with same hostname in same org and merge
    const existingByHostname = await prisma.machine.findMany({
      where: { orgId: req.user!.orgId, hostname },
    });

    let machine;
    if (existingByHostname.length > 0) {
      // Keep the first one, delete extras (dedup)
      const keep = existingByHostname[0];
      if (existingByHostname.length > 1) {
        const extraIds = existingByHostname.slice(1).map(m => m.id);
        // Reassign any policy rules from extras to the kept machine
        await prisma.policyRule.updateMany({
          where: { machineId: { in: extraIds } },
          data: { machineId: keep.id },
        });
        // Defense in depth: include orgId in the delete scope. extraIds
        // already came from an org-scoped findMany, but a compound where
        // here means no future refactor can accidentally turn this into
        // a cross-org mass delete if the source query changes.
        await prisma.machine.deleteMany({
          where: { id: { in: extraIds }, orgId: req.user!.orgId },
        });
      }
      // Update the kept machine
      machine = await prisma.machine.update({
        where: { id: keep.id },
        data: {
          machineId,
          detectedTools: detectedTools ? JSON.stringify(detectedTools) : '[]',
          lastSeenAt: new Date(),
        },
      });
    } else {
      // No existing by hostname — upsert by machineId
      machine = await prisma.machine.upsert({
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
    }

    // Audit log — userId may not be a valid User for standalone API keys, so wrap in try
    try {
      await prisma.auditLog.create({
        data: {
          orgId: req.user!.orgId,
          userId: req.user!.id,
          action: 'MACHINE_REGISTERED',
          resource: machine.id,
          metadata: JSON.stringify({ hostname, machineId }),
        },
      });
    } catch {
      // FK constraint fails for standalone API keys — log without userId
      await prisma.auditLog.create({
        data: {
          orgId: req.user!.orgId,
          action: 'MACHINE_REGISTERED',
          resource: machine.id,
          metadata: JSON.stringify({ hostname, machineId }),
        },
      });
    }

    res.json(machine);
  } catch (err: any) {
    console.error('Register machine error:', err);
    // Map only the one known actionable error (stale API key → deleted org)
    // to a client-visible hint. Everything else returns a generic error so
    // we don't leak Prisma error codes, SQL state, or stack context.
    if (err?.code === 'P2003') {
      return res.status(400).json({
        error: 'Organization not found — your API key may be linked to a deleted org.',
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete a machine (admin only — deleting a machine
// disrupts any sessions tied to it and wipes its policy state, so regular
// members shouldn't be able to do it org-wide).
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const machine = await prisma.machine.findFirst({
      where: { id: req.params.id as string, orgId: req.user!.orgId },
    });
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    // deleteMany with compound (id, orgId) enforces org scope at the DB
    // call even if the precheck above is ever dropped.
    const deleted = await prisma.machine.deleteMany({
      where: { id: machine.id, orgId: req.user!.orgId },
    });
    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    try {
      await prisma.auditLog.create({
        data: {
          orgId: req.user!.orgId,
          userId: req.user!.id,
          action: 'MACHINE_DELETED',
          resource: machine.id,
          metadata: JSON.stringify({ hostname: machine.hostname, machineId: machine.machineId }),
        },
      });
    } catch {
      await prisma.auditLog.create({
        data: {
          orgId: req.user!.orgId,
          action: 'MACHINE_DELETED',
          resource: machine.id,
          metadata: JSON.stringify({ hostname: machine.hostname, machineId: machine.machineId }),
        },
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete machine error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
