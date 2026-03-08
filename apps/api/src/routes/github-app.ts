import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import {
  createInstallationToken,
  testGitHubAppConnection,
  getGitHubAppConfig,
} from '../services/github-app.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'origin-v2-dev-secret';

// ── GET /install — redirect user to GitHub App installation page ──

router.get('/install', requireAuth, requireRole('ADMIN'), (req: AuthRequest, res: Response) => {
  const appConfig = getGitHubAppConfig();

  if (!appConfig.configured) {
    return res.status(500).json({
      error: 'GitHub App not configured on this server. Set GITHUB_APP_ID, GITHUB_APP_SLUG, and GITHUB_APP_PRIVATE_KEY environment variables.',
    });
  }

  // Create a signed state token with orgId to prevent CSRF and associate installation with org
  const state = jwt.sign(
    { orgId: req.user!.orgId, userId: req.user!.id },
    JWT_SECRET,
    { expiresIn: '15m' },
  );

  const installUrl = `https://github.com/apps/${appConfig.appSlug}/installations/new?state=${encodeURIComponent(state)}`;
  res.json({ installUrl });
});

// ── GET /callback — GitHub redirects here after App installation ──
// This route does NOT require auth — GitHub redirects the browser here directly.
// Instead, it validates the `state` JWT token signed during /install.

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { installation_id, setup_action, state } = req.query;

    if (!state) {
      return res.redirect('/settings?tab=integrations&github_app=error&msg=missing_state');
    }

    // Verify state token
    let statePayload: { orgId: string; userId: string };
    try {
      statePayload = jwt.verify(state as string, JWT_SECRET) as { orgId: string; userId: string };
    } catch {
      return res.redirect('/settings?tab=integrations&github_app=error&msg=invalid_state');
    }

    if (setup_action === 'request') {
      // User requested installation but org owner needs to approve
      return res.redirect('/settings?tab=integrations&github_app=requested');
    }

    if (!installation_id) {
      return res.redirect('/settings?tab=integrations&github_app=error&msg=no_installation_id');
    }

    const appConfig = getGitHubAppConfig();
    if (!appConfig.configured) {
      return res.redirect('/settings?tab=integrations&github_app=error&msg=server_not_configured');
    }

    // Generate initial installation access token
    let tokenResult: { token: string; expiresAt: string };
    try {
      tokenResult = await createInstallationToken(
        appConfig.appId!,
        appConfig.privateKey!,
        installation_id as string,
      );
    } catch (err: any) {
      console.error('[github-app] Failed to create initial token:', err.message);
      return res.redirect(`/settings?tab=integrations&github_app=error&msg=token_failed`);
    }

    // Upsert IntegrationConfig for this org
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: statePayload.orgId, provider: 'github' },
    });

    const existingSettings = existing
      ? (() => { try { return JSON.parse(existing.settings); } catch { return {}; } })()
      : {};

    const settings = {
      postChecks: true,
      postComments: true,
      checkOnReview: true,
      ...existingSettings,
      appId: appConfig.appId,
      installationId: installation_id as string,
      privateKey: appConfig.privateKey,
      tokenExpiresAt: tokenResult.expiresAt,
      appSlug: appConfig.appSlug,
    };

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: {
          token: tokenResult.token,
          authType: 'github_app',
          settings: JSON.stringify(settings),
        },
      });
    } else {
      await prisma.integrationConfig.create({
        data: {
          orgId: statePayload.orgId,
          provider: 'github',
          token: tokenResult.token,
          authType: 'github_app',
          settings: JSON.stringify(settings),
        },
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: statePayload.orgId,
        userId: statePayload.userId,
        action: 'GITHUB_APP_INSTALLED',
        resource: installation_id as string,
        metadata: JSON.stringify({
          installationId: installation_id,
          appSlug: appConfig.appSlug,
        }),
      },
    });

    // Redirect back to Settings page with success
    res.redirect('/settings?tab=integrations&github_app=success');
  } catch (err) {
    console.error('[github-app] Callback error:', err);
    res.redirect('/settings?tab=integrations&github_app=error&msg=unexpected');
  }
});

// ── GET /status — check GitHub App installation status ──

router.get('/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const appConfig = getGitHubAppConfig();

    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider: 'github' },
    });

    if (!config || (config as any).authType !== 'github_app') {
      return res.json({
        installed: false,
        serverConfigured: appConfig.configured,
        appSlug: appConfig.appSlug || null,
      });
    }

    let settings: any = {};
    try {
      settings = JSON.parse(config.settings);
    } catch { /* ignore */ }

    res.json({
      installed: true,
      serverConfigured: appConfig.configured,
      installationId: settings.installationId || null,
      appSlug: settings.appSlug || appConfig.appSlug || null,
    });
  } catch (err) {
    console.error('[github-app] Status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /test — test GitHub App connection ──

router.post('/test', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider: 'github' },
    });

    if (!config || (config as any).authType !== 'github_app') {
      return res.status(404).json({ error: 'No GitHub App integration found' });
    }

    let settings: any = {};
    try {
      settings = JSON.parse(config.settings);
    } catch { /* ignore */ }

    if (!settings.appId || !settings.privateKey || !settings.installationId) {
      return res.status(400).json({ error: 'GitHub App credentials incomplete' });
    }

    const apiBase = config.baseUrl || 'https://api.github.com';
    const result = await testGitHubAppConnection(
      settings.appId,
      settings.privateKey,
      settings.installationId,
      apiBase,
    );

    res.json(result);
  } catch (err) {
    console.error('[github-app] Test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
