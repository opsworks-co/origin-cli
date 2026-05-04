import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mockPrisma, createTestApp, resetAllMocks, setTestUser } from '../helpers.js';

import insightsRouter from '../../routes/insights.js';

const app = createTestApp(insightsRouter, '/api/insights');

describe('Insights Routes', () => {
  beforeEach(() => {
    resetAllMocks();
    setTestUser({ id: 'admin-1', orgId: 'org-1', role: 'ADMIN' });
  });

  describe('admin gate', () => {
    it('returns 403 with ADMIN_REQUIRED-shaped error for non-admin', async () => {
      setTestUser({ id: 'member-1', orgId: 'org-1', role: 'MEMBER' });
      const res = await request(app).get('/api/insights/spend-heatmap');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/insights/config', () => {
    it('returns the tunable thresholds', async () => {
      const res = await request(app).get('/api/insights/config');
      expect(res.status).toBe(200);
      expect(res.body.reworkRateAmber).toBe(0.05);
      expect(res.body.reworkRateRed).toBe(0.15);
      expect(res.body.modelFit).toBeDefined();
    });
  });

  describe('GET /api/insights/spend-quality', () => {
    it('returns empty rows when no sessions', async () => {
      mockPrisma.codingSession.groupBy.mockResolvedValue([]);
      const res = await request(app).get('/api/insights/spend-quality');
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      expect(res.body.range.from).toBeDefined();
      expect(res.body.range.to).toBeDefined();
    });

    it('returns per-dev rows with computed metrics', async () => {
      mockPrisma.codingSession.groupBy.mockResolvedValueOnce([
        { userId: 'u1', _sum: { costUsd: 50 }, _count: { _all: 10 } },
        { userId: 'u2', _sum: { costUsd: 25 }, _count: { _all: 5 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'Alice', email: 'a@x.com' },
        { id: 'u2', name: 'Bob',   email: 'b@x.com' },
      ]);
      mockPrisma.promptChange.findMany.mockResolvedValue([
        {
          sessionId: 's1', createdAt: new Date('2026-04-15'),
          filesChanged: '["a.ts"]', linesAdded: 100, linesRemoved: 0, aiPercentage: 80,
          session: { userId: 'u1' },
        },
      ]);
      mockPrisma.pullRequest.findMany.mockResolvedValue([]);
      mockPrisma.codingSession.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/insights/spend-quality?range=30d');
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(2);
      expect(res.body.rows[0]).toMatchObject({
        userId: 'u1', name: 'Alice', spendUsd: 50, sessionCount: 10,
      });
      expect(res.body.rows[0].aiAuthorship).toBeCloseTo(0.8, 5);
      expect(res.body.rows[0].costPerMergedPr).toBeNull();
    });

    it('returns 400 on invalid range', async () => {
      const res = await request(app).get('/api/insights/spend-quality?range=14d');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_RANGE');
    });
  });

  describe('GET /api/insights/top-sessions', () => {
    it('honors limit param up to max', async () => {
      mockPrisma.codingSession.findMany.mockResolvedValue([]);
      mockPrisma.codingSession.groupBy.mockResolvedValue([]);
      const res = await request(app).get('/api/insights/top-sessions?limit=10');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });

    it('returns flagged sessions', async () => {
      const fixedDate = new Date('2026-04-15T10:00:00Z');
      const fixedEnd = new Date('2026-04-15T10:30:00Z');
      mockPrisma.codingSession.findMany.mockResolvedValue([
        {
          id: 's1', costUsd: 50, commitId: null, branch: 'feat/x',
          startedAt: fixedDate, endedAt: fixedEnd, createdAt: fixedDate,
          userId: 'u1', user: { name: 'Alice' }, _count: { promptChanges: 30 },
        },
      ]);
      mockPrisma.codingSession.groupBy.mockResolvedValue([
        { userId: 'u1', _avg: { costUsd: 5 } }, // session is 10× avg
      ]);

      const res = await request(app).get('/api/insights/top-sessions?limit=5');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].flags).toEqual(expect.arrayContaining(['zero-commit', 'cost-outlier']));
    });
  });

  describe('GET /api/insights/model-fit-warnings', () => {
    it('flags Opus-on-cheap-task sessions', async () => {
      mockPrisma.codingSession.findMany.mockResolvedValue([
        {
          id: 's1', model: 'claude-opus-4-7', costUsd: 0.3, commitId: 'c1',
          user: { name: 'Alice' }, _count: { promptChanges: 1 },
          promptChanges: [{ filesChanged: '["a.ts"]' }],
        },
      ]);
      const res = await request(app).get('/api/insights/model-fit-warnings');
      expect(res.status).toBe(200);
      expect(res.body.warnings).toHaveLength(1);
      expect(res.body.warnings[0].reason).toBe('oversized-for-cheap-task');
    });
  });

  describe('GET /api/insights/spend-heatmap', () => {
    it('returns sparse cells', async () => {
      const d = new Date(2026, 3, 6, 14, 0); // Monday 14:00
      mockPrisma.codingSession.findMany.mockResolvedValue([
        { createdAt: d, costUsd: 5 },
      ]);
      const res = await request(app).get('/api/insights/spend-heatmap');
      expect(res.status).toBe(200);
      expect(res.body.cells).toHaveLength(1);
      expect(res.body.cells[0]).toMatchObject({ day: 1, hour: 14, costUsd: 5, sessionCount: 1 });
    });
  });

  describe('GET /api/insights/wasted-prompts', () => {
    it('returns degraded:true with explanation', async () => {
      const res = await request(app).get('/api/insights/wasted-prompts');
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      expect(res.body.degradedReason).toMatch(/snapshot-restore/i);
      expect(res.body.perDev).toEqual([]);
      expect(res.body.topPrompts).toEqual([]);
    });
  });

  describe('GET /api/insights/token-breakdown', () => {
    it('returns classified rows for users, agents, and models', async () => {
      // Three groupBy calls in order: byUser, byAgent, byModel
      mockPrisma.codingSession.groupBy
        .mockResolvedValueOnce([
          { userId: 'u1', _sum: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 750, cacheCreationTokens: 100 } },
        ])
        .mockResolvedValueOnce([
          { agentId: 'a1', _sum: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 600, cacheCreationTokens: 80 } },
        ])
        .mockResolvedValueOnce([
          { model: 'claude-opus-4-7', _sum: { inputTokens: 600, outputTokens: 300, cacheReadTokens: 450, cacheCreationTokens: 60 } },
        ]);
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Alice' }]);
      mockPrisma.agent.findMany.mockResolvedValue([{ id: 'a1', name: 'Claude Code', slug: 'claude' }]);

      const res = await request(app).get('/api/insights/token-breakdown');
      expect(res.status).toBe(200);

      // legacy per-engineer shape preserved
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0]).toMatchObject({ userId: 'u1', name: 'Alice', generatedTokens: 1500 });

      // per-agent rollup
      expect(res.body.byAgent).toHaveLength(1);
      expect(res.body.byAgent[0]).toMatchObject({ agentId: 'a1', name: 'Claude Code', slug: 'claude', generatedTokens: 1200 });
      expect(res.body.byAgent[0].userId).toBeUndefined();

      // per-model rollup
      expect(res.body.byModel).toHaveLength(1);
      expect(res.body.byModel[0]).toMatchObject({ model: 'claude-opus-4-7', name: 'claude-opus-4-7', generatedTokens: 900 });
      expect(res.body.byModel[0].userId).toBeUndefined();
    });

    it('returns empty arrays for all three breakdowns when no data', async () => {
      mockPrisma.codingSession.groupBy.mockResolvedValue([]);
      const res = await request(app).get('/api/insights/token-breakdown');
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
      expect(res.body.byAgent).toEqual([]);
      expect(res.body.byModel).toEqual([]);
    });
  });
});
