import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, createTestApp, resetAllMocks } from '../helpers.js';
import request from 'supertest';

// Mock checkpoint service before route import
vi.mock('../../services/checkpoint.js', () => ({
  syncCheckpoints: vi.fn().mockResolvedValue({ synced: 5, total: 10 }),
}));

// Mock github-integration service
vi.mock('../../services/github-integration.js', () => ({
  getIntegrationConfig: vi.fn().mockResolvedValue(null),
  listGitHubRepos: vi.fn().mockResolvedValue({ success: true, repos: [] }),
  createGitHubWebhook: vi.fn().mockResolvedValue({ success: true, hookId: 123 }),
  deleteGitHubWebhook: vi.fn().mockResolvedValue({ success: true }),
  parseRepoFullName: vi.fn((path: string) => {
    const cleaned = path.replace(/^https?:\/\//, '').replace(/^github\.com\//, '');
    const parts = cleaned.split('/');
    return parts.length >= 2 ? { owner: parts[0], repo: parts[1] } : null;
  }),
}));

// Import route AFTER mocks
import repoRouter from '../../routes/repos.js';

const app = createTestApp(repoRouter, '/api/repos');

describe('Repos Routes', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  describe('GET /api/repos', () => {
    it('returns list of repos', async () => {
      const repos = [
        { id: 'r1', orgId: 'org-1', name: 'my-app', path: '/repos/my-app', provider: 'github', _count: { commits: 42 } },
      ];
      mockPrisma.repo.findMany.mockResolvedValue(repos);

      const res = await request(app).get('/api/repos');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('my-app');
      expect(res.body[0]._count.commits).toBe(42);
    });

    it('returns empty array when no repos exist', async () => {
      mockPrisma.repo.findMany.mockResolvedValue([]);

      const res = await request(app).get('/api/repos');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('POST /api/repos', () => {
    it('creates repo with valid data', async () => {
      const newRepo = { id: 'r1', orgId: 'org-1', name: 'new-repo', path: '/repos/new-repo', provider: 'local' };
      mockPrisma.repo.create.mockResolvedValue(newRepo);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/repos')
        .send({ name: 'new-repo', path: '/repos/new-repo' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('new-repo');
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app)
        .post('/api/repos')
        .send({ name: 'test' }); // missing path
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/repos')
        .send({ path: '/repos/test' }); // missing name
      expect(res.status).toBe(400);
    });

    it('creates audit log on repo creation', async () => {
      mockPrisma.repo.create.mockResolvedValue({ id: 'r1', orgId: 'org-1', name: 'audited', path: '/x' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/repos')
        .send({ name: 'audited', path: '/x', provider: 'github' });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REPO_CREATED',
          }),
        }),
      );
    });
  });

  describe('GET /api/repos/:id', () => {
    it('returns a single repo with commit count', async () => {
      const repo = { id: 'r1', orgId: 'org-1', name: 'my-repo', path: '/repos/my-repo', _count: { commits: 10 } };
      mockPrisma.repo.findFirst.mockResolvedValue(repo);

      const res = await request(app).get('/api/repos/r1');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('my-repo');
      expect(res.body._count.commits).toBe(10);
    });

    it('returns 404 when repo not found', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/repos/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Repo not found');
    });
  });

  describe('PUT /api/repos/:id', () => {
    it('updates repo', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue({ id: 'r1', orgId: 'org-1' });
      mockPrisma.repo.update.mockResolvedValue({ id: 'r1', name: 'Updated Repo', path: '/new-path' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .put('/api/repos/r1')
        .send({ name: 'Updated Repo', path: '/new-path' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Repo');
    });

    it('returns 404 when repo not found', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .put('/api/repos/nonexistent')
        .send({ name: 'X' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Repo not found');
    });
  });

  describe('DELETE /api/repos/:id', () => {
    it('deletes repo with cascade delete of commits and sessions', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue({ id: 'r1', orgId: 'org-1', name: 'to-delete', path: 'github.com/org/repo' });
      mockPrisma.webhook.findMany.mockResolvedValue([]);
      mockPrisma.webhook.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.pullRequest.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.commit.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
      mockPrisma.sessionReview.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.codingSession.deleteMany.mockResolvedValue({ count: 2 });
      mockPrisma.commit.deleteMany.mockResolvedValue({ count: 2 });
      mockPrisma.repo.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app).delete('/api/repos/r1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when repo not found for deletion', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue(null);

      const res = await request(app).delete('/api/repos/nonexistent');
      expect(res.status).toBe(404);
    });

    it('handles repo with no commits gracefully', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue({ id: 'r1', orgId: 'org-1', name: 'empty-repo', path: 'local/repo' });
      mockPrisma.webhook.findMany.mockResolvedValue([]);
      mockPrisma.webhook.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.pullRequest.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.commit.findMany.mockResolvedValue([]);
      mockPrisma.repo.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app).delete('/api/repos/r1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Should not attempt to delete sessions or reviews when no commits
      expect(mockPrisma.sessionReview.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.codingSession.deleteMany).not.toHaveBeenCalled();
    });

    it('cascade deletes reviews, sessions, then commits', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue({ id: 'r1', orgId: 'org-1', name: 'cascade', path: 'github.com/org/repo' });
      mockPrisma.webhook.findMany.mockResolvedValue([]);
      mockPrisma.webhook.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.pullRequest.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.commit.findMany.mockResolvedValue([{ id: 'c1' }]);
      mockPrisma.sessionReview.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.codingSession.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.commit.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.repo.delete.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app).delete('/api/repos/r1');

      expect(mockPrisma.sessionReview.deleteMany).toHaveBeenCalledWith({
        where: { session: { commitId: { in: ['c1'] } } },
      });
      expect(mockPrisma.codingSession.deleteMany).toHaveBeenCalledWith({
        where: { commitId: { in: ['c1'] } },
      });
      expect(mockPrisma.commit.deleteMany).toHaveBeenCalledWith({
        where: { repoId: 'r1' },
      });
    });
  });

  describe('GET /api/repos/:id/commits', () => {
    it('returns commits for a repo', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue({ id: 'r1', orgId: 'org-1' });
      const commits = [
        { id: 'c1', repoId: 'r1', sha: 'abc123', message: 'initial', session: null },
      ];
      mockPrisma.commit.findMany.mockResolvedValue(commits);

      const res = await request(app).get('/api/repos/r1/commits');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].sha).toBe('abc123');
    });

    it('returns 404 when repo not found for commits', async () => {
      mockPrisma.repo.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/repos/nonexistent/commits');
      expect(res.status).toBe(404);
    });
  });
});
