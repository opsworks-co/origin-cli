import { Router, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rate-limit.js';
import { notifyOrgAdmins, notifyOrgMembers } from '../services/notifications.js';
import { safeParseArray, safeParseObject } from '../utils/safe-json.js';
import { generateSessionTitle } from '../services/ai-summarize.js';

/** Check if user has admin/owner role */
function isAdminUser(req: AuthRequest): boolean {
  const role = (req.activeRole! || '').toUpperCase();
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
router.use(resolveOrgContext);

const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min without prompt activity → IDLE
// Auto-end sessions idle for 1 hour even if heartbeat is alive (agent stopped working)
const AUTO_END_IDLE_MS = 60 * 60 * 1000; // 1 hour
// Safety net: if heartbeat hasn't pinged in 2 hours, the agent is truly dead.
// This only catches cases where the heartbeat daemon crashed without sending session/end.
const ABANDONED_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
// Hard cap: no real coding session should run longer than this. Catches
// runaway heartbeats and ghost sessions that never sent a prompt or end
// event. If startedAt was >24h ago and we're still "RUNNING", force-close.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function computeStatus(s: any): string {
  // COMPLETED/ERROR = terminal states. Only set by explicit session/end call.
  if (s.status === 'COMPLETED' || s.status === 'ERROR') return s.status;

  // RUNNING sessions: check prompt activity for IDLE detection
  if (s.status === 'RUNNING') {
    const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
    if (lastPrompt && Date.now() - lastPrompt > IDLE_THRESHOLD_MS) return 'IDLE';
    return 'RUNNING';
  }

  return s.status || 'COMPLETED';
}

/**
 * Derive a short human-readable title for a session from the data we have.
 *
 * Strategy (cheap, no LLM): first non-empty line of the first prompt, then
 * the first commit message, then the model. Capped to ~70 chars so the
 * snapshot list and sessions list stay tidy. The DB column \`aiTitle\` lets
 * a future enrichment pass overwrite this with an LLM-generated summary
 * without changing the read path.
 */
function deriveSessionTitle(s: any): string | null {
  const clean = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    // Drop common boilerplate prefixes / role markers.
    let t = String(raw).trim();
    if (!t) return null;
    // First non-empty line
    t = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
    if (!t) return null;
    // Strip leading punctuation/markdown
    t = t.replace(/^[#>\-*\s]+/, '').trim();
    if (t.length > 70) t = t.slice(0, 67).trimEnd() + '…';
    // Title-case the first letter so it reads as a session label.
    if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
    return t || null;
  };

  // Prefer the first prompt — it's almost always the most descriptive.
  // promptChanges (when included by the query) preserve order; fall back
  // to s.prompt which is the joined prompt text.
  const firstPrompt = Array.isArray(s.promptChanges) && s.promptChanges.length > 0
    ? s.promptChanges[0]?.promptText
    : null;
  const fromPrompt = clean(firstPrompt) || clean(s.prompt);
  if (fromPrompt) return fromPrompt;

  const fromCommit = clean(s.commit?.message);
  if (fromCommit) return fromCommit;

  return null;
}

function mapSession(s: any, pullRequests?: any[]) {
  return {
    id: s.id,
    commitId: s.commitId,
    agentId: s.agentId,
    agentName: s.agent?.name || null,
    userId: s.userId || null,
    // Prefer real user → email → API key name. Never expose the
    // "mcp-agent" placeholder string that the commit-author column
    // sometimes carries when no user is linked.
    userName: s.user?.name || s.user?.email || s.apiKeyName || null,
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
    aiTitle: (s as any).aiTitle || deriveSessionTitle(s),
    transcript: s.transcript,
    filesChanged: s.filesChanged,
    tokensUsed: s.tokensUsed,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: (s as any).cacheReadTokens ?? 0,
    cacheCreationTokens: (s as any).cacheCreationTokens ?? 0,
    toolCalls: s.toolCalls,
    durationMs: (() => {
      const status = computeStatus(s);
      // For active sessions, compute live duration from startedAt
      if ((status === 'RUNNING' || status === 'IDLE') && s.startedAt) {
        return Date.now() - new Date(s.startedAt).getTime();
      }
      return s.durationMs;
    })(),
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
    // safeParse* everywhere in this mapper: one corrupt row used to 500 the
    // entire list endpoint because a single JSON.parse throw inside a .map
    // callback bubbles all the way out. Logging + falling back to a sane
    // default keeps the list rendering while still surfacing the bad row.
    mergedFrom: s.mergedFrom ? safeParseObject(s.mergedFrom, `session.${s.id}.mergedFrom`, null as any) : null,
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
          concerns: safeParseArray(s.review.concerns, `session.${s.id}.review.concerns`),
          suggestions: safeParseArray(s.review.suggestions, `session.${s.id}.review.suggestions`),
          categories: s.review.categories
            ? safeParseObject(s.review.categories, `session.${s.id}.review.categories`, null as any)
            : null,
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
          commitShas: safeParseArray<string>(s.sessionDiff.commitShas, `session.${s.id}.sessionDiff.commitShas`),
          diff: s.sessionDiff.diff,
          diffTruncated: s.sessionDiff.diffTruncated,
          linesAdded: s.sessionDiff.linesAdded,
          linesRemoved: s.sessionDiff.linesRemoved,
        }
      : null,
    promptChanges: s.promptChanges
      ? (() => {
          // Deduplicate by promptIndex (race condition can create duplicates)
          const seen = new Set<number>();
          return s.promptChanges
            .map((pc: any) => ({
              promptIndex: pc.promptIndex,
              promptText: pc.promptText,
              filesChanged: safeParseArray<string>(pc.filesChanged, `session.${s.id}.promptChanges.filesChanged`),
              diff: pc.diff || '',
              uncommittedDiff: pc.uncommittedDiff || '',
              linesAdded: pc.linesAdded || 0,
              linesRemoved: pc.linesRemoved || 0,
              aiPercentage: pc.aiPercentage ?? 100,
              checkpointType: pc.checkpointType || null,
              commitSha: pc.commitSha || null,
              treeSha: pc.treeSha || null,
              createdAt: pc.createdAt,
            }))
            .filter((pc: any) => {
              if (seen.has(pc.promptIndex)) return false;
              seen.add(pc.promptIndex);
              return true;
            });
        })()
      : [],
    // Snapshots taken during this session, exposed for the timeline rail.
    snapshots: Array.isArray(s.snapshots)
      ? s.snapshots.map((sn: any) => ({
          id: sn.id,
          snapshotId: sn.snapshotId,
          type: sn.type,
          takenAt: sn.takenAt,
          promptIndex: sn.promptIndex,
          commitSha: sn.commitSha,
        }))
      : [],
    // All commits attributed to this session (primary + sessionCommits union),
    // deduplicated by SHA and sorted by time. Surfaces commits made on
    // feature branches during the session — the primary commit field only
    // ever points at one of them.
    commits: (() => {
      const all: any[] = [];
      if (s.commit) all.push(s.commit);
      if (Array.isArray(s.commits)) {
        for (const c of s.commits) all.push(c);
      }
      const seen = new Set<string>();
      return all
        .filter((c) => {
          if (!c?.sha || seen.has(c.sha)) return false;
          seen.add(c.sha);
          return true;
        })
        .sort((a, b) => new Date(a.committedAt).getTime() - new Date(b.committedAt).getTime())
        .map((c) => ({
          id: c.id,
          sha: c.sha,
          message: c.message,
          author: c.author,
          branch: c.branch || null,
          committedAt: c.committedAt,
          filesChanged: safeParseArray<string>(c.filesChanged, `session.${s.id}.commits.${c.sha}.filesChanged`),
          repoName: c.repo?.name || null,
        }));
    })(),
  };
}

// GET / — list coding sessions for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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
    const userRole = (req.activeRole! || '').toUpperCase();
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
          promptChanges: { orderBy: { promptIndex: 'asc' } },
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

    // Safety net: expire abandoned or long-idle sessions.
    const now = Date.now();
    const abandonedIds: string[] = [];
    for (const s of sessions) {
      if (s.status === 'RUNNING') {
        const lastHeartbeat = new Date(s.updatedAt || s.createdAt).getTime();
        const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
        const startedAt = new Date(s.startedAt || s.createdAt).getTime();

        // Heartbeat died
        if (now - lastHeartbeat > ABANDONED_THRESHOLD_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = s.updatedAt || s.createdAt;
          continue;
        }
        // Heartbeat alive but idle for 1 hour
        if (lastPrompt && now - lastPrompt > AUTO_END_IDLE_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = new Date(lastPrompt + AUTO_END_IDLE_MS);
          continue;
        }
        // Hard cap: a single session running for more than 24h is always a
        // ghost. Catches heartbeat-only sessions that never sent a prompt
        // (so the lastPrompt check above short-circuits) and runaway
        // heartbeat loops.
        if (now - startedAt > MAX_SESSION_AGE_MS) {
          abandonedIds.push(s.id);
          s.status = 'COMPLETED';
          s.endedAt = new Date(startedAt + MAX_SESSION_AGE_MS);
          continue;
        }
      }
    }
    if (abandonedIds.length > 0) {
      prisma.codingSession.updateMany({
        where: { id: { in: abandonedIds } },
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

    // Fire-and-forget: upgrade heuristic titles to LLM-generated ones for
    // sessions in this page that don't have an aiTitle yet. Capped to 5
    // per request so a fresh dashboard view doesn't fan out into dozens
    // of provider calls. Caller's response uses whatever's already on
    // the row; the next page load picks up the upgraded titles.
    try {
      const needsTitle = sessions.filter((s: any) => !s.aiTitle).slice(0, 5);
      for (const s of needsTitle) {
        generateSessionTitle(s.id).catch(() => { /* silent — heuristic stays */ });
      }
    } catch { /* ignore */ }

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
    const orgId = req.activeOrgId!;

    const activeWhere: any = {
      status: 'RUNNING',
      commit: { repo: { orgId } },
    };

    // Non-admin users only see their own active sessions
    const activeRole = (req.activeRole! || '').toUpperCase();
    const activeIsAdmin = activeRole === 'ADMIN' || activeRole === 'OWNER';
    if (!activeIsAdmin) {
      activeWhere.userId = req.user!.id;
    }

    // Active sessions list — cap 500 since "active" should be small by
    // definition (sessions still running in the last ~2h).
    const sessions = await prisma.codingSession.findMany({
      where: activeWhere,
      include: {
        commit: { include: { repo: true } },
        agent: true,
        user: true,
        review: { include: { user: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Auto-end abandoned or long-idle sessions
    const now = Date.now();
    const endIds: string[] = [];
    for (const s of sessions) {
      const lastHeartbeat = new Date(s.updatedAt || s.createdAt).getTime();
      const lastPrompt = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;

      // Heartbeat died — agent crashed
      if (now - lastHeartbeat > ABANDONED_THRESHOLD_MS) {
        endIds.push(s.id);
        s.status = 'COMPLETED';
        s.endedAt = s.updatedAt || s.createdAt;
        continue;
      }

      // Heartbeat alive but no prompt activity for 1 hour — agent stopped working
      if (lastPrompt && now - lastPrompt > AUTO_END_IDLE_MS) {
        endIds.push(s.id);
        s.status = 'COMPLETED';
        s.endedAt = new Date(lastPrompt + AUTO_END_IDLE_MS);
        continue;
      }
    }
    if (endIds.length > 0) {
      prisma.codingSession.updateMany({
        where: { id: { in: endIds } },
        data: { status: 'COMPLETED', endedAt: new Date() },
      }).catch(() => {});
    }

    // Only return truly active sessions
    const endSet = new Set(endIds);
    const activeSessions = sessions.filter((s) => !endSet.has(s.id));

    res.json({ sessions: activeSessions.map((s) => mapSession(s)) });
  } catch (err) {
    console.error('List active sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /by-pr — sessions grouped by pull request
router.get('/by-pr', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    // Get all repos for org (cap — the in(...) filter below otherwise
    // scales with total org repos, and unbounded materialization of
    // the id list alone is a DoS on large tenants).
    const repos = await prisma.repo.findMany({
      where: { orgId },
      select: { id: true },
      take: 5000,
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

      // Find commits for these SHAs (cap matches PR commit list ceiling)
      const commits = await prisma.commit.findMany({
        where: { repoId: pr.repoId, sha: { in: commitShas } },
        select: { id: true },
        take: 5000,
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
        take: 5000,
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
    const orgId = req.activeOrgId!;
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
    } catch (err) {
      console.warn(`[sessions] malformed filesChanged JSON for session ${session.id}:`, (err as Error).message);
    }

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
// Per-user concurrent stream cap. Without this an attacker who has a valid
// token (or a misbehaving client) can open N streams within the 120/min
// sessionLimiter budget and hold them indefinitely via server heartbeats,
// pinning sockets + EventEmitter listeners on the server. 10 is generous
// for legit use cases (multi-tab dashboards) and cheap to track in-memory.
const MAX_STREAMS_PER_USER = 10;
const activeStreamCounts = new Map<string, number>();
router.get('/stream', async (req: AuthRequest, res: Response) => {
  const orgId = req.activeOrgId!;
  const streamUserId = req.user!.id;

  const current = activeStreamCounts.get(streamUserId) || 0;
  if (current >= MAX_STREAMS_PER_USER) {
    return res.status(429).json({ error: 'Too many concurrent streams for this user' });
  }
  activeStreamCounts.set(streamUserId, current + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('data: {"type":"connected"}\n\n');

  const streamIsAdmin = isAdminUser(req);

  const unsubscribe = onSessionEvent((event: SessionEvent) => {
    if (event.orgId === orgId && (streamIsAdmin || event.userId === streamUserId)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    const next = (activeStreamCounts.get(streamUserId) || 1) - 1;
    if (next <= 0) activeStreamCounts.delete(streamUserId);
    else activeStreamCounts.set(streamUserId, next);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

// PATCH /bulk/archive — bulk archive sessions
router.patch('/bulk/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { sessionIds, archived } = req.body;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: 'sessionIds array required' });
    }
    // DoS cap: one bulk-archive call can touch at most 1000 sessions.
    // Without this a client could pass an arbitrarily long id list and
    // force a huge UPDATE.
    if (sessionIds.length > 1000) {
      return res.status(400).json({ error: 'Cannot archive more than 1000 sessions at once' });
    }

    const orgId = req.activeOrgId!;
    const result = await prisma.codingSession.updateMany({
      where: {
        id: { in: sessionIds },
        commit: { repo: { orgId } },
      },
      data: { archived: archived !== false },
    });

    res.json({ success: true, count: result.count });
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
      commit: { repo: { orgId: req.activeOrgId! } },
    };

    // Non-admin users can only view their own sessions
    const detailRole = (req.activeRole! || '').toUpperCase();
    const detailIsAdmin = detailRole === 'ADMIN' || detailRole === 'OWNER';
    if (!detailIsAdmin) {
      detailWhere.userId = req.user!.id;
    }

    const session = await prisma.codingSession.findFirst({
      where: detailWhere,
      include: {
        commit: { include: { repo: true } },
        // Additional commits attributed to this session (sessionCommits relation).
        // A session can span multiple commits — especially across branches when
        // a prompt runs `git checkout -b …`. `commit` above is the primary;
        // `commits` is every commit the post-commit hook attributed to us.
        commits: {
          include: { repo: { select: { name: true } } },
          orderBy: { committedAt: 'asc' },
          take: 500,
        },
        agent: true,
        user: true,
        review: { include: { user: true } },
        sessionDiff: true,
        promptChanges: { orderBy: { promptIndex: 'asc' } },
        sessionRepos: { include: { repo: true } },
        snapshots: { orderBy: { takenAt: 'asc' }, take: 500 },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Find linked pull requests
    let pullRequests: any[] = [];
    if (session.commit?.sha && session.commit?.repoId) {
      // Cap at 2000 PRs per repo. We can't narrow in SQL because
      // commitShas is a JSON string column, not a relation, so we fetch
      // and filter in memory. 2000 is well above typical per-repo PR
      // counts; beyond that we should migrate commitShas to a proper
      // join table.
      const allPRs = await prisma.pullRequest.findMany({
        where: { repoId: session.commit.repoId },
        take: 2000,
        orderBy: { createdAt: 'desc' },
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
      take: 500,
    });
    if (chainSessions.length > 1) {
      mapped.chainSessions = chainSessions;
    }

    // Mid-session model switches: surface every distinct model the session
    // saw across its prompt changes. Falls back to [session.model] when no
    // PromptChange.model values are present (older clients / single-model
    // sessions). Order: first-seen-first.
    const seen = new Set<string>();
    const modelsUsed: string[] = [];
    for (const pc of session.promptChanges ?? []) {
      const m = (pc as { model?: string | null }).model || null;
      if (m && !seen.has(m)) { seen.add(m); modelsUsed.push(m); }
    }
    if (modelsUsed.length === 0 && session.model) modelsUsed.push(session.model);
    mapped.modelsUsed = modelsUsed;

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
        commit: { repo: { orgId: req.activeOrgId! } },
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
      commitShas: safeParseArray<string>(session.sessionDiff.commitShas, `sessions.diff ${session.id}`),
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
    if (typeof status !== 'string' || status.length > 50) {
      return res.status(400).json({ error: 'Field status must be a string ≤ 50 chars' });
    }
    if (note != null && (typeof note !== 'string' || note.length > 10_000)) {
      return res.status(400).json({ error: 'Field note must be a string ≤ 10000 chars' });
    }

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
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
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'SESSION_REVIEWED',
        resource: id,
        metadata: JSON.stringify({ sessionId: id, status }),
      },
    });

    // Notify based on review status
    if (status === 'FLAGGED') {
      await notifyOrgAdmins(
        req.activeOrgId!,
        'SESSION_FLAGGED',
        'Session Flagged',
        `A coding session has been flagged for review`,
        `/sessions/${id}`,
        { sessionId: id, status }
      );
    } else {
      await notifyOrgAdmins(
        req.activeOrgId!,
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
      const integration = await getIntegrationConfig(req.activeOrgId!);
      if (integration?.parsedSettings.checkOnReview && session.commitId) {
        const commit = await prisma.commit.findUnique({
          where: { id: session.commitId },
          include: { repo: true },
        });

        if (commit?.sha && commit.repo) {
          // Find PRs that include this commit. Cap at 2000 per repo
          // (see identical comment above).
          const allPRs = await prisma.pullRequest.findMany({
            where: { repoId: commit.repoId },
            take: 2000,
            orderBy: { createdAt: 'desc' },
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
              const org = await prisma.org.findUnique({ where: { id: req.activeOrgId! }, select: { slug: true } });
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
      orgId: req.activeOrgId!,
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
// AI review hits the org's LLM key with the full session transcript —
// the most expensive single op in the API. Gate behind the strict
// limiter (10/min/user) so a compromised user token can't burn the
// entire budget in a tight loop.
router.post('/:id/ai-review', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const session = await prisma.codingSession.findFirst({
      where: {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
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
    try { filesChanged = JSON.parse(session.filesChanged); } catch (err) {
      console.warn(`[sessions] malformed filesChanged JSON for review session ${id}:`, (err as Error).message);
    }

    const result = await runAIReview({
      sessionId: id,
      orgId: req.activeOrgId!,
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
        concerns: safeParseArray(review.concerns, `sessions.ai-review ${id}.concerns`),
        suggestions: safeParseArray(review.suggestions, `sessions.ai-review ${id}.suggestions`),
        categories: review.categories ? safeParseObject(review.categories, `sessions.ai-review ${id}.categories`, null as any) : null,
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
          { commit: { repo: { orgId: req.activeOrgId! } } },
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

    // Wrap the status flip + audit log in a single transaction so a crash or
    // connection drop can't leave a RUNNING session with an orphan audit row
    // (or vice versa). Both writes succeed or neither does.
    await prisma.$transaction([
      prisma.codingSession.update({
        where: { id: session.id },
        data: {
          status: 'COMPLETED',
          endedAt: now,
          durationMs,
        },
      }),
      prisma.auditLog.create({
        data: {
          orgId: req.activeOrgId!,
          userId: req.user!.id,
          action: 'SESSION_ENDED',
          resource: session.id,
          metadata: JSON.stringify({ sessionId: session.id }),
        },
      }),
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('End session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/branch — queue a branch-creation command for the CLI heartbeat to pick up
router.post('/:id/branch', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;
    const { commitSha, branchName, checkout } = req.body;

    if (!commitSha) return res.status(400).json({ error: 'commitSha required' });

    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const command = JSON.stringify({
      type: 'branch',
      commitSha,
      branchName: branchName || null,
      checkout: !!checkout,
      requestedAt: new Date().toISOString(),
      requestedBy: (req.user as any).email || req.user!.id,
    });

    await prisma.codingSession.update({
      where: { id },
      data: { pendingCommand: command, lastCommandResult: null },
    });

    res.json({ success: true, message: 'Branch queued. CLI will create it on next heartbeat.' });
  } catch (err) {
    console.error('Branch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/restore — queue a restore command for the CLI heartbeat to pick up
router.post('/:id/restore', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;
    const { treeSha, commitSha, promptIndex } = req.body;

    if (!treeSha && !commitSha) {
      return res.status(400).json({ error: 'treeSha or commitSha required' });
    }

    // Verify session belongs to org
    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true, status: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Queue the restore command — CLI heartbeat will pick it up
    const command = JSON.stringify({
      type: 'restore',
      treeSha: treeSha || null,
      commitSha: commitSha || null,
      promptIndex: promptIndex ?? null,
      requestedAt: new Date().toISOString(),
      requestedBy: (req.user as any).email || req.user!.id,
    });

    await prisma.codingSession.update({
      where: { id },
      data: { pendingCommand: command, lastCommandResult: null },
    });

    res.json({ success: true, message: 'Restore queued. CLI will pick it up on next heartbeat.' });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/restore-status — lightweight status check for pending restore
router.get('/:id/restore-status', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.activeOrgId!;

    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { pendingCommand: true, lastCommandResult: true, status: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let result: any = null;
    if (session.lastCommandResult) {
      try { result = JSON.parse(session.lastCommandResult); } catch { /* ignore */ }
    }

    res.json({
      sessionStatus: session.status,
      pending: !!session.pendingCommand,
      result,
    });
  } catch (err) {
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
        commit: { repo: { orgId: req.activeOrgId! } },
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
        orgId: req.activeOrgId!,
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
        commit: { repo: { orgId: req.activeOrgId! } },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Cascade delete in a single transaction so a partial failure can't
    // leave orphan child rows (sessionDiff, promptChange, etc.) referencing
    // a non-existent session.
    await prisma.$transaction([
      prisma.issueSession.deleteMany({ where: { sessionId: id } }),
      prisma.sessionDiff.deleteMany({ where: { sessionId: id } }),
      prisma.promptChange.deleteMany({ where: { sessionId: id } }),
      prisma.secretFinding.deleteMany({ where: { sessionId: id } }),
      prisma.sessionReview.deleteMany({ where: { sessionId: id } }),
      prisma.codingSession.delete({ where: { id } }),
      prisma.commit.delete({ where: { id: session.commitId } }),
    ]);

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
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
        commit: { repo: { orgId: req.activeOrgId! } },
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

    // Deduplicate promptChanges by promptIndex (race condition can create duplicates)
    const seenIdx = new Set<number>();
    const dedupedChanges = session.promptChanges.filter((pc: any) => {
      if (seenIdx.has(pc.promptIndex)) return false;
      seenIdx.add(pc.promptIndex);
      return true;
    });

    for (const pc of dedupedChanges) {
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

    // Distinct list of models used across this session's prompts. Falls back
    // to [session.model] when no per-prompt model field is populated.
    const blameSeen = new Set<string>();
    const blameModelsUsed: string[] = [];
    for (const pc of session.promptChanges ?? []) {
      const m = (pc as { model?: string | null }).model || null;
      if (m && !blameSeen.has(m)) { blameSeen.add(m); blameModelsUsed.push(m); }
    }
    if (blameModelsUsed.length === 0 && session.model) blameModelsUsed.push(session.model);

    res.json({
      file,
      sessionId: id,
      model: session.model,
      modelsUsed: blameModelsUsed,
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

router.post('/:id/ask', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { question, context, messages: conversationHistory } = req.body;

    if (!question && (!conversationHistory || conversationHistory.length === 0)) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Cost-burning defense. /ask sends `question` + `conversationHistory`
    // straight into an LLM call, and every request here spends the org's
    // LLM credits. Without a cap, a member could post a 50MB question and
    // blow a five-figure hole in a single request. Cap the question
    // itself, the per-message content, and the total history size.
    const MAX_QUESTION_LEN = 8 * 1024;   // 8KB per question
    const MAX_HISTORY_BYTES = 50 * 1024; // 50KB aggregate history
    const MAX_HISTORY_MSGS = 50;         // even with slice(-10), cap incoming array
    if (question !== undefined && typeof question !== 'string') {
      return res.status(400).json({ error: 'question must be a string' });
    }
    if (typeof question === 'string' && question.length > MAX_QUESTION_LEN) {
      return res.status(413).json({ error: 'question exceeds maximum length' });
    }
    if (conversationHistory !== undefined && !Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    if (Array.isArray(conversationHistory)) {
      if (conversationHistory.length > MAX_HISTORY_MSGS) {
        return res.status(413).json({ error: 'messages array exceeds maximum length' });
      }
      let total = 0;
      for (const m of conversationHistory) {
        const c = typeof m?.content === 'string' ? m.content : '';
        total += c.length;
        if (total > MAX_HISTORY_BYTES) {
          return res.status(413).json({ error: 'messages aggregate size exceeds limit' });
        }
      }
    }

    const session = await prisma.codingSession.findFirst({
      where: scopedSessionWhere(req, {
        id,
        commit: { repo: { orgId: req.activeOrgId! } },
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
    const orgId = req.activeOrgId!;
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
    // Cap findings array. Each entry writes a SecretFinding row below, so
    // an unbounded POST turns into an unbounded sequential DB-write amp.
    const MAX_FINDINGS = 500;
    if (findings.length > MAX_FINDINGS) {
      return res.status(413).json({ error: `findings exceeds max of ${MAX_FINDINGS}` });
    }

    // Verify session exists and belongs to user's org
    const session = await prisma.codingSession.findFirst({
      where: {
        id: sessionId,
        commit: { repo: { orgId: req.activeOrgId! } },
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
    const orgId = req.activeOrgId!;
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
        commit: { repo: { orgId: req.activeOrgId! } },
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

    // Generate a 22-char base64url slug from 128 bits of entropy.
    //
    // The previous implementation used 6 bytes → 8 base64url chars ≈ 48
    // bits, which is well within brute-force range for an unauthenticated
    // URL that returns full prompts, transcripts, and diffs. At 48 bits an
    // attacker enumerating the slug space finds a valid link after roughly
    // 2^24 requests — minutes on a cheap VPS, even with our rate limits.
    //
    // 16 bytes → 22 base64url chars (trailing `=` stripped) → 128 bits. At
    // that width, enumeration becomes computationally infeasible regardless
    // of rate limits, matching the security posture of session UUIDs.
    //
    // Existing short slugs in the DB still work — they're looked up by
    // exact match in GET /:slug, so the length change is forward-compatible.
    const slug = crypto.randomBytes(16).toString('base64url').replace(/=+$/, '');

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
        commit: { repo: { orgId: req.activeOrgId! } },
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
    const orgId = req.activeOrgId!;

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
          tags: safeParseArray<string>(b.tags, `bookmarks.list ${b.id}`),
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
      tags: safeParseArray<string>(bookmark.tags, `bookmarks.create ${bookmark.id}`),
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
    // Hard cap — merging 100 sessions already stresses diff serialization,
    // and without a ceiling the client can make us load arbitrary rows.
    if (sessionIds.length > 100) {
      return res.status(400).json({ error: 'Cannot merge more than 100 sessions at once' });
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
            linesAdded: pc.linesAdded || 0,
            linesRemoved: pc.linesRemoved || 0,
            aiPercentage: pc.aiPercentage ?? 100,
            checkpointType: pc.checkpointType || null,
            commitSha: pc.commitSha || null,
            treeSha: pc.treeSha || null,
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
