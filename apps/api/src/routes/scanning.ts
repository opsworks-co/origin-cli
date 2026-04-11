import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — list all secret findings for the org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { severity, type } = req.query;

    // Get all repo IDs for this org
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    const findings = await prisma.secretFinding.findMany({
      where: {
        session: { commit: { repoId: { in: repoIds } } },
        ...(severity ? { severity: severity as string } : {}),
        ...(type ? { type: type as string } : {}),
      },
      include: {
        session: {
          select: {
            id: true,
            model: true,
            createdAt: true,
            commit: { select: { repo: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json(findings);
  } catch (err) {
    console.error('List findings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /session/:sessionId — findings for a specific session
router.get('/session/:sessionId', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.sessionId as string;

    // Defense-in-depth: scope the lookup via the repo join so a future
    // refactor that drops the post-hoc orgId check still can't leak.
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId,
        commit: { repo: { orgId: req.user!.orgId } },
      },
      select: { id: true },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const findings = await prisma.secretFinding.findMany({
      where: { sessionId },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 5000,
    });

    res.json(findings);
  } catch (err) {
    console.error('Session findings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /stats — aggregate counts by type and severity
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    const byType = await prisma.secretFinding.groupBy({
      by: ['type'],
      where: {
        session: { commit: { repoId: { in: repoIds } } },
      },
      _count: true,
    });

    const bySeverity = await prisma.secretFinding.groupBy({
      by: ['severity'],
      where: {
        session: { commit: { repoId: { in: repoIds } } },
      },
      _count: true,
    });

    const total = await prisma.secretFinding.count({
      where: {
        session: { commit: { repoId: { in: repoIds } } },
      },
    });

    res.json({
      total,
      byType: byType.map((g) => ({ type: g.type, count: g._count })),
      bySeverity: bySeverity.map((g) => ({ severity: g.severity, count: g._count })),
    });
  } catch (err) {
    console.error('Scanning stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
