import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

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

    const logs = await prisma.auditLog.findMany({
      where,
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    res.json(logs);
  } catch (err) {
    console.error('List audit logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
