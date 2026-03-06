import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { notifyOrgAdmins, notifyOrgMembers } from '../services/notifications.js';
import {
  getIntegrationConfig,
  getSessionsForPR,
  computeCheckStatus,
  postCommitStatus,
  updatePRComment,
  buildSessionSummaryComment,
  parseRepoFullName,
} from '../services/github-integration.js';
import { onSessionEvent, SessionEvent, emitSessionEvent } from '../services/session-events.js';

const router = Router();
router.use(requireAuth);

function mapSession(s: any, pullRequests?: any[]) {
  return {
    id: s.id,
    commitId: s.commitId,
    agentId: s.agentId,
    agentName: s.agent?.name || null,
    userId: s.userId || null,
    userName: s.user?.name || null,
    userEmail: s.user?.email || null,
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
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    toolCalls: s.toolCalls,
    durationMs: s.durationMs,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    costUsd: s.costUsd,
    agentSystemPrompt: s.agentSystemPrompt || null,
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
    pullRequests: pullRequests
      ? pullRequests.map((pr: any) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          checkStatus: pr.checkStatus,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
        }))
      : undefined,
    // Git capture data (only included on detail endpoint)
    sessionDiff: s.sessionDiff
      ? {
          headBefore: s.sessionDiff.headBefore,
          headAfter: s.sessionDiff.headAfter,
          commitShas: JSON.parse(s.sessionDiff.commitShas || '[]'),
          diff: s.sessionDiff.diff,
          diffTruncated: s.sessionDiff.diffTruncated,
          linesAdded: s.sessionDiff.linesAdded,
          linesRemoved: s.sessionDiff.linesRemoved,
        }
      : null,
    promptChanges: s.promptChanges
      ? s.promptChanges.map((pc: any) => ({
          promptIndex: pc.promptIndex,
          promptText: pc.promptText,
          filesChanged: JSON.parse(pc.filesChanged || '[]'),
          diff: pc.diff || '',
        }))
      : [],
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
    } else if (status === 'approved') {
      where.review = { status: 'APPROVED' };
    } else if (status === 'rejected') {
      where.review = { status: 'REJECTED' };
    }

    const [sessions, total] = await Promise.all([
      prisma.codingSession.findMany({
        where,
        include: {
          commit: { include: { repo: true } },
          agent: true,
          user: true,
          review: { include: { user: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.codingSession.count({ where }),
    ]);

    res.json({
      sessions: sessions.map((s) => mapSession(s)),
      total,
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /by-pr — sessions grouped by pull request
router.get('/by-pr', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    // Get all repos for org
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    // Get all PRs with their sessions
    const pullRequests = await prisma.pullRequest.findMany({
      where: { repoId: { in: repoIds } },
      include: { repo: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const results = [];

    for (const pr of pullRequests) {
      let commitShas: string[] = [];
      try {
        commitShas = JSON.parse(pr.commitShas);
      } catch {
        continue;
      }

      if (commitShas.length === 0) continue;

      // Find commits for these SHAs
      const commits = await prisma.commit.findMany({
        where: { repoId: pr.repoId, sha: { in: commitShas } },
        select: { id: true },
      });

      const commitIds = commits.map((c) => c.id);
      if (commitIds.length === 0) continue;

      // Find sessions for these commits
      const sessions = await prisma.codingSession.findMany({
        where: { commitId: { in: commitIds } },
        include: {
          commit: { include: { repo: true } },
          agent: true,
          user: true,
          review: { include: { user: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (sessions.length === 0) continue;

      // Aggregate stats
      const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
      const totalTokens = sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
      const totalLinesAdded = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
      const totalLinesRemoved = sessions.reduce((sum, s) => sum + s.linesRemoved, 0);

      results.push({
        pr: {
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          author: pr.author,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          checkStatus: pr.checkStatus,
          repoName: pr.repo.name,
          createdAt: pr.createdAt,
        },
        sessions: sessions.map((s) => mapSession(s)),
        stats: {
          sessionCount: sessions.length,
          totalCost: parseFloat(totalCost.toFixed(2)),
          totalTokens,
          totalLinesAdded,
          totalLinesRemoved,
          reviewStatus: sessions.every((s) => (s as any).review?.status === 'APPROVED')
            ? 'all_approved'
            : sessions.some((s) => (s as any).review?.status === 'REJECTED')
              ? 'has_rejections'
              : sessions.some((s) => (s as any).review?.status === 'FLAGGED')
                ? 'has_flags'
                : 'pending',
        },
      });
    }

    res.json({ groups: results });
  } catch (err) {
    console.error('Sessions by PR error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /stream — SSE real-time session events
router.get('/stream', async (req: AuthRequest, res: Response) => {
  const orgId = req.user!.orgId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('data: {"type":"connected"}\n\n');

  const unsubscribe = onSessionEvent((event: SessionEvent) => {
    if (event.orgId === orgId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
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
        user: true,
        review: { include: { user: true } },
        sessionDiff: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Find linked pull requests
    let pullRequests: any[] = [];
    if (session.commit?.sha && session.commit?.repoId) {
      const allPRs = await prisma.pullRequest.findMany({
        where: { repoId: session.commit.repoId },
      });
      pullRequests = allPRs.filter((pr) => {
        try {
          const shas: string[] = JSON.parse(pr.commitShas);
          return shas.includes(session.commit!.sha);
        } catch {
          return false;
        }
      });
    }

    res.json(mapSession(session, pullRequests));
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/diff — get session diff (lazy-loadable for large diffs)
router.get('/:id/diff', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
      include: { sessionDiff: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.sessionDiff) {
      return res.json({ diff: null });
    }

    res.json({
      headBefore: session.sessionDiff.headBefore,
      headAfter: session.sessionDiff.headAfter,
      commitShas: JSON.parse(session.sessionDiff.commitShas || '[]'),
      diff: session.sessionDiff.diff,
      diffTruncated: session.sessionDiff.diffTruncated,
      linesAdded: session.sessionDiff.linesAdded,
      linesRemoved: session.sessionDiff.linesRemoved,
    });
  } catch (err) {
    console.error('Get session diff error:', err);
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

    // Notify based on review status
    if (status === 'FLAGGED') {
      await notifyOrgAdmins(
        req.user!.orgId,
        'SESSION_FLAGGED',
        'Session Flagged',
        `A coding session has been flagged for review`,
        `/sessions/${id}`,
        { sessionId: id, status }
      );
    } else {
      await notifyOrgAdmins(
        req.user!.orgId,
        'REVIEW_COMPLETED',
        'Review Completed',
        `A coding session has been ${status.toLowerCase()}`,
        `/sessions/${id}`,
        { sessionId: id, status }
      );
    }

    // ── Update GitHub PR status check if integration is configured ──
    let githubUpdated = false;
    let prsUpdated = 0;
    try {
      const integration = await getIntegrationConfig(req.user!.orgId);
      if (integration?.parsedSettings.checkOnReview && session.commitId) {
        const commit = await prisma.commit.findUnique({
          where: { id: session.commitId },
          include: { repo: true },
        });

        if (commit?.sha && commit.repo) {
          // Find PRs that include this commit
          const allPRs = await prisma.pullRequest.findMany({
            where: { repoId: commit.repoId },
          });

          const linkedPRs = allPRs.filter((pr) => {
            try {
              const shas: string[] = JSON.parse(pr.commitShas);
              return shas.includes(commit.sha);
            } catch {
              return false;
            }
          });

          const parsed = parseRepoFullName(commit.repo.path);
          const originBaseUrl = process.env.ORIGIN_WEB_URL || 'http://localhost:5176';

          for (const pr of linkedPRs) {
            let commitShas: string[];
            try {
              commitShas = JSON.parse(pr.commitShas);
            } catch {
              commitShas = [];
            }

            const sessions = await getSessionsForPR(commit.repoId, commitShas);
            const { state, description } = computeCheckStatus(sessions);

            // Update status check
            if (parsed) {
              await postCommitStatus(
                integration.token,
                parsed.owner,
                parsed.repo,
                commit.sha,
                state,
                description,
                `${originBaseUrl}/sessions`,
                integration.apiBaseUrl,
              );
            }

            // Update PR comment
            if (integration.parsedSettings.postComments && pr.commentId && parsed) {
              const commentBody = buildSessionSummaryComment(sessions, originBaseUrl);
              await updatePRComment(
                integration.token,
                parsed.owner,
                parsed.repo,
                pr.commentId,
                commentBody,
                integration.apiBaseUrl,
              );
            }

            // Update check status on PR record
            await prisma.pullRequest.update({
              where: { id: pr.id },
              data: { checkStatus: state },
            });

            prsUpdated++;
          }

          if (prsUpdated > 0) githubUpdated = true;
        }
      }
    } catch (err) {
      console.error('Failed to update GitHub PR status on review:', err);
      // Don't fail the review if GitHub update fails
    }

    emitSessionEvent({
      type: 'session:reviewed',
      sessionId: id,
      orgId: req.user!.orgId,
      data: { status },
      timestamp: new Date().toISOString(),
    });

    res.json({ ...review, githubUpdated, prsUpdated });
  } catch (err) {
    console.error('Review session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete a session and its related data (ADMIN+)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Delete related records first (cascade)
    await prisma.sessionDiff.deleteMany({ where: { sessionId: id } });
    await prisma.promptChange.deleteMany({ where: { sessionId: id } });
    await prisma.secretFinding.deleteMany({ where: { sessionId: id } });
    await prisma.sessionReview.deleteMany({ where: { sessionId: id } });
    await prisma.codingSession.delete({ where: { id } });
    await prisma.commit.delete({ where: { id: session.commitId } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'SESSION_DELETED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
