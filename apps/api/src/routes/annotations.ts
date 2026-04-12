import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router({ mergeParams: true });

// ── GET /api/sessions/:sessionId/annotations ─────────────────────────────────
// Public if the session is shared; otherwise requires auth.
// We allow any authenticated user in the same org to read annotations (for the
// owned view). For the public shared view the caller is the share.ts route
// proxy — no auth is present, but we allow it unconditionally because the
// session data was already verified as shared before this route is called.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);

    // Verify session exists
    const session = await prisma.codingSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Auth check: must be authenticated OR session must be publicly shared
    if (!req.user) {
      const shared = await prisma.sharedSession.findFirst({
        where: { sessionId: { equals: sessionId } },
      });
      if (!shared || (shared.expiresAt && new Date(shared.expiresAt) < new Date())) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const annotations = await prisma.sessionAnnotation.findMany({
      where: { sessionId: { equals: sessionId } },
      orderBy: [{ turnIndex: 'asc' }, { createdAt: 'asc' }],
    });

    // Fetch author names separately to avoid Prisma include type issues
    const userIds = [...new Set(annotations.map((a) => a.authorId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u.name]));

    res.json(
      annotations.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        turnIndex: a.turnIndex,
        text: a.text,
        authorId: a.authorId,
        authorName: userMap.get(a.authorId) ?? null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    );
  } catch (err) {
    console.error('List annotations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/sessions/:sessionId/annotations ────────────────────────────────
// Auth required. Must be session owner or org admin/owner.
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const { turnIndex, text } = req.body;

    if (typeof turnIndex !== 'number' || turnIndex < 0) {
      return res.status(400).json({ error: 'turnIndex must be a non-negative number' });
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'text must be 2000 characters or fewer' });
    }

    const session = await prisma.codingSession.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const role = (req.user!.role || '').toUpperCase();
    const isAdmin = role === 'ADMIN' || role === 'OWNER';
    const isOwner = session.userId === req.user!.id;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Only the session owner or an admin can annotate this session' });
    }

    const annotation = await prisma.sessionAnnotation.create({
      data: {
        sessionId,
        turnIndex,
        text: text.trim(),
        authorId: req.user!.id,
      },
    });

    const author = await prisma.user.findUnique({
      where: { id: annotation.authorId },
      select: { id: true, name: true },
    });

    res.status(201).json({
      id: annotation.id,
      sessionId: annotation.sessionId,
      turnIndex: annotation.turnIndex,
      text: annotation.text,
      authorId: annotation.authorId,
      authorName: author?.name ?? null,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
    });
  } catch (err) {
    console.error('Create annotation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/sessions/:sessionId/annotations/:id ─────────────────────────
// Auth required. Must be the annotation author.
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = String(req.params.sessionId);
    const id = String(req.params.id);

    const annotation = await prisma.sessionAnnotation.findUnique({
      where: { id },
      select: { id: true, sessionId: true, authorId: true },
    });

    if (!annotation || annotation.sessionId !== sessionId) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    if (annotation.authorId !== req.user!.id) {
      return res.status(403).json({ error: 'Only the annotation author can delete it' });
    }

    await prisma.sessionAnnotation.delete({ where: { id } });

    res.status(204).end();
  } catch (err) {
    console.error('Delete annotation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
