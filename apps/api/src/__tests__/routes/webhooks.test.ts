import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma, resetAllMocks } from '../helpers.js';
import request from 'supertest';
import crypto from 'crypto';
import express from 'express';

// Mock github-integration service before route import
vi.mock('../../services/github-integration.js', () => ({
  updatePRGitHubStatus: vi.fn().mockResolvedValue(undefined),
  postCommitStatus: vi.fn().mockResolvedValue({ success: true }),
  postPRComment: vi.fn().mockResolvedValue({ success: true, commentId: 'cmt-1' }),
  updatePRComment: vi.fn().mockResolvedValue({ success: true }),
  getIntegrationConfig: vi.fn().mockResolvedValue(null),
  parseRepoFullName: vi.fn().mockReturnValue({ owner: 'org', repo: 'app' }),
  buildSessionSummaryComment: vi.fn().mockReturnValue('## Summary'),
  computeCheckStatus: vi.fn().mockReturnValue({ state: 'pending', description: 'awaiting' }),
  getSessionsForPR: vi.fn().mockResolvedValue([]),
  testGitHubConnection: vi.fn().mockResolvedValue({ success: true }),
}));

// Import route AFTER mocks
import webhookRouter from '../../routes/webhooks.js';

// Webhook routes don't use auth middleware — create a simpler app
function createWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRouter);
  return app;
}

const WEBHOOK_SECRET = 'test-webhook-secret-123';

function signPayload(payload: object, secret: string): string {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return 'sha256=' + hmac.digest('hex');
}

