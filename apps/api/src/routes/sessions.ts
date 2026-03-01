import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function mapSession(s: any) {
  return {
    id: s.id,
    commitId: s.commitId,
    agentId: s.agentId,
    agentName: s.agent?.name || null,
    repoId: s.commit?.repoId || null,
    repoName: s.commit?.repo?.name || null,
    commitSha: s.commit?.sha || null,
    commitMessage: s.commit?.message || null,
    commitAuthor: s.commit?.author || null,
    committedAt: s.commit?.committedAt || null,
    model: s.model,
    prompt: s.prompt,
    transcript: s.transcript,
    filesChanged: s.filesChanged,
    tokensUsed: s.tokensUsed,
    toolCalls: s.toolCalls,
    durationMs: s.durationMs,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    costUsd: s.costUsd,
    createdAt: s.createdAt,
    review: s.review
      ? {
          id: s.review.id,
          status: s.review.status,
          note: s.review.note,
          reviewerName: s.review.user?.name || null,
          createdAt: s.review.createdAt,
        }
      : null,
  };
}

// GET / — list coding sessions for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = {
      commit: {
        repo: { orgId },
      },
    };

    if (req.query.model) {
      where.model = req.query.model as string;
    }

    if (req.query.agentId) {
      where.agentId = req.query.agentId as string;
    }

    if (req.query.repoId) {
      where.commit = {
        ...where.commit,
        repoId: req.query.repoId as string,
      };
    }

    const status = req.query.status as string;
    if (status === 'reviewed') {
      where.review = { isNot: null };
    } else if (status === 'unreviewed') {
      where.review = null;
    } else if (status === 'flagged') {
      where.review = { status: 'FLAGGED' };
    }

    const [sessions, total] = await Promise.all([
      prisma.codingSession.findMany({
        where,
        include: {
          commit: { include: { repo: true } },
          agent: true,
          review: { include: { user: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.codingSession.count({ where }),
    ]);

    res.json({
      sessions: sessions.map(mapSession),
      total,
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single session
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
      include: {
        commit: { include: { repo: true } },
        agent: true,
        review: { include: { user: true } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(mapSession(session));
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/review — create or update review
router.post('/:id/review', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Missing required field: status' });
    }

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const review = await prisma.sessionReview.upsert({
      where: { sessionId: id },
      create: {
        sessionId: id,
        userId: req.user!.id,
        status,
        note: note || null,
      },
      update: {
        userId: req.user!.id,
        status,
        note: note || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'SESSION_REVIEWED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id, status }),
      },
    });

    res.json(review);
  } catch (err) {
    console.error('Review session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
