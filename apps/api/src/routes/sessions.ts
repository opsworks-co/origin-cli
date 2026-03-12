import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
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
import { callClaude } from './chat.js';

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
    branch: s.branch || null,
    status: s.status || 'COMPLETED',
    startedAt: s.startedAt || null,
    endedAt: s.endedAt || null,
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

    if (req.query.branch) {
      where.branch = req.query.branch as string;
    }

    // Enforce repo-scoped API key access
    if (req.apiKeyRepoScopes && req.apiKeyRepoScopes.length > 0) {
      where.commit = {
        ...where.commit,
        repoId: { in: req.apiKeyRepoScopes },
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

// GET /active — currently running sessions
router.get('/active', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    const sessions = await prisma.codingSession.findMany({
      where: {
        status: 'RUNNING',
        commit: { repo: { orgId } },
      },
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
          const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://origin-platform.fly.dev';

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
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
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
      where: {
        id,
        commit: { repo: { orgId: req.user!.orgId } },
      },
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

    const answer = await callClaude(systemPrompt, msgs, 2048);

    res.json({ answer });
  } catch (err: any) {
    console.error('Ask session author error:', err);
    if (err.message === 'AI chat is not configured') {
      return res.status(503).json({ error: 'AI chat is not configured. Set ANTHROPIC_API_KEY.' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
