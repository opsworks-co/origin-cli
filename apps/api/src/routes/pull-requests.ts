import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import {
  getSessionsForPR,
  computeCheckStatus,
  updatePRGitHubStatus,
} from '../services/github-integration.js';
import { updateMRGitLabStatus } from '../services/gitlab-integration.js';

const router = Router();
router.use(requireAuth);

// GET / — list all PRs for the org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { repoId, status, state } = req.query;

    // First find all repo IDs belonging to this org
    const orgRepos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const orgRepoIds = orgRepos.map((r) => r.id);

    const whereClause: Record<string, unknown> = {
      repoId: { in: orgRepoIds },
    };
    if (repoId) whereClause.repoId = repoId as string;
    if (state) whereClause.state = state as string;
    if (status) whereClause.checkStatus = status as string;

    const prs = await prisma.pullRequest.findMany({
      where: whereClause,
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    // Fetch repo info for all PRs
    const repoIds = [...new Set(prs.map((pr) => pr.repoId))];
    const repos = await prisma.repo.findMany({
      where: { id: { in: repoIds } },
      select: { id: true, name: true, path: true },
    });
    const repoMap = new Map(repos.map((r) => [r.id, r]));

    // Enrich with session counts
    const enriched = await Promise.all(
      prs.map(async (pr) => {
        let commitShas: string[];
        try {
          commitShas = JSON.parse(pr.commitShas);
        } catch {
          commitShas = [];
        }

        const sessions = await getSessionsForPR(pr.repoId, commitShas);
        const { state: checkState, description } = computeCheckStatus(sessions);
        const repo = repoMap.get(pr.repoId);

        return {
          id: pr.id,
          repoId: pr.repoId,
          repoName: repo?.name || '—',
          repoPath: repo?.path || '',
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          checkStatus: checkState,
          checkDescription: description,
          sessionsCount: sessions.length,
          sessionsApproved: sessions.filter((s) => s.reviewStatus?.toUpperCase() === 'APPROVED').length,
          sessionsFlagged: sessions.filter((s) => s.reviewStatus?.toUpperCase() === 'FLAGGED').length,
          sessionsRejected: sessions.filter((s) => s.reviewStatus?.toUpperCase() === 'REJECTED').length,
          sessionsPending: sessions.filter((s) => !s.reviewStatus).length,
          commitCount: commitShas.length,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
        };
      }),
    );

    res.json(enriched);
  } catch (err) {
    console.error('List PRs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single PR with full session details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: req.params.id as string },
    });

    if (!pr) {
      return res.status(404).json({ error: 'Pull request not found' });
    }

    // Check org access
    const repo = await prisma.repo.findFirst({
      where: { id: pr.repoId, orgId: req.user!.orgId },
      select: { id: true, name: true, path: true },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Pull request not found' });
    }

    let commitShas: string[];
    try {
      commitShas = JSON.parse(pr.commitShas);
    } catch {
      commitShas = [];
    }

    const sessions = await getSessionsForPR(pr.repoId, commitShas);
    const { state: checkState, description } = computeCheckStatus(sessions);

    res.json({
      id: pr.id,
      repoId: pr.repoId,
      repoName: repo.name,
      repoPath: repo.path,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      author: pr.author,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      checkStatus: checkState,
      checkDescription: description,
      commitShas,
      sessions,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    });
  } catch (err) {
    console.error('Get PR error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/recheck — manually re-run policy check and update GitHub
router.post('/:id/recheck', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: req.params.id as string },
    });

    if (!pr) {
      return res.status(404).json({ error: 'Pull request not found' });
    }

    // Check org access
    const repo = await prisma.repo.findFirst({
      where: { id: pr.repoId, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Pull request not found' });
    }

    let commitShas: string[];
    try {
      commitShas = JSON.parse(pr.commitShas);
    } catch {
      commitShas = [];
    }

    // Find the head SHA (last commit in the list)
    const headSha = commitShas[commitShas.length - 1];
    if (!headSha) {
      return res.status(400).json({ error: 'No commits linked to this PR' });
    }

    const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

    // Update status on the correct provider
    if (repo.provider === 'gitlab') {
      await updateMRGitLabStatus(
        req.user!.orgId,
        pr.repoId,
        pr.number,
        headSha,
        originBaseUrl,
      );
    } else {
      await updatePRGitHubStatus(
        req.user!.orgId,
        pr.repoId,
        pr.number,
        headSha,
        originBaseUrl,
      );
    }

    // Re-fetch status
    const sessions = await getSessionsForPR(pr.repoId, commitShas);
    const { state, description } = computeCheckStatus(sessions);

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'PR_RECHECK',
        resource: pr.id,
        metadata: JSON.stringify({
          prNumber: pr.number,
          repoName: repo.name,
          checkStatus: state,
        }),
      },
    });

    res.json({
      success: true,
      checkStatus: state,
      checkDescription: description,
      sessionsCount: sessions.length,
    });
  } catch (err) {
    console.error('Recheck PR error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
