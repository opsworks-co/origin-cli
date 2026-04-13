import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Helper: serialize Issue for API response
function mapIssue(issue: any) {
  return {
    ...issue,
    labels: JSON.parse(issue.labels || '[]'),
    deps: JSON.parse(issue.deps || '[]'),
    sessions: issue.issueSessions?.map((is: any) => ({
      sessionId: is.sessionId,
      model: is.session?.model,
      costUsd: is.session?.costUsd ?? 0,
      tokensUsed: is.session?.tokensUsed ?? 0,
      durationMs: is.session?.durationMs ?? 0,
      linesAdded: is.session?.linesAdded ?? 0,
      linesRemoved: is.session?.linesRemoved ?? 0,
      createdAt: is.session?.createdAt,
    })) || [],
  };
}

// GET /api/repos/:repoId/issues
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId } = req.params as any;
    const { status, priority, type, label } = req.query;

    const where: any = { repoId };
    if (status) where.status = status as string;
    if (priority) where.priority = parseInt(priority as string, 10);
    if (type) where.type = type as string;

    let issues = await prisma.issue.findMany({
      where,
      include: {
        issueSessions: {
          include: {
            session: {
              select: { id: true, model: true, costUsd: true, tokensUsed: true, durationMs: true, linesAdded: true, linesRemoved: true, createdAt: true },
            },
          },
        },
      },
      orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
    });

    if (label) {
      issues = issues.filter((i: any) => {
        const labels = JSON.parse(i.labels || '[]');
        return labels.includes(label as string);
      });
    }

    res.json(issues.map(mapIssue));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/repos/:repoId/issues/ready
router.get('/ready', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId } = req.params as any;

    const issues = await prisma.issue.findMany({
      where: { repoId, status: { in: ['open', 'in-progress'] } },
      include: {
        issueSessions: {
          include: {
            session: {
              select: { id: true, model: true, costUsd: true, tokensUsed: true, durationMs: true, linesAdded: true, linesRemoved: true, createdAt: true },
            },
          },
        },
      },
      orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
    });

    // Get all issues for dependency resolution
    const allIssues = await prisma.issue.findMany({ where: { repoId }, select: { shortId: true, status: true } });
    const statusMap = new Map(allIssues.map(i => [i.shortId, i.status]));

    const ready = issues.filter(issue => {
      const deps: string[] = JSON.parse(issue.deps || '[]');
      if (deps.length === 0) return true;
      return deps.every(depId => statusMap.get(depId) === 'closed');
    });

    res.json(ready.map(mapIssue));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/repos/:repoId/issues/stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId } = req.params as any;

    const issues = await prisma.issue.findMany({
      where: { repoId },
      include: {
        issueSessions: {
          include: {
            session: { select: { costUsd: true, tokensUsed: true, durationMs: true } },
          },
        },
      },
    });

    const open = issues.filter(i => i.status === 'open').length;
    const inProgress = issues.filter(i => i.status === 'in-progress').length;
    const blocked = issues.filter(i => i.status === 'blocked').length;
    const closed = issues.filter(i => i.status === 'closed').length;

    let totalCost = 0;
    let totalTokens = 0;
    let totalSessions = 0;
    let totalDurationMs = 0;

    for (const issue of issues) {
      for (const is of issue.issueSessions) {
        totalCost += is.session?.costUsd ?? 0;
        totalTokens += is.session?.tokensUsed ?? 0;
        totalDurationMs += is.session?.durationMs ?? 0;
        totalSessions++;
      }
    }

    // Top issues by cost
    const issueCosts = issues.map(i => ({
      id: i.shortId,
      title: i.title,
      cost: i.issueSessions.reduce((sum: number, is: any) => sum + (is.session?.costUsd ?? 0), 0),
      sessions: i.issueSessions.length,
    })).sort((a, b) => b.cost - a.cost).slice(0, 5);

    res.json({
      counts: { open, inProgress, blocked, closed, total: issues.length },
      cost: { totalCost, totalTokens, totalSessions, totalDurationMs },
      topIssuesByCost: issueCosts,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/repos/:repoId/issues/:shortId
router.get('/:shortId', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId, shortId } = req.params as any;

    const issue = await prisma.issue.findUnique({
      where: { repoId_shortId: { repoId, shortId } },
      include: {
        issueSessions: {
          include: {
            session: {
              select: {
                id: true, model: true, costUsd: true, tokensUsed: true,
                durationMs: true, linesAdded: true, linesRemoved: true,
                filesChanged: true, createdAt: true, branch: true,
              },
            },
          },
        },
      },
    });

    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    res.json(mapIssue(issue));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repos/:repoId/issues
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId } = req.params as any;
    const { shortId, title, description, type, priority, status, labels, deps } = req.body;

    const issue = await prisma.issue.create({
      data: {
        repoId,
        shortId,
        title,
        description,
        type: type || 'task',
        priority: priority ?? 3,
        status: status || 'open',
        labels: JSON.stringify(labels || []),
        deps: JSON.stringify(deps || []),
      },
    });

    res.status(201).json(mapIssue(issue));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/repos/:repoId/issues/:shortId
router.patch('/:shortId', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId, shortId } = req.params as any;
    const { title, description, type, priority, status, labels, deps } = req.body;

    const data: any = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (type !== undefined) data.type = type;
    if (priority !== undefined) data.priority = priority;
    if (status !== undefined) data.status = status;
    if (labels !== undefined) data.labels = JSON.stringify(labels);
    if (deps !== undefined) data.deps = JSON.stringify(deps);
    if (status === 'closed') data.closedAt = new Date();

    const issue = await prisma.issue.update({
      where: { repoId_shortId: { repoId, shortId } },
      data,
    });

    res.json(mapIssue(issue));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/repos/:repoId/issues/:shortId
router.delete('/:shortId', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId, shortId } = req.params as any;
    await prisma.issue.delete({ where: { repoId_shortId: { repoId, shortId } } });
    res.status(204).end();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repos/:repoId/issues/:shortId/link
router.post('/:shortId/link', async (req: AuthRequest, res: Response) => {
  try {
    const { repoId, shortId } = req.params as any;
    const { sessionId } = req.body;

    const issue = await prisma.issue.findUnique({ where: { repoId_shortId: { repoId, shortId } } });
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    await prisma.issueSession.upsert({
      where: { issueId_sessionId: { issueId: issue.id, sessionId } },
      create: { issueId: issue.id, sessionId },
      update: {},
    });

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