describe('Webhooks Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    resetAllMocks();
    app = createWebhookApp();
  });

  // ── HMAC Signature ──────────────────────────────────────────────

  describe('HMAC Signature Verification', () => {
    it('returns 401 when signature is missing', async () => {
      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-github-event', 'push')
        .send({ ref: 'refs/heads/main', commits: [] });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Missing signature');
    });

    it('returns 404 when no active webhook exists for repo', async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', 'sha256=invalid')
        .set('x-github-event', 'push')
        .send({ ref: 'refs/heads/main' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('No active webhook');
    });

    it('returns 401 when signature is invalid', async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', 'sha256=wrong')
        .set('x-github-event', 'push')
        .send({ ref: 'refs/heads/main' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid signature');
    });
  });

  // ── Ping Event ──────────────────────────────────────────────────

  describe('Ping Event', () => {
    it('responds with pong for ping events', async () => {
      const payload = { zen: 'Design for failure.', hook_id: 12345 };
      const sig = signPayload(payload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'ping')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('pong');
    });
  });

  // ── Push Events ─────────────────────────────────────────────────

  describe('Push Events', () => {
    const pushPayload = {
      ref: 'refs/heads/main',
      commits: [
        {
          id: 'abc123',
          message: 'feat: add login page',
          author: { name: 'Test User', email: 'test@test.com' },
          timestamp: '2024-01-15T10:00:00Z',
          added: ['src/Login.tsx'],
          modified: [],
          removed: [],
        },
      ],
      repository: { full_name: 'org/my-app' },
    };

    it('processes push event and creates commits', async () => {
      const sig = signPayload(pushPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      // Commit doesn't exist yet
      mockPrisma.commit.findFirst.mockResolvedValue(null);
      mockPrisma.commit.create.mockResolvedValue({ id: 'c-new' });
      mockPrisma.repo.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'push')
        .send(pushPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.created).toBe(1);
      expect(res.body.skipped).toBe(0);
    });

    it('skips duplicate commits', async () => {
      const sig = signPayload(pushPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      // Commit already exists
      mockPrisma.commit.findFirst.mockResolvedValue({ id: 'existing', sha: 'abc123' });
      mockPrisma.repo.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'push')
        .send(pushPayload);

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(0);
      expect(res.body.skipped).toBe(1);
    });

    it('creates audit log for push events', async () => {
      const sig = signPayload(pushPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      mockPrisma.commit.findFirst.mockResolvedValue(null);
      mockPrisma.commit.create.mockResolvedValue({});
      mockPrisma.repo.update.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'push')
        .send(pushPayload);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'WEBHOOK_RECEIVED',
          }),
        }),
      );
    });
  });

  // ── Pull Request Events ─────────────────────────────────────────

  describe('Pull Request Events', () => {
    const prPayload = {
      action: 'opened',
      number: 42,
      pull_request: {
        title: 'feat: add AI dashboard',
        html_url: 'https://github.com/org/my-app/pull/42',
        state: 'open',
        user: { login: 'dev-user' },
        base: { ref: 'main' },
        head: { ref: 'feature/dashboard', sha: 'def456' },
        merged: false,
      },
      repository: { full_name: 'org/my-app' },
    };

    it('processes PR opened event — creates new PR record', async () => {
      const sig = signPayload(prPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      // No existing PR
      mockPrisma.pullRequest.findFirst.mockResolvedValue(null);
      mockPrisma.commit.findMany.mockResolvedValue([]);
      mockPrisma.pullRequest.create.mockResolvedValue({
        id: 'pr-new',
        repoId: 'repo-1',
        number: 42,
        title: 'feat: add AI dashboard',
        state: 'open',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(prPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.action).toBe('opened');
      expect(res.body.number).toBe(42);
      expect(res.body.state).toBe('open');
    });

    it('updates existing PR record on synchronize', async () => {
      const syncPayload = { ...prPayload, action: 'synchronize' };
      const sig = signPayload(syncPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      // Existing PR
      mockPrisma.pullRequest.findFirst.mockResolvedValue({
        id: 'pr-existing',
        repoId: 'repo-1',
        number: 42,
        commitShas: '["abc123"]',
      });
      mockPrisma.commit.findMany.mockResolvedValue([]);
      mockPrisma.pullRequest.update.mockResolvedValue({
        id: 'pr-existing',
        repoId: 'repo-1',
        number: 42,
        state: 'open',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(syncPayload);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('synchronize');
      // Should update, not create
      expect(mockPrisma.pullRequest.update).toHaveBeenCalled();
      expect(mockPrisma.pullRequest.create).not.toHaveBeenCalled();
    });

    it('sets merged state when PR is merged', async () => {
      const mergedPayload = {
        ...prPayload,
        action: 'closed',
        pull_request: {
          ...prPayload.pull_request,
          state: 'closed',
          merged: true,
        },
      };
      const sig = signPayload(mergedPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      mockPrisma.pullRequest.findFirst.mockResolvedValue(null);
      mockPrisma.commit.findMany.mockResolvedValue([]);
      mockPrisma.pullRequest.create.mockResolvedValue({
        id: 'pr-merged',
        state: 'merged',
        number: 42,
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(mergedPayload);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('merged');
    });

    it('creates audit log for PR events', async () => {
      const sig = signPayload(prPayload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });
      mockPrisma.repo.findUnique.mockResolvedValue({ id: 'repo-1', orgId: 'org-1' });
      mockPrisma.pullRequest.findFirst.mockResolvedValue(null);
      mockPrisma.commit.findMany.mockResolvedValue([]);
      mockPrisma.pullRequest.create.mockResolvedValue({ id: 'pr-1', number: 42, state: 'open' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(prPayload);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'WEBHOOK_PR_RECEIVED',
          }),
        }),
      );
    });
  });

  // ── Unknown Events ──────────────────────────────────────────────

  describe('Unknown Events', () => {
    it('ignores unhandled events gracefully', async () => {
      const payload = { action: 'created' };
      const sig = signPayload(payload, WEBHOOK_SECRET);

      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: 'wh-1',
        repoId: 'repo-1',
        secret: WEBHOOK_SECRET,
        active: true,
      });

      const res = await request(app)
        .post('/api/webhooks/github/repo-1')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'issues')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('ignored');
    });
  });
});
