import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { testGitHubConnection } from '../services/github-integration.js';
import { testGitHubAppConnection } from '../services/github-app.js';
import { testGitLabConnection } from '../services/gitlab-integration.js';
import { testSlackWebhook } from '../services/slack.js';
import { checkSafeExternalUrl } from '../utils/ssrf-guard.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// GET / — list org integrations (ADMIN+ only, never expose tokens)
router.get('/', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const integrations = await prisma.integrationConfig.findMany({
      where: { orgId: req.activeOrgId! },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      integrations.map((i) => ({
        id: i.id,
        provider: i.provider,
        baseUrl: i.baseUrl,
        settings: safeParseJSON(i.settings),
        hasToken: !!i.token,
        authType: (i as any).authType || 'pat',
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
    );
  } catch (err) {
    console.error('List integrations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create integration (ADMIN+)
router.post('/', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { provider, token, baseUrl, settings } = req.body;

    if (!provider || !token) {
      return res.status(400).json({ error: 'Missing required fields: provider, token' });
    }

    if (!['github', 'gitlab', 'slack'].includes(provider)) {
      return res.status(400).json({ error: 'Provider must be "github", "gitlab", or "slack"' });
    }

    // SSRF guard: reject baseUrls that point at private/loopback/link-local
    // addresses. Enterprise self-hosted GitHub/GitLab is a legitimate use
    // case, so we can't hard-allowlist the SaaS domains — we instead block
    // the specific ranges that turn this integration into an SSRF primitive
    // (e.g. http://169.254.169.254 → cloud metadata, http://localhost →
    // internal services on the same fly machine).
    if (baseUrl) {
      const urlCheck = checkSafeExternalUrl(baseUrl);
      if (!urlCheck.ok) {
        return res.status(400).json({ error: `Invalid baseUrl: ${urlCheck.reason}` });
      }
    }

    // Check for existing integration of same provider
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: req.activeOrgId!, provider },
    });
    if (existing) {
      return res.status(409).json({ error: `A ${provider} integration already exists. Update or delete it first.` });
    }

    const integration = await prisma.integrationConfig.create({
      data: {
        orgId: req.activeOrgId!,
        provider,
        token,
        baseUrl: baseUrl || '',
        settings: settings ? JSON.stringify(settings) : '{}',
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'INTEGRATION_CREATED',
        resource: integration.id,
        metadata: JSON.stringify({ provider }),
      },
    });

    res.status(201).json({
      id: integration.id,
      provider: integration.provider,
      baseUrl: integration.baseUrl,
      settings: safeParseJSON(integration.settings),
      hasToken: true,
      authType: (integration as any).authType || 'pat',
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    });
  } catch (err) {
    console.error('Create integration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update integration (ADMIN+)
router.put('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { token, baseUrl, settings } = req.body;

    const existing = await prisma.integrationConfig.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Validate any new baseUrl before persisting — see SSRF comment on POST.
    if (baseUrl !== undefined && baseUrl !== '') {
      const urlCheck = checkSafeExternalUrl(baseUrl);
      if (!urlCheck.ok) {
        return res.status(400).json({ error: `Invalid baseUrl: ${urlCheck.reason}` });
      }
    }

    const data: any = {};
    if (token !== undefined) data.token = token;
    if (baseUrl !== undefined) data.baseUrl = baseUrl;
    if (settings !== undefined) data.settings = JSON.stringify(settings);

    // Defense-in-depth: scope by orgId in the update itself.
    const updateResult = await prisma.integrationConfig.updateMany({
      where: { id, orgId: req.activeOrgId! },
      data,
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: 'Integration not found' });
    }
    const integration = await prisma.integrationConfig.findUnique({ where: { id } });
    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'INTEGRATION_UPDATED',
        resource: id,
        metadata: JSON.stringify({ provider: integration.provider }),
      },
    });

    res.json({
      id: integration.id,
      provider: integration.provider,
      baseUrl: integration.baseUrl,
      settings: safeParseJSON(integration.settings),
      hasToken: !!integration.token,
      authType: (integration as any).authType || 'pat',
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    });
  } catch (err) {
    console.error('Update integration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete integration (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.integrationConfig.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Use deleteMany with an orgId scope instead of delete({ where: { id } }).
    // The precheck above already enforces org ownership, but belt-and-suspenders:
    // if a future refactor drops or reorders that check, a plain delete by id
    // would silently become an IDOR (attacker in org A deletes integrations
    // from org B by guessing UUIDs). deleteMany with a compound where makes
    // the authorization boundary explicit at the DB call itself.
    const deleted = await prisma.integrationConfig.deleteMany({
      where: { id, orgId: req.activeOrgId! },
    });
    if (deleted.count === 0) {
      // Lost a race (deleted between precheck and delete) or authz drift.
      return res.status(404).json({ error: 'Integration not found' });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'INTEGRATION_DELETED',
        resource: id,
        metadata: JSON.stringify({ provider: existing.provider }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete integration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/test — test connection (ADMIN+)
router.post('/:id/test', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const integration = await prisma.integrationConfig.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    if (integration.provider === 'github') {
      const apiBase = integration.baseUrl || 'https://api.github.com';
      try {
        const check = checkSafeExternalUrl(apiBase);
        if (!check.ok) return res.json({ success: false, error: `Invalid baseUrl: ${check.reason}` });
      } catch {
        return res.json({ success: false, error: 'Invalid baseUrl' });
      }
      const authType = (integration as any).authType || 'pat';

      if (authType === 'github_app') {
        const settings = safeParseJSON(integration.settings);
        if (!settings.appId || !settings.privateKey || !settings.installationId) {
          return res.json({ success: false, error: 'GitHub App credentials incomplete' });
        }
        const result = await testGitHubAppConnection(
          settings.appId,
          settings.privateKey,
          settings.installationId,
          apiBase,
        );
        return res.json(result);
      }

      const result = await testGitHubConnection(integration.token, apiBase);
      res.json(result);
    } else if (integration.provider === 'gitlab') {
      const apiBase = integration.baseUrl || 'https://gitlab.com/api/v4';
      const check = checkSafeExternalUrl(apiBase);
      if (!check.ok) return res.json({ success: false, error: `Invalid baseUrl: ${check.reason}` });
      const result = await testGitLabConnection(integration.token, apiBase);
      res.json(result);
    } else if (integration.provider === 'slack') {
      const result = await testSlackWebhook(integration.token);
      res.json(result);
    } else {
      res.json({ success: false, error: `Testing not supported for ${integration.provider} yet` });
    }
  } catch (err) {
    console.error('Test integration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function safeParseJSON(str: string): Record<string, any> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

export default router;
