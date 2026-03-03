import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import policyRouter from '../../routes/policies.js';

const app = createTestApp(policyRouter, '/api/policies');

describe('Policies Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/policies', () => {
    it('returns list of policies with rules', async () => {
      const policies = [
        {
          id: 'p1',
          orgId: 'org-1',
          name: 'Security Policy',
          type: 'SECURITY',
          active: true,
          rules: [{ id: 'r1', condition: 'no-secrets', action: 'BLOCK', agent: null }],
        },
      ];
      mockPrisma.policy.findMany.mockResolvedValue(policies);

      const res = await request(app).get('/api/policies');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Security Policy');
      expect(res.body[0].rules).toHaveLength(1);
    });

    it('returns empty array when no policies exist', async () => {
      mockPrisma.policy.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/policies');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('POST /api/policies', () => {
    it('creates policy with valid data', async () => {
      const newPolicy = { id: 'p1', orgId: 'org-1', name: 'Test Policy', type: 'SECURITY' };
      mockPrisma.policy.create.mockResolvedValue(newPolicy);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/policies')
        .send({ name: 'Test Policy', type: 'SECURITY' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Policy');
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/policies')
        .send({ name: 'Test' }); // missing type
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/policies')
        .send({ type: 'SECURITY' }); // missing name
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/policies/:id', () => {
    it('updates policy', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'Old' });
      mockPrisma.policy.update.mockResolvedValue({ id: 'p1', name: 'Updated Policy' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .put('/api/policies/p1')
        .send({ name: 'Updated Policy' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Policy');
    });

    it('returns 404 when policy not found', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put('/api/policies/nonexistent')
        .send({ name: 'X' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Policy not found');
    });
  });

  describe('DELETE /api/policies/:id', () => {
    it('deletes policy and its rules', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'To Delete' });
      mockPrisma.policyRule.deleteMany.mockResolvedValue({ count: 2 });
      mockPrisma.policy.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app).delete('/api/policies/p1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when policy not found for deletion', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/policies/nonexistent');
      expect(res.status).toBe(404);
    });

    it('deletes rules before deleting policy', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'Policy' });
      mockPrisma.policyRule.deleteMany.mockResolvedValue({ count: 3 });
      mockPrisma.policy.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app).delete('/api/policies/p1');

      expect(mockPrisma.policyRule.deleteMany).toHaveBeenCalledWith({ where: { policyId: 'p1' } });
      expect(mockPrisma.policy.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });
  });

  describe('POST /api/policies/:id/rules', () => {
    it('creates a rule for a policy', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1' });
      mockPrisma.policyRule.create.mockResolvedValue({
        id: 'r1',
        policyId: 'p1',
        condition: 'no-secrets',
        action: 'BLOCK',
        severity: 'HIGH',
      });

      const res = await request(app)
        .post('/api/policies/p1/rules')
        .send({ condition: 'no-secrets', action: 'BLOCK', severity: 'HIGH' });
      expect(res.status).toBe(201);
      expect(res.body.condition).toBe('no-secrets');
    });

    it('returns 400 when missing condition or action', async () => {
      const res = await request(app)
        .post('/api/policies/p1/rules')
        .send({ condition: 'no-secrets' }); // missing action
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 404 when policy not found for rule creation', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/policies/nonexistent/rules')
        .send({ condition: 'test', action: 'WARN' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/policies/:id/rules/:ruleId', () => {
    it('deletes a single rule', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1' });
      mockPrisma.policyRule.findFirst.mockResolvedValue({ id: 'r1', policyId: 'p1' });
      mockPrisma.policyRule.delete.mockResolvedValue({});

      const res = await request(app).delete('/api/policies/p1/rules/r1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when policy not found', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/policies/nonexistent/rules/r1');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Policy not found');
    });

    it('returns 404 when rule not found', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1' });
      mockPrisma.policyRule.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/policies/p1/rules/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Rule not found');
    });
  });

  describe('GET /api/policies/:id/versions', () => {
    it('returns list of policy versions', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue({ id: 'p1', orgId: 'org-1' });
      mockPrisma.policyVersion.findMany.mockResolvedValue([
        { id: 'v2', policyId: 'p1', version: 2, snapshot: '{"name":"Updated"}', changeType: 'UPDATED', createdAt: new Date() },
        { id: 'v1', policyId: 'p1', version: 1, snapshot: '{"name":"Initial"}', changeType: 'CREATED', createdAt: new Date() },
      ]);

      const res = await request(app).get('/api/policies/p1/versions');
      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.versions[0].snapshot).toEqual({ name: 'Updated' });
    });

    it('returns 404 when policy not found', async () => {
      mockPrisma.policy.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/policies/nonexistent/versions');
      expect(res.status).toBe(404);
    });
  });
});
