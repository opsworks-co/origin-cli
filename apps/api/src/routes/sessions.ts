import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { notifyOrgAdmins, notifyOrgMembers } from '../services/notifications.js';

/** Check if user has admin/owner role */
function isAdminUser(req: AuthRequest): boolean {
  const role = (req.user!.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'OWNER';
}

/** Build session where-clause scoped to user (non-admins see only own sessions) */
function scopedSessionWhere(req: AuthRequest, base: any = {}): any {
  if (!isAdminUser(req)) {
    base.userId = req.user!.id;
  }
  return base;
}
import {
  getIntegrationConfig,
  getSessionsForPR,
  computeCheckStatus,
  postCommitStatus,
  postPRComment,
  updatePRComment,
  buildSessionSummaryComment,
  parseRepoFullName,
} from '../services/github-integration.js';
import { onSessionEvent, SessionEvent, emitSessionEvent } from '../services/session-events.js';
import { callLLM } from './chat.js';
import { getOrgLLMKey, getOrgLLMModel, getOrgLLMProvider } from './settings.js';
import { runAIReview } from '../services/ai-review.js';

const router = Router();
router.use(requireAuth);

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min without prompt activity → IDLE

function computeStatus(s: any): string {
  if (s.status !== 'RUNNING') return s.status || 'COMPLETED';
  const lastActivity = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
  if (lastActivity && Date.now() - lastActivity > IDLE_THRESHOLD_MS) return 'IDLE';
  return 'RUNNING';
}

function mapSession(s: any, pullRequests?: any[]) {
  return {
    id: s.id,
    commitId: s.commitId,
    agentId: s.agentId,
    agentName: s.agent?.name || null,
    userId: s.userId || null,
    userName: s.user?.name || null,
    userEmail: s.user?.email || null,
    apiKeyId: s.apiKeyId || null,
    apiKeyName: s.apiKeyName || null,
    repoId: s.commit?.repoId || null,
    repoName: s.commit?.repo?.name || null,
    repoNames: s.sessionRepos && s.sessionRepos.length > 0
      ? s.sessionRepos.map((sr: any) => sr.repo?.name).filter(Boolean)
      : (s.commit?.repo?.name ? [s.commit.repo.name] : []),
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
    branch: s.branch || null,
    status: computeStatus(s),
    archived: s.archived || false,
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
    agentSystemPrompt: s.agentSystemPrompt || null,
    agentVersion: s.agentVersion || null,
    mergedFrom: s.mergedFrom ? JSON.parse(s.mergedFrom) : null,
    mergedInto: s.mergedInto || null,
    agentSessionId: s.agentSessionId || null,
    parentSessionId: s.parentSessionId || null,
    createdAt: s.createdAt,
    review: s.review
      ? {
          id: s.review.id,
          status: s.review.status,
          note: s.review.note,
          score: s.review.score ?? null,
          riskLevel: s.review.riskLevel ?? null,
          concerns: s.review.concerns ? JSON.parse(s.review.concerns) : [],
          suggestions: s.review.suggestions ? JSON.parse(s.review.suggestions) : [],
          categories: s.review.categories ? JSON.parse(s.review.categories) : null,
          isAutoReview: s.review.isAutoReview ?? false,
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
          uncommittedDiff: pc.uncommittedDiff || '',
          createdAt: pc.createdAt,
        }))
      : [],
  };
}

