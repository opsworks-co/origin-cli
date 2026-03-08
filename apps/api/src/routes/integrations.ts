import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { testGitHubConnection } from '../services/github-integration.js';
import { testGitHubAppConnection } from '../services/github-app.js';

const router = Router();
router.use(requireAuth);

// GET / — list org integrations (never expose tokens)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const integrations = await prisma.integrationConfig.findMany({
      where: { orgId: req.user!.orgId },
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

    if (!['github', 'gitlab'].includes(provider)) {
      return res.status(400).json({ error: 'Provider must be "github" or "gitlab"' });
    }

    // Check for existing integration of same provider
    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId: req.user!.orgId, provider },
    });
    if (existing) {
      return res.status(409).json({ error: `A ${provider} integration already exists. Update or delete it first.` });
    }

    const integration = await prisma.integrationConfig.create({
      data: {
        orgId: req.user!.orgId,
        provider,
        token,
        baseUrl: baseUrl || '',
        settings: settings ? JSON.stringify(settings) : '{}',
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const data: any = {};
    if (token !== undefined) data.token = token;
    if (baseUrl !== undefined) data.baseUrl = baseUrl;
    if (settings !== undefined) data.settings = JSON.stringify(settings);

    const integration = await prisma.integrationConfig.update({
      where: { id },
      data,
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    await prisma.integrationConfig.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
      where: { id, orgId: req.user!.orgId },
    });
    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    if (integration.provider === 'github') {
      const apiBase = integration.baseUrl || 'https://api.github.com';
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
