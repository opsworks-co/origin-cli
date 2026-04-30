import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext } from '../middleware/auth.js';
import { safeParseObject } from '../utils/safe-json.js';
import { parseLimit, parseOffset } from '../utils/validate.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// GET / — list notifications for current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const limit = parseLimit(req.query.limit, 50, 200);
    const offset = parseOffset(req.query.offset);
    const unreadOnly = req.query.unread === 'true';

    const where: any = { userId };
    if (unreadOnly) where.read = false;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({
      notifications: notifications.map(n => ({
        ...n,
        // Previously a bare JSON.parse — one bad row would throw synchronously
        // and 500 the whole list response, hiding every other notification.
        metadata: safeParseObject(n.metadata, `notification.${n.id}.metadata`),
      })),
      total,
    });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /unread-count — quick count for badge
router.get('/unread-count', async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user!.id, read: false },
    });
    res.json({ count });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id/read — mark single notification as read
router.put('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    // Defense in depth: use updateMany with a compound (id, userId) where
    // instead of a precheck-then-update-by-id pattern. The Notification
    // schema has no compound unique, so update({ where: { id } }) would
    // silently succeed even if a future refactor dropped the precheck,
    // letting any authenticated user mark any other user's notifications
    // as read by guessing the UUID. updateMany scopes authorization at
    // the DB call itself.
    const result = await prisma.notification.updateMany({
      where: { id, userId: req.user!.id },
      data: { read: true, readAt: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const updated = await prisma.notification.findFirst({
      where: { id, userId: req.user!.id },
    });

    res.json(updated);
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /read-all — mark all notifications as read
router.put('/read-all', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, read: false },
      data: { read: true, readAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
