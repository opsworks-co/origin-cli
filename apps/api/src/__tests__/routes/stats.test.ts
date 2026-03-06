import { describe, it, expect, beforeEach } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import statsRouter from '../../routes/stats.js';

const app = createTestApp(statsRouter, '/api/stats');

describe('Stats Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  // Helper to set up all the default mocks the stats endpoint needs.
  // Call order in stats.ts:
  //   1. repo.findMany
  //   2. agent.count
  //   3. commit.count
  //   4. codingSession.count x3 (totalSessions, sessionsThisWeek, unreviewed)
  //   5. codingSession.aggregate x3 (all-time, month, sessionAvgs)
  //   6. codingSession.groupBy x4 (modelGroups, topAgentGroups, contributorAggs, costByUserAggs)
  //   7. codingSession.findMany x1 (recentSessions)
  //   8. commit.findMany x2 (totalCommitsByDay, commitRepos)
  //   9. agent.findMany
  //  10. commit.groupBy x1 (authorGroups)
  //  11. auditLog.count
  //  12. user.findMany x2 (contributorDetails, orgUsers)
  //  13. sessionReview.groupBy x1
  //  14. auditLog.findMany x1 (violationEntries)
  function setupDefaultStatsMocks() {
    // repos
    mockPrisma.repo.findMany.mockResolvedValue([
      { id: 'r1', name: 'repo-1' },
      { id: 'r2', name: 'repo-2' },
    ]);

    // counts
    mockPrisma.agent.count.mockResolvedValue(3);
    // commit.count called twice: totalCommits, then aiCommitCount
    mockPrisma.commit.count
      .mockResolvedValueOnce(100)   // totalCommits
      .mockResolvedValueOnce(50);   // aiCommitCount (session + heuristic)

    // codingSession.count is called 3 times (total, this week, unreviewed)
    mockPrisma.codingSession.count
      .mockResolvedValueOnce(50)   // totalSessions
      .mockResolvedValueOnce(12)   // sessionsThisWeek
      .mockResolvedValueOnce(8);   // unreviewed

    // codingSession.aggregate called 3 times (all time, this month, session averages)
    mockPrisma.codingSession.aggregate
      .mockResolvedValueOnce({
        _sum: { tokensUsed: 500000, costUsd: 125.50, linesAdded: 3000, linesRemoved: 800 },
      })
      .mockResolvedValueOnce({
        _sum: { costUsd: 45.00, linesAdded: 1200 },
      })
      .mockResolvedValueOnce({
        _avg: { costUsd: 2.51, durationMs: 180000, tokensUsed: 10000 },
      });

    // codingSession.groupBy called 4 times
    mockPrisma.codingSession.groupBy
      .mockResolvedValueOnce([
        // modelGroups
        { model: 'claude-4', _count: 30, _sum: { costUsd: 75.00 } },
        { model: 'gpt-4', _count: 20, _sum: { costUsd: 50.50 } },
      ])
      .mockResolvedValueOnce([
        // topAgentGroups
        { agentId: 'a1', _count: 15 },
      ])
      .mockResolvedValueOnce([
        // contributorAggs
        { userId: 'user-1', _count: 20, _sum: { costUsd: 60.00, linesAdded: 1500 } },
        { userId: 'user-2', _count: 10, _sum: { costUsd: 30.00, linesAdded: 800 } },
      ])
      .mockResolvedValueOnce([
        // costByUserAggs
        { userId: 'user-1', _sum: { costUsd: 60.00 } },
        { userId: 'user-2', _sum: { costUsd: 30.00 } },
      ]);

    // codingSession.findMany (recentSessions) - with all needed fields
    mockPrisma.codingSession.findMany.mockResolvedValue([]);

    // commit.findMany called twice (totalCommitsByDay, commitRepos)
    mockPrisma.commit.findMany
      .mockResolvedValueOnce([])   // totalCommitsByDay
      .mockResolvedValueOnce([]);  // commitRepos

    // agent details for top agents
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'a1', name: 'Claude Bot', model: 'claude-4' },
    ]);

    // commit.groupBy for top engineers
    mockPrisma.commit.groupBy.mockResolvedValue([
      { author: 'dev@example.com', _count: 25 },
    ]);

    // audit log count for policy violations
    mockPrisma.auditLog.count.mockResolvedValue(2);

    // user.findMany called twice (contributorDetails, orgUsers)
    mockPrisma.user.findMany
      .mockResolvedValueOnce([
        { id: 'user-1', name: 'Alice' },
        { id: 'user-2', name: 'Bob' },
      ])
      .mockResolvedValueOnce([
        { id: 'user-1', name: 'Alice' },
        { id: 'user-2', name: 'Bob' },
      ]);

    // sessionReview.groupBy for quality metrics
    mockPrisma.sessionReview.groupBy.mockResolvedValue([
      { status: 'APPROVED', _count: 15 },
      { status: 'REJECTED', _count: 3 },
      { status: 'FLAGGED', _count: 2 },
    ]);

    // auditLog.findMany for violation entries
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { metadata: JSON.stringify({ policyType: 'FILE_RESTRICTION' }) },
      { metadata: JSON.stringify({ policyType: 'MODEL_ALLOWLIST' }) },
    ]);

    // secretFinding.groupBy for secret detections by type
    mockPrisma.secretFinding.groupBy.mockResolvedValue([]);
  }

  describe('GET /api/stats', () => {
    it('returns stats object with all expected fields', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);

      // Original fields
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

      // New enriched fields
      expect(res.body).toHaveProperty('costByDay');
      expect(res.body).toHaveProperty('tokensByDay');
      expect(res.body).toHaveProperty('durationBuckets');
      expect(res.body).toHaveProperty('topContributors');
      expect(res.body).toHaveProperty('qualityMetrics');
      expect(res.body).toHaveProperty('violationsByType');
      expect(res.body).toHaveProperty('avgSessionCost');
      expect(res.body).toHaveProperty('avgSessionDuration');
      expect(res.body).toHaveProperty('avgSessionTokens');
      expect(res.body).toHaveProperty('costByUser');
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

    it('returns sessionsByDay as array of ~30 days', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      // Default range is 30 days ago → today inclusive = 31 entries
      expect(res.body.sessionsByDay.length).toBeGreaterThanOrEqual(30);
      expect(res.body.sessionsByDay.length).toBeLessThanOrEqual(31);
      expect(res.body.sessionsByDay[0]).toHaveProperty('date');
      expect(res.body.sessionsByDay[0]).toHaveProperty('count');
    });

    it('handles zero commits gracefully for aiPercentage', async () => {
      setupDefaultStatsMocks();
      // Override commit count to 0 (both totalCommits and aiCommitCount)
      mockPrisma.commit.count.mockReset();
      mockPrisma.commit.count
        .mockResolvedValueOnce(0)   // totalCommits = 0
        .mockResolvedValueOnce(0);  // aiCommitCount = 0

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.aiPercentage).toBe(0);
    });

    it('returns costByDay and tokensByDay as ~30-day arrays', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      // Default range is 30 days ago → today inclusive = 31 entries
      expect(res.body.costByDay.length).toBeGreaterThanOrEqual(30);
      expect(res.body.costByDay.length).toBeLessThanOrEqual(31);
      expect(res.body.costByDay[0]).toHaveProperty('date');
      expect(res.body.costByDay[0]).toHaveProperty('cost');
      expect(res.body.tokensByDay.length).toBeGreaterThanOrEqual(30);
      expect(res.body.tokensByDay.length).toBeLessThanOrEqual(31);
      expect(res.body.tokensByDay[0]).toHaveProperty('date');
      expect(res.body.tokensByDay[0]).toHaveProperty('tokens');
    });

    it('returns durationBuckets with correct structure', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.durationBuckets).toHaveLength(4);
      const bucketNames = res.body.durationBuckets.map((b: any) => b.bucket);
      expect(bucketNames).toEqual(['<1m', '1-5m', '5-15m', '15m+']);
      for (const b of res.body.durationBuckets) {
        expect(b).toHaveProperty('count');
        expect(typeof b.count).toBe('number');
      }
    });

    it('returns topContributors with user details', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.topContributors).toHaveLength(2);
      expect(res.body.topContributors[0]).toEqual({
        id: 'user-1',
        name: 'Alice',
        sessions: 20,
        cost: 60,
        lines: 1500,
      });
      expect(res.body.topContributors[1]).toEqual({
        id: 'user-2',
        name: 'Bob',
        sessions: 10,
        cost: 30,
        lines: 800,
      });
    });

    it('returns qualityMetrics from review status counts', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.qualityMetrics).toEqual({
        approved: 15,
        rejected: 3,
        flagged: 2,
        pending: 8, // matches unreviewed count
      });
    });

    it('returns violationsByType parsed from audit log metadata', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.violationsByType).toEqual(
        expect.arrayContaining([
          { type: 'FILE_RESTRICTION', count: 1 },
          { type: 'MODEL_ALLOWLIST', count: 1 },
        ])
      );
    });

    it('returns session average metrics', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.avgSessionCost).toBeCloseTo(2.51, 2);
      expect(res.body.avgSessionDuration).toBe(180000);
      expect(res.body.avgSessionTokens).toBe(10000);
    });

    it('returns costByUser with user names', async () => {
      setupDefaultStatsMocks();

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.costByUser).toHaveLength(2);
      expect(res.body.costByUser[0]).toEqual({
        userId: 'user-1',
        name: 'Alice',
        cost: 60,
      });
    });
  });
});
