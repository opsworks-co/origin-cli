import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { parseLimit, parseOffset } from '../utils/validate.js';

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
    const file = req.query.file as string | undefined;
    const limit = parseLimit(req.query.limit, 20, 100);
    const offset = parseOffset(req.query.offset);

    // Get repo IDs for org. Cap at 5000 — this list only exists to build
    // the `repoId IN (...)` filter; an org with more repos than that is
    // already past the point where a single-page search scales well, and
    // materializing unbounded repo lists on every prompt query is a DoS
    // vector on large tenants.
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
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
      // IDOR fix: the old code did `where.session.commit.repoId = repoId`
      // which replaced the `{ in: repoIds }` org-scope filter with a
      // raw user-supplied id, meaning a caller could query prompts for
      // any repo in the entire database by passing its UUID. Enforce
      // that the requested repoId is actually in this org before
      // narrowing the filter; otherwise return an empty page.
      if (!repoIds.includes(repoId)) {
        return res.json({ prompts: [], total: 0 });
      }
      where.session.commit.repoId = repoId;
    }

    // Non-admins can only filter prompts by their own userId — previously
    // any org member could read a coworker's entire prompt history just
    // by guessing/knowing their user UUID.
    const role = (req.user!.role || '').toUpperCase();
    const canViewOthers = role === 'ADMIN' || role === 'OWNER';
    if (userId) {
      if (!canViewOthers && userId !== req.user!.id) {
        return res.status(403).json({ error: 'Insufficient permissions to view other users\' prompts' });
      }
      where.session.userId = userId;
    } else if (!canViewOthers) {
      where.session.userId = req.user!.id;
    }

    if (file) {
      where.filesChanged = { contains: file };
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

    // Get repo IDs for org (same cap as the search endpoint).
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
    });
    const repoIds = repos.map((r) => r.id);

    if (repoIds.length === 0) {
      return res.json({ patterns: [] });
    }

    // Fetch prompts with their session review status. Cap at 50k rows —
    // pattern analysis is a histogram over categories, so a partial scan
    // is still directionally accurate for an org with millions of
    // prompts, and unbounded scans OOM the route on active tenants.
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
      take: 50_000,
      orderBy: { createdAt: 'desc' },
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
