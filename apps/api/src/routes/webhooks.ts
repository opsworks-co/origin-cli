import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { verifyGitHubSignature, verifyGitLabToken } from '../services/webhook.js';
import { enqueueDelivery } from '../services/webhook-queue.js';

const router = Router();

// ── Replay-attack protection ──────────────────────────────────────────────
// In-memory LRU-ish cache of recently seen delivery IDs (GitHub's
// x-github-delivery and GitLab's x-gitlab-event-uuid). An attacker who
// captures a signed payload can replay it indefinitely because the HMAC
// is still valid — so we track delivery IDs for 24 h and reject dupes.
// Bounded at 50k entries; oldest evicted on overflow.
const MAX_SEEN_DELIVERIES = 50_000;
const SEEN_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const seenDeliveries = new Map<string, number>();

function isReplay(deliveryId: string | undefined): boolean {
  if (!deliveryId) return false;
  const now = Date.now();
  // Lazy eviction: every call drops any expired entries it sees in the top slot.
  if (seenDeliveries.size >= MAX_SEEN_DELIVERIES) {
    // Drop the oldest ~10% so we don't churn on every request once full.
    let drop = Math.max(1, Math.floor(MAX_SEEN_DELIVERIES * 0.1));
    for (const key of seenDeliveries.keys()) {
      seenDeliveries.delete(key);
      if (--drop <= 0) break;
    }
  }
  const existing = seenDeliveries.get(deliveryId);
  if (existing && now - existing < SEEN_DELIVERY_TTL_MS) {
    return true;
  }
  seenDeliveries.set(deliveryId, now);
  return false;
}

// POST /github/:repoId — receive GitHub webhook events (public, authenticated via HMAC)
router.post('/github/:repoId', async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repoId as string;
    const signature = req.headers['x-hub-signature-256'] as string;
    const event = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Reject replays (attacker captured a signed payload and resends it).
    if (isReplay(deliveryId ? `gh:${repoId}:${deliveryId}` : undefined)) {
      return res.status(202).json({ accepted: true, duplicate: true });
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

    // Persist delivery first — guarantees retry on processing failure
    if (event === 'push' || event === 'pull_request') {
      const deliveryId = await enqueueDelivery({
        provider: 'github',
        repoId,
        event,
        payload,
        headers: { 'x-github-event': event },
      });
      // 202 Accepted: queued for processing. The delivery worker will retry on failure.
      return res.status(202).json({ accepted: true, deliveryId });
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
    const ghDeliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Reject replays keyed on GitHub's delivery ID.
    if (isReplay(ghDeliveryId ? `gh-app:${ghDeliveryId}` : undefined)) {
      return res.status(202).json({ accepted: true, duplicate: true });
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

    // Find the IntegrationConfig with this installationId. Scanned
    // linearly because installationId lives inside the JSON `settings`
    // column. Cap at 10k — this is a webhook hot path and an unbounded
    // scan over every github-app integration across every tenant
    // grows with customer count.
    const integrations = await prisma.integrationConfig.findMany({
      where: { provider: 'github', authType: 'github_app' },
      take: 10_000,
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
      take: 5000,
    });

    const matchedRepo = allOrgRepos.find((r) => {
      const normalized = r.path.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '');
      return normalized === repoFullName || r.path.includes(repoFullName);
    });

    if (!matchedRepo) {
      return res.json({ message: `Repository ${repoFullName} not tracked in Origin` });
    }

    // Persist delivery for retryable processing
    if (event === 'push' || event === 'pull_request') {
      const deliveryId = await enqueueDelivery({
        provider: 'github-app',
        repoId: matchedRepo.id,
        event,
        payload,
        headers: { 'x-github-event': event, installationId },
      });
      return res.status(202).json({ accepted: true, deliveryId });
    }

    res.json({ message: `Event '${event}' ignored` });
  } catch (err) {
    console.error('[github-app-webhook] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /gitlab/:repoId — receive GitLab webhook events (public, authenticated via token) ──

router.post('/gitlab/:repoId', async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repoId as string;
    const gitlabToken = req.headers['x-gitlab-token'] as string;
    const event = req.headers['x-gitlab-event'] as string;
    const glEventUuid = req.headers['x-gitlab-event-uuid'] as string | undefined;

    if (!gitlabToken) {
      return res.status(401).json({ error: 'Missing token' });
    }

    // Reject replays keyed on GitLab's event UUID.
    if (isReplay(glEventUuid ? `gl:${repoId}:${glEventUuid}` : undefined)) {
      return res.status(202).json({ accepted: true, duplicate: true });
    }

    // Find webhook for this repo
    const webhook = await prisma.webhook.findFirst({
      where: { repoId, active: true },
    });

    if (!webhook) {
      return res.status(404).json({ error: 'No active webhook for this repo' });
    }

    // Verify token (GitLab uses plain string comparison)
    if (!verifyGitLabToken(gitlabToken, webhook.secret)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const payload = req.body;

    // Map GitLab event names to canonical event types
    let canonicalEvent: string | null = null;
    if (event === 'Push Hook') canonicalEvent = 'push';
    else if (event === 'Merge Request Hook') canonicalEvent = 'merge_request';

    if (canonicalEvent) {
      const deliveryId = await enqueueDelivery({
        provider: 'gitlab',
        repoId,
        event: canonicalEvent,
        payload,
        headers: { 'x-gitlab-event': event },
      });
      return res.status(202).json({ accepted: true, deliveryId });
    }

    res.json({ message: `GitLab event '${event}' ignored` });
  } catch (err) {
    console.error('GitLab webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
