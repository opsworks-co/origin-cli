import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { safeParseArray, safeParseObject } from '../utils/safe-json.js';

const router = Router();

// Wraps the shared util so callers in this file keep the old
// `safeParse(val, fallback)` ergonomics but we get real logging instead
// of a bare `catch {}` that silently swallows schema drift.
function safeParse(val: string | null | undefined, fallback: any = []) {
  if (val == null) return fallback;
  if (Array.isArray(fallback)) {
    const arr = safeParseArray(val, 'share.safeParse');
    return arr.length === 0 && fallback.length > 0 ? fallback : arr;
  }
  return safeParseObject(val, 'share.safeParse', fallback);
}

// GET /:slug — public endpoint (NO auth) — returns full session data for the share page
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;

    const shared = await prisma.sharedSession.findUnique({
      where: { slug },
    });

    if (!shared) {
      return res.status(404).json({ error: 'Shared session not found' });
    }

    // Check expiry
    if (shared.expiresAt && new Date(shared.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'This shared session link has expired' });
    }

    // Fetch the full session with all relations
    const session = await prisma.codingSession.findUnique({
      where: { id: shared.sessionId },
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

    // Map to the same shape as GET /api/sessions/:id
    res.json({
      id: session.id,
      commitId: session.commitId,
      agentId: session.agentId,
      agentName: session.agent?.name || null,
      userId: session.userId || null,
      userName: session.user?.name || null,
      repoName: session.commit?.repo?.name || null,
      commitSha: session.commit?.sha || null,
      commitMessage: session.commit?.message || null,
      commitAuthor: session.commit?.author || null,
      committedAt: session.commit?.committedAt || null,
      model: session.model,
      prompt: session.prompt,
      transcript: session.transcript,
      filesChanged: session.filesChanged,
      tokensUsed: session.tokensUsed,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      toolCalls: session.toolCalls,
      durationMs: session.durationMs,
      linesAdded: session.linesAdded,
      linesRemoved: session.linesRemoved,
      costUsd: session.costUsd,
      branch: session.branch || null,
      status: session.status || 'COMPLETED',
      startedAt: session.startedAt || null,
      endedAt: session.endedAt || null,
      createdAt: session.createdAt,
      review: session.review
        ? {
            id: session.review.id,
            status: session.review.status,
            note: session.review.note,
            score: session.review.score ?? null,
            riskLevel: session.review.riskLevel ?? null,
            concerns: safeParse(session.review.concerns, []),
            suggestions: safeParse(session.review.suggestions, []),
            categories: safeParse(session.review.categories, null),
            isAutoReview: session.review.isAutoReview ?? false,
            reviewerName: session.review.user?.name || null,
            createdAt: session.review.createdAt,
          }
        : null,
      sessionDiff: session.sessionDiff
        ? {
            headBefore: session.sessionDiff.headBefore,
            headAfter: session.sessionDiff.headAfter,
            commitShas: safeParse(session.sessionDiff.commitShas, []),
            diff: session.sessionDiff.diff,
            diffTruncated: session.sessionDiff.diffTruncated,
            linesAdded: session.sessionDiff.linesAdded,
            linesRemoved: session.sessionDiff.linesRemoved,
          }
        : null,
      promptChanges: session.promptChanges
        ? session.promptChanges.map((pc: any) => ({
            promptIndex: pc.promptIndex,
            promptText: pc.promptText,
            filesChanged: safeParse(pc.filesChanged, []),
            diff: pc.diff || '',
            uncommittedDiff: pc.uncommittedDiff || '',
            createdAt: pc.createdAt,
          }))
        : [],
      // Share metadata
      shared: {
        slug: shared.slug,
        expiresAt: shared.expiresAt,
        createdAt: shared.createdAt,
      },
    });
  } catch (err) {
    console.error('Get shared session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
