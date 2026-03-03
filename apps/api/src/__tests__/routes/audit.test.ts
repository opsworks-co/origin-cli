import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import auditRouter from '../../routes/audit.js';

const app = createTestApp(auditRouter, '/api/audit');

describe('Audit Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/audit', () => {
    it('returns paginated list of audit log entries', async () => {
      const logs = [
        {
          id: 'log1',
          userId: 'user-1',
          action: 'AGENT_CREATED',
          resource: 'a1',
          metadata: '{"name":"Claude Agent"}',
          createdAt: new Date('2025-01-15'),
          user: { name: 'Test User' },
        },
      ];
      mockPrisma.auditLog.findMany.mockResolvedValue(logs);
      mockPrisma.auditLog.count.mockResolvedValue(1);

      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].action).toBe('AGENT_CREATED');
      expect(res.body.entries[0].userName).toBe('Test User');
    });

    it('returns empty list when no logs exist', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    it('filters by action query parameter', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      await request(app).get('/api/audit?action=REPO_CREATED');

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orgId: 'org-1',
            action: 'REPO_CREATED',
          }),
        }),
      );
    });

    it('filters by userId query parameter', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      await request(app).get('/api/audit?userId=user-2');

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orgId: 'org-1',
            userId: 'user-2',
          }),
        }),
      );
    });

    it('respects limit and offset query params', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      await request(app).get('/api/audit?limit=25&offset=50');

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 50,
        }),
      );
    });

    it('maps userName to null when user is missing', async () => {
      const logs = [
        {
          id: 'log1',
          userId: 'user-deleted',
          action: 'POLICY_DELETED',
          resource: 'p1',
          metadata: '{}',
          createdAt: new Date('2025-01-15'),
          user: null,
        },
      ];
      mockPrisma.auditLog.findMany.mockResolvedValue(logs);
      mockPrisma.auditLog.count.mockResolvedValue(1);

      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body.entries[0].userName).toBeNull();
    });
  });
});
