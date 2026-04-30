import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole, requireAgentAccess } from '../middleware/auth.js';
import { createAgentVersion } from '../services/versioning.js';
import { safeParseObject } from '../utils/safe-json.js';
import { readableAgentIds, type AgentLevel } from '../services/access.js';
import { AGENT_CATALOG, isCatalogSlug } from '../data/agent-catalog.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// Length caps for user-supplied agent fields. Applied on create + update so
// a client can't push multi-MB strings into the DB and bloat every listing
// response. Caps are generous (10KB for prompts) and only reject pathological
// payloads, not legitimate input.
const AGENT_FIELD_LIMITS = {
  name: 200,
  slug: 100,
  description: 2_000,
  model: 100,
  systemPrompt: 10_000,
  securityRules: 10_000,
} as const;
function validateAgentFieldLengths(fields: Record<string, unknown>): string | null {
  for (const [key, limit] of Object.entries(AGENT_FIELD_LIMITS)) {
    const val = fields[key];
    if (val == null) continue;
    if (typeof val !== 'string') {
      return `Field ${key} must be a string`;
    }
    if (val.length > limit) {
      return `Field ${key} exceeds max length of ${limit} characters`;
    }
  }
  return null;
}

// GET / — list agents for org. Same access shape as /repos: non-privileged
// users only see agents they have an explicit AgentMember row for. The
// new Agents page renders cards with month-to-date sessions + spend, so
// we aggregate that in one round-trip per request rather than asking the
// FE to do N follow-up calls.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const accessible = await readableAgentIds(req.user!.id, req.activeOrgId!, req.activeRole);
    const accessFilter = accessible === null ? {} : { id: { in: accessible } };
    const agents = await prisma.agent.findMany({
      where: { orgId: req.activeOrgId!, ...accessFilter },
      include: {
        _count: { select: { sessions: true, versions: true } },
      },
      orderBy: [{ isCustom: 'asc' }, { name: 'asc' }],
      take: 500,
    });

    // Month-to-date stats. groupBy on agentId keeps this O(1) DB calls
    // regardless of how many catalog rows exist.
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const stats = await prisma.codingSession.groupBy({
      by: ['agentId'],
      where: {
        agentId: { in: agents.map((a) => a.id) },
        createdAt: { gte: startOfMonth },
      },
      _count: { _all: true },
      _sum: { costUsd: true },
    });
    const statsByAgent = new Map(stats.map((s) => [s.agentId, s]));

    res.json(agents.map((a) => {
      const s = statsByAgent.get(a.id);
      return {
        ...a,
        sessionsThisMonth: s?._count._all || 0,
        costThisMonth: parseFloat((s?._sum.costUsd || 0).toFixed(2)),
      };
    }));
  } catch (err) {
    console.error('List agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /catalog — static list of agents Origin natively supports.
// Surfaced so the FE can render the same defaults the seeder uses
// without shipping a duplicate copy.
router.get('/catalog', async (_req: AuthRequest, res: Response) => {
  res.json(AGENT_CATALOG);
});

// POST / — create CUSTOM agent (MEMBER+). Catalog slugs are reserved
// for the seeder; admins toggle those, they don't create them.
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug, description, model, systemPrompt, securityRulesEnabled, securityRules, allowedTools, maxCostPerSession, maxTokensPerSession, permissions } = req.body;

    if (!name || !slug || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, model' });
    }

    if (isCatalogSlug(slug)) {
      return res.status(400).json({
        error: `'${slug}' is a built-in agent. Enable it from the Agents page instead of creating a custom one.`,
      });
    }

    // Per-field caps. Without these a client can pass multi-MB strings and
    // bloat the DB + every response that lists agents. 10KB is generous for
    // system prompts; description/name caps are normal form-field sizes.
    const lenErr = validateAgentFieldLengths({ name, slug, description, model, systemPrompt, securityRules });
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
    }

    // Check for duplicate slug within the org
    const existingAgent = await prisma.agent.findFirst({
      where: { orgId: req.activeOrgId!, slug },
    });
    if (existingAgent) {
      return res.status(409).json({ error: `Agent with slug '${slug}' already exists in this organization.` });
    }

    const agent = await prisma.agent.create({
      data: {
        orgId: req.activeOrgId!,
        name,
        slug,
        description: description || null,
        model,
        systemPrompt: systemPrompt || null,
        securityRulesEnabled: securityRulesEnabled === true, // default false
        securityRules: securityRules || null,
        allowedTools: allowedTools ? JSON.stringify(allowedTools) : '[]',
        maxCostPerSession: maxCostPerSession ?? null,
        maxTokensPerSession: maxTokensPerSession ?? null,
        permissions: permissions ? JSON.stringify(permissions) : '{}',
        // Anything created through this endpoint is custom. Catalog rows
        // come from the seeder. Custom agents start enabled — there's no
        // pre-installed disabled state for them, the user just made one.
        isCustom: true,
        isEnabled: true,
      },
    });

    await createAgentVersion(agent.id, req.user!.id, 'CREATED');

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_CREATED',
        resource: agent.id,
        metadata: JSON.stringify({ name, slug, model }),
      },
    });

    res.status(201).json(agent);
  } catch (err) {
    console.error('Create agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /my — agents available to current user (for CLI agent selection)
router.get('/my', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.activeOrgId!;

    const allAgents = await prisma.agent.findMany({
      where: { orgId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      take: 500,
    });
    res.json(allAgents);
  } catch (err) {
    console.error('Get my agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single agent with recent sessions and version count
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const agent = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
      include: {
        sessions: {
          where: { status: 'RUNNING' },
          orderBy: { createdAt: 'desc' },
          include: { commit: true },
        },
        _count: { select: { versions: true } },
      },
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json(agent);
  } catch (err) {
    console.error('Get agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update agent (MEMBER+)
router.put('/:id', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, model, status, systemPrompt, securityRulesEnabled, securityRules, allowedTools, maxCostPerSession, maxTokensPerSession, permissions } = req.body;

    const lenErr = validateAgentFieldLengths({ name, description, model, systemPrompt, securityRules });
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
    }

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Determine change type
    let changeType = 'UPDATED';
    if (status !== undefined && status !== existing.status) {
      changeType = 'STATUS_CHANGED';
    } else if (systemPrompt !== undefined && systemPrompt !== existing.systemPrompt) {
      changeType = 'PROMPT_CHANGED';
    } else if (model !== undefined && model !== existing.model) {
      changeType = 'MODEL_CHANGED';
    } else if (permissions !== undefined || allowedTools !== undefined) {
      changeType = 'PERMISSIONS_CHANGED';
    }

    // Defense in depth: updateMany with compound (id, orgId) so authorization
    // is enforced at the DB call, not just by the precheck above.
    const updateResult = await prisma.agent.updateMany({
      where: { id, orgId: req.activeOrgId! },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(model !== undefined && { model }),
        ...(status !== undefined && { status }),
        ...(systemPrompt !== undefined && { systemPrompt: systemPrompt || null }),
        ...(securityRulesEnabled !== undefined && { securityRulesEnabled: !!securityRulesEnabled }),
        ...(securityRules !== undefined && { securityRules: securityRules || null }),
        ...(allowedTools !== undefined && { allowedTools: JSON.stringify(allowedTools) }),
        ...(maxCostPerSession !== undefined && { maxCostPerSession }),
        ...(maxTokensPerSession !== undefined && { maxTokensPerSession }),
        ...(permissions !== undefined && { permissions: JSON.stringify(permissions) }),
      },
    });
    if (updateResult.count === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const agent = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });

    await createAgentVersion(id, req.user!.id, changeType);

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_UPDATED',
        resource: id,
        metadata: JSON.stringify({ changeType, name, description, model, status }),
      },
    });

    res.json(agent);
  } catch (err) {
    console.error('Update agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/restore/:versionId — restore agent to a previous version (ADMIN+)
router.post('/:id/restore/:versionId', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const versionId = req.params.versionId as string;

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const version = await prisma.agentVersion.findFirst({
      where: { id: versionId, agentId: id },
    });

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    // Safe-parse the snapshot — a malformed snapshot used to crash the
    // whole restore with a raw JSON.parse throw.
    const snapshot = safeParseObject<Record<string, any>>(
      version.snapshot,
      `agentVersion.${version.id}.snapshot`,
    );

    // Restore agent fields from snapshot. updateMany with (id, orgId) to
    // enforce org scope at the DB call itself.
    const restoreResult = await prisma.agent.updateMany({
      where: { id, orgId: req.activeOrgId! },
      data: {
        name: snapshot.name ?? existing.name,
        description: snapshot.description ?? existing.description,
        model: snapshot.model ?? existing.model,
        status: snapshot.status ?? existing.status,
        systemPrompt: snapshot.systemPrompt ?? null,
        securityRulesEnabled: snapshot.securityRulesEnabled ?? existing.securityRulesEnabled,
        securityRules: snapshot.securityRules ?? existing.securityRules,
        allowedTools: snapshot.allowedTools ? JSON.stringify(snapshot.allowedTools) : existing.allowedTools,
        maxCostPerSession: snapshot.maxCostPerSession ?? null,
        maxTokensPerSession: snapshot.maxTokensPerSession ?? null,
        permissions: snapshot.permissions ? JSON.stringify(snapshot.permissions) : existing.permissions,
      },
    });
    if (restoreResult.count === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const agent = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });

    // Create a new version for this restore action
    await createAgentVersion(id, req.user!.id, 'RESTORED');

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_RESTORED',
        resource: id,
        metadata: JSON.stringify({ restoredToVersion: version.version, versionId }),
      },
    });

    res.json(agent);
  } catch (err) {
    console.error('Restore agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete agent (ADMIN+)
// PATCH /:id/toggle — flip the catalog enable/disable switch.
// Admin-only. Works for custom agents too (a custom agent toggled off
// stays in the DB but doesn't show on the main Agents page).
router.patch('/:id/toggle', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must include `enabled: boolean`' });
    }

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
      select: { id: true, name: true, slug: true, isEnabled: true },
    });
    if (!existing) return res.status(404).json({ error: 'Agent not found' });
    if (existing.isEnabled === enabled) {
      return res.json({ id, isEnabled: enabled });
    }

    await prisma.agent.update({
      where: { id },
      data: { isEnabled: enabled },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: enabled ? 'AGENT_ENABLED' : 'AGENT_DISABLED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name, slug: existing.slug }),
      },
    });

    res.json({ id, isEnabled: enabled });
  } catch (err) {
    console.error('Toggle agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.activeOrgId! },
      include: { _count: { select: { sessions: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Catalog agents are immutable rows seeded for every org. Admins
    // disable them via the toggle endpoint; deleting would create the
    // mismatch this whole feature exists to prevent (CLI emits the slug,
    // backend has no row to attribute it to, sessions silently float).
    if (!existing.isCustom) {
      return res.status(400).json({
        error: 'Catalog agents can only be disabled, not deleted. Use the Disable toggle on the Agents page.',
      });
    }

    // Unlink sessions from this agent (don't delete them)
    await prisma.codingSession.updateMany({
      where: { agentId: id },
      data: { agentId: null },
    });

    // Remove agent from policy rules
    await prisma.policyRule.updateMany({
      where: { agentId: id },
      data: { agentId: null },
    });

    // Delete agent versions (FK constraint)
    await prisma.agentVersion.deleteMany({
      where: { agentId: id },
    });

    // deleteMany with compound (id, orgId) enforces authorization at the
    // DB call even if the precheck above is ever dropped in a refactor.
    const deleted = await prisma.agent.deleteMany({
      where: { id, orgId: req.activeOrgId! },
    });
    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name, sessionsUnlinked: existing._count.sessions }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete agent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/versions — list versions for an agent
router.get('/:id/versions', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const agent = await prisma.agent.findFirst({ where: { id, orgId: req.activeOrgId! } });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const versions = await prisma.agentVersion.findMany({
      where: { agentId: id },
      orderBy: { version: 'desc' },
    });

    res.json({
      versions: versions.map(v => ({
        ...v,
        snapshot: safeParseObject(v.snapshot, `agentVersion.${v.id}.snapshot`),
      })),
      total: versions.length,
    });
  } catch (err) {
    console.error('List agent versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Per-model budget overrides (AgentModel) ──────────────────────────────
// Scope every read/write to the calling user's org via Agent.findFirst with
// (id, orgId) before touching AgentModel — same IDOR-safe pattern as
// routes/budget.ts:115. The `:modelKey` is the URL-encoded model string;
// (agentId, model) is the natural unique key, so we don't leak AgentModel
// UUIDs into the URL.

router.get('/:id/models', async (req: AuthRequest, res: Response) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found in your organization' });

    const models = await prisma.agentModel.findMany({
      where: { agentId: agent.id },
      orderBy: { model: 'asc' },
    });
    res.json(models);
  } catch (err) {
    console.error('List agent models error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/models', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found in your organization' });

    const { model, monthlyLimit, tokenLimit, maxCostPerSession, maxTokensPerSession } = req.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'model is required' });
    }
    if (model.length > AGENT_FIELD_LIMITS.model) {
      return res.status(413).json({ error: `model exceeds max length of ${AGENT_FIELD_LIMITS.model}` });
    }

    try {
      const created = await prisma.agentModel.create({
        data: {
          agentId: agent.id,
          model: model.trim(),
          monthlyLimit: typeof monthlyLimit === 'number' && monthlyLimit > 0 ? monthlyLimit : null,
          tokenLimit: typeof tokenLimit === 'number' && tokenLimit > 0 ? tokenLimit : null,
          maxCostPerSession: typeof maxCostPerSession === 'number' && maxCostPerSession > 0 ? maxCostPerSession : null,
          maxTokensPerSession: typeof maxTokensPerSession === 'number' && maxTokensPerSession > 0 ? maxTokensPerSession : null,
        },
      });
      res.json(created);
    } catch (e: any) {
      // Prisma P2002 — unique constraint (agentId, model). Hint the caller to
      // PUT instead of POST so they don't have to reason about which case.
      if (e?.code === 'P2002') {
        return res.status(409).json({ error: 'Model already configured for this agent. PUT to update.' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Create agent model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found in your organization' });

    const model = decodeURIComponent(req.params.modelKey as string);
    const { monthlyLimit, tokenLimit, maxCostPerSession, maxTokensPerSession } = req.body || {};

    // Each field separately optional — a missing key means "leave as is"; an
    // explicit `null` (or 0) means "clear the override / inherit". This
    // matches the inline-edit flow in the UI where one field is changed at a
    // time without resending the whole row.
    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'monthlyLimit')) {
      data.monthlyLimit = typeof monthlyLimit === 'number' && monthlyLimit > 0 ? monthlyLimit : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tokenLimit')) {
      data.tokenLimit = typeof tokenLimit === 'number' && tokenLimit > 0 ? tokenLimit : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'maxCostPerSession')) {
      data.maxCostPerSession = typeof maxCostPerSession === 'number' && maxCostPerSession > 0 ? maxCostPerSession : null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'maxTokensPerSession')) {
      data.maxTokensPerSession = typeof maxTokensPerSession === 'number' && maxTokensPerSession > 0 ? maxTokensPerSession : null;
    }

    try {
      const updated = await prisma.agentModel.update({
        where: { agentId_model: { agentId: agent.id, model } },
        data,
      });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === 'P2025') {
        return res.status(404).json({ error: 'Model not configured for this agent' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Update agent model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found in your organization' });

    const model = decodeURIComponent(req.params.modelKey as string);
    try {
      await prisma.agentModel.delete({
        where: { agentId_model: { agentId: agent.id, model } },
      });
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        return res.status(404).json({ error: 'Model not configured for this agent' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Delete agent model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Agent Member Management ─────────────────────────────────────────────

const VALID_AGENT_LEVELS = ['use', 'admin'] as const;

router.get('/:id/members', requireAgentAccess('use'), async (req: AuthRequest, res: Response) => {
  try {
    const agentId = req.params.id as string;

    const direct = await prisma.agentMember.findMany({
      where: { agentId },
      select: {
        level: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const privileged = await prisma.membership.findMany({
      where: { orgId: req.activeOrgId!, role: { in: ['OWNER', 'ADMIN'] } },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    const directIds = new Set(direct.map((d) => d.user.id));
    const inherited = privileged
      .filter((p) => !directIds.has(p.user.id))
      .map((p) => ({
        ...p.user,
        level: 'admin' as AgentLevel,
        inherited: true,
        orgRole: p.role,
      }));

    res.json({
      members: [
        ...direct.map((d) => ({ ...d.user, level: d.level, inherited: false, grantedAt: d.createdAt })),
        ...inherited,
      ],
    });
  } catch (err) {
    console.error('List agent members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/members/:userId', requireAgentAccess('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const agentId = req.params.id as string;
    const targetUserId = req.params.userId as string;
    const { level } = req.body as { level?: string };

    if (!level || !VALID_AGENT_LEVELS.includes(level as AgentLevel)) {
      return res.status(400).json({ error: 'level must be use | admin' });
    }

    const targetMembership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetUserId, orgId: req.activeOrgId! } },
      select: { role: true },
    });
    if (!targetMembership) {
      return res.status(400).json({ error: 'User is not a member of this org' });
    }
    if (targetMembership.role === 'OWNER' || targetMembership.role === 'ADMIN') {
      return res.status(400).json({
        error: `${targetMembership.role}s have implicit admin on every agent. Change their org role instead.`,
      });
    }

    const row = await prisma.agentMember.upsert({
      where: { userId_agentId: { userId: targetUserId, agentId } },
      update: { level, grantedBy: req.user!.id },
      create: { userId: targetUserId, agentId, level, grantedBy: req.user!.id },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_ACCESS_GRANTED',
        resource: agentId,
        metadata: JSON.stringify({ targetUserId, level }),
      },
    });

    res.json({ userId: row.userId, agentId: row.agentId, level: row.level });
  } catch (err) {
    console.error('Update agent member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/members/:userId', requireAgentAccess('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const agentId = req.params.id as string;
    const targetUserId = req.params.userId as string;

    const { count } = await prisma.agentMember.deleteMany({
      where: { userId: targetUserId, agentId },
    });
    if (count === 0) {
      return res.status(404).json({ error: 'No explicit access on this agent (org admins inherit access)' });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'AGENT_ACCESS_REVOKED',
        resource: agentId,
        metadata: JSON.stringify({ targetUserId }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete agent member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
