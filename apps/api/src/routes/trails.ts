import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { validateFieldLengths, COMMON_LIMITS } from '../utils/validate.js';

const TRAIL_LIMITS = {
  name: COMMON_LIMITS.name,
  description: COMMON_LIMITS.description,
  branch: 255,
  priority: 50,
};

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// GET / — List trails for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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
    const orgId = req.activeOrgId!;
    const { name, description, branch, priority, labels } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }
    const lenErr = validateFieldLengths({ name, description, branch, priority }, TRAIL_LIMITS);
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
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
    const orgId = req.activeOrgId!;
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
        // Cap at 5000 PRs — commitShas is a JSON column so we filter
        // in memory; 5000 is well above realistic per-trail PR counts.
        const allPRs = await prisma.pullRequest.findMany({
          where: { repoId: { in: repoIds } },
          include: { repo: { select: { name: true } } },
          take: 5000,
          orderBy: { createdAt: 'desc' },
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
    const orgId = req.activeOrgId!;
    const id = req.params.id as string;

    const existing = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    const { name, description, status, priority, labels } = req.body;

    const lenErr = validateFieldLengths({ name, description, priority }, TRAIL_LIMITS);
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
    }

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (labels !== undefined) data.labels = JSON.stringify(labels);

    // Defense-in-depth: compound-scope the update so a future refactor
    // that drops the precheck above still can't touch another org's trail.
    const updateResult = await prisma.trail.updateMany({
      where: { id, orgId },
      data,
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: 'Trail not found' });
    }
    const updated = await prisma.trail.findUnique({ where: { id } });
    if (!updated) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    res.json({
      ...updated,
      labels: JSON.parse(updated.labels || '[]'),
    });
  } catch (err) {
    console.error('Update trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — Delete trail (admin-only — trails represent investigation
// history and shouldn't be deletable by any org member).
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const id = req.params.id as string;

    const existing = await prisma.trail.findFirst({
      where: { id, orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    // Defense-in-depth: compound-scope the delete so the precheck above
    // isn't the only line preventing cross-org deletion.
    // TrailSession cascade delete is handled by Prisma onDelete: Cascade.
    const { count } = await prisma.trail.deleteMany({
      where: { id, orgId },
    });
    if (count === 0) {
      return res.status(404).json({ error: 'Trail not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete trail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/sessions — Add sessions to trail
router.post('/:id/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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

    // IDOR fix: validate every incoming sessionId belongs to a repo in this
    // org before linking it into the trail. Previously the handler trusted
    // whatever ids the client supplied, so an attacker who knew (or guessed)
    // a session UUID in another org could attach that session into one of
    // their own trails — and then read its contents through the trail
    // endpoints, turning this into a cross-org data-leak vector.
    const uniqueIds = Array.from(new Set(sessionIds.filter((s): s is string => typeof s === 'string')));
    const ownedSessions = uniqueIds.length
      ? await prisma.codingSession.findMany({
          where: {
            id: { in: uniqueIds },
            commit: { repo: { orgId } },
          },
          select: { id: true },
        })
      : [];
    const ownedIds = new Set(ownedSessions.map((s) => s.id));

    for (const sessionId of uniqueIds) {
      if (!ownedIds.has(sessionId)) {
        skipped.push(sessionId);
        continue;
      }
      try {
        await prisma.trailSession.create({
          data: {
            trailId: id,
            sessionId,
          },
        });
        added.push(sessionId);
      } catch {
        // Duplicate — skip
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
    const orgId = req.activeOrgId!;
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
