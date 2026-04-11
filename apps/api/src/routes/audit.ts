import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { parseLimit, parseOffset } from '../utils/validate.js';

const router = Router();
router.use(requireAuth);

// GET / — list audit logs for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const limit = parseLimit(req.query.limit, 100, 500);
    const offset = parseOffset(req.query.offset);

    const where: any = { orgId };

    if (req.query.action) {
      where.action = req.query.action as string;
    }

    // Only admins/owners can filter audit logs by arbitrary userId.
    // Non-privileged users are forced to see only their own entries —
    // otherwise any org member could snoop on a coworker's audit trail
    // just by passing `?userId=<coworker-id>`.
    const role = (req.user!.role || '').toUpperCase();
    const canViewOthers = role === 'ADMIN' || role === 'OWNER';
    if (req.query.userId) {
      const requestedUserId = req.query.userId as string;
      if (!canViewOthers && requestedUserId !== req.user!.id) {
        return res.status(403).json({ error: 'Insufficient permissions to view other users\' audit logs' });
      }
      where.userId = requestedUserId;
    } else if (!canViewOthers) {
      where.userId = req.user!.id;
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

// Audit logs are append-only — no deletion endpoint.
// This is intentional: audit trails must be immutable for governance compliance.

export default router;
