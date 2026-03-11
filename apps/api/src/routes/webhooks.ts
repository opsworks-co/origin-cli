import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { verifyGitHubSignature, processGitHubPush, processGitHubPR } from '../services/webhook.js';

const router = Router();

// POST /github/:repoId — receive GitHub webhook events (public, authenticated via HMAC)
router.post('/github/:repoId', async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repoId as string;
    const signature = req.headers['x-hub-signature-256'] as string;
    const event = req.headers['x-github-event'] as string;

    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Find webhook for this repo
    const webhook = await prisma.webhook.findFirst({
      where: { repoId, active: true },
    });

    if (!webhook) {
      return res.status(404).json({ error: 'No active webhook for this repo' });
    }

    // Verify HMAC signature using the raw body buffer (before JSON parsing)
    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      return res.status(500).json({ error: 'Raw body not captured' });
    }
    if (!verifyGitHubSignature(rawBody, signature, webhook.secret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Handle ping event (GitHub sends this when webhook is first created)
    if (event === 'ping') {
      return res.json({ message: 'pong' });
    }

    // Body already parsed by raw body middleware in index.ts
    const payload = req.body;

    // Get repo for audit log
    const repo = await prisma.repo.findUnique({ where: { id: repoId } });

    // ── Handle push events ──
    if (event === 'push') {
      const result = await processGitHubPush(repoId, payload);

      await prisma.auditLog.create({
        data: {
          orgId: repo?.orgId || '',
          action: 'WEBHOOK_RECEIVED',
          resource: repoId,
          metadata: JSON.stringify({
            event,
            ref: payload.ref,
            commitsCreated: result.created,
            commitsSkipped: result.skipped,
            repository: payload.repository?.full_name,
          }),
        },
      });

      return res.json({ success: true, ...result });
    }

    // ── Handle pull_request events ──
    if (event === 'pull_request') {
      const result = await processGitHubPR(repoId, payload);

      await prisma.auditLog.create({
        data: {
          orgId: repo?.orgId || '',
          action: 'WEBHOOK_PR_RECEIVED',
          resource: repoId,
          metadata: JSON.stringify({
            event,
            action: result.action,
            prNumber: result.number,
            state: result.state,
            commitShas: result.commitShas,
            repository: payload.repository?.full_name,
          }),
        },
      });

      return res.json({ success: true, ...result });
    }

    // Ignore other events
    res.json({ message: `Event '${event}' ignored` });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /github-app — centralized webhook endpoint for GitHub App events ──
// GitHub App sends ALL events for ALL installations to this single URL.
// Routes to the correct org/repo by matching installation_id → IntegrationConfig.

router.post('/github-app', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string;
    const event = req.headers['x-github-event'] as string;

    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Verify using the App's webhook secret from environment
    const appWebhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!appWebhookSecret) {
      console.error('[github-app-webhook] GITHUB_APP_WEBHOOK_SECRET not configured');
      return res.status(500).json({ error: 'App webhook secret not configured' });
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      return res.status(500).json({ error: 'Raw body not captured' });
    }
    if (!verifyGitHubSignature(rawBody, signature, appWebhookSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Handle ping event
    if (event === 'ping') {
      return res.json({ message: 'pong' });
    }

    // Body already parsed by raw body middleware in index.ts
    const payload = req.body;
    const installationId = String(payload.installation?.id || '');
    const repoFullName = payload.repository?.full_name;

    if (!installationId || !repoFullName) {
      return res.json({ message: 'No installation or repository in payload' });
    }

    // Find the IntegrationConfig with this installationId
    const integrations = await prisma.integrationConfig.findMany({
      where: { provider: 'github', authType: 'github_app' },
    });

    const matchingIntegration = integrations.find((i) => {
      try {
        const settings = JSON.parse(i.settings);
        return String(settings.installationId) === installationId;
      } catch {
        return false;
      }
    });

    if (!matchingIntegration) {
      return res.json({ message: `No matching installation for ID ${installationId}` });
    }

    // Find the repo in this org by path
    const repo = await prisma.repo.findFirst({
      where: {
        orgId: matchingIntegration.orgId,
        provider: 'github',
      },
    });

    // Try to find by full_name match in path
    const allOrgRepos = await prisma.repo.findMany({
      where: {
        orgId: matchingIntegration.orgId,
        provider: 'github',
      },
    });

    const matchedRepo = allOrgRepos.find((r) => {
      const normalized = r.path.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '');
      return normalized === repoFullName || r.path.includes(repoFullName);
    });

    if (!matchedRepo) {
      return res.json({ message: `Repository ${repoFullName} not tracked in Origin` });
    }

    // Handle push events
    if (event === 'push') {
      const result = await processGitHubPush(matchedRepo.id, payload);

      await prisma.auditLog.create({
        data: {
          orgId: matchingIntegration.orgId,
          action: 'WEBHOOK_RECEIVED',
          resource: matchedRepo.id,
          metadata: JSON.stringify({
            event,
            ref: payload.ref,
            commitsCreated: result.created,
            commitsSkipped: result.skipped,
            repository: repoFullName,
            source: 'github_app',
          }),
        },
      });

      return res.json({ success: true, ...result });
    }

    // Handle pull_request events
    if (event === 'pull_request') {
      const result = await processGitHubPR(matchedRepo.id, payload);

      await prisma.auditLog.create({
        data: {
          orgId: matchingIntegration.orgId,
          action: 'WEBHOOK_PR_RECEIVED',
          resource: matchedRepo.id,
          metadata: JSON.stringify({
            event,
            action: result.action,
            prNumber: result.number,
            state: result.state,
            commitShas: result.commitShas,
            repository: repoFullName,
            source: 'github_app',
          }),
        },
      });

      return res.json({ success: true, ...result });
    }

    res.json({ message: `Event '${event}' ignored` });
  } catch (err) {
    console.error('[github-app-webhook] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
