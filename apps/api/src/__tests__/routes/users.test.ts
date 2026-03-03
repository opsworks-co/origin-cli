import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';

// Import the router under test
import usersRouter from '../../routes/users.js';

const app = createTestApp(usersRouter, '/api/users');

describe('Users Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/users', () => {
    it('returns list of org members with stats', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          name: 'Alice',
          email: 'alice@example.com',
          role: 'OWNER',
          createdAt: new Date('2024-01-01'),
          _count: { reviews: 5, sessions: 10 },
        },
        {
          id: 'user-2',
          name: 'Bob',
          email: 'bob@example.com',
          role: 'MEMBER',
          createdAt: new Date('2024-02-01'),
          _count: { reviews: 2, sessions: 3 },
        },
      ]);

      mockPrisma.codingSession.groupBy
        .mockResolvedValueOnce([
          { userId: 'user-1', _sum: { costUsd: 25.5, linesAdded: 1000 } },
          { userId: 'user-2', _sum: { costUsd: 10.0, linesAdded: 500 } },
        ])
        .mockResolvedValueOnce([
          { userId: 'user-1', _max: { createdAt: new Date('2024-06-15') } },
          { userId: 'user-2', _max: { createdAt: new Date('2024-06-10') } },
        ]);

      const res = await request(app).get('/api/users');

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(2);
      expect(res.body.users[0]).toMatchObject({
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'OWNER',
        sessions: 10,
        reviews: 5,
        totalCost: 25.5,
        linesAdded: 1000,
      });
      expect(res.body.users[1]).toMatchObject({
        id: 'user-2',
        name: 'Bob',
        sessions: 3,
        reviews: 2,
      });
    });

    it('returns empty array when no users exist', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.codingSession.groupBy.mockResolvedValue([]);

      const res = await request(app).get('/api/users');

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(0);
    });
  });

  describe('GET /api/users/:id', () => {
    it('returns user detail with sessions, reviews, and audit', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'OWNER',
        createdAt: new Date('2024-01-01'),
      });

      mockPrisma.codingSession.count.mockResolvedValue(10);
      mockPrisma.sessionReview.count.mockResolvedValue(5);
      mockPrisma.codingSession.aggregate.mockResolvedValue({
        _sum: { costUsd: 25.5, linesAdded: 1000, linesRemoved: 200, tokensUsed: 50000 },
      });

      mockPrisma.codingSession.findMany.mockResolvedValue([
        {
          id: 'sess-1',
          model: 'claude-4',
          costUsd: 5.0,
          tokensUsed: 10000,
          linesAdded: 200,
          createdAt: new Date(),
          commit: { message: 'Fix bug', repo: { name: 'my-app' } },
          agent: null,
          review: null,
        },
      ]);

      mockPrisma.sessionReview.findMany.mockResolvedValue([
        {
          id: 'rev-1',
          sessionId: 'sess-2',
          status: 'APPROVED',
          note: 'Looks good',
          createdAt: new Date(),
          session: { commit: { message: 'Add feature', repo: { name: 'my-app' } } },
        },
      ]);

      mockPrisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'audit-1',
          action: 'SESSION_REVIEWED',
          resource: 'sess-2',
          createdAt: new Date(),
        },
      ]);

      const res = await request(app).get('/api/users/user-1');

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        id: 'user-1',
        name: 'Alice',
        stats: {
          sessions: 10,
          reviews: 5,
          totalCost: 25.5,
          linesAdded: 1000,
        },
      });
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.reviews).toHaveLength(1);
      expect(res.body.audit).toHaveLength(1);
    });

    it('returns 404 when user not found', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/users/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });
  });
});
