import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';

const router = Router();

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
            concerns: session.review.concerns ? JSON.parse(session.review.concerns) : [],
            suggestions: session.review.suggestions ? JSON.parse(session.review.suggestions) : [],
            categories: session.review.categories ? JSON.parse(session.review.categories) : null,
            isAutoReview: session.review.isAutoReview ?? false,
            reviewerName: session.review.user?.name || null,
            createdAt: session.review.createdAt,
          }
        : null,
      sessionDiff: session.sessionDiff
        ? {
            headBefore: session.sessionDiff.headBefore,
            headAfter: session.sessionDiff.headAfter,
            commitShas: JSON.parse(session.sessionDiff.commitShas || '[]'),
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
            filesChanged: JSON.parse(pc.filesChanged || '[]'),
            diff: pc.diff || '',
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
