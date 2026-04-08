import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import {
  getGitLabOAuthConfig,
  getGitLabOAuthConfigForOrg,
  getGitLabOAuthBaseUrl,
  exchangeGitLabOAuthCode,
  getValidGitLabOAuthToken,
  testGitLabConnection,
} from '../services/gitlab-integration.js';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

// ── GET /debug-config — temporary debug endpoint ──
router.get('/debug-config', (_req: Request, res: Response) => {
  const clientId = process.env.GITLAB_APP_ID || process.env.GITLAB_CLIENT_ID || 'NOT_SET';
  const hasSecret = !!(process.env.GITLAB_APP_SECRET || process.env.GITLAB_CLIENT_SECRET);
  const redirectUri = process.env.GITLAB_APP_REDIRECT_URI || process.env.GITLAB_REDIRECT_URI || 'NOT_SET';
  res.json({ clientId: clientId.slice(0, 12) + '...', hasSecret, redirectUri });
});

// ── GET /config — get GitLab OAuth app config for this org ──

router.get('/config', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;

    // Check env vars first
    const envConfig = getGitLabOAuthConfig();
    if (envConfig.configured) {
      return res.json({
        configured: true,
        source: 'environment',
        clientId: envConfig.clientId,
        redirectUri: envConfig.redirectUri,
        // Never expose secret
      });
    }

    // Check per-org DB config
    const dbConfig = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'gitlab_oauth_app' },
    });

    if (!dbConfig) {
      return res.json({ configured: false, source: 'none' });
    }

    let settings: any = {};
    try { settings = JSON.parse(dbConfig.settings); } catch {}

    res.json({
      configured: !!(settings.clientId && settings.clientSecret && settings.redirectUri),
      source: 'database',
      clientId: settings.clientId || null,
      redirectUri: settings.redirectUri || null,
    });
  } catch (err) {
    console.error('[gitlab-oauth] Config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /config — save GitLab OAuth app credentials for this org ──

router.put('/config', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const { clientId, clientSecret, redirectUri } = req.body;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(400).json({ error: 'clientId, clientSecret, and redirectUri are required' });
    }

    const settings = JSON.stringify({ clientId, clientSecret, redirectUri });

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'gitlab_oauth_app' },
    });

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'gitlab_oauth_app', token: '', settings },
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'GITLAB_OAUTH_APP_CONFIGURED',
        resource: 'gitlab_oauth_app',
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[gitlab-oauth] Config save error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /config — remove GitLab OAuth app credentials ──

router.delete('/config', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'gitlab_oauth_app' },
    });

    if (existing) {
      await prisma.integrationConfig.delete({ where: { id: existing.id } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[gitlab-oauth] Config delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /install — redirect user to GitLab OAuth authorization page ──

router.get('/install', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  const oauthConfig = await getGitLabOAuthConfigForOrg(req.user!.orgId);

  if (!oauthConfig.configured) {
    return res.status(500).json({
      error: 'GitLab OAuth not configured. Add your GitLab Application credentials in Settings or set GITLAB_APP_ID, GITLAB_APP_SECRET, and GITLAB_APP_REDIRECT_URI environment variables.',
    });
  }

  // Determine GitLab instance URL from org's existing integration or default to gitlab.com
  let gitlabBaseUrl = 'https://gitlab.com';
  const existing = await prisma.integrationConfig.findFirst({
    where: { orgId: req.user!.orgId, provider: 'gitlab' },
  });
  if (existing?.baseUrl) {
    gitlabBaseUrl = getGitLabOAuthBaseUrl(existing.baseUrl);
  }

  // Create signed state token (CSRF protection + org association)
  const state = jwt.sign(
    { orgId: req.user!.orgId, userId: req.user!.id },
    JWT_SECRET,
    { expiresIn: '15m' },
  );

  console.log('[gitlab-oauth] Install config:', JSON.stringify({ clientId: oauthConfig.clientId, redirectUri: oauthConfig.redirectUri, gitlabBaseUrl }));

  const authorizeUrl = `${gitlabBaseUrl}/oauth/authorize?` + new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: oauthConfig.redirectUri,
    response_type: 'code',
    state,
    scope: 'api',
  }).toString();

  console.log('[gitlab-oauth] Full authorize URL:', authorizeUrl);
  res.json({ authorizeUrl });
});

// ── GET /callback — GitLab redirects here after OAuth authorization ──

