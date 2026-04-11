import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rate-limit.js';
import { createPolicyVersion } from '../services/versioning.js';
import { getOrgLLMKey, getOrgLLMModel, getOrgLLMProvider } from './settings.js';
import { callLLM } from './chat.js';
import { safeParseObject } from '../utils/safe-json.js';
import { validateFieldLengths, COMMON_LIMITS } from '../utils/validate.js';

const POLICY_LIMITS = {
  name: COMMON_LIMITS.name,
  description: COMMON_LIMITS.description,
  type: 100,
};
const POLICY_RULE_LIMITS = {
  condition: COMMON_LIMITS.condition,
  action: COMMON_LIMITS.action,
  severity: COMMON_LIMITS.severity,
};

const router = Router();
router.use(requireAuth);

// GET / — list policies for org (includes agent assignments)
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
        assignments: {
          include: {
            agent: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
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
    const lenErr = validateFieldLengths({ name, description, type }, POLICY_LIMITS);
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
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

    const lenErr = validateFieldLengths({ name, description, type }, POLICY_LIMITS);
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
    }

    const existing = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Defense in depth: use updateMany with compound (id, orgId) where so
    // authorization is enforced at the DB call itself, not just by the
    // precheck above. Prevents a future refactor from silently turning
    // this into a cross-org IDOR if the precheck is dropped or reordered.
    const updated = await prisma.policy.updateMany({
      where: { id, orgId: req.user!.orgId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(type !== undefined && { type }),
        ...(active !== undefined && { active }),
      },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
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

    // Delete related records first, then policy. Use deleteMany with
    // compound (id, orgId) scope on the final delete so authorization is
    // enforced at the DB call even if the precheck above is later removed.
    await prisma.policyVersion.deleteMany({ where: { policyId: id } });
    await prisma.policyRule.deleteMany({ where: { policyId: id } });
    await prisma.policyAssignment.deleteMany({ where: { policyId: id } });
    const deletedPolicy = await prisma.policy.deleteMany({
      where: { id, orgId: req.user!.orgId },
    });
    if (deletedPolicy.count === 0) {
      return res.status(404).json({ error: 'Policy not found' });
    }

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
    const ruleLenErr = validateFieldLengths({ condition, action, severity }, POLICY_RULE_LIMITS);
    if (ruleLenErr) {
      return res.status(400).json({ error: ruleLenErr });
    }

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    // Validate scope IDs belong to the same org. agentId used to be
    // trusted blindly — an attacker could attach a rule scoped to an
    // agent from another org, which would then fire on that foreign
    // agent's sessions via the policy engine join path.
    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId: req.user!.orgId } });
      if (!agent) return res.status(400).json({ error: 'Agent not found in your organization' });
    }
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

    // Scope the delete with a compound (id, policyId) where so the rule
    // has to both match the id AND belong to the already-org-checked
    // policy. Without policyId here, a future refactor that drops the
    // precheck would let anyone delete any rule by guessing its UUID.
    const deletedRule = await prisma.policyRule.deleteMany({
      where: { id: ruleId, policyId: id },
    });
    if (deletedRule.count === 0) {
      return res.status(404).json({ error: 'Rule not found' });
    }

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
        // Previously a bare JSON.parse — one malformed snapshot would
        // throw and 500 the whole versions list.
        snapshot: safeParseObject(v.snapshot, `policyVersion.${v.id}.snapshot`),
      })),
      total: versions.length,
    });
  } catch (err) {
    console.error('List policy versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Policy-Agent Assignments ───────────────────────────────────

// PUT /:id/assignments — set agent assignments for a policy (MEMBER+)
router.put('/:id/assignments', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { agentIds } = req.body as { agentIds: string[] };

    if (!Array.isArray(agentIds)) {
      return res.status(400).json({ error: 'agentIds must be an array' });
    }
    // DoS cap — realistic orgs assign a policy to <50 agents.
    if (agentIds.length > 500) {
      return res.status(400).json({ error: 'agentIds cannot exceed 500 items' });
    }

    const policy = await prisma.policy.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    // Validate all agent IDs belong to the same org
    if (agentIds.length > 0) {
      const agents = await prisma.agent.findMany({
        where: { id: { in: agentIds }, orgId: req.user!.orgId },
        select: { id: true },
      });
      const validIds = new Set(agents.map(a => a.id));
      const invalid = agentIds.filter(aid => !validIds.has(aid));
      if (invalid.length > 0) {
        return res.status(400).json({ error: `Agent(s) not found in your organization: ${invalid.join(', ')}` });
      }
    }

    // Replace all assignments: delete existing, create new
    await prisma.policyAssignment.deleteMany({ where: { policyId: id } });
    if (agentIds.length > 0) {
      await prisma.policyAssignment.createMany({
        data: agentIds.map(agentId => ({ policyId: id, agentId })),
      });
    }

    // Fetch updated assignments
    const assignments = await prisma.policyAssignment.findMany({
      where: { policyId: id },
      include: { agent: { select: { id: true, name: true, slug: true } } },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'POLICY_ASSIGNMENTS_UPDATED',
        resource: id,
        metadata: JSON.stringify({ policyName: policy.name, agentIds }),
      },
    });

    res.json({ assignments });
  } catch (err) {
    console.error('Update policy assignments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/assignments — get agent assignments for a policy
router.get('/:id/assignments', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const policy = await prisma.policy.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const assignments = await prisma.policyAssignment.findMany({
      where: { policyId: id },
      include: { agent: { select: { id: true, name: true, slug: true } } },
    });

    res.json({ assignments });
  } catch (err) {
    console.error('Get policy assignments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Natural Language Policy Creation ────────────────────────────
// POST /from-natural-language — parse a natural language description into policies

const NL_SYSTEM_PROMPT = `You are a policy engine for Origin, an AI code governance platform. Your job is to convert natural language policy descriptions into structured policy objects.

IMPORTANT: You can ONLY create policies that the engine supports. Do NOT invent new policy types or conditions.

Available policy types (these 6 exist):
- MODEL_ALLOWLIST: Restrict which AI models can be used. Use when the user wants to allow/block specific models.
- COST_LIMIT: Per-session cost/token thresholds. Use for budget limits.
- FILE_RESTRICTION: Block or flag when specific file paths are touched. Uses glob patterns on file paths only (NOT file contents).
- REQUIRE_REVIEW: Auto-flag sessions for review based on cost, files changed, lines added, duration, or file path patterns.
- CONTENT_FILTER: Block or flag when diff content contains a regex pattern. Use when the user wants to block specific words, patterns, or code in commits. Matches against the unified diff of the session.
- COMMIT_MESSAGE: Validate commit message format or block specific patterns. Use "pattern" to require a format (commits not matching are flagged), or "blocked_pattern" to block commits whose message matches.

Available actions for rules:
- BLOCK: Prevent/flag the action (MODEL_ALLOWLIST, FILE_RESTRICTION, CONTENT_FILTER, COMMIT_MESSAGE)
- WARN: Log a warning but allow
- REQUIRE_REVIEW: Flag the session for human review
- NOTIFY: Notify admins

Available severity levels: LOW, MEDIUM, HIGH

Condition format (JSON) — ONLY these conditions are supported:
- MODEL_ALLOWLIST: { "models": ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"] }
- COST_LIMIT: { "max_cost": 5.0 } or { "max_tokens": 100000 }
- FILE_RESTRICTION: { "path": "**/.env" } — glob pattern on file PATH only
- REQUIRE_REVIEW: { "cost_above": 2.0 } or { "files_above": 20 } or { "max_lines": 500 } or { "max_duration_minutes": 30 } or { "path": "**/auth/**" }
- CONTENT_FILTER: { "pattern": "TODO|FIXME" } — regex match against diff content. Optional: { "pattern": "secret", "caseSensitive": false }
- COMMIT_MESSAGE: { "pattern": "^(feat|fix|chore|docs|refactor|test):" } — require format. Or { "blocked_pattern": "WIP|DO NOT MERGE" } — block matching. Optional: { "blocked_pattern": "wip", "caseSensitive": false }

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

router.post('/from-natural-language', expensiveLimiter, requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing required field: prompt' });
    }
    // Cap the natural-language prompt. Every call here burns org LLM
    // credits, so an attacker with MEMBER role could drain budget by
    // posting megabyte-scale prompts. 8KB is plenty for policy text.
    if (prompt.length > 8 * 1024) {
      return res.status(413).json({ error: 'prompt exceeds maximum length' });
    }

    const orgId = req.user!.orgId;

    // Fetch context: existing agents, repos for name resolution. Cap
    // both — the LLM context is the limiter here, not the DB, and
    // dumping 50k repo names into the system prompt would blow the
    // token budget long before the SQL became the bottleneck.
    const [agents, repos] = await Promise.all([
      prisma.agent.findMany({ where: { orgId }, select: { id: true, slug: true, name: true }, take: 200 }),
      prisma.repo.findMany({ where: { orgId }, select: { id: true, name: true }, take: 500 }),
    ]);

    const contextInfo = [
      `Available agents: ${agents.map(a => `${a.name} (slug: ${a.slug})`).join(', ') || 'none'}`,
      `Available repos: ${repos.map(r => r.name).join(', ') || 'none'}`,
    ].join('\n');

    const [apiKey, orgModel, orgProvider] = await Promise.all([
      getOrgLLMKey(orgId),
      getOrgLLMModel(orgId),
      getOrgLLMProvider(orgId),
    ]);
    if (!apiKey) {
      return res.status(400).json({ error: 'LLM API key not configured. Add it in Settings → AI Chat.' });
    }

    const text = await callLLM(
      NL_SYSTEM_PROMPT,
      [{ role: 'user', content: `Context:\n${contextInfo}\n\nUser request:\n${prompt}` }],
      2000,
      { apiKey, model: orgModel, provider: orgProvider },
    );

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
