import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { createAgentVersion } from '../services/versioning.js';

const router = Router();
router.use(requireAuth);

// GET / — list agents for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const agents = await prisma.agent.findMany({
      where: { orgId: req.user!.orgId },
      include: {
        _count: { select: { sessions: true, versions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(agents);
  } catch (err) {
    console.error('List agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create agent (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, slug, description, model, systemPrompt, securityRulesEnabled, securityRules, allowedTools, maxCostPerSession, maxTokensPerSession, permissions } = req.body;

    if (!name || !slug || !model) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, model' });
    }

    // Check for duplicate slug within the org
    const existingAgent = await prisma.agent.findFirst({
      where: { orgId: req.user!.orgId, slug },
    });
    if (existingAgent) {
      return res.status(409).json({ error: `Agent with slug '${slug}' already exists in this organization.` });
    }

    const agent = await prisma.agent.create({
      data: {
        orgId: req.user!.orgId,
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
      },
    });

    await createAgentVersion(agent.id, req.user!.id, 'CREATED');

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
    const orgId = req.user!.orgId;

    const allAgents = await prisma.agent.findMany({
      where: { orgId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
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
      where: { id, orgId: req.user!.orgId },
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

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.user!.orgId },
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

    const agent = await prisma.agent.update({
      where: { id },
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

    await createAgentVersion(id, req.user!.id, changeType);

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
      where: { id, orgId: req.user!.orgId },
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

    const snapshot = JSON.parse(version.snapshot);

    // Restore agent fields from snapshot
    const agent = await prisma.agent.update({
      where: { id },
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

    // Create a new version for this restore action
    await createAgentVersion(id, req.user!.id, 'RESTORED');

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.agent.findFirst({
      where: { id, orgId: req.user!.orgId },
      include: { _count: { select: { sessions: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
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

    await prisma.agent.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
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
    const agent = await prisma.agent.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const versions = await prisma.agentVersion.findMany({
      where: { agentId: id },
      orderBy: { version: 'desc' },
    });

    res.json({
      versions: versions.map(v => ({
        ...v,
        snapshot: JSON.parse(v.snapshot),
      })),
      total: versions.length,
    });
  } catch (err) {
    console.error('List agent versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
