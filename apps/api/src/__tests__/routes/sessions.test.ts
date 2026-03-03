import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import sessionRouter from '../../routes/sessions.js';

const app = createTestApp(sessionRouter, '/api/sessions');

function createMockSession(overrides: any = {}) {
  return {
    id: 's1',
    commitId: 'c1',
    agentId: 'a1',
    model: 'claude-4',
    prompt: 'Fix the bug',
    transcript: '[]',
    filesChanged: ['src/index.ts'],
    tokensUsed: 1000,
    toolCalls: 5,
    durationMs: 30000,
    linesAdded: 20,
    linesRemoved: 5,
    costUsd: 0.05,
    createdAt: new Date('2025-01-15'),
    agent: { name: 'Claude Agent' },
    commit: {
      repoId: 'r1',
      sha: 'abc123',
      message: 'fix: resolve bug',
      author: 'dev@example.com',
      committedAt: new Date('2025-01-15'),
      repo: { name: 'my-repo', orgId: 'org-1' },
    },
    review: null,
    ...overrides,
  };
}

describe('Sessions Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/sessions', () => {
    it('returns paginated list of sessions', async () => {
      const sessions = [createMockSession()];
      mockPrisma.codingSession.findMany.mockResolvedValue(sessions);
      mockPrisma.codingSession.count.mockResolvedValue(1);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.sessions[0].commitSha).toBe('abc123');
      expect(res.body.sessions[0].agentName).toBe('Claude Agent');
    });

    it('returns empty list when no sessions exist', async () => {
      mockPrisma.codingSession.findMany.mockResolvedValue([]);
      mockPrisma.codingSession.count.mockResolvedValue(0);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    it('maps review data when present', async () => {
      const sessionWithReview = createMockSession({
        review: {
          id: 'rev1',
          status: 'APPROVED',
          note: 'Looks good',
          user: { name: 'Reviewer' },
          createdAt: new Date('2025-01-16'),
        },
      });
      mockPrisma.codingSession.findMany.mockResolvedValue([sessionWithReview]);
      mockPrisma.codingSession.count.mockResolvedValue(1);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body.sessions[0].review).not.toBeNull();
      expect(res.body.sessions[0].review.status).toBe('APPROVED');
      expect(res.body.sessions[0].review.reviewerName).toBe('Reviewer');
    });

    it('respects limit and offset query params', async () => {
      mockPrisma.codingSession.findMany.mockResolvedValue([]);
      mockPrisma.codingSession.count.mockResolvedValue(0);

      await request(app).get('/api/sessions?limit=10&offset=20');
      expect(mockPrisma.codingSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        }),
      );
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns a single session with mapped fields', async () => {
      const session = createMockSession();
      mockPrisma.codingSession.findFirst.mockResolvedValue(session);

      const res = await request(app).get('/api/sessions/s1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('s1');
      expect(res.body.repoName).toBe('my-repo');
      expect(res.body.commitMessage).toBe('fix: resolve bug');
    });

    it('returns 404 when session not found', async () => {
      mockPrisma.codingSession.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/sessions/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });
  });

  describe('POST /api/sessions/:id/review', () => {
    it('creates a review for a session', async () => {
      const session = createMockSession();
      mockPrisma.codingSession.findFirst.mockResolvedValue(session);
      mockPrisma.sessionReview.upsert.mockResolvedValue({
        id: 'rev1',
        sessionId: 's1',
        userId: 'user-1',
        status: 'APPROVED',
        note: 'Looks good',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/sessions/s1/review')
        .send({ status: 'APPROVED', note: 'Looks good' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
    });

    it('returns 400 when status is missing', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/review')
        .send({ note: 'Missing status' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required field');
    });

    it('returns 404 when session not found for review', async () => {
      mockPrisma.codingSession.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/sessions/nonexistent/review')
        .send({ status: 'FLAGGED' });
      expect(res.status).toBe(404);
    });

    it('creates audit log on review', async () => {
      mockPrisma.codingSession.findFirst.mockResolvedValue(createMockSession());
      mockPrisma.sessionReview.upsert.mockResolvedValue({ id: 'rev1', status: 'FLAGGED' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/sessions/s1/review')
        .send({ status: 'FLAGGED' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SESSION_REVIEWED',
            resource: 's1',
          }),
        }),
      );
    });
  });
});
