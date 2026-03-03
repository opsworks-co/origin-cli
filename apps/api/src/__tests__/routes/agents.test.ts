import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Import route AFTER mocks
import agentRouter from '../../routes/agents.js';

const app = createTestApp(agentRouter, '/api/agents');

describe('Agents Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/agents', () => {
    it('returns list of agents', async () => {
      const agents = [
        { id: 'a1', orgId: 'org-1', name: 'Claude Agent', slug: 'claude', model: 'claude-4', status: 'ACTIVE', _count: { sessions: 5 } },
      ];
      mockPrisma.agent.findMany.mockResolvedValue(agents);

      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Claude Agent');
    });

    it('returns empty array when no agents exist', async () => {
      mockPrisma.agent.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('POST /api/agents', () => {
    it('creates agent with valid data', async () => {
      const newAgent = { id: 'a1', orgId: 'org-1', name: 'Test', slug: 'test', model: 'claude-4', status: 'ACTIVE' };
      mockPrisma.agent.create.mockResolvedValue(newAgent);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Test', slug: 'test', model: 'claude-4' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test');
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Test' }); // missing slug and model
      expect(res.status).toBe(400);
    });

    it('returns 400 when slug is missing', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Test', model: 'claude-4' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('creates audit log on agent creation', async () => {
      const newAgent = { id: 'a1', orgId: 'org-1', name: 'Audited', slug: 'audited', model: 'gpt-4' };
      mockPrisma.agent.create.mockResolvedValue(newAgent);
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/agents')
        .send({ name: 'Audited', slug: 'audited', model: 'gpt-4' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'AGENT_CREATED',
          }),
        }),
      );
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns agent with sessions', async () => {
      const agent = { id: 'a1', orgId: 'org-1', name: 'Agent', slug: 'agent', sessions: [] };
      mockPrisma.agent.findFirst.mockResolvedValue(agent);

      const res = await request(app).get('/api/agents/a1');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Agent');
    });

    it('returns 404 when not found', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/agents/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/agents/:id', () => {
    it('updates agent', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: 'a1', orgId: 'org-1' });
      mockPrisma.agent.update.mockResolvedValue({ id: 'a1', name: 'Updated' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .put('/api/agents/a1')
        .send({ name: 'Updated' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('returns 404 when agent not found', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const res = await request(app).put('/api/agents/nonexistent').send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes agent and unlinks sessions', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: 'a1', orgId: 'org-1', name: 'Agent', _count: { sessions: 2 } });
      mockPrisma.codingSession.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.policyRule.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.agent.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app).delete('/api/agents/a1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when agent not found for deletion', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/agents/nonexistent');
      expect(res.status).toBe(404);
    });

    it('unlinks sessions and policy rules before deleting', async () => {
      mockPrisma.agent.findFirst.mockResolvedValue({ id: 'a1', orgId: 'org-1', name: 'Agent', _count: { sessions: 3 } });
      mockPrisma.codingSession.updateMany.mockResolvedValue({ count: 3 });
      mockPrisma.policyRule.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.agent.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app).delete('/api/agents/a1');

      expect(mockPrisma.codingSession.updateMany).toHaveBeenCalledWith({
        where: { agentId: 'a1' },
        data: { agentId: null },
      });
      expect(mockPrisma.policyRule.updateMany).toHaveBeenCalledWith({
        where: { agentId: 'a1' },
        data: { agentId: null },
      });
      expect(mockPrisma.agent.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    });
  });
});