// GET / — list coding sessions for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const where: any = {
      commit: {
        repo: { orgId },
      },
      archived: req.query.archived === 'true' ? true : false,
      mergedInto: null, // hide sessions that were merged into another
    };

    if (req.query.model) {
      where.model = req.query.model as string;
    }

    if (req.query.agentId) {
      where.agentId = req.query.agentId as string;
    }

    if (req.query.repoId) {
      where.OR = [
        { commit: { ...where.commit, repoId: req.query.repoId as string } },
        { commit: { repo: { orgId } }, sessionRepos: { some: { repoId: req.query.repoId as string } } },
      ];
    }

    if (req.query.repoName) {
      where.commit = {
        ...where.commit,
        repo: { ...where.commit?.repo, name: req.query.repoName as string },
      };
    }

    if (req.query.branch) {
      where.branch = req.query.branch as string;
    }

    if (req.query.userId) {
      where.userId = req.query.userId as string;
    }

    // Enforce repo-scoped API key access
    if (req.apiKeyRepoScopes && req.apiKeyRepoScopes.length > 0) {
      where.commit = {
        ...where.commit,
        repoId: { in: req.apiKeyRepoScopes },
      };
    }

    // User-level scoping: non-admin users only see their own sessions
    // Admin/Owner can see all org sessions, or pass ?mine=true to see only theirs
    const userRole = (req.user!.role || '').toUpperCase();
    const isAdmin = userRole === 'ADMIN' || userRole === 'OWNER';
    if (!isAdmin || req.query.mine === 'true') {
      where.userId = req.user!.id;
    }

    const status = req.query.status as string;
    if (status === 'RUNNING' || status === 'COMPLETED') {
      where.status = status;
    } else if (status === 'reviewed') {
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

    const [sessions, total, aggregates] = await Promise.all([
      prisma.codingSession.findMany({
        where,
        include: {
          commit: { include: { repo: true } },
          agent: true,
          user: true,
          review: { include: { user: true } },
          sessionRepos: { include: { repo: true } },
        },
        orderBy: [
          { status: 'desc' },   // RUNNING sorts before COMPLETED alphabetically
          { createdAt: 'desc' },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.codingSession.count({ where }),
      prisma.codingSession.aggregate({
        where,
        _sum: { costUsd: true, tokensUsed: true, durationMs: true, toolCalls: true },
        _avg: { costUsd: true, durationMs: true },
        _count: true,
      }),
    ]);

    // Auto-expire stale RUNNING sessions (no heartbeat ping in 15 minutes)
    const STALE_THRESHOLD_MS = 15 * 60 * 1000;
    const now = Date.now();
    const staleIds: string[] = [];
    for (const s of sessions) {
      if (s.status === 'RUNNING') {
        const lastActivity = new Date(s.updatedAt || s.createdAt).getTime();
        if (now - lastActivity > STALE_THRESHOLD_MS) {
          staleIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = s.updatedAt || s.createdAt;
        }
      }
    }
    // Update stale sessions in DB in background
    if (staleIds.length > 0) {
      prisma.codingSession.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'COMPLETED', endedAt: new Date() },
      }).catch(() => {});
    }

    // Count flagged/rejected sessions across all matching (not just current page)
    const flaggedCount = await prisma.sessionReview.count({
      where: {
        session: where,
        status: { in: ['FLAGGED', 'REJECTED'] },
      },
    }).catch(() => 0);

    // Count scored reviews for avg score
    const scoreAgg = await prisma.sessionReview.aggregate({
      where: {
        session: where,
        score: { not: null },
      },
      _avg: { score: true },
      _count: true,
    }).catch(() => ({ _avg: { score: null }, _count: 0 }));

    res.json({
      sessions: sessions.map((s) => mapSession(s)),
      total,
      aggregates: {
        totalCost: aggregates._sum.costUsd || 0,
        totalTokens: aggregates._sum.tokensUsed || 0,
        totalDuration: aggregates._sum.durationMs || 0,
        totalTools: aggregates._sum.toolCalls || 0,
        avgCost: aggregates._avg.costUsd || 0,
        avgDuration: aggregates._avg.durationMs || 0,
        avgScore: scoreAgg._avg.score != null ? Math.round(scoreAgg._avg.score) : null,
        flaggedCount,
      },
    });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /active — currently running sessions
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    const activeWhere: any = {
      status: 'RUNNING',
      commit: { repo: { orgId } },
    };

    // Non-admin users only see their own active sessions
    const activeRole = (req.user!.role || '').toUpperCase();
    const activeIsAdmin = activeRole === 'ADMIN' || activeRole === 'OWNER';
    if (!activeIsAdmin) {
      activeWhere.userId = req.user!.id;
    }

    const sessions = await prisma.codingSession.findMany({
      where: activeWhere,
      include: {
        commit: { include: { repo: true } },
        agent: true,
        user: true,
        review: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ sessions: sessions.map((s) => mapSession(s)) });
  } catch (err) {
    console.error('List active sessions error:', err);
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

// GET /by-commit — find session linked to a specific commit SHA
router.get('/by-commit', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const sha = req.query.sha as string;

    if (!sha) {
      return res.status(400).json({ error: 'sha query parameter required' });
    }

    // Find commits matching this SHA in org's repos
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
    });
    const repoIds = repos.map((r) => r.id);

    const commit = await prisma.commit.findFirst({
      where: {
        sha,
        repoId: { in: repoIds },
      },
      include: {
        session: {
          include: {
            agent: true,
            _count: { select: { promptChanges: true } },
          },
        },
        codingSession: {
          include: {
            agent: true,
            _count: { select: { promptChanges: true } },
          },
        },
      },
    });

    if (!commit) {
      return res.status(404).json({ error: 'No session found for this commit' });
    }

    const session = commit.session || commit.codingSession;
    if (!session) {
      return res.status(404).json({ error: 'No session found for this commit' });
    }

    let filesChanged: string[] = [];
    try {
      filesChanged = JSON.parse(session.filesChanged || '[]');
    } catch {}

    res.json({
      sessionId: session.id,
      model: session.model,
      agentName: session.agent?.name || null,
      costUsd: session.costUsd,
      promptCount: (session as any)._count?.promptChanges || 0,
      filesChanged,
    });
  } catch (err) {
    console.error('Get session by commit error:', err);
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

  const streamIsAdmin = isAdminUser(req);
  const streamUserId = req.user!.id;

  const unsubscribe = onSessionEvent((event: SessionEvent) => {
    if (event.orgId === orgId && (streamIsAdmin || event.userId === streamUserId)) {
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

// PATCH /bulk/archive — bulk archive sessions
router.patch('/bulk/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { sessionIds, archived } = req.body;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: 'sessionIds array required' });
    }

    const orgId = req.user!.orgId;
    await prisma.codingSession.updateMany({
      where: {
        id: { in: sessionIds },
        commit: { repo: { orgId } },
      },
      data: { archived: archived !== false },
    });

    res.json({ success: true, count: sessionIds.length });
  } catch (err) {
    console.error('Bulk archive error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single session
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const detailWhere: any = {
      id: id.length < 36 ? { startsWith: id } : id,
      commit: { repo: { orgId: req.user!.orgId } },
    };

    // Non-admin users can only view their own sessions
    const detailRole = (req.user!.role || '').toUpperCase();
    const detailIsAdmin = detailRole === 'ADMIN' || detailRole === 'OWNER';
    if (!detailIsAdmin) {
      detailWhere.userId = req.user!.id;
    }

    const session = await prisma.codingSession.findFirst({
      where: detailWhere,
      include: {
        commit: { include: { repo: true } },
        agent: true,
        user: true,
        review: { include: { user: true } },
        sessionDiff: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
        sessionRepos: { include: { repo: true } },
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

    const mapped: any = mapSession(session, pullRequests);

    // Fetch chain siblings if this session is part of a chain
    const chainId = session.parentSessionId || session.id;
    const chainSessions = await prisma.codingSession.findMany({
      where: {
        OR: [{ id: chainId }, { parentSessionId: chainId }],
        mergedInto: null,
      },
      select: { id: true, startedAt: true, endedAt: true, costUsd: true, tokensUsed: true, durationMs: true, status: true, model: true },
      orderBy: { startedAt: 'asc' },
    });
    if (chainSessions.length > 1) {
      mapped.chainSessions = chainSessions;
    }

    res.json(mapped);
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
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      }),
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
router.post('/:id/review', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
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
          const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';

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

            // Update or create PR comment
            if (integration.parsedSettings.postComments && parsed) {
              const org = await prisma.org.findUnique({ where: { id: req.user!.orgId }, select: { slug: true } });
              const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);
              if (pr.commentId) {
                await updatePRComment(
                  integration.token,
                  parsed.owner,
                  parsed.repo,
                  pr.commentId,
                  commentBody,
                  integration.apiBaseUrl,
                );
              } else {
                const result = await postPRComment(
                  integration.token,
                  parsed.owner,
                  parsed.repo,
                  pr.number,
                  commentBody,
                  integration.apiBaseUrl,
                );
                if (result.commentId) {
                  await prisma.pullRequest.update({
                    where: { id: pr.id },
                    data: { commentId: result.commentId },
                  });
                }
              }
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

// POST /:id/ai-review — trigger AI review on an existing session
router.post('/:id/ai-review', async (req: AuthRequest, res: Response) => {
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
        sessionDiff: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Delete existing AI review if present (allow re-run)
    const existing = await prisma.sessionReview.findUnique({
      where: { sessionId: id },
    });
    if (existing?.isAutoReview) {
      await prisma.sessionReview.delete({ where: { sessionId: id } });
    }

    let filesChanged: string[] = [];
    try { filesChanged = JSON.parse(session.filesChanged); } catch {}

    const result = await runAIReview({
      sessionId: id,
      orgId: req.user!.orgId,
      model: session.model,
      prompt: session.prompt || '',
      filesChanged,
      tokensUsed: session.tokensUsed,
      toolCalls: session.toolCalls,
      linesAdded: session.linesAdded,
      linesRemoved: session.linesRemoved,
      costUsd: session.costUsd,
      durationMs: session.durationMs,
      transcript: session.transcript || undefined,
      diff: session.sessionDiff?.diff || undefined,
    });

    if (!result) {
      return res.status(500).json({ error: 'AI review failed — configure LLM key in Settings > Integrations' });
    }

    // Fetch the updated review
    const review = await prisma.sessionReview.findUnique({
      where: { sessionId: id },
      include: { user: true },
    });

    res.json({
      score: result.score,
      status: result.status,
      riskLevel: result.riskLevel,
      categories: result.categories,
      concerns: result.concerns,
      suggestions: result.suggestions,
      review: review ? {
        id: review.id,
        status: review.status,
        note: review.note,
        score: review.score,
        riskLevel: review.riskLevel,
        concerns: review.concerns ? JSON.parse(review.concerns) : [],
        suggestions: review.suggestions ? JSON.parse(review.suggestions) : [],
        categories: review.categories ? JSON.parse(review.categories) : null,
        isAutoReview: review.isAutoReview,
        reviewerName: review.user?.name || null,
        createdAt: review.createdAt,
      } : null,
    });
  } catch (err) {
    console.error('AI review trigger error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/end — mark a running session as completed (admin or session owner)
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const idParam = req.params.id as string;

    // Support both full UUID and short prefix (e.g. "4f39c580")
    // Sessions may not have a linked commit yet, so also match by org via repo or user
    const idFilter = idParam.length < 36 ? { startsWith: idParam } : idParam;
    const session = await prisma.codingSession.findFirst({
      where: {
        id: idFilter,
        OR: [
          { commit: { repo: { orgId: req.user!.orgId } } },
          { userId: req.user!.id },
        ],
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only admin/owner or the session owner can end a session
    if (!isAdminUser(req) && session.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Only admins or the session owner can end a session' });
    }

    if (session.status !== 'RUNNING') {
      // Already ended — return success (idempotent)
      return res.json({ ok: true, message: 'Session already ended' });
    }

    const now = new Date();
    const durationMs = session.startedAt
      ? now.getTime() - new Date(session.startedAt).getTime()
      : session.durationMs;

    await prisma.codingSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        endedAt: now,
        durationMs,
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'SESSION_ENDED',
        resource: session.id,
        metadata: JSON.stringify({ sessionId: session.id }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('End session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete a session and its related data (ADMIN+)
// PATCH /:id/archive — archive or unarchive a session
router.patch('/:id/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { archived } = req.body;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await prisma.codingSession.update({
      where: { id },
      data: { archived: archived !== false },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: archived !== false ? 'SESSION_ARCHIVED' : 'SESSION_UNARCHIVED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Archive session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
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

// ---------------------------------------------------------------------------
// GET /:id/blame — Line-level AI attribution for a file in a session
// ---------------------------------------------------------------------------

interface BlameLine {
  lineNumber: number;
  content: string;
  attribution: {
    promptIndex: number;
    promptText: string;
    type: 'added' | 'modified';
  } | null;
  isGap?: boolean;
}

interface BlamePrompt {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
}

/**
 * Parse a unified diff string and extract per-file hunks.
 * Returns line additions/modifications for the target file.
 */
function parseDiffForFile(
  diffText: string,
  targetFile: string,
): Array<{ lineNumber: number; content: string; type: 'added' | 'modified' }> {
  if (!diffText) return [];

  const results: Array<{ lineNumber: number; content: string; type: 'added' | 'modified' }> = [];

  // Split by file sections (diff --git or --- a/)
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : '';

    // Check if this section is for our target file (flexible matching)
    const normalizedTarget = targetFile.replace(/^\//, '');
    const normalizedFile = filePath.replace(/^\//, '');
    if (
      normalizedFile !== normalizedTarget &&
      !normalizedFile.endsWith(normalizedTarget) &&
      !normalizedTarget.endsWith(normalizedFile)
    ) {
      continue;
    }

    // Parse hunks
    let newLineNum = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        // Parse hunk header: @@ -old,count +new,count @@
        const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          newLineNum = parseInt(hunkMatch[1], 10);
        }
        continue;
      }

      if (line.startsWith('+++') || line.startsWith('---')) continue;

      if (line.startsWith('+')) {
        results.push({
          lineNumber: newLineNum,
          content: line.slice(1),
          type: 'added',
        });
        newLineNum++;
      } else if (line.startsWith('-')) {
        // Removed lines don't increment new line number
        // They indicate modification context
      } else {
        // Context line
        newLineNum++;
      }
    }
  }

  return results;
}

/**
 * Parse a unified diff and extract ALL lines (context + additions + gap markers)
 * for a target file. Returns the file view as seen in the "new" version.
 * Context lines = human-written / unchanged. Added lines = AI-written.
 */
function parseFullDiffForFile(
  diffText: string,
  targetFile: string,
): Array<{ lineNumber: number; content: string; type: 'context' | 'added'; isGap?: boolean }> {
  if (!diffText) return [];

  const results: Array<{ lineNumber: number; content: string; type: 'context' | 'added'; isGap?: boolean }> = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);
  let lastLineNum = 0;

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = headerMatch ? headerMatch[2] : '';

    const normalizedTarget = targetFile.replace(/^\//, '');
    const normalizedFile = filePath.replace(/^\//, '');
    if (
      normalizedFile !== normalizedTarget &&
      !normalizedFile.endsWith(normalizedTarget) &&
      !normalizedTarget.endsWith(normalizedFile)
    ) continue;

    let newLineNum = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Skip meta lines
      if (line.startsWith('\\ ')) continue;
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('similarity') ||
          line.startsWith('rename ') || line.startsWith('Binary ')) continue;

      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          const nextLineNum = parseInt(hunkMatch[1], 10);
          // Insert gap marker if there are hidden lines between hunks
          if (lastLineNum > 0 && nextLineNum > lastLineNum + 1) {
            results.push({
              lineNumber: -1,
              content: `${nextLineNum - lastLineNum - 1} lines hidden`,
              type: 'context',
              isGap: true,
            });
          } else if (lastLineNum === 0 && nextLineNum > 1) {
            results.push({
              lineNumber: -1,
              content: `${nextLineNum - 1} lines hidden`,
              type: 'context',
              isGap: true,
            });
          }
          newLineNum = nextLineNum;
        }
        continue;
      }

      if (line.startsWith('+')) {
        results.push({ lineNumber: newLineNum, content: line.slice(1), type: 'added' });
        lastLineNum = newLineNum;
        newLineNum++;
      } else if (line.startsWith('-')) {
        // Removed lines are not in the new file — skip
      } else {
        // Context line (starts with ' ' or is empty)
        results.push({
          lineNumber: newLineNum,
          content: line.startsWith(' ') ? line.slice(1) : line,
          type: 'context',
        });
        lastLineNum = newLineNum;
        newLineNum++;
      }
    }
  }

  return results;
}

router.get('/:id/blame', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const file = req.query.file as string;

    if (!file) {
      return res.status(400).json({ error: 'file query parameter is required' });
    }

    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      }),
      include: {
        promptChanges: { orderBy: { promptIndex: 'asc' } },
        sessionDiff: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Build attribution: walk through each prompt's diff in order
    // Later prompts override earlier attributions for the same lines
    const lineAttributions = new Map<
      number,
      { content: string; promptIndex: number; promptText: string; type: 'added' | 'modified' }
    >();

    const promptsInfo: BlamePrompt[] = [];

    for (const pc of session.promptChanges) {
      const filesChanged: string[] = (() => {
        try {
          return JSON.parse(pc.filesChanged || '[]');
        } catch {
          return [];
        }
      })();

      promptsInfo.push({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged,
      });

      // Check if this prompt touched the target file
      const normalizedTarget = file.replace(/^\//, '');
      const touchesFile = filesChanged.some((f) => {
        const nf = f.replace(/^\//, '');
        return nf === normalizedTarget || nf.endsWith(normalizedTarget) || normalizedTarget.endsWith(nf);
      });

      if (!touchesFile || !pc.diff) continue;

      // Parse the diff for this prompt and extract line attributions
      const lineChanges = parseDiffForFile(pc.diff, file);
      for (const change of lineChanges) {
        lineAttributions.set(change.lineNumber, {
          content: change.content,
          promptIndex: pc.promptIndex,
          promptText: pc.promptText,
          type: change.type,
        });
      }
    }

    // Build the blame result
    // If sessionDiff exists, show full file context (human + AI lines + gaps)
    // Otherwise, fall back to only attributed lines
    let blameLines: BlameLine[] = [];

    if (session.sessionDiff?.diff) {
      const fullView = parseFullDiffForFile(session.sessionDiff.diff, file);
      blameLines = fullView.map((line) => {
        if (line.isGap) {
          return {
            lineNumber: -1,
            content: line.content,
            attribution: null,
            isGap: true,
          };
        }
        // Check if this line has per-prompt attribution
        const attr = lineAttributions.get(line.lineNumber);
        return {
          lineNumber: line.lineNumber,
          content: line.content,
          attribution: attr
            ? {
                promptIndex: attr.promptIndex,
                promptText:
                  attr.promptText.length > 200
                    ? attr.promptText.slice(0, 200) + '...'
                    : attr.promptText,
                type: attr.type,
              }
            : null,
        };
      });
    } else {
      // Fallback: only attributed lines (no session diff available)
      const allLineNumbers = Array.from(lineAttributions.keys()).sort(
        (a, b) => a - b,
      );
      blameLines = allLineNumbers.map((ln) => {
        const attr = lineAttributions.get(ln)!;
        return {
          lineNumber: ln,
          content: attr.content,
          attribution: {
            promptIndex: attr.promptIndex,
            promptText:
              attr.promptText.length > 200
                ? attr.promptText.slice(0, 200) + '...'
                : attr.promptText,
            type: attr.type,
          },
        };
      });
    }

    const totalAttributedLines = blameLines.filter(
      (l) => l.attribution !== null && !l.isGap,
    ).length;

    res.json({
      file,
      sessionId: id,
      model: session.model,
      totalAttributedLines,
      lines: blameLines,
      prompts: promptsInfo.map((p) => ({
        ...p,
        promptText:
          p.promptText.length > 200 ? p.promptText.slice(0, 200) + '...' : p.promptText,
      })),
    });
  } catch (err) {
    console.error('Get session blame error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/ask — Ask the Author: contextual questions about a session
// ---------------------------------------------------------------------------

const ASK_AUTHOR_SYSTEM_PROMPT = `You are explaining code that was written during an AI coding session. You have access to the full transcript of the conversation between the human developer and the AI assistant, along with the code changes that were produced.

Your role is to explain WHY specific code decisions were made, based on what was discussed in the transcript. Reference specific parts of the conversation when relevant.

When answering:
- Reference specific prompts from the conversation that led to the code
- Explain the reasoning and intent, not just what the code does
- If the question is about code you don't have context for, say so
- Be concise but thorough
- Format responses in markdown when helpful
`;

router.post('/:id/ask', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { question, context, messages: conversationHistory } = req.body;

    if (!question && (!conversationHistory || conversationHistory.length === 0)) {
      return res.status(400).json({ error: 'question is required' });
    }

    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      }),
      include: {
        commit: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Build context sections
    const contextParts: string[] = [];

    // Session metadata
    contextParts.push(
      `=== Session Context ===\nModel: ${session.model}\nCommit: ${session.commit?.sha?.slice(0, 8) || 'n/a'} - ${session.commit?.message || 'n/a'}\nFiles Changed: ${(() => { try { return JSON.parse(session.filesChanged).join(', '); } catch { return 'n/a'; } })()}\nPrompt Count: ${session.promptChanges.length}`,
    );

    // Transcript (truncated to stay within token limits)
    let transcript = '';
    try {
      const parsed = JSON.parse(session.transcript);
      if (Array.isArray(parsed)) {
        transcript = parsed
          .map((m: any) => `[${m.role?.toUpperCase()}]: ${m.content}`)
          .join('\n\n');
      }
    } catch {
      transcript = session.transcript || '';
    }

    // Truncate transcript to ~30k chars
    if (transcript.length > 30000) {
      transcript = transcript.slice(-30000);
      transcript = '...(transcript truncated)...\n\n' + transcript;
    }

    if (transcript) {
      contextParts.push(`=== Transcript ===\n${transcript}`);
    }

    // Include relevant diffs
    let diffContext = '';
    if (context?.file) {
      // File-specific context: only include diffs for that file
      const relevantChanges = session.promptChanges.filter((pc) => {
        const files: string[] = (() => {
          try {
            return JSON.parse(pc.filesChanged || '[]');
          } catch {
            return [];
          }
        })();
        return files.some(
          (f) =>
            f === context.file ||
            f.endsWith(context.file) ||
            context.file.endsWith(f),
        );
      });

      diffContext = relevantChanges
        .map((pc) => `--- Prompt #${pc.promptIndex}: "${pc.promptText.slice(0, 100)}" ---\n${pc.diff}`)
        .join('\n\n');
    } else if (context?.promptIndex !== undefined) {
      // Prompt-specific context
      const pc = session.promptChanges.find(
        (p) => p.promptIndex === context.promptIndex,
      );
      if (pc) {
        diffContext = `--- Prompt #${pc.promptIndex}: "${pc.promptText}" ---\n${pc.diff}`;
      }
    } else {
      // General context: include all diffs (truncated)
      diffContext = session.promptChanges
        .map((pc) => `--- Prompt #${pc.promptIndex}: "${pc.promptText.slice(0, 80)}" ---\n${(pc.diff || '').slice(0, 2000)}`)
        .join('\n\n');

      if (diffContext.length > 15000) {
        diffContext = diffContext.slice(0, 15000) + '\n...(diffs truncated)...';
      }
    }

    if (diffContext) {
      contextParts.push(`=== Code Changes ===\n${diffContext}`);
    }

    const systemPrompt = ASK_AUTHOR_SYSTEM_PROMPT + '\n' + contextParts.join('\n\n');

    // Build messages array
    const msgs: Array<{ role: string; content: string }> = [];
    if (conversationHistory && Array.isArray(conversationHistory)) {
      msgs.push(...conversationHistory.slice(-10));
    }
    if (question) {
      msgs.push({ role: 'user', content: question });
    }

    // Use org-level LLM config (same key configured in Settings)
    const orgId = req.user!.orgId;
    const [orgKey, orgModel, orgProvider] = await Promise.all([
      getOrgLLMKey(orgId),
      getOrgLLMModel(orgId),
      getOrgLLMProvider(orgId),
    ]);

    const answer = await callLLM(systemPrompt, msgs, 2048, {
      apiKey: orgKey || undefined,
      model: orgModel,
      provider: orgProvider,
    });

    res.json({ answer });
  } catch (err: any) {
    console.error('Ask session author error:', err);
    if (err.message === 'AI chat is not configured') {
      return res.status(503).json({ error: 'AI chat is not configured. Set ANTHROPIC_API_KEY in Settings → Integrations.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/secrets — Report secret findings from pre-commit hook
// ---------------------------------------------------------------------------

router.post('/:id/secrets', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const { findings, source } = req.body;

    if (!findings || !Array.isArray(findings) || findings.length === 0) {
      return res.status(400).json({ error: 'findings array is required' });
    }

    // Verify session exists and belongs to user's org
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Store each finding
    for (const f of findings) {
      await prisma.secretFinding.create({
        data: {
          sessionId,
          type: f.type || 'GENERIC_SECRET',
          severity: f.severity || 'medium',
          filePath: f.filePath || '',
          lineNumber: f.lineNumber || 0,
          match: f.match || '',
          ruleName: f.ruleName || 'pre-commit',
        },
      });
    }

    // Audit log
    const orgId = req.user!.orgId;
    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'SECRET_DETECTED',
        resource: sessionId,
        metadata: JSON.stringify({
          sessionId,
          source: source || 'pre-commit',
          findingsCount: findings.length,
          types: [...new Set(findings.map((f: any) => f.type))],
          severities: [...new Set(findings.map((f: any) => f.severity))],
        }),
      },
    });

    // Notify admins for critical/high findings
    const criticalFindings = findings.filter(
      (f: any) => f.severity === 'critical' || f.severity === 'high',
    );
    if (criticalFindings.length > 0) {
      const typesSummary = [...new Set(criticalFindings.map((f: any) => f.ruleName))].join(', ');
      await notifyOrgAdmins(
        orgId,
        'SECRET_DETECTED',
        `Secret Detected (pre-commit): ${criticalFindings.length} finding${criticalFindings.length !== 1 ? 's' : ''}`,
        `${typesSummary} found — commit blocked`,
        `/sessions/${sessionId}`,
        { sessionId, findingsCount: criticalFindings.length, types: [...new Set(criticalFindings.map((f: any) => f.type))] },
      );
    }

    console.log(`[secrets] Session ${sessionId}: ${findings.length} finding(s) from ${source || 'pre-commit'}`);
    res.json({ stored: findings.length });
  } catch (err: any) {
    console.error('Store secret findings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/share — create a public share link for a session
router.post('/:id/share', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;
    const { expiresAt } = req.body || {};

    // Verify the session exists and belongs to user's org (support short ID prefix)
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId.length < 36 ? { startsWith: sessionId } : sessionId,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if already shared — return existing link (use resolved full ID)
    const existing = await prisma.sharedSession.findFirst({
      where: { sessionId: session.id },
    });

    if (existing) {
      const baseUrl = process.env.PUBLIC_URL || 'https://getorigin.io';
      return res.json({
        url: `${baseUrl}/s/${existing.slug}`,
        slug: existing.slug,
        expiresAt: existing.expiresAt,
      });
    }

    // Generate random 8-char alphanumeric slug
    const slug = crypto.randomBytes(6).toString('base64url').slice(0, 8);

    const shared = await prisma.sharedSession.create({
      data: {
        sessionId: session.id,
        slug,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdById: req.user!.id,
      },
    });

    const baseUrl = process.env.PUBLIC_URL || 'https://getorigin.io';
    res.json({
      url: `${baseUrl}/s/${shared.slug}`,
      slug: shared.slug,
      expiresAt: shared.expiresAt,
    });
  } catch (err) {
    console.error('Share session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/share — revoke a shared session link
router.delete('/:id/share', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId.length < 36 ? { startsWith: sessionId } : sessionId,
        commit: { repo: { orgId: req.user!.orgId } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await prisma.sharedSession.deleteMany({
      where: { sessionId: session.id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Revoke share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bookmarks ─────────────────────────────────────────────────────────────────

// GET /bookmarked — list bookmarked sessions for the current user
router.get('/bookmarked', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const orgId = req.user!.orgId;

    const bookmarks = await prisma.sessionBookmark.findMany({
      where: { userId },
      include: {
        session: {
          include: {
            commit: { include: { repo: true } },
            agent: true,
            user: true,
            review: { include: { user: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter to only sessions in the user's org
    const filtered = bookmarks.filter(
      (b) => b.session.commit?.repo?.orgId === orgId,
    );

    res.json(
      filtered.map((b) => ({
        ...mapSession(b.session),
        bookmark: {
          id: b.id,
          tags: JSON.parse(b.tags || '[]'),
          note: b.note,
          createdAt: b.createdAt,
        },
      })),
    );
  } catch (err) {
    console.error('List bookmarks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/bookmark — bookmark a session
router.post('/:id/bookmark', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;
    const { tags, note } = req.body || {};

    const bookmark = await prisma.sessionBookmark.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      update: {
        tags: JSON.stringify(tags || []),
        note: note || '',
      },
      create: {
        sessionId,
        userId,
        tags: JSON.stringify(tags || []),
        note: note || '',
      },
    });

    res.json({
      id: bookmark.id,
      sessionId: bookmark.sessionId,
      tags: JSON.parse(bookmark.tags || '[]'),
      note: bookmark.note,
      createdAt: bookmark.createdAt,
    });
  } catch (err) {
    console.error('Bookmark session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/bookmark — remove bookmark
router.delete('/:id/bookmark', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const sessionId = req.params.id as string;

    await prisma.sessionBookmark.deleteMany({
      where: { sessionId, userId },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Remove bookmark error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /merge — merge multiple sessions into one
router.post('/merge', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionIds, name } = req.body as { sessionIds: string[]; name?: string };

    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 session IDs are required' });
    }

    // Fetch all sessions with their data
    const sessions = await prisma.codingSession.findMany({
      where: {
        id: { in: sessionIds },
        userId, // only merge own sessions
      },
      include: {
        commit: { include: { repo: true } },
        agent: true,
        promptChanges: { orderBy: { createdAt: 'asc' } },
        sessionDiff: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    if (sessions.length !== sessionIds.length) {
      return res.status(404).json({ error: 'One or more sessions not found or not accessible' });
    }

    // Validate: no running sessions
    if (sessions.some((s) => s.status === 'RUNNING')) {
      return res.status(400).json({ error: 'Cannot merge running sessions. Wait for them to complete.' });
    }

    // Validate: all from same repo
    const repoIds = new Set(sessions.map((s) => s.commit?.repoId).filter(Boolean));
    if (repoIds.size > 1) {
      return res.status(400).json({ error: 'Cannot merge sessions from different repositories' });
    }

    // Validate: not already merged
    if (sessions.some((s) => s.mergedInto)) {
      return res.status(400).json({ error: 'One or more sessions were already merged into another session' });
    }

    // Compute merged values
    const totalTokens = sessions.reduce((sum, s) => sum + s.tokensUsed, 0);
    const totalInputTokens = sessions.reduce((sum, s) => sum + s.inputTokens, 0);
    const totalOutputTokens = sessions.reduce((sum, s) => sum + s.outputTokens, 0);
    const totalToolCalls = sessions.reduce((sum, s) => sum + s.toolCalls, 0);
    const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const totalLinesAdded = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
    const totalLinesRemoved = sessions.reduce((sum, s) => sum + s.linesRemoved, 0);
    const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);

    // Files changed: union of all
    const allFiles = new Set<string>();
    for (const s of sessions) {
      try {
        const files = JSON.parse(s.filesChanged);
        if (Array.isArray(files)) files.forEach((f: string) => allFiles.add(f));
      } catch { /* ignore */ }
    }

    // Agent: use common agent or "Multiple"
    const agentIds = new Set(sessions.map((s) => s.agentId).filter(Boolean));
    const agentNames = [...new Set(sessions.map((s) => s.agent?.name).filter(Boolean))];
    const mergedAgentId = agentIds.size === 1 ? [...agentIds][0] : null;

    // Model: use common model or list
    const models = [...new Set(sessions.map((s) => s.model))];
    const mergedModel = models.length === 1 ? models[0] : models.join(' + ');

    // Branch: use common branch
    const branches = [...new Set(sessions.map((s) => s.branch).filter(Boolean))];
    const mergedBranch = branches.length === 1 ? branches[0] : branches.join(', ');

    // Combine transcripts
    const combinedTranscript: any[] = [];
    for (const s of sessions) {
      try {
        const parsed = JSON.parse(s.transcript);
        if (Array.isArray(parsed)) {
          combinedTranscript.push(
            { role: 'system', content: `--- Session ${s.id.slice(0, 8)} (${s.agent?.name || s.model}) ---` },
            ...parsed,
          );
        }
      } catch {
        if (s.transcript) {
          combinedTranscript.push(
            { role: 'system', content: `--- Session ${s.id.slice(0, 8)} ---` },
            { role: 'assistant', content: s.transcript },
          );
        }
      }
    }

    // Combine diffs
    const combinedDiff = sessions
      .map((s) => s.sessionDiff?.diff || '')
      .filter(Boolean)
      .join('\n');

    // Time range
    const startedAt = sessions[0].startedAt || sessions[0].createdAt;
    const endedAt = sessions[sessions.length - 1].endedAt || sessions[sessions.length - 1].createdAt;

    // Create placeholder commit for the merged session
    const placeholderSha = crypto.randomBytes(20).toString('hex');
    const repoId = sessions[0].commit?.repoId!;
    const mergedCommit = await prisma.commit.create({
      data: {
        repoId,
        sha: placeholderSha,
        message: name || `Merged session (${sessions.length} sessions)`,
        author: 'origin-merge',
        aiToolDetected: mergedModel,
        aiDetectionMethod: 'merge',
        filesChanged: JSON.stringify([...allFiles]),
        committedAt: new Date(),
      },
    });

    // Create the merged session
    const mergedSession = await prisma.codingSession.create({
      data: {
        commitId: mergedCommit.id,
        agentId: mergedAgentId,
        userId,
        model: mergedModel,
        prompt: name || `Merged: ${agentNames.length > 1 ? agentNames.join(' + ') : agentNames[0] || 'AI'} session`,
        transcript: JSON.stringify(combinedTranscript),
        filesChanged: JSON.stringify([...allFiles]),
        tokensUsed: totalTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: totalToolCalls,
        durationMs: totalDuration,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        costUsd: totalCost,
        branch: mergedBranch || null,
        status: 'COMPLETED',
        mergedFrom: JSON.stringify(sessionIds),
        startedAt,
        endedAt,
      },
    });

    // Create merged session diff
    if (combinedDiff) {
      const allCommitShas = sessions.flatMap((s) => {
        try { return JSON.parse(s.sessionDiff?.commitShas || '[]'); } catch { return []; }
      });
      await prisma.sessionDiff.create({
        data: {
          sessionId: mergedSession.id,
          headBefore: sessions[0].sessionDiff?.headBefore || '',
          headAfter: sessions[sessions.length - 1].sessionDiff?.headAfter || '',
          commitShas: JSON.stringify([...new Set(allCommitShas)]),
          diff: combinedDiff,
          diffTruncated: sessions.some((s) => s.sessionDiff?.diffTruncated),
          linesAdded: totalLinesAdded,
          linesRemoved: totalLinesRemoved,
        },
      });
    }

    // Re-index prompt changes into the merged session
    let promptOffset = 0;
    for (const s of sessions) {
      for (const pc of s.promptChanges) {
        await prisma.promptChange.create({
          data: {
            sessionId: mergedSession.id,
            promptIndex: promptOffset + pc.promptIndex,
            promptText: pc.promptText,
            filesChanged: pc.filesChanged,
            diff: pc.diff,
            uncommittedDiff: pc.uncommittedDiff || '',
            createdAt: pc.createdAt,
          },
        });
      }
      promptOffset += s.promptChanges.length;
    }

    // Mark original sessions as merged
    await prisma.codingSession.updateMany({
      where: { id: { in: sessionIds } },
      data: { mergedInto: mergedSession.id },
    });

    res.json({
      mergedSessionId: mergedSession.id,
      mergedCount: sessions.length,
      totalTokens,
      totalCost,
    });
  } catch (err) {
    console.error('Merge sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
