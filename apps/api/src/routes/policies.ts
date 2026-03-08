import { Router, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { createPolicyVersion } from '../services/versioning.js';

const router = Router();
router.use(requireAuth);

// GET / — list policies for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const policies = await prisma.policy.findMany({
      where: { orgId: req.user!.orgId },
      include: {
        rules: {
          include: {
            agent: { select: { name: true } },
            machine: { select: { hostname: true } },
            repo: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(policies);
  } catch (err) {
    console.error('List policies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create policy (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Missing required fields: name, type' });
    }

    const policy = await prisma.policy.create({
      data: {
        orgId: req.user!.orgId,
        name,
        description: description || null,
        type,
      },
    });

    await createPolicyVersion(policy.id, req.user!.id, 'CREATED');

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_CREATED',
        resource: policy.id,
        metadata: JSON.stringify({ name, type }),
      },
    });

    res.status(201).json(policy);
  } catch (err) {
    console.error('Create policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update policy (MEMBER+)
router.put('/:id', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, description, type, active } = req.body;

    const existing = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(type !== undefined && { type }),
        ...(active !== undefined && { active }),
      },
    });

    await createPolicyVersion(id, req.user!.id, 'UPDATED');

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_UPDATED',
        resource: id,
        metadata: JSON.stringify({ name, description, type, active }),
      },
    });

    res.json(policy);
  } catch (err) {
    console.error('Update policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete policy and its rules (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Delete rules first, then policy
    await prisma.policyRule.deleteMany({ where: { policyId: id } });
    await prisma.policy.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete policy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/rules — create rule for policy (MEMBER+)
router.post('/:id/rules', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { agentId, machineId, repoId, condition, action, severity } = req.body;

    if (!condition || !action) {
      return res.status(400).json({ error: 'Missing required fields: condition, action' });
    }

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Validate scope IDs belong to the same org
    if (machineId) {
      const machine = await prisma.machine.findFirst({ where: { id: machineId, orgId: req.user!.orgId } });
      if (!machine) return res.status(400).json({ error: 'Machine not found in your organization' });
    }
    if (repoId) {
      const repo = await prisma.repo.findFirst({ where: { id: repoId, orgId: req.user!.orgId } });
      if (!repo) return res.status(400).json({ error: 'Repo not found in your organization' });
    }

    const rule = await prisma.policyRule.create({
      data: {
        policyId: id,
        agentId: agentId || null,
        machineId: machineId || null,
        repoId: repoId || null,
        condition,
        action,
        severity: severity || 'MEDIUM',
      },
      include: {
        agent: { select: { name: true } },
        machine: { select: { hostname: true } },
        repo: { select: { name: true } },
      },
    });

    await createPolicyVersion(id, req.user!.id, 'RULE_ADDED');

    res.status(201).json(rule);
  } catch (err) {
    console.error('Create rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/rules/:ruleId — delete a single rule (ADMIN+)
router.delete('/:id/rules/:ruleId', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const ruleId = (req.params as any).ruleId as string;

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const rule = await prisma.policyRule.findFirst({
      where: { id: ruleId, policyId: id },
    });

    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await prisma.policyRule.delete({ where: { id: ruleId } });

    await createPolicyVersion(id, req.user!.id, 'RULE_REMOVED');

    res.json({ success: true });
  } catch (err) {
    console.error('Delete rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/versions — list versions for a policy
router.get('/:id/versions', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const policy = await prisma.policy.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const versions = await prisma.policyVersion.findMany({
      where: { policyId: id },
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
    console.error('List policy versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Natural Language Policy Creation ────────────────────────────
// POST /from-natural-language — parse a natural language description into policies

const NL_SYSTEM_PROMPT = `You are a policy engine for Origin, an AI code governance platform. Your job is to convert natural language policy descriptions into structured policy objects.

Available policy types:
- MODEL_ALLOWLIST: Restrict which AI models can be used
- COST_LIMIT: Per-session cost/token thresholds
- FILE_RESTRICTION: Block or flag file access patterns
- REQUIRE_REVIEW: Auto-flag sessions for review based on conditions

Available actions for rules:
- BLOCK: Prevent the session from starting (MODEL_ALLOWLIST only)
- WARN: Log a warning but allow
- REQUIRE_REVIEW: Flag the session for human review
- NOTIFY: Notify admins

Available severity levels: LOW, MEDIUM, HIGH

Condition format (JSON) depends on policy type:
- MODEL_ALLOWLIST: { "models": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"] }
- COST_LIMIT: { "max_cost": 5.0 } or { "max_tokens": 100000 }
- FILE_RESTRICTION: { "path": "**/.env" }
- REQUIRE_REVIEW: { "cost_above": 2.0 } or { "files_above": 20 } or { "max_lines": 500 } or { "max_duration_minutes": 30 } or { "path": "**/auth/**" }

You MUST respond with valid JSON only. No markdown, no explanation. The response must be an array of policy objects:
[
  {
    "name": "Human-readable policy name",
    "description": "What this policy does",
    "type": "POLICY_TYPE",
    "rules": [
      {
        "condition": "{ valid JSON string }",
        "action": "ACTION",
        "severity": "SEVERITY",
        "agentSlug": null or "agent-slug-if-mentioned"
      }
    ]
  }
]

If the user mentions a specific agent (like "claude code", "cursor"), set agentSlug to the slug form (e.g. "claude-code", "cursor"). If no agent is specified, set agentSlug to null (applies to all agents).

Multiple rules can be part of the same policy, or the user may describe multiple policies. Use your judgement.`;

router.post('/from-natural-language', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing required field: prompt' });
    }

    const orgId = req.user!.orgId;

    // Fetch context: existing agents, repos for name resolution
    const [agents, repos] = await Promise.all([
      prisma.agent.findMany({ where: { orgId }, select: { id: true, slug: true, name: true } }),
      prisma.repo.findMany({ where: { orgId }, select: { id: true, name: true } }),
    ]);

    const contextInfo = [
      `Available agents: ${agents.map(a => `${a.name} (slug: ${a.slug})`).join(', ') || 'none'}`,
      `Available repos: ${repos.map(r => r.name).join(', ') || 'none'}`,
    ].join('\n');

    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: NL_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Context:\n${contextInfo}\n\nUser request:\n${prompt}` },
      ],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';

    let parsed: any[];
    try {
      // Strip any markdown fences if present
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [parsed];
    } catch {
      return res.status(422).json({
        error: 'Failed to parse AI response into policies',
        raw: text,
      });
    }

    // Create the policies and rules in the database
    const created = [];

    for (const policyDef of parsed) {
      const policy = await prisma.policy.create({
        data: {
          orgId,
          name: policyDef.name || 'Untitled Policy',
          description: policyDef.description || null,
          type: policyDef.type || 'REQUIRE_REVIEW',
        },
      });

      const rules = [];
      for (const ruleDef of (policyDef.rules || [])) {
        // Resolve agent slug to ID
        let agentId: string | null = null;
        if (ruleDef.agentSlug) {
          const agent = agents.find(a => a.slug === ruleDef.agentSlug);
          if (agent) agentId = agent.id;
        }

        // Resolve repo name to ID
        let repoId: string | null = null;
        if (ruleDef.repoName) {
          const repo = repos.find(r => r.name.toLowerCase() === ruleDef.repoName.toLowerCase());
          if (repo) repoId = repo.id;
        }

        const condition = typeof ruleDef.condition === 'string'
          ? ruleDef.condition
          : JSON.stringify(ruleDef.condition);

        const rule = await prisma.policyRule.create({
          data: {
            policyId: policy.id,
            agentId,
            repoId,
            condition,
            action: ruleDef.action || 'WARN',
            severity: ruleDef.severity || 'MEDIUM',
          },
          include: {
            agent: { select: { name: true } },
            repo: { select: { name: true } },
          },
        });
        rules.push(rule);
      }

      await createPolicyVersion(policy.id, req.user!.id, 'CREATED');

      await prisma.auditLog.create({
        data: {
          orgId,
          userId: req.user!.id,
          action: 'POLICY_CREATED',
          resource: policy.id,
          metadata: JSON.stringify({ name: policy.name, type: policy.type, fromNaturalLanguage: true, prompt }),
        },
      });

      created.push({ ...policy, rules });
    }

    res.status(201).json({
      policies: created,
      parsed,
      message: `Created ${created.length} polic${created.length === 1 ? 'y' : 'ies'} with ${created.reduce((sum, p) => sum + p.rules.length, 0)} rule(s)`,
    });
  } catch (err) {
    console.error('Natural language policy error:', err);
    res.status(500).json({ error: 'Failed to create policy from natural language' });
  }
});

export default router;
