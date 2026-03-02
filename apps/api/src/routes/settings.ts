import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

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
      select: { id: true, name: true, keyPrefix: true, createdAt: true },
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

export default router;
