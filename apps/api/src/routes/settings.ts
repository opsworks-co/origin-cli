import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
import { getBudgetConfig, saveBudgetConfig, getMonthlySpend, getDailySpend, getSpendByModel, getSpendByUser, getSpend } from '../services/budget.js';
import { sendTestEmail, sendWeeklyDigest, generateWeeklyDigestData } from '../services/email.js';
import { buildWeeklyDigestHTML } from '../services/email-templates.js';
import { recomputeOrgSessionCosts } from '../services/cost-recompute.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);



// GET /api/settings/api-keys (ADMIN+ only)
// Lists API keys for the active org. Admins see every key (so they can
// audit and revoke); members see only their own keys (so the Settings →
// API Keys page works for them too — they need to view, name, and delete
// their own CLI tokens). Without this scope the page returned 403 on load
// for any non-admin member.
router.get('/api-keys', async (req: AuthRequest, res: Response) => {
  try {
    const callerRole = (req.activeRole || '').toUpperCase();
    const isAdmin = callerRole === 'OWNER' || callerRole === 'ADMIN';
    const where: { orgId: string; userId?: string } = { orgId: req.activeOrgId! };
    if (!isAdmin) where.userId = req.user!.id;
    const keys = await prisma.apiKey.findMany({
      where,
      select: {
        id: true, name: true, keyPrefix: true, createdAt: true,
        userId: true, role: true,
        user: { select: { name: true, email: true } },
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(keys.map((k) => ({
      ...k,
      repoScopes: k.repoScopes.map((s) => ({ repoId: s.repo.id, repoName: s.repo.name })),
      agentScopes: k.agentScopes.map((s) => ({ agentId: s.agent.id, agentName: s.agent.name, agentSlug: s.agent.slug })),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/api-keys (ADMIN+ only)
// Note: deliberately *not* gated by requireRole('ADMIN') — members of any
// role need to be able to create CLI keys for themselves, which is what
// solo dev workflows and team members onboarding both rely on. Admin
// privilege is enforced *only* when the caller is targeting another user.
router.post('/api-keys', async (req: AuthRequest, res: Response) => {
  try {
    const { name, role, repoIds, agentIds, targetUserId } = req.body;

    // Validate role if provided (standalone key)
    const validRoles = ['VIEWER', 'MEMBER', 'ADMIN'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be VIEWER, MEMBER, or ADMIN.' });
    }

    // Resolve who this key is for. By default it's the caller — every
    // member can mint their own CLI key. Admins (OWNER/ADMIN) may also
    // issue keys on behalf of *other* members in the same org via
    // `targetUserId` — the IAM "Generate Key for <member>" flow.
    let ownerUserId = req.user!.id;
    if (typeof targetUserId === 'string' && targetUserId.length > 0 && targetUserId !== req.user!.id) {
      const callerRole = (req.activeRole || '').toUpperCase();
      if (callerRole !== 'OWNER' && callerRole !== 'ADMIN') {
        return res.status(403).json({ error: 'Only admins can issue keys on behalf of other members' });
      }
      const targetMembership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: targetUserId, orgId: req.activeOrgId! } },
        select: { userId: true },
      });
      if (!targetMembership) {
        return res.status(404).json({ error: 'Target user is not a member of this organization' });
      }
      ownerUserId = targetMembership.userId;
    }

    // Only admins can mint keys with elevated `role` (a "standalone" key
    // that escalates beyond the caller's own permission level). Members
    // creating their own keys must use a member-level (or null) role.
    if (role && role !== 'MEMBER' && role !== 'VIEWER') {
      const callerRole = (req.activeRole || '').toUpperCase();
      if (callerRole !== 'OWNER' && callerRole !== 'ADMIN') {
        return res.status(403).json({ error: 'Only admins can mint elevated-role keys' });
      }
    }

    // DoS caps on scope arrays — nobody legitimately scopes a key to
    // 10k+ repos/agents, and without caps a client can force huge
    // validation queries and createMany batches.
    const MAX_SCOPE_ITEMS = 500;
    if (Array.isArray(repoIds) && repoIds.length > MAX_SCOPE_ITEMS) {
      return res.status(400).json({ error: `repoIds cannot exceed ${MAX_SCOPE_ITEMS} items` });
    }
    if (Array.isArray(agentIds) && agentIds.length > MAX_SCOPE_ITEMS) {
      return res.status(400).json({ error: `agentIds cannot exceed ${MAX_SCOPE_ITEMS} items` });
    }

    // Validate repoIds belong to this org
    if (repoIds && Array.isArray(repoIds) && repoIds.length > 0) {
      const validRepos = await prisma.repo.findMany({
        where: { orgId: req.activeOrgId!, id: { in: repoIds } },
        select: { id: true },
      });
      if (validRepos.length !== repoIds.length) {
        return res.status(400).json({ error: 'One or more repos do not belong to your organization' });
      }
    }

    // Validate agentIds belong to this org
    if (agentIds && Array.isArray(agentIds) && agentIds.length > 0) {
      const validAgents = await prisma.agent.findMany({
        where: { orgId: req.activeOrgId!, id: { in: agentIds } },
        select: { id: true },
      });
      if (validAgents.length !== agentIds.length) {
        return res.status(400).json({ error: 'One or more agents do not belong to your organization' });
      }
    }

    const rawKey = 'org_sk_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 14);

    // Link key to the resolved owner — current user by default, or the
    // targeted member when an admin uses the "Generate Key for <member>" flow.
    const key = await prisma.apiKey.create({
      data: {
        orgId: req.activeOrgId!,
        userId: ownerUserId,
        name: name || 'API Key',
        keyHash,
        keyPrefix,
        role: role || null,
        repoScopes: {
          create: (repoIds && Array.isArray(repoIds) ? repoIds : []).map((repoId: string) => ({ repoId })),
        },
        agentScopes: {
          create: (agentIds && Array.isArray(agentIds) ? agentIds : []).map((agentId: string) => ({ agentId })),
        },
      },
      include: {
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
    });

    res.json({
      id: key.id, name: key.name, keyPrefix: key.keyPrefix, key: rawKey, role: key.role, createdAt: key.createdAt,
      repoScopes: key.repoScopes.map((s) => ({ repoId: s.repo.id, repoName: s.repo.name })),
      agentScopes: key.agentScopes.map((s) => ({ agentId: s.agent.id, agentName: s.agent.name, agentSlug: s.agent.slug })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/api-keys/:id — update agent/repo scopes on an existing key.
// Members can update their *own* keys (rename/scope a CLI token they minted);
// admins can update any key in the org. Without the self-update path,
// non-admin members hit "Forbidden: insufficient permissions" trying to
// manage the keys they created themselves.
router.put('/api-keys/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { agentIds, repoIds } = req.body;

    // Same DoS cap as POST /api-keys.
    const MAX_SCOPE_ITEMS = 500;
    if (Array.isArray(repoIds) && repoIds.length > MAX_SCOPE_ITEMS) {
      return res.status(400).json({ error: `repoIds cannot exceed ${MAX_SCOPE_ITEMS} items` });
    }
    if (Array.isArray(agentIds) && agentIds.length > MAX_SCOPE_ITEMS) {
      return res.status(400).json({ error: `agentIds cannot exceed ${MAX_SCOPE_ITEMS} items` });
    }

    const key = await prisma.apiKey.findFirst({ where: { id, orgId: req.activeOrgId! } });
    if (!key) return res.status(404).json({ error: 'API key not found' });

    const callerRole = (req.activeRole || '').toUpperCase();
    const isAdmin = callerRole === 'OWNER' || callerRole === 'ADMIN';
    if (!isAdmin && key.userId !== req.user!.id) {
      return res.status(403).json({ error: 'You can only update your own API keys' });
    }

    // Update agent scopes if provided
    if (agentIds !== undefined && Array.isArray(agentIds)) {
      if (agentIds.length > 0) {
        const validAgents = await prisma.agent.findMany({
          where: { orgId: req.activeOrgId!, id: { in: agentIds } },
          select: { id: true },
        });
        if (validAgents.length !== agentIds.length) {
          return res.status(400).json({ error: 'One or more agents do not belong to your organization' });
        }
      }
      await prisma.apiKeyAgentScope.deleteMany({ where: { apiKeyId: id } });
      if (agentIds.length > 0) {
        await prisma.apiKeyAgentScope.createMany({
          data: agentIds.map((agentId: string) => ({ apiKeyId: id, agentId })),
        });
      }
    }

    // Update repo scopes if provided
    if (repoIds !== undefined && Array.isArray(repoIds)) {
      if (repoIds.length > 0) {
        const validRepos = await prisma.repo.findMany({
          where: { orgId: req.activeOrgId!, id: { in: repoIds } },
          select: { id: true },
        });
        if (validRepos.length !== repoIds.length) {
          return res.status(400).json({ error: 'One or more repos do not belong to your organization' });
        }
      }
      await prisma.apiKeyRepoScope.deleteMany({ where: { apiKeyId: id } });
      if (repoIds.length > 0) {
        await prisma.apiKeyRepoScope.createMany({
          data: repoIds.map((repoId: string) => ({ apiKeyId: id, repoId })),
        });
      }
    }

    // Return updated key
    const updated = await prisma.apiKey.findUnique({
      where: { id },
      include: {
        repoScopes: { include: { repo: { select: { id: true, name: true } } } },
        agentScopes: { include: { agent: { select: { id: true, name: true, slug: true } } } },
      },
    });

    res.json({
      id: updated!.id,
      repoScopes: updated!.repoScopes.map((s) => ({ repoId: s.repo.id, repoName: s.repo.name })),
      agentScopes: updated!.agentScopes.map((s) => ({ agentId: s.agent.id, agentName: s.agent.name, agentSlug: s.agent.slug })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/settings/api-keys/:id — members can revoke their own keys
// (a lost laptop is the user's problem to fix immediately, not a ticket
// for an admin); admins can revoke any key in the org.
router.delete('/api-keys/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const callerRole = (req.activeRole || '').toUpperCase();
    const isAdmin = callerRole === 'OWNER' || callerRole === 'ADMIN';
    const where = isAdmin
      ? { id, orgId: req.activeOrgId! }
      : { id, orgId: req.activeOrgId!, userId: req.user!.id };
    const result = await prisma.apiKey.deleteMany({ where });
    if (result.count === 0) {
      return res.status(403).json({ error: 'You can only revoke your own API keys' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Budget / Cost Controls ──────────────────────────────────────────────────

// GET /api/settings/budget — get budget config + current spend.
// Returns daily/weekly/monthly totals so the UI can show all three at a
// glance without three round-trips.
router.get('/budget', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const [config, daily, weekly, monthly, dailySpend, spendByModel, spendByUser] = await Promise.all([
      getBudgetConfig(orgId),
      getSpend(orgId, 'daily'),
      getSpend(orgId, 'weekly'),
      getMonthlySpend(orgId),
      getDailySpend(orgId),
      getSpendByModel(orgId),
      getSpendByUser(orgId),
    ]);

    // The "current period" spend is whichever period the org has configured.
    const periodSpend = config.period === 'daily' ? daily : config.period === 'weekly' ? weekly : monthly;
    const percentage = config.monthlyLimit > 0 ? (periodSpend / config.monthlyLimit) * 100 : 0;

    res.json({
      config,
      currentSpend: {
        // legacy: kept for clients that read .monthly directly. Now reflects
        // whatever period is active so existing UI keeps showing the right
        // number against the limit; new UI should prefer .period[period].
        monthly: periodSpend,
        percentage,
        period: config.period,
        byPeriod: { daily, weekly, monthly },
        dailySpend,
        byModel: spendByModel,
        byUser: spendByUser,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/budget — update budget config. Admin-only because it
// changes a control that gates every member's session starts.
router.put('/budget', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { monthlyLimit, alertThresholds, blockOnExceed, period, caps } = req.body;
    const config = await saveBudgetConfig(req.activeOrgId!, {
      ...(monthlyLimit !== undefined && { monthlyLimit }),
      ...(alertThresholds !== undefined && { alertThresholds }),
      ...(blockOnExceed !== undefined && { blockOnExceed }),
      ...(period !== undefined && { period }),
      ...(caps !== undefined && { caps }),
      alertedAt: [], // Reset alerts when config changes
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'BUDGET_UPDATED',
        resource: 'budget',
        metadata: JSON.stringify({ monthlyLimit, alertThresholds, blockOnExceed, period, caps }),
      },
    });

    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Organization Settings ───────────────────────────────────────────────────

// GET /api/settings/org — get org details
router.get('/org', async (req: AuthRequest, res: Response) => {
  try {
    const org = await prisma.org.findUnique({
      where: { id: req.activeOrgId! },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { memberships: true, repos: true, agents: true, policies: true } },
      },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ org });
  } catch (err) {
    console.error('Get org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/org — update org settings (admin/owner only)
router.put('/org', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const { name, slug } = req.body;

    if (!name && !slug) {
      return res.status(400).json({ error: 'At least one field (name or slug) is required' });
    }

    // Validate slug format
    if (slug) {
      const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
      if (slug.length < 2 || slug.length > 48 || !slugRegex.test(slug)) {
        return res.status(400).json({
          error: 'Slug must be 2-48 characters, lowercase alphanumeric with hyphens, and cannot start/end with a hyphen',
        });
      }

      // Check slug uniqueness (exclude current org)
      const existing = await prisma.org.findFirst({
        where: { slug, id: { not: orgId } },
      });
      if (existing) {
        return res.status(409).json({ error: 'This slug is already taken' });
      }
    }

    // Validate name
    if (name && (name.length < 1 || name.length > 100)) {
      return res.status(400).json({ error: 'Organization name must be 1-100 characters' });
    }

    const updateData: any = {};
    if (name) updateData.name = name.trim();
    if (slug) updateData.slug = slug.trim().toLowerCase();

    const org = await prisma.org.update({
      where: { id: orgId },
      data: updateData,
    });

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'ORG_UPDATED',
        resource: 'org',
        metadata: JSON.stringify({ name: org.name, slug: org.slug }),
      },
    });

    res.json({ org });
  } catch (err) {
    console.error('Update org error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── AI Chat Configuration ────────────────────────────────────────────────────

// GET /api/settings/chat — get chat config
router.get('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'llm' },
    });

    if (!config) {
      return res.json({
        configured: false,
        llmProvider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        hasKey: !!process.env.ANTHROPIC_API_KEY,
        source: process.env.ANTHROPIC_API_KEY ? 'environment' : 'none',
      });
    }

    let settings: Record<string, any> = {};
    try { settings = JSON.parse(config.settings); } catch (err) {
      console.warn('[settings] malformed config.settings JSON:', (err as Error).message);
    }

    res.json({
      configured: true,
      llmProvider: settings.llmProvider || 'anthropic',
      model: settings.model || 'claude-sonnet-4-20250514',
      hasKey: true,
      source: 'org',
    });
  } catch (err) {
    console.error('Get chat config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Valid models per provider
const VALID_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-5-20251001',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'o3',
    'o3-mini',
    'o4-mini',
  ],
  google: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
  ],
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
};

const VALID_PROVIDERS = ['anthropic', 'openai', 'google'];

// PUT /api/settings/chat — save chat config
router.put('/chat', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const { apiKey, model, llmProvider } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const provider = VALID_PROVIDERS.includes(llmProvider) ? llmProvider : 'anthropic';
    const providerModels = VALID_MODELS[provider] || VALID_MODELS.anthropic;
    const selectedModel = providerModels.includes(model) ? model : (DEFAULT_MODELS[provider] || providerModels[0]);

    const settings = JSON.stringify({ model: selectedModel, llmProvider: provider });

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'llm' },
    });

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { token: apiKey, settings },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'llm', token: apiKey, settings },
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: 'CHAT_CONFIG_UPDATED',
        resource: 'llm',
        metadata: JSON.stringify({ model: selectedModel, llmProvider: provider }),
      },
    });

    res.json({ ok: true, model: selectedModel, llmProvider: provider });
  } catch (err) {
    console.error('Save chat config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/chat/test — test chat config
router.post('/chat/test', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;
    const { apiKey, llmProvider } = req.body;

    const keyToTest = apiKey || (await getOrgLLMKey(orgId)) || process.env.ANTHROPIC_API_KEY;
    if (!keyToTest) {
      return res.status(400).json({ error: 'No API key provided or configured' });
    }

    const provider = llmProvider || (await getOrgLLMProvider(orgId));
    let response: globalThis.Response;

    switch (provider) {
      case 'openai':
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyToTest}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        break;

      case 'google':
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${keyToTest}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 10 },
            }),
          },
        );
        break;

      case 'anthropic':
      default:
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': keyToTest,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        break;
    }

    if (!response.ok) {
      const err = await response.text();
      return res.json({ success: false, error: `API returned ${response.status}` });
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('Settings error:', err);
    res.json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Get the org-level LLM API key, or null if not configured.
 * Exported for use by chat.ts
 */
export async function getOrgLLMKey(orgId: string): Promise<string | null> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'llm' },
  });
  return config?.token || null;
}

export async function getOrgLLMModel(orgId: string): Promise<string> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'llm' },
  });
  if (!config) return 'claude-sonnet-4-20250514';
  try {
    const settings = JSON.parse(config.settings);
    return settings.model || 'claude-sonnet-4-20250514';
  } catch {
    return 'claude-sonnet-4-20250514';
  }
}

export async function getOrgLLMProvider(orgId: string): Promise<'anthropic' | 'openai' | 'google'> {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'llm' },
  });
  if (!config) return 'anthropic';
  try {
    const settings = JSON.parse(config.settings);
    const p = settings.llmProvider;
    if (p === 'openai' || p === 'google') return p;
    return 'anthropic';
  } catch {
    return 'anthropic';
  }
}

// ---- Email Report Settings ------------------------------------------------

// GET /api/settings/email — get email preferences
router.get('/email', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.integrationConfig.findFirst({
      where: { orgId: req.activeOrgId!, provider: 'email' },
    });

    const defaults = { enabled: false, recipients: [] as string[], sendDay: 'monday' };
    if (!config) return res.json(defaults);

    try {
      const settings = JSON.parse(config.settings);
      res.json({ ...defaults, ...settings });
    } catch {
      res.json(defaults);
    }
  } catch (err) {
    console.error('Get email settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/settings/email — save email preferences
router.put('/email', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { enabled, recipients, sendDay } = req.body;
    const orgId = req.activeOrgId!;

    const settings = {
      enabled: enabled ?? false,
      recipients: recipients ?? [],
      sendDay: sendDay ?? 'monday',
    };

    const existing = await prisma.integrationConfig.findFirst({
      where: { orgId, provider: 'email' },
    });

    if (existing) {
      await prisma.integrationConfig.update({
        where: { id: existing.id },
        data: { settings: JSON.stringify(settings) },
      });
    } else {
      await prisma.integrationConfig.create({
        data: { orgId, provider: 'email', token: '', settings: JSON.stringify(settings) },
      });
    }

    res.json(settings);
  } catch (err) {
    console.error('Save email settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/email/test — send a test email
router.post('/email/test', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { to } = req.body;
    const recipient = to || req.activeOrgId!; // Will be resolved to user email

    // Get user email if no explicit recipient
    let email = to;
    if (!email) {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      email = user?.email;
    }

    if (!email) {
      return res.status(400).json({ error: 'No email address provided' });
    }

    const result = await sendTestEmail(email);
    res.json(result);
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Weekly Digest ────────────────────────────────────────────────────────────

// POST /api/settings/send-digest — manually trigger the weekly digest (for testing)
router.post('/send-digest', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const result = await sendWeeklyDigest(req.activeOrgId!);
    res.json(result);
  } catch (err) {
    console.error('Send digest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings/digest-preview — returns the HTML preview without sending
router.get('/digest-preview', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const data = await generateWeeklyDigestData(req.activeOrgId!);
    if (!data) {
      return res.status(404).json({ error: 'Org not found' });
    }
    const html = buildWeeklyDigestHTML(data);
    // Return as HTML so the browser can render it directly
    if (req.query.format === 'json') {
      res.json({ html, data });
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    }
  } catch (err) {
    console.error('Digest preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/recompute-costs — re-derive every session's costUsd
// from the stored token counts using the current pricing table. ADMIN only.
// Pass { dryRun: true } to preview without persisting.
router.post('/recompute-costs', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const result = await recomputeOrgSessionCosts(req.activeOrgId!, { dryRun });
    if (!dryRun && result.updated > 0) {
      await prisma.auditLog.create({
        data: {
          orgId: req.activeOrgId!,
          userId: req.user!.id,
          action: 'COSTS_RECOMPUTED',
          resource: req.activeOrgId!,
          metadata: JSON.stringify({
            scanned: result.scanned,
            updated: result.updated,
            totalBefore: result.totalCostBefore,
            totalAfter: result.totalCostAfter,
          }),
        },
      });
    }
    res.json(result);
  } catch (err: any) {
    console.error('Recompute costs error:', err?.message || err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings/fix-orphaned-keys — assign unlinked keys to current user
router.post('/fix-orphaned-keys', async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.apiKey.updateMany({
      where: { orgId: req.activeOrgId!, userId: null },
      data: { userId: req.user!.id },
    });
    res.json({ updated: result.count });
  } catch (err) {
    console.error('Fix orphaned keys error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

export default router;
