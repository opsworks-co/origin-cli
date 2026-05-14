import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import {
  getGitLabOAuthConfig,
  getGitLabOAuthConfigForOrg,
  getGitLabOAuthBaseUrl,
  exchangeGitLabOAuthCode,
  getValidGitLabOAuthToken,
  testGitLabConnection,
} from '../services/gitlab-integration.js';
import { assertSafeExternalUrl } from '../utils/ssrf-guard.js';

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

router.get('/config', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

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
    try { settings = JSON.parse(dbConfig.settings); } catch (err) {
      console.warn('[gitlab-oauth] malformed dbConfig.settings JSON:', (err as Error).message);
    }

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

router.put('/config', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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

router.delete('/config', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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

router.get('/install', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  const oauthConfig = await getGitLabOAuthConfigForOrg(req.activeOrgId!);

  if (!oauthConfig.configured) {
    return res.status(500).json({
      error: 'GitLab OAuth not configured. Add your GitLab Application credentials in Settings or set GITLAB_APP_ID, GITLAB_APP_SECRET, and GITLAB_APP_REDIRECT_URI environment variables.',
    });
  }

  // Determine GitLab instance URL from org's existing integration or default to gitlab.com
  let gitlabBaseUrl = 'https://gitlab.com';
  const existing = await prisma.integrationConfig.findFirst({
    where: { orgId: req.activeOrgId!, provider: 'gitlab' },
  });
  if (existing?.baseUrl) {
    gitlabBaseUrl = getGitLabOAuthBaseUrl(existing.baseUrl);
  }

  // Create signed state token (CSRF protection + org association)
  const from = (req.query.from as string) || '';
  const flavor = (req.query.flavor as string) || '';
  const state = jwt.sign(
    { orgId: req.activeOrgId!, userId: req.user!.id, from, flavor },
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

// Build an error redirect that lands the user back where they started the
// OAuth flow (onboarding vs settings) instead of always sending them to
// /settings, where the message gets lost mid-onboarding.
function gitlabErrorRedirect(from: string | undefined, msg: string) {
  const enc = encodeURIComponent(msg);
  if (from === 'onboarding') return `/onboarding?step=1&gitlab_oauth=error&msg=${enc}`;
  return `/settings?tab=integrations&gitlab_oauth=error&msg=${enc}`;
}

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
    let statePayload: { orgId: string; userId: string; from?: string; flavor?: string };
    try {
      // Pin HS256 — we sign the state token with HS256 and must reject
      // any other algorithm, including alg=none / key-confusion attacks.
      statePayload = jwt.verify(state as string, JWT_SECRET, { algorithms: ['HS256'] }) as { orgId: string; userId: string; from?: string; flavor?: string };
    } catch {
      return res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=invalid_state');
    }

    if (!code) {
      return res.redirect(gitlabErrorRedirect(statePayload.from, 'GitLab returned no authorization code.'));
    }

    // Resolve OAuth config for this org
    const oauthConfig = await getGitLabOAuthConfigForOrg(statePayload.orgId);
    if (!oauthConfig.configured) {
      return res.redirect(gitlabErrorRedirect(statePayload.from, 'GitLab OAuth is not configured on this Origin instance.'));
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
      console.error('[gitlab-oauth] Token exchange failed:', err.message, {
        redirectUri: oauthConfig.redirectUri,
        clientIdPrefix: oauthConfig.clientId?.slice(0, 12),
        gitlabBaseUrl,
      });
      // GitLab's invalid_grant error is a catch-all (redirect URI mismatch,
      // code already consumed, wrong client, expired). Surface the redirect
      // URI we sent so the user can compare it against the one configured in
      // their GitLab OAuth app — that's the most common cause.
      const rawMsg = err?.message || 'unknown';
      const isInvalidGrant = /invalid_grant/i.test(rawMsg);
      const actionable = isInvalidGrant
        ? `GitLab rejected the authorization. Most common cause: the Redirect URI on your GitLab OAuth app must match exactly: ${oauthConfig.redirectUri}. If you just retried, the previous one-time code is already used — click Connect to start fresh.`
        : `GitLab token exchange failed: ${rawMsg}`;
      return res.redirect(gitlabErrorRedirect(statePayload.from, actionable));
    }

    // Verify the freshly minted OAuth token actually works against this
    // GitLab instance. Previously this check captured the username
    // best-effort and swallowed errors, so a token that couldn't fetch
    // /user (wrong scopes, instance mismatch, etc.) still produced a
    // "Connected" UI even though every downstream call would 401. Now
    // a failed /user call is fatal — we redirect with a real error
    // message instead of a misleading success.
    let username = '';
    {
      const apiBase = existingConfig?.baseUrl || 'https://gitlab.com/api/v4';
      const userUrl = `${apiBase}/user`;
      try {
        assertSafeExternalUrl(userUrl, 'gitlab-oauth.callback.user');
      } catch (err: any) {
        console.error('[gitlab-oauth] Unsafe baseUrl on callback:', err?.message);
        return res.redirect(gitlabErrorRedirect(statePayload.from, 'GitLab API base URL is not reachable from Origin.'));
      }
      // Note: this file's top-level `Response` import is express's
      // response type, so we lean on type inference here for the fetch
      // result rather than annotating with the global Response type.
      let userFetch: Awaited<ReturnType<typeof fetch>>;
      try {
        userFetch = await fetch(userUrl, {
          headers: { Authorization: `Bearer ${tokenResult.access_token}` },
        });
      } catch (err: any) {
        console.error('[gitlab-oauth] /user fetch failed:', err?.message);
        return res.redirect(gitlabErrorRedirect(statePayload.from, 'Could not reach GitLab to verify the new token.'));
      }
      if (!userFetch.ok) {
        const detail = await userFetch.text().catch(() => '');
        console.error(`[gitlab-oauth] /user returned ${userFetch.status}:`, detail.slice(0, 500));
        const msg =
          userFetch.status === 401 || userFetch.status === 403
            ? 'GitLab rejected the new token (insufficient scopes — the OAuth app needs the `api` or `read_api` scope).'
            : `GitLab returned HTTP ${userFetch.status} when verifying the token. Try connecting again.`;
        return res.redirect(gitlabErrorRedirect(statePayload.from, msg));
      }
      try {
        const userData = (await userFetch.json()) as { username: string };
        username = userData.username || '';
      } catch { /* username is metadata only — don't fail the connect over it */ }
    }

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

    // Redirect — onboarding goes back to onboarding; everywhere else lands on
    // /repos with ?gitlab_oauth=success which the Repos page picks up to
    // auto-open the import dialog. Settings callers explicitly pass
    // from=settings if they want to stay on Settings after install.
    let successRedirect: string;
    if (statePayload.from === 'onboarding') {
      const flavorParam = statePayload.flavor ? `&from=${encodeURIComponent(statePayload.flavor)}` : '';
      successRedirect = `/onboarding?step=1&gitlab_oauth=success${flavorParam}`;
    } else if (statePayload.from === 'settings') {
      successRedirect = '/settings?tab=integrations&gitlab_oauth=success';
    } else {
      successRedirect = '/repos?gitlab_oauth=success&import=open';
    }
    res.redirect(successRedirect);
  } catch (err) {
    console.error('[gitlab-oauth] Callback error:', err);
    res.redirect('/settings?tab=integrations&gitlab_oauth=error&msg=unexpected');
  }
});

// ── GET /status — check GitLab OAuth status ──

router.get('/status', requireAuth, resolveOrgContext, async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
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

router.post('/test', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.activeOrgId!, provider: 'gitlab' },
    });

    if (!config || (config as any).authType !== 'gitlab_oauth') {
      return res.status(404).json({ error: 'No GitLab OAuth integration found' });
    }

    // Get valid token (auto-refresh if expired)
    const token = await getValidGitLabOAuthToken({ ...config, orgId: req.activeOrgId! });
    const apiBase = config.baseUrl || 'https://gitlab.com/api/v4';
    assertSafeExternalUrl(apiBase, 'gitlab-oauth.test');
    const result = await testGitLabConnection(token, apiBase, 'gitlab_oauth');

    res.json(result);
  } catch (err: any) {
    console.error('[gitlab-oauth] Test error:', err);
    console.error('[gitlab-oauth] Test error detail:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /disconnect — revoke GitLab OAuth and revert to PAT or remove ──

router.post('/disconnect', requireAuth, resolveOrgContext, requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.activeOrgId!, provider: 'gitlab' },
    });

    if (!config || (config as any).authType !== 'gitlab_oauth') {
      return res.status(404).json({ error: 'No GitLab OAuth integration found' });
    }

    // Try to revoke the token on GitLab
    try {
      const oauthConfig = await getGitLabOAuthConfigForOrg(req.activeOrgId!);
      const gitlabBaseUrl = getGitLabOAuthBaseUrl(config.baseUrl || 'https://gitlab.com/api/v4');
      const revokeUrl = `${gitlabBaseUrl}/oauth/revoke`;
      assertSafeExternalUrl(revokeUrl, 'gitlab-oauth.disconnect');
      if (oauthConfig.configured) {
        await fetch(revokeUrl, {
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
        orgId: req.activeOrgId!,
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
