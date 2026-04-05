import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import {
  createInstallationToken,
  generateAppJWT,
  testGitHubAppConnection,
  getGitHubAppConfig,
} from '../services/github-app.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

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

// ── POST /detect — auto-detect existing GitHub App installation ──
// When the app is already installed on a user's GitHub account, GitHub won't
// redirect back with a new installation_id. This endpoint lists all installations
// of the Origin GitHub App and lets the admin pick/auto-link one.

router.post('/detect', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const appConfig = getGitHubAppConfig();
    if (!appConfig.configured) {
      return res.status(500).json({ error: 'GitHub App not configured on this server.' });
    }

    // Already connected?
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider: 'github', authType: 'github_app' },
    });
    if (existing) {
      let s: any = {};
      try { s = JSON.parse(existing.settings); } catch { /* */ }
      if (s.installationId) {
        return res.json({ linked: true, installationId: s.installationId, message: 'Already linked.' });
      }
    }

    // Authenticate as the GitHub App itself and list all installations
    const decodedKey = appConfig.privateKey!.replace(/\\n/g, '\n');
    const appJwt = generateAppJWT(appConfig.appId!, decodedKey);

    const ghRes = await fetch('https://api.github.com/app/installations?per_page=100', {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Origin-AI-Governance/1.0',
      },
    });

    if (!ghRes.ok) {
      const err = await ghRes.text();
      return res.status(502).json({ error: `GitHub API error (${ghRes.status}): ${err}` });
    }

    const installationsRaw = await ghRes.json();
    const installations: any[] = Array.isArray(installationsRaw) ? installationsRaw : [];
    console.log(`[github-app] Detect: GitHub returned ${installations.length} installation(s)`, installations.map((i: any) => ({ id: i.id, account: i.account?.login })));

    if (installations.length === 0) {
      return res.json({ linked: false, installations: [], message: 'No installations found. Install the GitHub App first.' });
    }

    // Filter out installations already claimed by ANY org (including this one)
    // This prevents showing other users' GitHub accounts to unrelated Origin users
    const claimedByAny = await prisma.integrationConfig.findMany({
      where: {
        provider: 'github',
        authType: 'github_app',
      },
      select: { settings: true },
    });
    const claimedInstallationIds = new Set<string>();
    for (const cfg of claimedByAny) {
      try {
        const s = JSON.parse(cfg.settings);
        if (s.installationId) claimedInstallationIds.add(String(s.installationId));
      } catch { /* ignore */ }
    }

    // Never return the full installation list — that leaks other users' GitHub accounts.
    // Instead, allow linking by specific installationId OR by GitHub account name.
    const targetId = req.body?.installationId || null;
    const targetAccount = req.body?.githubAccount?.trim().toLowerCase() || null;

    // Find the target installation by ID or account name
    let target: any = null;
    if (targetId) {
      target = installations.find((i: any) => String(i.id) === targetId);
      if (!target) {
        return res.status(400).json({ error: 'Installation not found.' });
      }
    } else if (targetAccount) {
      target = installations.find(
        (i: any) => (i.account?.login || '').toLowerCase() === targetAccount,
      );
      if (!target) {
        return res.status(404).json({
          error: `No GitHub App installation found for account "${req.body.githubAccount}". Make sure the Origin app is installed on that GitHub account.`,
        });
      }
      // Check if already claimed by another org
      if (claimedInstallationIds.has(String(target.id))) {
        return res.status(409).json({
          error: `The GitHub App installation for "${req.body.githubAccount}" is already linked to another Origin organization. Disconnect it there first.`,
        });
      }
    }

    if (!target) {
      // No target specified — just report whether unclaimed installations exist
      const hasUnclaimed = installations.some(
        (inst: any) => !claimedInstallationIds.has(String(inst.id)),
      );
      return res.json({
        linked: false,
        hasUnclaimedInstallations: hasUnclaimed,
        message: hasUnclaimed
          ? 'Existing installations found. Provide your GitHub username to link.'
          : 'No unclaimed installations found. Install the GitHub App first.',
      });
    }

    {

      const linkedId = String(target.id);

      // Create installation token
      const tokenResult = await createInstallationToken(
        appConfig.appId!,
        decodedKey,
        linkedId,
      );

      const settings = {
        postChecks: true,
        postComments: true,
        checkOnReview: true,
        appId: appConfig.appId,
        installationId: linkedId,
        privateKey: appConfig.privateKey, // store escaped version
        tokenExpiresAt: tokenResult.expiresAt,
        appSlug: appConfig.appSlug,
      };

      if (existing) {
        const existingSettings = (() => { try { return JSON.parse(existing.settings); } catch { return {}; } })();
        await prisma.integrationConfig.update({
          where: { id: existing.id },
          data: {
            token: tokenResult.token,
            authType: 'github_app',
            settings: JSON.stringify({ ...existingSettings, ...settings }),
          },
        });
      } else {
        await prisma.integrationConfig.create({
          data: {
            orgId: req.user!.orgId,
            provider: 'github',
            token: tokenResult.token,
            authType: 'github_app',
            settings: JSON.stringify(settings),
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          orgId: req.user!.orgId,
          userId: req.user!.id,
          action: 'GITHUB_APP_LINKED',
          resource: linkedId,
          metadata: JSON.stringify({
            installationId: linkedId,
            account: target.account?.login,
            method: targetAccount ? 'by-account-name' : 'by-installation-id',
          }),
        },
      });

      return res.json({
        linked: true,
        installationId: linkedId,
        account: target.account?.login,
        message: `Linked to GitHub account "${target.account?.login}"`,
      });
    }
  } catch (err: any) {
    console.error('[github-app] Detect error:', err);
    console.error('[github-app] Detect error detail:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
