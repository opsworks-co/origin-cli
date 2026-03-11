import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET / — Search prompts
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const q = req.query.q as string | undefined;
    const model = req.query.model as string | undefined;
    const repoId = req.query.repoId as string | undefined;
    const userId = req.query.userId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Get repo IDs for org
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    if (repoIds.length === 0) {
      return res.json({ prompts: [], total: 0 });
    }

    // Build where clause
    const where: any = {
      session: {
        commit: { repoId: { in: repoIds } },
      },
    };

    if (q) {
      where.promptText = { contains: q };
    }

    if (model) {
      where.session.model = model;
    }

    if (repoId) {
      where.session.commit.repoId = repoId;
    }

    if (userId) {
      where.session.userId = userId;
    }

    const [prompts, total] = await Promise.all([
      prisma.promptChange.findMany({
        where,
        include: {
          session: {
            select: {
              id: true,
              model: true,
              userId: true,
              user: { select: { name: true } },
              costUsd: true,
              createdAt: true,
              review: { select: { status: true } },
              commit: {
                select: {
                  repo: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.promptChange.count({ where }),
    ]);

    const mapped = prompts.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      promptIndex: p.promptIndex,
      promptText: p.promptText,
      filesChanged: JSON.parse(p.filesChanged || '[]'),
      createdAt: p.createdAt,
      session: {
        id: p.session.id,
        model: p.session.model,
        userId: p.session.userId,
        userName: p.session.user?.name || null,
        costUsd: p.session.costUsd,
        createdAt: p.session.createdAt,
        reviewStatus: p.session.review?.status || null,
        repoName: p.session.commit?.repo?.name || null,
      },
    }));

    res.json({ prompts: mapped, total });
  } catch (err) {
    console.error('Search prompts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /patterns — Prompt pattern analysis
router.get('/patterns', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    // Get repo IDs for org
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    if (repoIds.length === 0) {
      return res.json({ patterns: [] });
    }

    // Fetch all prompts with their session review status
    const prompts = await prisma.promptChange.findMany({
      where: {
        session: {
          commit: { repoId: { in: repoIds } },
        },
      },
      select: {
        promptText: true,
        session: {
          select: {
            review: { select: { status: true } },
          },
        },
      },
    });

    // Categorize each prompt by keyword matching
    const categoryMap = new Map<
      string,
      { count: number; approved: number; reviewedWithDecision: number }
    >();

    for (const p of prompts) {
      const text = p.promptText.toLowerCase();
      let category: string;

      if (/\b(fix|bug|error)\b/.test(text)) {
        category = 'Bug Fix';
      } else if (/\b(add|create|implement|build)\b/.test(text)) {
        category = 'New Feature';
      } else if (/\b(refactor|clean|reorganize)\b/.test(text)) {
        category = 'Refactoring';
      } else if (/\b(test|spec)\b/.test(text)) {
        category = 'Testing';
      } else if (/\b(update|modify|change)\b/.test(text)) {
        category = 'Enhancement';
      } else if (/\b(doc|readme|comment)\b/.test(text)) {
        category = 'Documentation';
      } else if (/\b(review|check)\b/.test(text)) {
        category = 'Review';
      } else if (/\b(debug|investigate)\b/.test(text)) {
        category = 'Debugging';
      } else if (/\b(config|setup|install)\b/.test(text)) {
        category = 'Configuration';
      } else {
        category = 'Other';
      }

      if (!categoryMap.has(category)) {
        categoryMap.set(category, { count: 0, approved: 0, reviewedWithDecision: 0 });
      }

      const entry = categoryMap.get(category)!;
      entry.count++;

      if (p.session.review) {
        entry.reviewedWithDecision++;
        if (p.session.review.status === 'APPROVED') {
          entry.approved++;
        }
      }
    }

    const patterns = Array.from(categoryMap.entries()).map(([category, data]) => ({
      category,
      count: data.count,
      approvalRate:
        data.reviewedWithDecision > 0
          ? parseFloat(
              ((data.approved / data.reviewedWithDecision) * 100).toFixed(1)
            )
          : 0,
    }));

    // Sort by count descending
    patterns.sort((a, b) => b.count - a.count);

    res.json({ patterns });
  } catch (err) {
    console.error('Prompt patterns error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
