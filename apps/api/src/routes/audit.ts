import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list audit logs for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = { orgId };

    if (req.query.action) {
      where.action = req.query.action as string;
    }

    if (req.query.userId) {
      where.userId = req.query.userId as string;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const entries = logs.map((l) => ({
      id: l.id,
      userId: l.userId,
      userName: l.user?.name || null,
      action: l.action,
      resource: l.resource,
      metadata: l.metadata,
      createdAt: l.createdAt,
    }));

    res.json({ entries, total });
  } catch (err) {
    console.error('List audit logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /bulk — delete specific audit entries by ID (admin only)
router.delete('/bulk', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    const result = await prisma.auditLog.deleteMany({
      where: {
        id: { in: ids },
        orgId: req.user!.orgId,
      },
    });

    res.json({ deleted: result.count });
  } catch (err) {
    console.error('Bulk delete audit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