router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('[gitlab-oauth] Authorization error:', error, error_description);
      return res.redirect(`/settings?tab=integrations&gitlab_oauth=error&msg=${encodeURIComponent(String(error_description || error))}`);
    }

    if (!state) {
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=missing_state');
    }

    // Verify state token
    let statePayload: { orgId: string; userId: string };
    try {
      statePayload = jwt.verify(state as string, JWT_SECRET) as { orgId: string; userId: string };
    } catch {
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=invalid_state');
    }

    if (!code) {
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=no_code');
    }

    // Resolve OAuth config for this org
    const oauthConfig = await getGitLabOAuthConfigForOrg(statePayload.orgId);
    if (!oauthConfig.configured) {
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=oauth_not_configured');
    }

    // Determine GitLab instance URL
    let gitlabBaseUrl = 'https://gitlab.com';
    const existingConfig = await prisma.integrationConfig.findFirst({
      where: { orgId: statePayload.orgId, provider: 'gitlab' },
    });
    if (existingConfig?.baseUrl) {
      gitlabBaseUrl = getGitLabOAuthBaseUrl(existingConfig.baseUrl);
    }

    // Exchange authorization code for tokens
    let tokenResult: { access_token: string; refresh_token: string; expires_in: number; created_at: number };
    try {
      tokenResult = await exchangeGitLabOAuthCode(code as string, gitlabBaseUrl, oauthConfig);
    } catch (err: any) {
      console.error('[gitlab-oauth] Token exchange failed:', err.message);
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=token_exchange_failed');
    }

    // Fetch user info to store username
    let username = '';
    try {
      const apiBase = existingConfig?.baseUrl || 'https://gitlab.com/api/v4';
      const userRes = await fetch(`${apiBase}/user`, {
        headers: { Authorization: `Bearer ${tokenResult.access_token}` },
      });
      if (userRes.ok) {
        const userData = (await userRes.json()) as { username: string };
        username = userData.username;
      }
    } catch { /* non-fatal */ }

    const tokenExpiresAt = new Date((tokenResult.created_at + tokenResult.expires_in) * 1000).toISOString();

    // Upsert IntegrationConfig
    const existingSettings = existingConfig
      ? (() => { try { return JSON.parse(existingConfig.settings); } catch { return {}; } })()
      : {};

    const settings = {
      postChecks: true,
      postComments: true,
      checkOnReview: true,
      ...existingSettings,
      refreshToken: tokenResult.refresh_token,
      tokenExpiresAt,
      oauthUsername: username,
    };

    if (existingConfig) {
      await prisma.integrationConfig.update({
        where: { id: existingConfig.id },
        data: {
          token: tokenResult.access_token,
          authType: 'gitlab_oauth',
          settings: JSON.stringify(settings),
        },
      });
    } else {
      await prisma.integrationConfig.create({
        data: {
          orgId: statePayload.orgId,
          provider: 'gitlab',
          token: tokenResult.access_token,
          authType: 'gitlab_oauth',
          baseUrl: 'https://gitlab.com/api/v4',
          settings: JSON.stringify(settings),
        },
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: statePayload.orgId,
        userId: statePayload.userId,
        action: 'GITLAB_OAUTH_CONNECTED',
        resource: 'gitlab',
        metadata: JSON.stringify({ username }),
      },
    });

    // Check if Solo user to redirect to repos page
    const callbackUser = await prisma.user.findUnique({ where: { id: statePayload.userId }, select: { accountType: true } });
    const successRedirect = callbackUser?.accountType === 'developer' ? '/repos?gitlab_oauth=success' : '/settings?tab=integrations&gitlab_oauth=success';
    res.redirect(successRedirect);
  } catch (err) {
    console.error('[gitlab-oauth] Callback error:', err);
    res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=unexpected');
  }
});

// ── GET /status — check GitLab OAuth status ──

router.get('/status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.user!.orgId;
    const oauthConfig = await getGitLabOAuthConfigForOrg(orgId);

    const config = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'gitlab' },
    });

    const authType = (config as any)?.authType || 'pat';

    if (!config || authType !== 'gitlab_oauth') {
      return res.json({
        connected: false,
        authType: config ? authType : null,
        serverConfigured: oauthConfig.configured,
      });
    }

    let settings: any = {};
    try { settings = JSON.parse(config.settings); } catch { /* */ }

    res.json({
      connected: true,
      authType: 'gitlab_oauth',
      serverConfigured: oauthConfig.configured,
      username: settings.oauthUsername || null,
    });
  } catch (err) {
    console.error('[gitlab-oauth] Status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /test — test GitLab OAuth connection ──

router.post('/test', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider: 'gitlab' },
    });

    if (!config || (config as any).authType !== 'gitlab_oauth') {
      return res.status(404).json({ error: 'No GitLab OAuth integration found' });
    }

    // Get valid token (auto-refresh if expired)
    const token = await getValidGitLabOAuthToken({ ...config, orgId: req.user!.orgId });
    const apiBase = config.baseUrl || 'https://gitlab.com/api/v4';
    const result = await testGitLabConnection(token, apiBase, 'gitlab_oauth');

    res.json(result);
  } catch (err: any) {
    console.error('[gitlab-oauth] Test error:', err);
    console.error('[gitlab-oauth] Test error detail:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /disconnect — revoke GitLab OAuth and revert to PAT or remove ──

router.post('/disconnect', requireAuth, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider: 'gitlab' },
    });

    if (!config || (config as any).authType !== 'gitlab_oauth') {
      return res.status(404).json({ error: 'No GitLab OAuth integration found' });
    }

    // Try to revoke the token on GitLab
    try {
      const oauthConfig = await getGitLabOAuthConfigForOrg(req.user!.orgId);
      const gitlabBaseUrl = getGitLabOAuthBaseUrl(config.baseUrl || 'https://gitlab.com/api/v4');
      if (oauthConfig.configured) {
        await fetch(`${gitlabBaseUrl}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            token: config.token,
          }),
        });
      }
    } catch (err) {
      console.error('[gitlab-oauth] Token revocation failed (non-fatal):', err);
    }

    // Delete the integration (user can re-add via PAT or OAuth)
    await prisma.integrationConfig.delete({ where: { id: config.id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'GITLAB_OAUTH_DISCONNECTED',
        resource: 'gitlab',
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[gitlab-oauth] Disconnect error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
