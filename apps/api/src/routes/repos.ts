import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { syncCheckpoints } from '../services/checkpoint.js';

const router = Router();
router.use(requireAuth);

// GET / — list repos for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const repos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId },
      include: { _count: { select: { commits: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(repos);
  } catch (err) {
    console.error('List repos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create repo (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, path, provider } = req.body;

    if (!name || !path) {
      return res.status(400).json({ error: 'Missing required fields: name, path' });
    }

    const repo = await prisma.repo.create({
      data: {
        orgId: req.user!.orgId,
        name,
        path,
        provider: provider || 'local',
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_CREATED',
        resource: repo.id,
        metadata: JSON.stringify({ name, path, provider }),
      },
    });

    res.status(201).json(repo);
  } catch (err) {
    console.error('Create repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/sync — sync a repo
router.post('/:id/sync', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const result = await syncCheckpoints(repo);

    await prisma.repo.update({
      where: { id },
      data: { syncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_SYNCED',
        resource: repo.id,
        metadata: JSON.stringify({ synced: result.synced, total: result.total }),
      },
    });

    res.json(result);
  } catch (err) {
    console.error('Sync repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single repo
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
      include: { _count: { select: { commits: true } } },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    res.json(repo);
  } catch (err) {
    console.error('Get repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update repo
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, path, provider } = req.body;

    const existing = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    const repo = await prisma.repo.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(path !== undefined && { path }),
        ...(provider !== undefined && { provider }),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_UPDATED',
        resource: id,
        metadata: JSON.stringify({ name, path, provider }),
      },
    });

    res.json(repo);
  } catch (err) {
    console.error('Update repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete repo and all commits/sessions (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    // Delete in order: reviews -> sessions -> commits -> repo
    const commits = await prisma.commit.findMany({ where: { repoId: id }, select: { id: true } });
    const commitIds = commits.map((c) => c.id);

    if (commitIds.length > 0) {
      await prisma.sessionReview.deleteMany({
        where: { session: { commitId: { in: commitIds } } },
      });
      await prisma.codingSession.deleteMany({
        where: { commitId: { in: commitIds } },
      });
      await prisma.commit.deleteMany({ where: { repoId: id } });
    }

    await prisma.repo.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/commits — list commits for a repo
router.get('/:id/commits', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: { session: true },
      orderBy: { committedAt: 'desc' },
    });

    res.json(commits);
  } catch (err) {
    console.error('List commits error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
