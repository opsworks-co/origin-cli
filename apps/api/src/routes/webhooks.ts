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

    // Verify HMAC signature
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!verifyGitHubSignature(rawBody, signature, webhook.secret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Handle ping event (GitHub sends this when webhook is first created)
    if (event === 'ping') {
      return res.json({ message: 'pong' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

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

export default router;
