import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — List trails for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const status = req.query.status as string | undefined;
    const label = req.query.label as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = { orgId };

    if (status) {
      where.status = status;
    }

    if (label) {
      where.labels = { contains: label };
    }

    const [trails, total] = await Promise.all([
      prisma.trail.findMany({
        where,
        include: {
          _count: { select: { sessions: true } },
          sessions: {
            include: {
              session: {
                select: { costUsd: true },
              },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.trail.count({ where }),
    ]);

    const mapped = trails.map((t) => {
      const totalCost = t.sessions.reduce(
        (sum, ts) => sum + (ts.session.costUsd || 0),
        0
      );
      return {
        id: t.id,
        orgId: t.orgId,
        name: t.name,
        description: t.description,
        branch: t.branch,
        status: t.status,
        priority: t.priority,
        labels: JSON.parse(t.labels || '[]'),
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        sessionCount: t._count.sessions,
        totalCost: parseFloat(totalCost.toFixed(2)),
      };
    });

    res.json({ trails: mapped, total });
  } catch (err) {
    console.error('List trails error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — Create trail
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { name, description, branch, priority, labels } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }

    const trail = await prisma.trail.create({
      data: {
        orgId,
        name,
        description: description || null,
        branch: branch || null,
        priority: priority || 'MEDIUM',
        labels: labels ? JSON.stringify(labels) : '[]',
        createdBy: req.user!.id,
      },
    });

    res.status(201).json({
      ...trail,
      labels: JSON.parse(trail.labels || '[]'),
    });
  } catch (err) {
    console.error('Create trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — Trail detail with sessions
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;

    const trail = await prisma.trail.findFirst({
      where: { id, orgId },
      include: {
        sessions: {
          include: {
            session: {
              include: {
                commit: {
                  include: { repo: { select: { name: true } } },
                },
                review: { select: { status: true } },
                user: { select: { name: true } },
              },
            },
          },
          orderBy: { addedAt: 'desc' },
        },
      },
    });

    if (!trail) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    // Map sessions with detail
    const sessions = trail.sessions.map((ts) => {
      const s = ts.session;
      return {
        trailSessionId: ts.id,
        sessionId: s.id,
        addedAt: ts.addedAt,
        model: s.model,
        promptFirstLine: s.prompt ? s.prompt.split('\n')[0].slice(0, 200) : '',
        costUsd: s.costUsd,
        linesAdded: s.linesAdded,
        linesRemoved: s.linesRemoved,
        status: s.status,
        createdAt: s.createdAt,
        reviewStatus: s.review?.status || null,
        repoName: s.commit?.repo?.name || null,
        commitSha: s.commit?.sha || null,
        commitMessage: s.commit?.message || null,
        userName: s.user?.name || null,
      };
    });

    // Get linked PRs via commits
    const commitIds = trail.sessions
      .map((ts) => ts.session.commitId)
      .filter(Boolean);

    let linkedPRs: any[] = [];
    if (commitIds.length > 0) {
      const commits = await prisma.commit.findMany({
        where: { id: { in: commitIds } },
        select: { sha: true, repoId: true },
      });

      const repoIds = [...new Set(commits.map((c) => c.repoId))];
      const shas = commits.map((c) => c.sha);

      if (repoIds.length > 0) {
        const allPRs = await prisma.pullRequest.findMany({
          where: { repoId: { in: repoIds } },
          include: { repo: { select: { name: true } } },
        });

        linkedPRs = allPRs.filter((pr) => {
          try {
            const prShas: string[] = JSON.parse(pr.commitShas);
            return prShas.some((s) => shas.includes(s));
          } catch {
            return false;
          }
        }).map((pr) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author,
          repoName: pr.repo.name,
        }));
      }
    }

    res.json({
      id: trail.id,
      orgId: trail.orgId,
      name: trail.name,
      description: trail.description,
      branch: trail.branch,
      status: trail.status,
      priority: trail.priority,
      labels: JSON.parse(trail.labels || '[]'),
      createdBy: trail.createdBy,
      createdAt: trail.createdAt,
      updatedAt: trail.updatedAt,
      sessions,
      linkedPRs,
    });
  } catch (err) {
    console.error('Get trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — Update trail
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;

    const existing = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    const { name, description, status, priority, labels } = req.body;

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (labels !== undefined) data.labels = JSON.stringify(labels);

    const updated = await prisma.trail.update({
      where: { id },
      data,
    });

    res.json({
      ...updated,
      labels: JSON.parse(updated.labels || '[]'),
    });
  } catch (err) {
    console.error('Update trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — Delete trail
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;

    const existing = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    // TrailSession cascade delete is handled by Prisma onDelete: Cascade
    await prisma.trail.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/sessions — Add sessions to trail
router.post('/:id/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;
    const { sessionIds } = req.body;

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: 'sessionIds array is required' });
    }

    const trail = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!trail) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    const added: string[] = [];
    const skipped: string[] = [];

    for (const sessionId of sessionIds) {
      try {
        await prisma.trailSession.create({
          data: {
            trailId: id,
            sessionId,
          },
        });
        added.push(sessionId);
      } catch {
        // Duplicate or invalid — skip
        skipped.push(sessionId);
      }
    }

    // Touch trail updatedAt
    await prisma.trail.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    res.json({ added, skipped });
  } catch (err) {
    console.error('Add trail sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/sessions/:sessionId — Remove session from trail
router.delete('/:id/sessions/:sessionId', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const id = req.params.id as string;
    const sessionId = req.params.sessionId as string;

    const trail = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!trail) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    const trailSession = await prisma.trailSession.findFirst({
      where: { trailId: id, sessionId },
    });

    if (!trailSession) {
      return res.status(404).json({ error: 'Session not found in trail' });
    }

    await prisma.trailSession.delete({ where: { id: trailSession.id } });

    // Touch trail updatedAt
    await prisma.trail.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Remove trail session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
