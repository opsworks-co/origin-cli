import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import statsRouter from '../../routes/stats.js';

const app = createTestApp(statsRouter, '/api/stats');

describe('Stats Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // Helper to set up all the default mocks the stats endpoint needs
  function setupDefaultStatsMocks() {
    // repos
    mockPrisma.repo.findMany.mockResolvedValue([
      { id: 'r1', name: 'repo-1' },
      { id: 'r2', name: 'repo-2' },
    ]);

    // counts
    mockPrisma.agent.count.mockResolvedValue(3);
    mockPrisma.commit.count.mockResolvedValue(100);

    // codingSession.count is called multiple times (total, this week, unreviewed)
    mockPrisma.codingSession.count
      .mockResolvedValueOnce(50)   // totalSessions
      .mockResolvedValueOnce(12)   // sessionsThisWeek
      .mockResolvedValueOnce(8);   // unreviewed

    // aggregate called twice (all time, this month)
    mockPrisma.codingSession.aggregate
      .mockResolvedValueOnce({
        _sum: { tokensUsed: 500000, costUsd: 125.50, linesAdded: 3000, linesRemoved: 800 },
      })
      .mockResolvedValueOnce({
        _sum: { costUsd: 45.00, linesAdded: 1200 },
      });

    // groupBy for model breakdown
    (mockPrisma.codingSession as any).groupBy = vi.fn()
      .mockResolvedValueOnce([
        { model: 'claude-4', _count: 30, _sum: { costUsd: 75.00 } },
        { model: 'gpt-4', _count: 20, _sum: { costUsd: 50.50 } },
      ])
      .mockResolvedValueOnce([
        { agentId: 'a1', _count: 15 },
      ]);

    // findMany for recent sessions (sessionsByDay)
    mockPrisma.codingSession.findMany.mockResolvedValue([]);

    // findMany for commits (totalCommitsByDay and sessionsByRepo)
    mockPrisma.commit.findMany
      .mockResolvedValueOnce([])   // totalCommitsByDay
      .mockResolvedValueOnce([]);  // commitRepos

    // agent details for top agents
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'a1', name: 'Claude Bot', model: 'claude-4' },
    ]);

    // commit groupBy for top engineers
    (mockPrisma.commit as any).groupBy = vi.fn().mockResolvedValue([
      { author: 'dev@example.com', _count: 25 },
    ]);

    // audit log count for policy violations
    mockPrisma.auditLog.count.mockResolvedValue(2);
  }

  describe('GET /api/stats', () => {
    it('returns stats object with all expected fields', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);

      // Verify key fields are present
      expect(res.body).toHaveProperty('totalSessions');
      expect(res.body).toHaveProperty('activeAgents');
      expect(res.body).toHaveProperty('sessionsThisWeek');
      expect(res.body).toHaveProperty('aiPercentage');
      expect(res.body).toHaveProperty('tokensUsed');
      expect(res.body).toHaveProperty('costUsd');
      expect(res.body).toHaveProperty('estimatedCostThisMonth');
      expect(res.body).toHaveProperty('unreviewed');
      expect(res.body).toHaveProperty('modelBreakdown');
      expect(res.body).toHaveProperty('costByModel');
      expect(res.body).toHaveProperty('sessionsByDay');
      expect(res.body).toHaveProperty('sessionsByRepo');
      expect(res.body).toHaveProperty('aiAuthorshipOverTime');
      expect(res.body).toHaveProperty('topAgents');
      expect(res.body).toHaveProperty('topEngineers');
      expect(res.body).toHaveProperty('policyViolations');
      expect(res.body).toHaveProperty('linesAdded');
      expect(res.body).toHaveProperty('linesRemoved');
    });

    it('returns correct numeric values from aggregates', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.activeAgents).toBe(3);
      expect(res.body.totalSessions).toBe(50);
      expect(res.body.sessionsThisWeek).toBe(12);
      expect(res.body.tokensUsed).toBe(500000);
      expect(res.body.linesAdded).toBe(3000);
      expect(res.body.linesRemoved).toBe(800);
      expect(res.body.policyViolations).toBe(2);
    });

    it('computes aiPercentage correctly', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      // totalSessions=50, totalCommits=100, so 50%
      expect(res.body.aiPercentage).toBe(50);
    });

    it('returns sessionsByDay as array of 30 days', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.sessionsByDay).toHaveLength(30);
      expect(res.body.sessionsByDay[0]).toHaveProperty('date');
      expect(res.body.sessionsByDay[0]).toHaveProperty('count');
    });

    it('handles zero commits gracefully for aiPercentage', async () => {
      setupDefaultStatsMocks();
      // Override commit count to 0
      mockPrisma.commit.count.mockReset();
      mockPrisma.commit.count.mockResolvedValue(0);

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.aiPercentage).toBe(0);
    });
  });
});
