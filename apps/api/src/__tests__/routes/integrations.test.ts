import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks, setTestUser, TEST_USER, TEST_VIEWER } from '../helpers.js';
import request from 'supertest';

// Mock github-integration service before route import
vi.mock('../../services/github-integration.js', () => ({
  testGitHubConnection: vi.fn().mockResolvedValue({ success: true, login: 'octocat' }),
}));

// Import route AFTER mocks
import integrationRouter from '../../routes/integrations.js';

const app = createTestApp(integrationRouter, '/api/integrations');

describe('Integrations Routes', () => {
  beforeEach(() => {
    resetAllMocks();
    setTestUser(TEST_USER); // OWNER
  });

  // ── GET / ────────────────────────────────────────────────────────

  describe('GET /api/integrations', () => {
    it('returns list of integrations without tokens', async () => {
      mockPrisma.integrationConfig.findMany.mockResolvedValue([
        {
          id: 'int-1',
          orgId: 'org-1',
          provider: 'github',
          token: 'ghp_secrettoken123',
          baseUrl: '',
          settings: '{"postChecks":true,"postComments":true,"checkOnReview":true}',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ]);

      const res = await request(app).get('/api/integrations');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].provider).toBe('github');
      expect(res.body[0].hasToken).toBe(true);
      // Token should NEVER be exposed
      expect(res.body[0].token).toBeUndefined();
    });

    it('returns empty array when no integrations', async () => {
      mockPrisma.integrationConfig.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/integrations');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('parses settings JSON correctly', async () => {
      mockPrisma.integrationConfig.findMany.mockResolvedValue([
        {
          id: 'int-1',
          orgId: 'org-1',
          provider: 'github',
          token: 'ghp_test',
          baseUrl: 'https://github.example.com/api/v3',
          settings: '{"postChecks":false,"postComments":true,"checkOnReview":false}',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const res = await request(app).get('/api/integrations');
      expect(res.body[0].settings.postChecks).toBe(false);
      expect(res.body[0].settings.postComments).toBe(true);
      expect(res.body[0].settings.checkOnReview).toBe(false);
      expect(res.body[0].baseUrl).toBe('https://github.example.com/api/v3');
    });
  });

  // ── POST / ────────────────────────────────────────────────────────

  describe('POST /api/integrations', () => {
    it('creates a new integration', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue(null); // no existing
      mockPrisma.integrationConfig.create.mockResolvedValue({
        id: 'int-new',
        orgId: 'org-1',
        provider: 'github',
        token: 'ghp_newtoken',
        baseUrl: '',
        settings: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/integrations')
        .send({ provider: 'github', token: 'ghp_newtoken' });

      expect(res.status).toBe(201);
      expect(res.body.provider).toBe('github');
      expect(res.body.hasToken).toBe(true);
      expect(res.body.token).toBeUndefined();
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/integrations')
        .send({ provider: 'github' }); // missing token

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 for invalid provider', async () => {
      const res = await request(app)
        .post('/api/integrations')
        .send({ provider: 'bitbucket', token: 'tok123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Provider must be');
    });

    it('returns 409 when integration already exists for provider', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
      });

      const res = await request(app)
        .post('/api/integrations')
        .send({ provider: 'github', token: 'ghp_dup' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('creates audit log on creation', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue(null);
      mockPrisma.integrationConfig.create.mockResolvedValue({
        id: 'int-audit',
        orgId: 'org-1',
        provider: 'github',
        token: 'ghp_tok',
        baseUrl: '',
        settings: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/integrations')
        .send({ provider: 'github', token: 'ghp_tok' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'INTEGRATION_CREATED',
          }),
        }),
      );
    });

    it('rejects VIEWER role (requires ADMIN)', async () => {
      setTestUser(TEST_VIEWER);

      const res = await request(app)
        .post('/api/integrations')
        .send({ provider: 'github', token: 'ghp_tok' });

      expect(res.status).toBe(403);
    });
  });

  // ── PUT /:id ──────────────────────────────────────────────────────

  describe('PUT /api/integrations/:id', () => {
    it('updates integration settings', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
      });
      mockPrisma.integrationConfig.update.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
        token: 'ghp_existing',
        baseUrl: 'https://ghe.corp.com/api/v3',
        settings: '{"postChecks":false}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .put('/api/integrations/int-1')
        .send({ baseUrl: 'https://ghe.corp.com/api/v3', settings: { postChecks: false } });

      expect(res.status).toBe(200);
      expect(res.body.baseUrl).toBe('https://ghe.corp.com/api/v3');
    });

    it('returns 404 when integration not found', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put('/api/integrations/nonexistent')
        .send({ baseUrl: 'test' });

      expect(res.status).toBe(404);
    });

    it('creates audit log on update', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
      });
      mockPrisma.integrationConfig.update.mockResolvedValue({
        id: 'int-1',
        provider: 'github',
        token: 'tok',
        baseUrl: '',
        settings: '{}',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .put('/api/integrations/int-1')
        .send({ baseUrl: 'new-url' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'INTEGRATION_UPDATED',
          }),
        }),
      );
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────

  describe('DELETE /api/integrations/:id', () => {
    it('deletes integration', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
      });
      mockPrisma.integrationConfig.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app).delete('/api/integrations/int-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when integration not found', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/integrations/nonexistent');
      expect(res.status).toBe(404);
    });

    it('creates audit log on deletion', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
      });
      mockPrisma.integrationConfig.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app).delete('/api/integrations/int-1');

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'INTEGRATION_DELETED',
          }),
        }),
      );
    });
  });

  // ── POST /:id/test ───────────────────────────────────────────────

  describe('POST /api/integrations/:id/test', () => {
    it('tests GitHub connection successfully', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'github',
        token: 'ghp_real',
        baseUrl: '',
      });

      const res = await request(app).post('/api/integrations/int-1/test');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.login).toBe('octocat');
    });

    it('returns 404 when integration not found', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue(null);

      const res = await request(app).post('/api/integrations/nonexistent/test');
      expect(res.status).toBe(404);
    });

    it('returns error for unsupported providers', async () => {
      mockPrisma.integrationConfig.findFirst.mockResolvedValue({
        id: 'int-1',
        orgId: 'org-1',
        provider: 'gitlab',
        token: 'glpat_test',
        baseUrl: '',
      });

      const res = await request(app).post('/api/integrations/int-1/test');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not supported');
    });
  });
});
