import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';

// ── In-memory mutex for session-start to prevent race conditions ────────
// When multiple session-starts fire simultaneously (Cursor, Codex), they all
// hit the dedup query before any of them commit. This lock serializes
// session-start per agent+repo+machine combination.
const sessionStartLocks = new Map<string, Promise<any>>();
function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionStartLocks.get(key) || Promise.resolve();
  const result = prev.catch(() => {}).then(() => fn());
  sessionStartLocks.set(key, result.catch(() => {}));
  // Cleanup stale entries
  result.finally(() => { setTimeout(() => sessionStartLocks.delete(key), 10000); });
  return result;
}
import { notifyOrgAdmins } from '../services/notifications.js';
import { runAIReview } from '../services/ai-review.js';
import { checkBudget, recordSpend } from '../services/budget.js';
import { emitSessionEvent } from '../services/session-events.js';
import { enforceSessionStart, enforceSessionEnd, applyEnforcementActions, enforceAgentLimits, loadOrgPolicies, shouldSkipRule, shouldSkipPolicy } from '../services/policy-engine.js';
import { describeCondition, describeAction } from '../utils/policy-descriptions.js';
import { updateSessionPRChecks } from '../services/github-integration.js';
import { updateSessionMRChecks } from '../services/gitlab-integration.js';
import { sendSlackNotification } from '../services/slack.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { detectAITool } from '../services/ai-commit-detector.js';

const router = Router();

// ── Input validation caps ────────────────────────────────────────
// Centralized size limits for the session write path. These are deliberately
// generous (real Claude transcripts go to ~5MB) but bound hostile payloads
// that would otherwise balloon the DB or OOM the process.
const MAX_PROMPT_LEN = 1_000_000;      // 1MB  — user prompt text
const MAX_TRANSCRIPT_LEN = 10_000_000; // 10MB — full assistant transcript
const MAX_DIFF_LEN = 10_000_000;       // 10MB — unified diff
const MAX_COMMIT_DETAILS = 500;        // commits per session/end or PATCH
const MAX_PROMPT_CHANGES = 500;        // prompt_changes rows per call
const MAX_FILES_CHANGED = 2_000;       // filesChanged array length
const MAX_FILE_PATH_LEN = 1024;        // single file path
const MAX_SAFE_INT_FIELD = 1e12;       // cap for tokens / cost / duration

/** Clamp a string to maxLen. Returns undefined if not a string. */
function clampStr(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

/** Coerce to a finite non-negative number in [0, MAX_SAFE_INT_FIELD]. */
function clampNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n > MAX_SAFE_INT_FIELD ? MAX_SAFE_INT_FIELD : n;
}

const ALLOWED_SESSION_STATUS = new Set(['RUNNING', 'COMPLETED', 'ERROR']);
function clampStatus(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return ALLOWED_SESSION_STATUS.has(v) ? v : undefined;
}

const DEFAULT_SECURITY_RULES = `CRITICAL: Follow these security rules at all times.

1. NEVER commit, write, or output secrets, API keys, tokens, passwords, or credentials in code, config files, or logs.
2. NEVER create or modify .env files with real secret values. Use placeholder values like "your-api-key-here" instead.
3. NEVER hardcode database connection strings, private keys, or authentication tokens.
4. Always use environment variables for secrets — never inline them in source code.
5. If you encounter existing secrets in the codebase, do NOT copy, move, or expose them further.
6. Redact any sensitive values when producing logs, error messages, or output.
7. NEVER add secrets to git — if a secret was accidentally staged, alert the user immediately.
8. When writing configuration examples, always use clearly fake placeholder values.`;

interface McpRequest extends Request {
  orgId?: string;
  mcpUserId?: string;  // User ID resolved from the API key (for per-member attribution)
  apiKeyId?: string;   // ID of the API key that created this session
  apiKeyName?: string; // Name of the API key (for standalone key attribution)
  keyType?: string;    // "solo" = auto-generated dev key, "team" = org-managed key
  accountType?: string; // "developer" or "org"
  repoScopes?: string[]; // Repo IDs this API key is scoped to (empty = unrestricted)
  agentScopes?: string[]; // Agent IDs this API key is scoped to (empty = no agent access)
}

// Helper: authenticate by API key header
async function authByApiKey(req: McpRequest, res: Response, next: NextFunction) {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const found = await prisma.apiKey.findFirst({
      where: { keyHash },
      include: {
        org: { include: { users: { where: { role: 'OWNER' }, take: 1 } } },
        user: { select: { accountType: true } },
        repoScopes: { select: { repoId: true } },
        agentScopes: { select: { agentId: true } },
      },
    });

    if (!found) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.orgId = found.orgId;
    req.apiKeyId = found.id;
    req.apiKeyName = found.name;
    req.keyType = (found as any).keyType || 'team';
    req.accountType = (found as any).user?.accountType || 'org';
    req.repoScopes = found.repoScopes.map((s: { repoId: string }) => s.repoId);
    req.agentScopes = found.agentScopes.map((s: { agentId: string }) => s.agentId);
    // Resolve user for session attribution:
    // Linked key: use the key's userId
    // Standalone key (has role, no userId): fall back to org owner so sessions are visible
    req.mcpUserId = found.userId ?? found.org.users[0]?.id ?? undefined;
    next();
  } catch (err) {
    console.error('API key auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.use(authByApiKey);

// GET /whoami — verify API key and return org info
router.get('/whoami', async (req: McpRequest, res: Response) => {
  try {
    const org = await prisma.org.findUnique({ where: { id: req.orgId as string } });
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const agentCount = await prisma.agent.count({ where: { orgId: org.id, status: 'ACTIVE' } });
    const repoCount = await prisma.repo.count({ where: { orgId: org.id, archived: false } });

    res.json({
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      apiKeyName: req.apiKeyName,
      keyType: req.keyType || 'team',
      accountType: req.accountType || 'org',
      repoScopes: req.repoScopes || [],
      agentScopes: req.agentScopes || [],
      agentCount,
      repoCount,
    });
  } catch (err) {
    console.error('Whoami error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /policies — load active policies for the org
router.get('/policies', async (req: McpRequest, res: Response) => {
  try {
    const policies = await prisma.policy.findMany({
      where: { orgId: req.orgId as string, active: true },
      include: {
        rules: true,
        assignments: {
          include: { agent: { select: { id: true, name: true, slug: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = policies.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: p.type,
      assignedAgents: p.assignments.map((a) => ({
        id: a.agent.id,
        name: a.agent.name,
        slug: a.agent.slug,
      })),
      rules: p.rules.map((r) => ({
        id: r.id,
        condition: r.condition,
        action: r.action,
        severity: r.severity,
        agentId: r.agentId,
        machineId: r.machineId,
        repoId: r.repoId,
      })),
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Load policies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/start — start a coding session
router.post('/session/start', async (req: McpRequest, res: Response) => {
  try {
    const { machineId, prompt, model, repoPath, repoUrl, agentSlug, branch, additionalRepoPaths, agentSessionId } = req.body;

    if (!machineId || !model || !repoPath) {
      return res.status(400).json({ error: 'Missing required fields: machineId, model, repoPath' });
    }

    // Input size caps. /session/start accepts fields straight off an API key
    // with no express.json() limit applied at this router, and abuse would
    // turn a single request into arbitrary write amplification downstream
    // (huge prompt columns, thousands of SessionRepo rows, matching regex
    // engines against multi-megabyte blobs, etc.). Reject early.
    const MAX_PROMPT_LEN = 1_000_000; // 1MB text
    const MAX_ADDITIONAL_REPOS = 50;
    const MAX_PATH_LEN = 1024;
    const MAX_BRANCH_LEN = 512;
    if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_LEN) {
      return res.status(413).json({ error: 'prompt exceeds maximum length' });
    }
    if (typeof repoPath === 'string' && repoPath.length > MAX_PATH_LEN) {
      return res.status(413).json({ error: 'repoPath exceeds maximum length' });
    }
    if (typeof branch === 'string' && branch.length > MAX_BRANCH_LEN) {
      return res.status(413).json({ error: 'branch exceeds maximum length' });
    }
    if (additionalRepoPaths !== undefined && !Array.isArray(additionalRepoPaths)) {
      return res.status(400).json({ error: 'additionalRepoPaths must be an array' });
    }
    if (Array.isArray(additionalRepoPaths) && additionalRepoPaths.length > MAX_ADDITIONAL_REPOS) {
      return res.status(413).json({ error: `additionalRepoPaths exceeds max of ${MAX_ADDITIONAL_REPOS}` });
    }

    const orgId = req.orgId as string;
    console.log('[session/start]', { orgId, repoPath, repoUrl: repoUrl || '(none)', agentSlug, machineId, additionalRepoPaths: additionalRepoPaths?.length || 0 });

    // Check budget before allowing session
    const budgetCheck = await checkBudget(orgId);
    if (budgetCheck.blocked) {
      return res.status(429).json({
        error: 'Budget limit exceeded',
        message: budgetCheck.message,
        spent: budgetCheck.spent,
        limit: budgetCheck.limit,
      });
    }

    // Look up repo — try exact path, then remote URL slug, then fuzzy directory name
    let repo = await prisma.repo.findFirst({
      where: { orgId, path: repoPath },
    });

    // If no exact match and repoUrl provided, extract owner/repo slug and match against repo.path
    if (!repo && repoUrl) {
      let slug: string | null = null;
      // Handle HTTPS URLs: https://github.com/owner/repo.git
      const httpsMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        slug = httpsMatch[1].toLowerCase();
      }
      // Handle SSH URLs: git@github.com:owner/repo.git
      if (!slug) {
        const sshMatch = repoUrl.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
        if (sshMatch) {
          slug = sshMatch[1].toLowerCase();
        }
      }
      if (slug) {
        const orgRepos = await prisma.repo.findMany({ where: { orgId } });
        repo = orgRepos.find((r) => {
          const rLower = r.path.toLowerCase();
          return rLower === slug
            || rLower === `https://github.com/${slug}`
            || rLower === `https://github.com/${slug}.git`
            || rLower.endsWith(`/${slug}`)
            || rLower.endsWith(`/${slug}.git`);
        }) || null;
      }
    }

    // Fall back to matching by directory name (exact match only — fuzzy substring
    // matching caused false positives like "origin" matching "origin-cli")
    if (!repo) {
      const dirName = repoPath.split('/').filter(Boolean).pop()?.toLowerCase();
      if (dirName) {
        const orgRepos = await prisma.repo.findMany({ where: { orgId } });
        repo = orgRepos.find((r) => {
          const repoName = r.path.split('/').pop()?.toLowerCase();
          return repoName === dirName;
        }) || null;
      }
    }

    const isSoloKey = req.keyType === 'solo' || req.accountType === 'developer';

    if (!repo) {
      if (isSoloKey) {
        // Solo developer: auto-register the repo
        const repoName = repoPath.split('/').filter(Boolean).pop() || repoPath;
        try {
          repo = await prisma.repo.create({
            data: { orgId, name: repoName, path: repoPath, provider: repoUrl ? 'github' : 'local' },
          });
        } catch {
          // Race condition — repo was created between findFirst and create
          repo = await prisma.repo.findFirst({ where: { orgId, path: repoPath } });
        }
        if (!repo) {
          return res.status(500).json({ error: 'Failed to auto-register repo' });
        }
        console.log('[session/start] auto-registered repo for solo dev', { repoPath, repoId: repo.id });
      } else {
        const orgRepos = await prisma.repo.findMany({ where: { orgId }, select: { path: true } });
        console.log('[session/start] REPO NOT FOUND', { repoPath, repoUrl, orgRepoPaths: orgRepos.map(r => r.path) });
        return res.status(403).json({
          error: 'Repository not registered',
          message: `"${repoPath}" is not registered in Origin. Ask your admin to add it first.`,
        });
      }
    }

    // Enforce repo-scoped API key access — solo keys have unrestricted access
    if (!isSoloKey && (!req.repoScopes || req.repoScopes.length === 0 || !req.repoScopes.includes(repo.id))) {
      return res.status(403).json({
        error: 'Access denied',
        message: `This API key does not have access to repo "${repo.name}". Assign repo access in Settings → API Keys.`,
      });
    }

    // Look up machine DB id for policy scoping — auto-register if missing
    let machine = await prisma.machine.findFirst({
      where: { machineId },
    });
    if (!machine) {
      try {
        const hostname = req.body.hostname || machineId.slice(0, 8);
        machine = await prisma.machine.upsert({
          where: { machineId },
          create: { orgId, hostname, machineId, detectedTools: '[]', lastSeenAt: new Date() },
          update: { lastSeenAt: new Date() },
        });
        console.log('[session/start] auto-registered machine', { machineId, hostname });
      } catch { /* non-fatal */ }
    } else {
      // Update lastSeenAt
      prisma.machine.update({ where: { id: machine.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }

    // Resolve agent from API key scopes + tool type
    // The API key is already assigned to specific agents — use those, no slug guessing needed
    let agent: { id: string; systemPrompt?: string | null; securityRulesEnabled?: boolean; securityRules?: string | null; slug?: string; name?: string; versions?: { version: number }[] } | null = null;
    const agentSelect = { id: true, systemPrompt: true, securityRulesEnabled: true, securityRules: true, slug: true, name: true, versions: { orderBy: { version: 'desc' as const }, take: 1, select: { version: true } } };

    // Enforce API key → agent scope: solo keys skip this check
    if (!isSoloKey) {
      if (!req.agentScopes || req.agentScopes.length === 0) {
        return res.status(403).json({
          error: 'No agent access',
          message: 'This API key has no agent assignments. Assign agents in Settings → API Keys.',
        });
      }
    }

    // Get all agents this API key has access to
    const allowedAgents = isSoloKey
      ? await prisma.agent.findMany({ where: { orgId, status: 'ACTIVE' }, select: agentSelect })
      : await prisma.agent.findMany({ where: { orgId, id: { in: req.agentScopes }, status: 'ACTIVE' }, select: agentSelect });

    if (allowedAgents.length === 0 && !isSoloKey) {
      return res.status(403).json({
        error: 'No active agents',
        message: 'This API key is assigned to agents that no longer exist or are inactive.',
      });
    }

    // Solo developer with no agents: auto-create one based on the tool type
    if (allowedAgents.length === 0 && isSoloKey) {
      const autoSlug = agentSlug || 'ai-agent';
      const autoName = autoSlug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const created = await prisma.agent.upsert({
        where: { orgId_slug: { orgId, slug: autoSlug } },
        create: { orgId, name: autoName, slug: autoSlug, model: model || 'unknown', status: 'ACTIVE' },
        update: { status: 'ACTIVE' },
      });
      agent = { ...created, systemPrompt: null, securityRulesEnabled: false, securityRules: null, versions: [] };
      console.log('[session/start] auto-created agent for solo dev', { slug: autoSlug, agentId: created.id });
    }

    if (agentSlug) {
      // Try to match the tool type (claude-code, gemini, etc.) to an allowed agent
      const slugLower = agentSlug.toLowerCase();
      const prefix = slugLower.split('-')[0]; // "claude-code" → "claude"
      // 1. Exact slug or name match (highest priority)
      agent = allowedAgents.find((a) => {
        const s = (a.slug || '').toLowerCase();
        const n = (a.name || '').toLowerCase();
        return s === slugLower || n === slugLower;
      }) || null;
      // 2. Prefix match on slug/name (e.g. "claude-code" → prefix "claude" matches agent slug "claude")
      if (!agent) {
        agent = allowedAgents.find((a) => {
          const s = (a.slug || '').toLowerCase();
          const n = (a.name || '').toLowerCase();
          return s === prefix || n === prefix;
        }) || null;
      }
      // 3. Fuzzy: name or slug contains the tool prefix
      if (!agent) {
        agent = allowedAgents.find((a) => {
          const n = (a.name || '').toLowerCase();
          const s = (a.slug || '').toLowerCase();
          return n.includes(prefix) || s.includes(prefix);
        }) || null;
      }
    }

    // Solo dev: auto-create the correct agent if no match found
    if (!agent && isSoloKey && agentSlug) {
      const autoSlug = agentSlug.toLowerCase();
      const autoName = autoSlug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const created = await prisma.agent.upsert({
        where: { orgId_slug: { orgId, slug: autoSlug } },
        create: { orgId, name: autoName, slug: autoSlug, model: model || 'unknown', status: 'ACTIVE' },
        update: { status: 'ACTIVE' },
      });
      agent = { ...created, systemPrompt: null, securityRulesEnabled: false, securityRules: null, versions: [] };
      console.log('[session/start] auto-created agent for solo dev', { slug: autoSlug, agentId: created.id });
    }

    // Team key: reject if no matching agent — API key must have explicit agent permission
    if (!agent && !isSoloKey) {
      return res.status(403).json({
        error: 'Agent not permitted',
        message: `This API key does not have access to agent "${agentSlug || 'unknown'}". Available agents: ${allowedAgents.map((a) => a.name).join(', ')}. Assign the correct agent in Settings → API Keys.`,
      });
    }

    // Solo fallback
    if (!agent) {
      agent = allowedAgents[0] || null;
    }

    // Check model allowlist policies (with agent/machine/repo scope) — skip for solo devs
    const modelCheck = isSoloKey ? { allowed: true, violations: [] } : await enforceSessionStart(orgId, model, {
      agentId: agent?.id ?? null,
      machineId: machine?.id ?? null,
      repoId: repo.id,
    });
    if (!modelCheck.allowed) {
      const violation = modelCheck.violations[0];
      return res.status(403).json({
        error: 'Model not allowed by policy',
        message: violation?.message || 'Model is not in the allowed list',
        policy: violation?.policyName,
      });
    }

    // ── Server-side dedup with mutex lock ──────────────────────────────────
    // Serializes session-start per agent+repo+machine to prevent race conditions
    // when multiple hooks fire simultaneously (Cursor, Codex).
    const lockKey = `${agent?.id || 'null'}:${repo.id}:${machineId}`;
    return withSessionLock(lockKey, async () => {

    const HEARTBEAT_ALIVE_MS = 2 * 60 * 1000; // 2 minutes — heartbeat pings every 30s
    const heartbeatCutoff = new Date(Date.now() - HEARTBEAT_ALIVE_MS);
    // Zombie cleanup threshold: matches sessions.ts ABANDONED_THRESHOLD_MS (2h).
    // IMPORTANT: Claude Code is hook-based (no continuous heartbeat daemon),
    // so between prompts `updatedAt` is naturally stale for many minutes.
    // Using HEARTBEAT_ALIVE_MS (2 min) here would mark every idle Claude Code
    // session as COMPLETED on the next session/start — that's the "dies
    // instead of going idle" bug. Let sessions.ts computeStatus render them
    // as IDLE via lastActivityAt, and only reap after the genuine 2h abandon.
    const ZOMBIE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
    const zombieCutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS);
    // When the client supplies its native session id (Claude Code's
    // claudeSessionId, Cursor's conversation_id, etc.), scope dedup to that
    // value so two unrelated conversations on the same machine/repo/agent
    // don't collapse into one session row. Without this, every new Claude
    // Code window appended its prompts to the still-RUNNING prior session.
    const existingSession = await prisma.codingSession.findFirst({
      where: {
        agentId: agent?.id || null,
        machineId: machineId || undefined,
        // Explicit orgId scope prevents cross-tenant collisions — even though
        // repo.id is already org-scoped, defense-in-depth ensures a bug in
        // repo resolution can't leak sessions across tenants.
        commit: { repoId: repo.id, repo: { orgId } },
        status: 'RUNNING',
        updatedAt: { gte: heartbeatCutoff }, // heartbeat must be alive
        ...(agentSessionId ? { agentSessionId } : {}),
      },
      include: { commit: { select: { repoId: true } } },
      orderBy: { startedAt: 'desc' },
    });

    if (existingSession) {
      await prisma.codingSession.update({
        where: { id: existingSession.id },
        data: {
          lastActivityAt: new Date(),
          ...(!existingSession.machineId && machineId && { machineId }),
        },
      });
      console.log('[session/start] DEDUP: returning existing session (heartbeat alive)', {
        existingId: existingSession.id, machineId,
      });

      // Re-evaluate system prompt
      let dedupPrompt = agent?.systemPrompt || existingSession.agentSystemPrompt || null;
      if (agent?.securityRulesEnabled === true) {
        const securityBlock = agent?.securityRules?.trim() || DEFAULT_SECURITY_RULES;
        dedupPrompt = dedupPrompt
          ? `${dedupPrompt}\n\n<security-rules>\n${securityBlock}\n</security-rules>`
          : `<security-rules>\n${securityBlock}\n</security-rules>`;
      }
      if (dedupPrompt !== existingSession.agentSystemPrompt) {
        await prisma.codingSession.update({
          where: { id: existingSession.id },
          data: { agentSystemPrompt: dedupPrompt },
        });
      }
      return res.json({
        sessionId: existingSession.id,
        agentSystemPrompt: dedupPrompt || undefined,
        activePolicies: [],
        startedAt: existingSession.startedAt?.toISOString(),
        verboseCapture: !!repo.verboseCapture,
      });
    }

    // ── Clean up zombie RUNNING sessions (heartbeat dead, never got session/end) ──
    // Mark them COMPLETED so they don't accumulate forever.
    const zombieSessions = await prisma.codingSession.findMany({
      where: {
        agentId: agent?.id || null,
        commit: { repoId: repo.id, repo: { orgId } },
        status: 'RUNNING',
        updatedAt: { lt: zombieCutoff },
      },
      select: { id: true },
      take: 1000,
    });
    if (zombieSessions.length > 0) {
      await prisma.codingSession.updateMany({
        where: { id: { in: zombieSessions.map(s => s.id) } },
        data: { status: 'COMPLETED', endedAt: new Date() },
      });
      console.log('[session/start] ZOMBIE CLEANUP: ended', zombieSessions.length, 'dead sessions for', agentSlug);
    }

    // ── Session reuse & chaining ──────────────────────────────────────
    // 1. IDLE/RUNNING sessions → resume them (return existing session, don't create new)
    // 2. COMPLETED sessions ended < 10 min ago → chain as related sessions
    // 3. COMPLETED sessions ended > 10 min ago → fresh session, no chain
    let parentSessionId: string | null = null;
    let reuseSession: { id: string; status: string } | null = null;

    // First: check for IDLE or RUNNING session on same repo+branch+agent that we should resume
    // MUST match the same agent — never reuse a Gemini session for Codex, etc.
    const activeSession = agent?.id ? await prisma.codingSession.findFirst({
      where: {
        commit: { repoId: repo.id },
        branch: branch || undefined,
        status: { in: ['RUNNING', 'IDLE'] },
        mergedInto: null,
        agentId: agent.id,
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true },
    }) : null;

    if (activeSession) {
      reuseSession = activeSession;
      console.log('[session/start] REUSE: resuming existing session', {
        sessionId: activeSession.id, status: activeSession.status, agentId: agent?.id,
      });
    }

    // If no active session to reuse, check for recently completed sessions to chain
    if (!reuseSession) {
      if (agentSessionId) {
        // Primary: match by agent's native session ID
        const priorByAgent = await prisma.codingSession.findFirst({
          where: {
            agentSessionId,
            mergedInto: null,
          },
          orderBy: { startedAt: 'desc' },
        });
        if (priorByAgent) {
          parentSessionId = priorByAgent.parentSessionId || priorByAgent.id;
          console.log('[session/start] CHAIN: linking to prior session via agentSessionId', {
            priorId: priorByAgent.id, parentSessionId, agentSessionId,
          });
        }
      }

      if (!parentSessionId && agent?.id) {
        // Heuristic: same repo + branch + agent + machine, completed within 10 minutes
        // MUST have a valid agentId — never chain across different agents
        const cutoff10m = new Date(Date.now() - 10 * 60 * 1000);
        const priorByHeuristic = await prisma.codingSession.findFirst({
          where: {
            agentId: agent.id,
            commit: { repoId: repo.id },
            branch: branch || undefined,
            updatedAt: { gte: cutoff10m },
            status: 'COMPLETED',
            mergedInto: null,
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (priorByHeuristic) {
          parentSessionId = priorByHeuristic.parentSessionId || priorByHeuristic.id;
          console.log('[session/start] CHAIN: linking to recently completed session', {
            priorId: priorByHeuristic.id, parentSessionId, agentId: agent.id,
          });
        }
      }
    }

    // If reusing an existing session, update it to RUNNING and return it
    if (reuseSession) {
      await prisma.codingSession.update({
        where: { id: reuseSession.id },
        data: { status: 'RUNNING' },
      });
      // Emit session started event for Live Feed
      emitSessionEvent({
        type: 'session:started',
        sessionId: reuseSession.id,
        orgId,
        userId: req.mcpUserId || undefined,
        timestamp: new Date().toISOString(),
        data: { repoPath: repoPath || repo.name, agentSlug: agentSlug || model, model, resumed: true },
      });
      return res.json({
        sessionId: reuseSession.id,
        systemPrompt: agent?.systemPrompt || null,
        resumed: true,
        verboseCapture: !!repo.verboseCapture,
      });
    }

    // Generate a placeholder SHA (random 40-char hex)
    const placeholderSha = crypto.randomBytes(20).toString('hex');

    // Create a commit with placeholder SHA (mark as session-detected AI).
    // Prefer the real user's name/email over the hardcoded "mcp-agent"
    // string — showing "mcp-agent" in every row of the commit list is
    // useless to the user and hides who actually ran the session.
    let commitAuthor = 'mcp-agent';
    if (req.mcpUserId) {
      try {
        const authorUser = await prisma.user.findUnique({
          where: { id: req.mcpUserId },
          select: { name: true, email: true },
        });
        commitAuthor = authorUser?.name || authorUser?.email || req.apiKeyName || 'mcp-agent';
      } catch {
        commitAuthor = req.apiKeyName || 'mcp-agent';
      }
    } else if (req.apiKeyName) {
      commitAuthor = req.apiKeyName;
    }
    const commit = await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: placeholderSha,
        message: '',
        author: commitAuthor,
        aiToolDetected: model,
        aiDetectionMethod: 'session',
        committedAt: new Date(),
      },
    });

    // Build the full system prompt: custom prompt + security rules (if enabled)
    let fullSystemPrompt = agent?.systemPrompt || null;
    if (agent?.securityRulesEnabled === true) {
      const securityBlock = agent?.securityRules?.trim() || DEFAULT_SECURITY_RULES;
      fullSystemPrompt = fullSystemPrompt
        ? `${fullSystemPrompt}\n\n<security-rules>\n${securityBlock}\n</security-rules>`
        : `<security-rules>\n${securityBlock}\n</security-rules>`;
    }

    // Create the coding session (link to agent if resolved, snapshot system prompt)
    const codingSession = await prisma.codingSession.create({
      data: {
        commitId: commit.id,
        model,
        prompt: prompt || '',
        transcript: '',
        filesChanged: '[]',
        status: 'RUNNING',
        startedAt: new Date(),
        lastActivityAt: new Date(),
        userId: req.mcpUserId || null,
        apiKeyId: req.apiKeyId || null,
        apiKeyName: req.apiKeyName || null,
        agentId: agent?.id || null,
        agentSystemPrompt: fullSystemPrompt,
        agentVersion: agent?.versions?.[0]?.version || null,
        branch: branch || null,
        agentSessionId: agentSessionId || null,
        parentSessionId,
        machineId: machineId || null,
      },
    });

    // Create SessionRepo records for multi-repo sessions
    // Always create the primary repo link
    await prisma.sessionRepo.create({
      data: {
        sessionId: codingSession.id,
        repoId: repo.id,
        isPrimary: true,
      },
    });
    // Create records for additional repos (if any).
    // Uses EXACT path match only — the old `endsWith('/dirname')` fallback
    // would collide repos like `/a/origin` with `/b/origin` and bundle
    // unrelated projects into the same session.
    if (additionalRepoPaths && Array.isArray(additionalRepoPaths)) {
      for (const extraPath of additionalRepoPaths) {
        try {
          let extraRepo = await prisma.repo.findFirst({ where: { orgId, path: extraPath } });
          // Auto-register for solo devs — do it inside a tx so a concurrent
          // request can't create the same row between our check and write.
          if (!extraRepo && isSoloKey) {
            const dirName = extraPath.split('/').filter(Boolean).pop() || extraPath;
            extraRepo = await prisma.$transaction(async (tx) => {
              const existing = await tx.repo.findFirst({ where: { orgId, path: extraPath } });
              if (existing) return existing;
              return tx.repo.create({
                data: { orgId, name: dirName, path: extraPath, provider: 'local' },
              });
            });
          }
          if (extraRepo) {
            await prisma.sessionRepo.create({
              data: {
                sessionId: codingSession.id,
                repoId: extraRepo.id,
                isPrimary: false,
              },
            });
          }
        } catch (err) {
          console.log('[session/start] additional repo link failed (non-fatal)', extraPath, err);
        }
      }
    }

    // Update machine lastSeenAt
    await prisma.machine.updateMany({
      where: { machineId },
      data: { lastSeenAt: new Date() },
    });

    // Log audit event
    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.mcpUserId || null,
        action: 'SESSION_STARTED',
        resource: codingSession.id,
        metadata: JSON.stringify({ machineId, model, repoPath, agentSlug }),
      },
    });

    emitSessionEvent({
      type: 'session:started',
      sessionId: codingSession.id,
      orgId,
      data: { model, repoPath, agentSlug },
      timestamp: new Date().toISOString(),
    });

    // Build active policy summary for system message + raw rules for CLI enforcement
    let activePolicies: string[] = [];
    let enforcementRules: Array<{ type: string; condition: string; action: string; severity: string }> = [];
    try {
      const allPolicies = await loadOrgPolicies(orgId);
      const scope = { agentId: agent?.id ?? null, machineId: machine?.id ?? null, repoId: repo.id };
      for (const p of allPolicies) {
        if (shouldSkipPolicy(p, scope)) continue;
        for (const r of p.rules) {
          if (shouldSkipRule(r, scope)) continue;
          const desc = describeCondition(p.type, r.condition);
          activePolicies.push(`${p.name}: ${desc.summary} (${describeAction(r.action)})`);
          enforcementRules.push({ type: p.type, condition: r.condition, action: r.action, severity: r.severity });
        }
      }
    } catch { /* non-critical */ }

    res.json({ sessionId: codingSession.id, parentSessionId, activePolicies, enforcementRules, agentSystemPrompt: fullSystemPrompt, verboseCapture: !!repo.verboseCapture });

    }); // end withSessionLock
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/:id/resume — resume an existing session (returns fresh agent prompt + policies)
router.post('/session/:id/resume', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    // Scope the lookup by orgId. Previously this used findUnique({id})
    // which let any org's API key resume (and flip RUNNING) a session in
    // any other org — a classic cross-tenant IDOR via the MCP surface.
    // Join through commit.repo.orgId so we can use a single query.
    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      include: { agent: true, commit: { select: { repo: { select: { verboseCapture: true } } } } },
    });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Re-activate session on resume
    if (session.status !== 'RUNNING') {
      await prisma.codingSession.update({
        where: { id },
        data: { status: 'RUNNING', endedAt: null },
      });
    }

    // Fetch the latest agent system prompt (not the snapshot — the live version) with security rules
    let agentSystemPrompt = session.agent?.systemPrompt || session.agentSystemPrompt || null;
    if (session.agent && (session.agent as any).securityRulesEnabled === true) {
      const securityBlock = (session.agent as any).securityRules?.trim() || DEFAULT_SECURITY_RULES;
      agentSystemPrompt = agentSystemPrompt
        ? `${agentSystemPrompt}\n\n<security-rules>\n${securityBlock}\n</security-rules>`
        : `<security-rules>\n${securityBlock}\n</security-rules>`;
    }

    // Fetch active policies for THIS org only. The previous query read
    // every active policy across every tenant — both a data leak (other
    // orgs' policy names and descriptions) and an unbounded scan that
    // grows with total customers.
    let activePolicies: string[] = [];
    try {
      const allPolicies = await prisma.policy.findMany({
        where: { orgId, active: true },
        take: 500,
      });
      activePolicies = allPolicies
        .map((p: any) => `[${p.type}] ${p.name}: ${p.description || ''}`.trim());
    } catch { /* non-critical */ }

    res.json({
      sessionId: id,
      status: session.status,
      activePolicies,
      agentSystemPrompt,
      verboseCapture: !!session.commit?.repo?.verboseCapture,
    });
  } catch (err) {
    console.error('Resume session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/:id/command-result — CLI reports back command execution result
router.post('/session/:id/command-result', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    const { type, status, message } = req.body;

    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const result = JSON.stringify({
      type: type || 'unknown',
      status: status || 'unknown',
      message: (message || '').slice(0, 500),
      at: new Date().toISOString(),
    });

    await prisma.codingSession.update({
      where: { id },
      data: { lastCommandResult: result },
    });

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'command-result failed' });
  }
});

// POST /session/:id/attach-repo — lazily attach a repo to a running session.
// Called by the CLI when a tool touches a file in a git repo that wasn't
// known at session-start (e.g. agent reads a file in a sibling directory).
router.post('/session/:id/attach-repo', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    const { repoPath } = req.body;

    if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 1000) {
      return res.status(400).json({ error: 'invalid repoPath' });
    }

    const scopeCheck = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!scopeCheck) return res.status(404).json({ error: 'Session not found' });

    const isSoloKey = req.keyType === 'solo' || req.accountType === 'developer';

    let repo = await prisma.repo.findFirst({ where: { orgId, path: repoPath } });
    if (!repo && isSoloKey) {
      const dirName = repoPath.split('/').filter(Boolean).pop() || repoPath;
      repo = await prisma.$transaction(async (tx) => {
        const existing = await tx.repo.findFirst({ where: { orgId, path: repoPath } });
        if (existing) return existing;
        return tx.repo.create({
          data: { orgId, name: dirName, path: repoPath, provider: 'local' },
        });
      });
    }
    if (!repo) return res.json({ ok: true, attached: false, reason: 'repo not registered' });

    // @@unique([sessionId, repoId]) makes this idempotent.
    try {
      await prisma.sessionRepo.create({
        data: { sessionId: id, repoId: repo.id, isPrimary: false },
      });
    } catch {
      // duplicate — already attached, treat as success
    }
    res.json({ ok: true, attached: true, repoId: repo.id });
  } catch (err: any) {
    console.log('[session/attach-repo] failed', err?.message);
    res.status(500).json({ error: 'attach-repo failed' });
  }
});

// POST /session/:id/snapshot — record an auto/manual snapshot the CLI just
// created. Stored centrally so the dashboard timeline can mark dots for each
// snapshot taken during a session. Idempotent on (sessionId, snapshotId).
router.post('/session/:id/snapshot', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    const {
      snapshotId,
      type,
      takenAt,
      promptIndex,
      commitSha,
      treeSha,
      filesChanged,
      linesAdded,
      linesRemoved,
    } = req.body;

    if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200) {
      return res.status(400).json({ error: 'invalid snapshotId' });
    }
    if (typeof type !== 'string' || !type || type.length > 40) {
      return res.status(400).json({ error: 'invalid type' });
    }

    const scopeCheck = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!scopeCheck) return res.status(404).json({ error: 'Session not found' });

    const filesArr = Array.isArray(filesChanged) ? filesChanged.slice(0, 200).filter((f) => typeof f === 'string') : [];

    await prisma.snapshot.upsert({
      where: { sessionId_snapshotId: { sessionId: id, snapshotId } },
      create: {
        sessionId: id,
        snapshotId,
        type,
        takenAt: takenAt ? new Date(takenAt) : new Date(),
        promptIndex: typeof promptIndex === 'number' ? promptIndex : null,
        commitSha: typeof commitSha === 'string' ? commitSha : null,
        treeSha: typeof treeSha === 'string' ? treeSha : null,
        filesChanged: JSON.stringify(filesArr),
        linesAdded: Number.isFinite(Number(linesAdded)) ? Number(linesAdded) : 0,
        linesRemoved: Number.isFinite(Number(linesRemoved)) ? Number(linesRemoved) : 0,
      },
      update: {
        type,
        promptIndex: typeof promptIndex === 'number' ? promptIndex : undefined,
        commitSha: typeof commitSha === 'string' ? commitSha : undefined,
        treeSha: typeof treeSha === 'string' ? treeSha : undefined,
      },
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.log('[session/snapshot] failed', err?.message);
    res.status(500).json({ error: 'snapshot upload failed' });
  }
});

// POST /session/:id/ping — lightweight keepalive heartbeat
router.post('/session/:id/ping', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    const session = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { status: true, pendingCommand: true, branch: true },
    });
    if (!session) return res.json({ ok: true, status: 'NOT_FOUND' });

    // The heartbeat reports the agent's current git branch every 30s, so the
    // dashboard reflects mid-session checkouts (e.g. agent runs `git checkout
    // -b feature/x`) instead of staying stuck on the branch the session
    // started on.
    const reportedBranch = typeof req.body?.branch === 'string' ? req.body.branch.slice(0, 500) : null;
    const branchChanged = reportedBranch && reportedBranch !== session.branch;

    if (session.status === 'RUNNING') {
      await prisma.codingSession.update({
        where: { id },
        data: {
          updatedAt: new Date(),
          ...(branchChanged && { branch: reportedBranch }),
        },
      });
    } else if (branchChanged) {
      await prisma.codingSession.update({
        where: { id },
        data: { branch: reportedBranch },
      });
    }

    // If there's a pending command, include it and clear it (one-shot delivery)
    let command = null;
    if (session.pendingCommand) {
      try {
        command = JSON.parse(session.pendingCommand);
        await prisma.codingSession.update({ where: { id }, data: { pendingCommand: null } });
      } catch { /* malformed JSON, clear it */
        await prisma.codingSession.update({ where: { id }, data: { pendingCommand: null } });
      }
    }

    res.json({ ok: true, status: session.status, command });
  } catch {
    res.status(500).json({ error: 'ping failed' });
  }
});

// PATCH /session/:id — incremental session update (during active session)
router.patch('/session/:id', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.orgId as string;
    const {
      prompt, transcript, filesChanged, tokensUsed, toolCalls,
      linesAdded, linesRemoved, model, inputTokens, outputTokens,
      cacheReadTokens, cacheCreationTokens,
      durationMs, costUsd, promptChanges, branch, status,
    } = req.body;

    // Org-scope check BEFORE the update. Previously the handler issued
    // `update({where:{id}})` directly against a user-controlled id, so a
    // valid API key in any tenant could mutate arbitrary sessions in
    // any other tenant — prompt, transcript, tokens, cost, status.
    // That's both an integrity break (attacker can rewrite another
    // org's audit trail) and a pricing attack (zero a victim's costUsd).
    const scopeCheck = await prisma.codingSession.findFirst({
      where: { id, commit: { repo: { orgId } } },
      select: { id: true },
    });
    if (!scopeCheck) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Clamp every field we're about to persist so a hostile client can't
    // DoS us by shipping a 500MB prompt or NaN costs.
    const cleanPrompt = clampStr(prompt, MAX_PROMPT_LEN);
    const cleanTranscript = clampStr(transcript, MAX_TRANSCRIPT_LEN);
    const cleanToolCalls = clampNum(toolCalls);
    const cleanStatus = clampStatus(status);
    const cleanTokensUsed = clampNum(tokensUsed);
    const cleanInputTokens = clampNum(inputTokens);
    const cleanOutputTokens = clampNum(outputTokens);
    const cleanCacheReadTokens = clampNum(cacheReadTokens);
    const cleanCacheCreationTokens = clampNum(cacheCreationTokens);
    const cleanLinesAdded = clampNum(linesAdded);
    const cleanLinesRemoved = clampNum(linesRemoved);
    const cleanDurationMs = clampNum(durationMs);
    const cleanCostUsd = clampNum(costUsd);
    // Cap filesChanged array and per-path length before JSON.stringify.
    let cleanFilesChangedStr: string | undefined;
    if (filesChanged !== undefined) {
      const arr = Array.isArray(filesChanged) ? filesChanged : [];
      const capped = arr
        .slice(0, MAX_FILES_CHANGED)
        .filter((f): f is string => typeof f === 'string')
        .map((f) => (f.length > MAX_FILE_PATH_LEN ? f.slice(0, MAX_FILE_PATH_LEN) : f));
      cleanFilesChangedStr = JSON.stringify(capped);
    }

    await prisma.codingSession.update({
      where: { id },
      data: {
        ...(cleanPrompt !== undefined && { prompt: cleanPrompt }),
        ...(cleanTranscript !== undefined && { transcript: cleanTranscript }),
        ...(cleanFilesChangedStr !== undefined && { filesChanged: cleanFilesChangedStr }),
        ...(cleanTokensUsed !== undefined && { tokensUsed: cleanTokensUsed }),
        ...(cleanToolCalls !== undefined && { toolCalls: cleanToolCalls }),
        ...(cleanLinesAdded !== undefined && { linesAdded: cleanLinesAdded }),
        ...(cleanLinesRemoved !== undefined && { linesRemoved: cleanLinesRemoved }),
        ...(typeof model === 'string' && model.length <= 200 && { model }),
        ...(cleanInputTokens !== undefined && { inputTokens: cleanInputTokens }),
        ...(cleanOutputTokens !== undefined && { outputTokens: cleanOutputTokens }),
        ...(cleanCacheReadTokens !== undefined && { cacheReadTokens: cleanCacheReadTokens }),
        ...(cleanCacheCreationTokens !== undefined && { cacheCreationTokens: cleanCacheCreationTokens }),
        ...(cleanDurationMs !== undefined && { durationMs: cleanDurationMs }),
        ...(cleanCostUsd !== undefined && { costUsd: cleanCostUsd }),
        ...(typeof branch === 'string' && branch.length <= 500 && { branch }),
        ...(cleanStatus !== undefined && { status: cleanStatus }),
        // Re-opening a completed session clears endedAt
        ...(cleanStatus === 'RUNNING' && { endedAt: null }),
        // Track last real activity (prompt/tool use) for IDLE detection
        lastActivityAt: new Date(),
      },
    });

    // Git capture: store incremental commit data (sent by post-commit hook)
    const { gitCapture } = req.body;
    if (gitCapture && typeof gitCapture === 'object') {
      const session = await prisma.codingSession.findUnique({
        where: { id },
        include: { commit: { select: { repoId: true } } },
      });

      if (session?.commit?.repoId) {
        const rawCommitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }> =
          Array.isArray(gitCapture.commitDetails) ? gitCapture.commitDetails : [];
        // Cap commit fan-out — without this a malicious client could fire
        // thousands of INSERTs in a single PATCH.
        const commitDetails = rawCommitDetails.slice(0, MAX_COMMIT_DETAILS);
        // Cap diff size before any downstream storage / concat.
        if (typeof gitCapture.diff === 'string' && gitCapture.diff.length > MAX_DIFF_LEN) {
          gitCapture.diff = gitCapture.diff.slice(0, MAX_DIFF_LEN);
        }

        // Count lines from diff if linesAdded/linesRemoved not provided.
        // This is pure computation so it runs before the transaction.
        let patchLinesAdded = gitCapture.linesAdded || 0;
        let patchLinesRemoved = gitCapture.linesRemoved || 0;
        if (patchLinesAdded === 0 && patchLinesRemoved === 0 && gitCapture.diff) {
          const diffLines = gitCapture.diff.split('\n');
          for (const line of diffLines) {
            if (line.startsWith('+') && !line.startsWith('+++')) patchLinesAdded++;
            else if (line.startsWith('-') && !line.startsWith('---')) patchLinesRemoved++;
          }
        }

        // Everything below mutates related rows (Commit, SessionDiff,
        // CodingSession) that must stay consistent with each other — e.g.
        // if we create the commits but crash before writing SessionDiff,
        // the dashboard would show a session with orphan commits but no
        // diff, and the line counters on CodingSession would be off by
        // however much we'd already merged from a prior partial call.
        // Wrap in an interactive transaction so the whole block commits
        // or rolls back as one unit. 15s timeout is generous for the
        // largest real payloads we've observed.
        const repoIdForCommit = session.commit.repoId;
        await prisma.$transaction(
          async (tx) => {
            // Create or link Commit records for each new commit
            for (const detail of commitDetails) {
              const existing = await tx.commit.findFirst({ where: { sha: detail.sha, repoId: repoIdForCommit } });
              if (existing) {
                // Commit already exists (e.g., created by GitHub webhook) — link it to this session
                if (!existing.sessionId) {
                  await tx.commit.update({
                    where: { id: existing.id },
                    data: {
                      sessionId: id,
                      aiToolDetected: existing.aiToolDetected || session.model || 'unknown',
                      aiDetectionMethod: existing.aiDetectionMethod || 'session',
                    },
                  });
                }
              } else {
                await tx.commit.create({
                  data: {
                    repoId: repoIdForCommit,
                    sha: detail.sha,
                    message: detail.message || '',
                    author: detail.author || 'ai-agent',
                    aiToolDetected: session.model || 'unknown',
                    aiDetectionMethod: 'session',
                    filesChanged: JSON.stringify(detail.filesChanged || []),
                    committedAt: new Date(),
                    sessionId: id,
                  },
                });
              }
            }

            // Upsert SessionDiff — merge with existing if present
            const existingDiff = await tx.sessionDiff.findUnique({ where: { sessionId: id } });
            if (existingDiff) {
              // Merge: append new diff, update headAfter, merge commitShas.
              // Guard the JSON.parse — a corrupt commitShas payload should
              // not take down the whole session update; fall back to an
              // empty list and log.
              let existingShas: string[] = [];
              try {
                existingShas = JSON.parse(existingDiff.commitShas || '[]') as string[];
                if (!Array.isArray(existingShas)) existingShas = [];
              } catch (err) {
                console.error('[mcp/session] failed to parse existing commitShas', {
                  sessionId: id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              const newShas = (gitCapture.commitShas || []) as string[];
              const mergedShas = [...new Set([...existingShas, ...newShas])];
              await tx.sessionDiff.update({
                where: { sessionId: id },
                data: {
                  headAfter: gitCapture.headAfter || existingDiff.headAfter,
                  commitShas: JSON.stringify(mergedShas),
                  diff: existingDiff.diff + '\n' + (gitCapture.diff || ''),
                  linesAdded: (existingDiff.linesAdded || 0) + patchLinesAdded,
                  linesRemoved: (existingDiff.linesRemoved || 0) + patchLinesRemoved,
                },
              });
            } else {
              await tx.sessionDiff.create({
                data: {
                  sessionId: id,
                  headBefore: gitCapture.headBefore || '',
                  headAfter: gitCapture.headAfter || '',
                  commitShas: JSON.stringify(gitCapture.commitShas || []),
                  diff: gitCapture.diff || '',
                  diffTruncated: gitCapture.diffTruncated || false,
                  linesAdded: patchLinesAdded,
                  linesRemoved: patchLinesRemoved,
                },
              });
            }

            // Update session line counts
            if (patchLinesAdded || patchLinesRemoved) {
              await tx.codingSession.update({
                where: { id },
                data: {
                  linesAdded: { increment: patchLinesAdded },
                  linesRemoved: { increment: patchLinesRemoved },
                },
              });
            }
          },
          { timeout: 15000 },
        );

        // Scan incremental diff for secrets (fire-and-forget)
        if (gitCapture.diff && session?.commit?.repoId) {
          const commitOrgId = (await prisma.repo.findUnique({ where: { id: session.commit.repoId }, select: { orgId: true } }))?.orgId;
          if (commitOrgId) {
            scanForSecrets(id, gitCapture.diff, commitOrgId)
              .catch(err => console.error('[secret-scanner] Incremental scan error:', err));
          }
        }
      }
    }

    // Upsert prompt→file change mappings (append/update, never delete previous prompts)
    // Count existing prompts BEFORE upsert so we know if new ones were added
    let prevPromptCount = 0;
    if (promptChanges && Array.isArray(promptChanges) && promptChanges.length > 0) {
      prevPromptCount = await prisma.promptChange.count({ where: { sessionId: id } });
      // Cap row count so a client can't ask us to insert a million rows.
      const capped = promptChanges.slice(0, MAX_PROMPT_CHANGES);
      await Promise.all(capped.map(async (pc: any) => {
        const promptIndex = Number.isFinite(Number(pc?.promptIndex)) ? Number(pc.promptIndex) : 0;
        const promptText = (typeof pc?.promptText === 'string' ? pc.promptText : '').slice(0, 1000);
        const filesChanged = JSON.stringify(
          Array.isArray(pc?.filesChanged)
            ? pc.filesChanged.slice(0, MAX_FILES_CHANGED).filter((f: unknown) => typeof f === 'string')
            : [],
        );
        const diff = (typeof pc?.diff === 'string' ? pc.diff : '').slice(0, 200_000);
        const uncommittedDiff = (typeof pc?.uncommittedDiff === 'string' ? pc.uncommittedDiff : '').slice(0, 200_000);

        // Never overwrite non-empty data with empty data (prevents heartbeats from clearing diffs)
        const existing = await prisma.promptChange.findUnique({
          where: { sessionId_promptIndex: { sessionId: id, promptIndex } },
          select: { promptText: true, filesChanged: true, diff: true, uncommittedDiff: true },
        });

        // Snapshot metadata fields
        const pcLinesAdded = Number.isFinite(Number(pc?.linesAdded)) ? Number(pc.linesAdded) : 0;
        const pcLinesRemoved = Number.isFinite(Number(pc?.linesRemoved)) ? Number(pc.linesRemoved) : 0;
        const pcAiPercentage = Number.isFinite(Number(pc?.aiPercentage)) ? Number(pc.aiPercentage) : 100;
        const pcCheckpointType = typeof pc?.checkpointType === 'string' ? pc.checkpointType : null;
        const pcCommitSha = typeof pc?.commitSha === 'string' ? pc.commitSha : null;
        const pcTreeSha = typeof pc?.treeSha === 'string' ? pc.treeSha : null;

        const updateData = {
          promptText: promptText || existing?.promptText || '',
          filesChanged: (filesChanged && filesChanged !== '[]') ? filesChanged : (existing?.filesChanged || '[]'),
          diff: diff || existing?.diff || '',
          uncommittedDiff: uncommittedDiff || existing?.uncommittedDiff || '',
          ...(pcLinesAdded > 0 && { linesAdded: pcLinesAdded }),
          ...(pcLinesRemoved > 0 && { linesRemoved: pcLinesRemoved }),
          ...(pcAiPercentage !== 100 && { aiPercentage: pcAiPercentage }),
          ...(pcCheckpointType && { checkpointType: pcCheckpointType }),
          ...(pcCommitSha && { commitSha: pcCommitSha }),
          ...(pcTreeSha && { treeSha: pcTreeSha }),
        };

        return prisma.promptChange.upsert({
          where: { sessionId_promptIndex: { sessionId: id, promptIndex } },
          update: updateData,
          create: { sessionId: id, promptIndex, ...updateData },
        });
      }));

      // Roll the per-prompt line counts up to the session row so the header
      // aggregate stays in sync. Without this the session shows +0/−0 while
      // individual turns clearly show changes — misleading the user.
      // Only re-aggregate when the client didn't send an explicit session-level
      // value in this PATCH (explicit wins, sum is fallback).
      if (cleanLinesAdded === undefined || cleanLinesRemoved === undefined) {
        const agg = await prisma.promptChange.aggregate({
          where: { sessionId: id },
          _sum: { linesAdded: true, linesRemoved: true },
        });
        await prisma.codingSession.update({
          where: { id },
          data: {
            ...(cleanLinesAdded === undefined && { linesAdded: agg._sum.linesAdded ?? 0 }),
            ...(cleanLinesRemoved === undefined && { linesRemoved: agg._sum.linesRemoved ?? 0 }),
          },
        });
      }
    }

    // Emit rich real-time events for Live Feed
    const now = new Date().toISOString();
    const emitOrgId = req.orgId as string;
    const emitUserId = req.mcpUserId;

    // Always emit a generic update
    emitSessionEvent({ type: 'session:updated', sessionId: id, orgId: emitOrgId, userId: emitUserId, timestamp: now });

    // Emit prompt event only when NEW prompts are added (not re-sent duplicates)
    if (promptChanges && Array.isArray(promptChanges) && promptChanges.length > prevPromptCount) {
      const latest = promptChanges[promptChanges.length - 1];
      emitSessionEvent({
        type: 'session:prompt',
        sessionId: id,
        orgId: emitOrgId,
        userId: emitUserId,
        timestamp: now,
        data: {
          promptIndex: latest?.promptIndex ?? promptChanges.length - 1,
          promptText: (typeof latest?.promptText === 'string' ? latest.promptText : '').slice(0, 200),
          filesChanged: Array.isArray(latest?.filesChanged) ? latest.filesChanged.slice(0, 10) : [],
          promptCount: promptChanges.length,
        },
      });
    }

    // Emit metrics update when tokens/cost change
    if (tokensUsed !== undefined || costUsd !== undefined) {
      emitSessionEvent({
        type: 'session:metrics',
        sessionId: id,
        orgId: emitOrgId,
        userId: emitUserId,
        timestamp: now,
        data: {
          tokensUsed: cleanTokensUsed,
          costUsd: cleanCostUsd,
          linesAdded: cleanLinesAdded,
          linesRemoved: cleanLinesRemoved,
          toolCalls: cleanToolCalls,
          durationMs: cleanDurationMs,
        },
      });
    }

    // Emit output event when transcript is updated (agent console output)
    if (cleanTranscript) {
      // Send last 20 000 chars so the Live Feed has full recent context
      const tail = cleanTranscript.length > 20_000 ? cleanTranscript.slice(-20_000) : cleanTranscript;
      emitSessionEvent({
        type: 'session:output',
        sessionId: id,
        orgId: emitOrgId,
        userId: emitUserId,
        timestamp: now,
        data: {
          output: tail,
          totalLength: cleanTranscript.length,
        },
      });
    }

    // Emit files event when new files are changed
    if (filesChanged && Array.isArray(filesChanged) && filesChanged.length > 0) {
      emitSessionEvent({
        type: 'session:files',
        sessionId: id,
        orgId: emitOrgId,
        userId: emitUserId,
        timestamp: now,
        data: { files: filesChanged.slice(0, 20) },
      });
    }

    // Emit commit event when git capture has new commits
    if (gitCapture && Array.isArray(gitCapture.commitDetails) && gitCapture.commitDetails.length > 0) {
      for (const detail of gitCapture.commitDetails.slice(0, 5)) {
        emitSessionEvent({
          type: 'session:commit',
          sessionId: id,
          orgId: emitOrgId,
          userId: emitUserId,
          timestamp: now,
          data: {
            sha: detail.sha?.slice(0, 8),
            message: (detail.message || '').slice(0, 120),
            filesChanged: Array.isArray(detail.filesChanged) ? detail.filesChanged.length : 0,
          },
        });
      }
    }

    // Real-time agent limit enforcement (check during active session, not just at end)
    // Run in background — never block the hook response
    if (costUsd !== undefined || tokensUsed !== undefined) {
      (async () => {
        try {
          const session = await prisma.codingSession.findUnique({
            where: { id },
            select: {
              agentId: true, model: true, costUsd: true, tokensUsed: true,
              toolCalls: true, linesAdded: true, linesRemoved: true, durationMs: true,
              commit: { select: { repoId: true } },
            },
          });
          if (!session?.agentId) return;

          const result = await enforceAgentLimits({
            sessionId: id,
            orgId: req.orgId as string,
            model: session.model,
            costUsd: session.costUsd,
            tokensUsed: session.tokensUsed,
            toolCalls: session.toolCalls,
            linesAdded: session.linesAdded,
            linesRemoved: session.linesRemoved,
            durationMs: session.durationMs,
            filesChanged: [],
            agentId: session.agentId,
            machineId: null,
            repoId: session.commit?.repoId ?? null,
          });

          if (result.violations.length > 0) {
            console.log(`[agent-limits] Session ${id} flagged mid-session: ${result.violations.map(v => v.message).join('; ')}`);
          }
        } catch (err) {
          console.error('[agent-limits] Real-time check error:', err);
        }
      })();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/end — end a coding session
router.post('/session/end', async (req: McpRequest, res: Response) => {
  try {
    const {
      sessionId,
      prompt,
      summary,
      transcript,
      tokensUsed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      toolCalls,
      linesAdded,
      linesRemoved,
      costUsd,
      filesChanged,
      durationMs,
      branch,
    } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing required field: sessionId' });
    }

    const orgId = req.orgId as string;

    // Update the coding session with final data
    // transcript field: prefer full transcript if provided, fall back to summary
    const transcriptValue = transcript || summary;

    // Check session exists AND belongs to this org. The old findUnique
    // lookup by id alone let any valid API key close (and mutate
    // tokens/cost/transcript on) any session in any tenant. Scope
    // through commit.repo.orgId.
    const existingSession = await prisma.codingSession.findFirst({
      where: { id: sessionId, commit: { repo: { orgId } } },
    });
    if (!existingSession) {
      return res.status(404).json({ error: 'Session not found', sessionId });
    }

    // Same clamping as PATCH /session/:id — keep hostile payloads out of the DB.
    const cleanPromptEnd = clampStr(prompt, MAX_PROMPT_LEN);
    const cleanTranscriptEnd = clampStr(transcriptValue, MAX_TRANSCRIPT_LEN);
    const cleanToolCallsEnd = clampNum(toolCalls);
    const cleanTokensUsedEnd = clampNum(tokensUsed);
    const cleanInputTokensEnd = clampNum(inputTokens);
    const cleanOutputTokensEnd = clampNum(outputTokens);
    const cleanCacheReadTokensEnd = clampNum(cacheReadTokens);
    const cleanCacheCreationTokensEnd = clampNum(cacheCreationTokens);
    const cleanLinesAddedEnd = clampNum(linesAdded);
    const cleanLinesRemovedEnd = clampNum(linesRemoved);
    const cleanCostUsdEnd = clampNum(costUsd);
    const cleanDurationMsEnd = clampNum(durationMs);
    let cleanFilesChangedEndStr: string | undefined;
    if (filesChanged !== undefined) {
      const arr = Array.isArray(filesChanged) ? filesChanged : [];
      const capped = arr
        .slice(0, MAX_FILES_CHANGED)
        .filter((f): f is string => typeof f === 'string')
        .map((f) => (f.length > MAX_FILE_PATH_LEN ? f.slice(0, MAX_FILE_PATH_LEN) : f));
      cleanFilesChangedEndStr = JSON.stringify(capped);
    }

    const codingSession = await prisma.codingSession.update({
      where: { id: sessionId },
      data: {
        ...(cleanPromptEnd !== undefined && { prompt: cleanPromptEnd }),
        ...(cleanTranscriptEnd !== undefined && { transcript: cleanTranscriptEnd }),
        ...(cleanTokensUsedEnd !== undefined && { tokensUsed: cleanTokensUsedEnd }),
        ...(cleanInputTokensEnd !== undefined && { inputTokens: cleanInputTokensEnd }),
        ...(cleanOutputTokensEnd !== undefined && { outputTokens: cleanOutputTokensEnd }),
        ...(cleanCacheReadTokensEnd !== undefined && { cacheReadTokens: cleanCacheReadTokensEnd }),
        ...(cleanCacheCreationTokensEnd !== undefined && { cacheCreationTokens: cleanCacheCreationTokensEnd }),
        ...(cleanToolCallsEnd !== undefined && { toolCalls: cleanToolCallsEnd }),
        ...(cleanLinesAddedEnd !== undefined && { linesAdded: cleanLinesAddedEnd }),
        ...(cleanLinesRemovedEnd !== undefined && { linesRemoved: cleanLinesRemovedEnd }),
        ...(cleanCostUsdEnd !== undefined && { costUsd: cleanCostUsdEnd }),
        ...(cleanFilesChangedEndStr !== undefined && { filesChanged: cleanFilesChangedEndStr }),
        ...(cleanDurationMsEnd !== undefined && { durationMs: cleanDurationMsEnd }),
        ...(typeof branch === 'string' && branch.length <= 500 && { branch }),
        status: 'COMPLETED',
        endedAt: new Date(),
      },
      include: { commit: { select: { repoId: true } } },
    });

    // Update the commit message — use summary, fall back to the payload
    // prompt, then to whatever prompt was already stored on the session at
    // session/start. Without this last fallback, sessions that don't resend
    // the prompt on session/end leave the placeholder commit with an empty
    // `message` and the commits list shows blank rows.
    const messageSource = summary
      || (prompt ? prompt.slice(0, 200) : '')
      || (existingSession.prompt ? existingSession.prompt.slice(0, 200) : '');
    // Same treatment for the author — if the placeholder was stamped with
    // "mcp-agent" at session/start (no user context yet) and we now have
    // the session's user or apiKeyName, upgrade the author string.
    let updatedAuthor: string | null = null;
    try {
      const placeholderCommit = await prisma.commit.findUnique({
        where: { id: codingSession.commitId },
        select: { author: true },
      });
      if (placeholderCommit?.author === 'mcp-agent') {
        if (existingSession.userId) {
          const u = await prisma.user.findUnique({
            where: { id: existingSession.userId },
            select: { name: true, email: true },
          });
          updatedAuthor = u?.name || u?.email || existingSession.apiKeyName || null;
        } else if (existingSession.apiKeyName) {
          updatedAuthor = existingSession.apiKeyName;
        }
      }
    } catch { /* non-fatal */ }

    if (messageSource || updatedAuthor) {
      // Re-run AI detection on the real commit message (may have Co-Authored-By trailers)
      const detection = messageSource ? detectAITool(messageSource, '') : { aiToolDetected: null, aiDetectionMethod: null };
      await prisma.commit.update({
        where: { id: codingSession.commitId },
        data: {
          ...(messageSource && { message: messageSource }),
          ...(updatedAuthor && { author: updatedAuthor }),
          ...(detection.aiToolDetected ? {
            aiToolDetected: detection.aiToolDetected,
            aiDetectionMethod: detection.aiDetectionMethod,
          } : {}),
        },
      });
    }

    // ── Git Capture: store real commit SHAs, diffs, and prompt→change mappings ──

    const { gitCapture, promptChanges } = req.body;

    if (gitCapture && typeof gitCapture === 'object') {
      const repoId = codingSession.commit.repoId;
      // Cap commit fan-out and diff size to keep hostile payloads bounded.
      const rawCommitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }> =
        Array.isArray(gitCapture.commitDetails) ? gitCapture.commitDetails : [];
      const commitDetails = rawCommitDetails.slice(0, MAX_COMMIT_DETAILS);
      if (typeof gitCapture.diff === 'string' && gitCapture.diff.length > MAX_DIFF_LEN) {
        gitCapture.diff = gitCapture.diff.slice(0, MAX_DIFF_LEN);
      }

      // Update placeholder commit SHA with real value
      const realSha = (gitCapture.commitShas?.length > 0)
        ? gitCapture.commitShas[0]         // First real commit SHA
        : (gitCapture.headAfter || null);  // Or HEAD at session end

      if (realSha) {
        // Check if a commit with this SHA already exists (e.g., created by GitHub webhook)
        const existingReal = await prisma.commit.findFirst({
          where: { repoId, sha: realSha },
        });

        if (existingReal && existingReal.id !== codingSession.commitId) {
          // A webhook-created commit exists — link it to this session and delete the placeholder
          await prisma.commit.update({
            where: { id: existingReal.id },
            data: {
              sessionId: sessionId,
              aiToolDetected: existingReal.aiToolDetected || codingSession.model || 'unknown',
              aiDetectionMethod: existingReal.aiDetectionMethod || 'session',
            },
          });
          // Move the session's primary commit to the real one
          await prisma.codingSession.update({
            where: { id: sessionId },
            data: { commitId: existingReal.id },
          });
          // Delete the placeholder commit
          await prisma.commit.delete({ where: { id: codingSession.commitId } });
        } else {
          // No duplicate — update the placeholder with real SHA
          const firstDetail = commitDetails.find(d => d.sha.startsWith(realSha) || realSha.startsWith(d.sha));
          await prisma.commit.update({
            where: { id: codingSession.commitId },
            data: {
              sha: realSha,
              message: firstDetail?.message || messageSource || '',
              author: firstDetail?.author || updatedAuthor || 'ai-agent',
              filesChanged: firstDetail ? JSON.stringify(firstDetail.filesChanged) : '[]',
            },
          });
        }
      }

      // Create or link individual Commit records for remaining SHAs
      if (commitDetails.length > 1) {
        for (const detail of commitDetails) {
          // Skip the first commit (already stored as the primary commit)
          if (detail.sha === realSha || detail.sha.startsWith(realSha?.slice(0, 7) || '___') || realSha?.startsWith(detail.sha.slice(0, 7))) {
            continue;
          }
          const existingCommit = await prisma.commit.findFirst({ where: { sha: detail.sha, repoId } });
          if (existingCommit) {
            // Link existing commit (e.g., from webhook) to this session
            if (!existingCommit.sessionId) {
              await prisma.commit.update({
                where: { id: existingCommit.id },
                data: {
                  sessionId,
                  aiToolDetected: existingCommit.aiToolDetected || codingSession.model,
                  aiDetectionMethod: existingCommit.aiDetectionMethod || 'session',
                },
              });
            }
          } else {
            await prisma.commit.create({
              data: {
                repoId,
                sha: detail.sha,
                message: detail.message || '',
                author: detail.author || 'ai-agent',
                aiToolDetected: codingSession.model,
                aiDetectionMethod: 'session',
                filesChanged: JSON.stringify(detail.filesChanged || []),
                committedAt: new Date(),
                sessionId,
              },
            });
          }
        }
      }

      // If linesAdded/linesRemoved are missing but diff exists, count from diff
      let diffLinesAdded = gitCapture.linesAdded || 0;
      let diffLinesRemoved = gitCapture.linesRemoved || 0;
      if (diffLinesAdded === 0 && diffLinesRemoved === 0 && gitCapture.diff) {
        const diffLines = gitCapture.diff.split('\n');
        for (const line of diffLines) {
          if (line.startsWith('+') && !line.startsWith('+++')) diffLinesAdded++;
          else if (line.startsWith('-') && !line.startsWith('---')) diffLinesRemoved++;
        }
      }

      // Create or MERGE SessionDiff record — append new diff to existing
      const existingEndDiff = await prisma.sessionDiff.findUnique({ where: { sessionId } });
      if (existingEndDiff) {
        // Merge: append new diff, combine commit SHAs, keep earliest headBefore
        let existingEndShas: string[] = [];
        try { existingEndShas = JSON.parse(existingEndDiff.commitShas || '[]'); } catch {}
        const newEndShas = (gitCapture.commitShas || []) as string[];
        const mergedEndShas = [...new Set([...existingEndShas, ...newEndShas])];
        const mergedDiff = existingEndDiff.diff
          ? existingEndDiff.diff + '\n' + (gitCapture.diff || '')
          : (gitCapture.diff || '');
        await prisma.sessionDiff.update({
          where: { sessionId },
          data: {
            headAfter: gitCapture.headAfter || existingEndDiff.headAfter,
            commitShas: JSON.stringify(mergedEndShas),
            diff: mergedDiff,
            diffTruncated: gitCapture.diffTruncated || existingEndDiff.diffTruncated,
            linesAdded: (existingEndDiff.linesAdded || 0) + diffLinesAdded,
            linesRemoved: (existingEndDiff.linesRemoved || 0) + diffLinesRemoved,
          },
        });
      } else {
        await prisma.sessionDiff.create({
          data: {
            sessionId,
            headBefore: gitCapture.headBefore || '',
            headAfter: gitCapture.headAfter || '',
            commitShas: JSON.stringify(gitCapture.commitShas || []),
            diff: gitCapture.diff || '',
            diffTruncated: gitCapture.diffTruncated || false,
            linesAdded: diffLinesAdded,
            linesRemoved: diffLinesRemoved,
          },
        });
      }

      // Update session lines from actual diff counts (more accurate than estimates)
      if (diffLinesAdded || diffLinesRemoved) {
        await prisma.codingSession.update({
          where: { id: sessionId },
          data: {
            linesAdded: diffLinesAdded,
            linesRemoved: diffLinesRemoved,
          },
        });
      }

      // Bidirectional backlink: for each commit SHA in this session's diff,
      // update any existing Commit rows in the same org to point at this session.
      // This handles the case where the commit was already synced from
      // GitHub/GitLab (and looked Human) before the CLI uploaded the session.
      try {
        const shas: string[] = Array.isArray(gitCapture.commitShas) ? gitCapture.commitShas : [];
        if (shas.length > 0) {
          const sess = await prisma.codingSession.findUnique({
            where: { id: sessionId },
            select: {
              model: true,
              commit: { select: { repo: { select: { orgId: true } } } },
              agent: { select: { name: true } },
            },
          });
          const tool = sess?.agent?.name?.toLowerCase() || sess?.model || 'ai';
          const orgId = sess?.commit?.repo?.orgId;
          if (orgId) {
            await prisma.commit.updateMany({
              where: {
                sha: { in: shas },
                sessionId: null,
                repo: { orgId },
              },
              data: {
                sessionId,
                aiToolDetected: tool,
                aiDetectionMethod: 'session-diff-link',
              },
            });
          }
        }
      } catch (e) {
        console.error('SessionDiff → Commit backlink failed:', e);
      }
    }

    // Upsert prompt→file change mappings (same pattern as PATCH handler)
    if (promptChanges && Array.isArray(promptChanges) && promptChanges.length > 0) {
      const capped = promptChanges.slice(0, MAX_PROMPT_CHANGES);
      await Promise.all(capped.map(async (pc: any) => {
        const promptIndex = Number.isFinite(Number(pc?.promptIndex)) ? Number(pc.promptIndex) : 0;
        const promptText = (typeof pc?.promptText === 'string' ? pc.promptText : '').slice(0, 1000);
        const filesChanged = JSON.stringify(
          Array.isArray(pc?.filesChanged)
            ? pc.filesChanged.slice(0, MAX_FILES_CHANGED).filter((f: unknown) => typeof f === 'string')
            : [],
        );
        const diff = (typeof pc?.diff === 'string' ? pc.diff : '').slice(0, 200_000);
        const uncommittedDiff = (typeof pc?.uncommittedDiff === 'string' ? pc.uncommittedDiff : '').slice(0, 200_000);

        // Never overwrite non-empty data with empty data
        const existing = await prisma.promptChange.findUnique({
          where: { sessionId_promptIndex: { sessionId, promptIndex } },
          select: { promptText: true, filesChanged: true, diff: true, uncommittedDiff: true },
        });

        // Snapshot metadata fields
        const pcLinesAdded = Number.isFinite(Number(pc?.linesAdded)) ? Number(pc.linesAdded) : 0;
        const pcLinesRemoved = Number.isFinite(Number(pc?.linesRemoved)) ? Number(pc.linesRemoved) : 0;
        const pcAiPercentage = Number.isFinite(Number(pc?.aiPercentage)) ? Number(pc.aiPercentage) : 100;
        const pcCheckpointType = typeof pc?.checkpointType === 'string' ? pc.checkpointType : null;
        const pcCommitSha = typeof pc?.commitSha === 'string' ? pc.commitSha : null;
        const pcTreeSha = typeof pc?.treeSha === 'string' ? pc.treeSha : null;

        const updateData = {
          promptText: promptText || existing?.promptText || '',
          filesChanged: (filesChanged && filesChanged !== '[]') ? filesChanged : (existing?.filesChanged || '[]'),
          diff: diff || existing?.diff || '',
          uncommittedDiff: uncommittedDiff || existing?.uncommittedDiff || '',
          ...(pcLinesAdded > 0 && { linesAdded: pcLinesAdded }),
          ...(pcLinesRemoved > 0 && { linesRemoved: pcLinesRemoved }),
          ...(pcAiPercentage !== 100 && { aiPercentage: pcAiPercentage }),
          ...(pcCheckpointType && { checkpointType: pcCheckpointType }),
          ...(pcCommitSha && { commitSha: pcCommitSha }),
          ...(pcTreeSha && { treeSha: pcTreeSha }),
        };

        return prisma.promptChange.upsert({
          where: { sessionId_promptIndex: { sessionId, promptIndex } },
          update: updateData,
          create: { sessionId, promptIndex, ...updateData },
        });
      }));
    }

    // Log audit event
    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'SESSION_ENDED',
        resource: sessionId,
        metadata: JSON.stringify({ sessionId, tokensUsed, toolCalls, durationMs, costUsd }),
      },
    });

    emitSessionEvent({
      type: 'session:ended',
      sessionId,
      orgId,
      data: { costUsd, tokensUsed, toolCalls, durationMs },
      timestamp: new Date().toISOString(),
    });

    // Record spend for budget tracking
    if (costUsd) {
      await recordSpend(orgId, costUsd);
    }

    // Trigger AI auto-review in background (don't block response)
    let parsedFiles: string[] = [];
    if (Array.isArray(filesChanged)) {
      parsedFiles = filesChanged;
    } else if (typeof filesChanged === 'string' && filesChanged) {
      try {
        const parsed = JSON.parse(filesChanged);
        parsedFiles = Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.warn(`[mcp] malformed filesChanged for session ${sessionId}:`, (err as Error).message);
      }
    }

    // Send Slack notification for session completion (fire-and-forget)
    const sessionCost = costUsd ?? 0;
    const sessionDuration = durationMs ? `${Math.round(durationMs / 60000)}min` : 'unknown';
    const fileCount = parsedFiles.length || 0;
    sendSlackNotification({
      orgId,
      type: 'SESSION_COMPLETED',
      title: 'AI Session Completed',
      message: `*${codingSession.model}* session finished — $${sessionCost.toFixed(2)} • ${fileCount} file${fileCount !== 1 ? 's' : ''} • ${sessionDuration}`,
      link: `/sessions/${sessionId}`,
    }).catch((err) => {
      console.warn(`[mcp] Slack session-completed notification failed for org ${orgId}:`, (err as Error).message);
    });

    // AI auto-review disabled by default — run manually via dashboard or origin review
    // TODO: add org-level setting to enable auto-review
    // runAIReview({ ... }).catch(err => console.error('[ai-review] Background error:', err));

    // Run secret/PII scanner on the diff in background
    // Use gitCapture.diff if available, otherwise read stored diff from sessionDiff
    const scanDiff = gitCapture?.diff || null;
    if (scanDiff) {
      scanForSecrets(sessionId, scanDiff, orgId)
        .catch(err => console.error('[secret-scanner] Background error:', err));
    } else {
      // No diff in session-end payload — scan the incrementally stored diff
      prisma.sessionDiff.findUnique({ where: { sessionId } }).then(stored => {
        if (stored?.diff) {
          scanForSecrets(sessionId, stored.diff, orgId)
            .catch(err => console.error('[secret-scanner] Background error:', err));
        }
      }).catch(err => console.error('[secret-scanner] Diff lookup error:', err));
    }

    // Look up machine DB id for policy scoping at session end
    const endMachineId = req.body.machineId
      ? (await prisma.machine.findFirst({ where: { machineId: req.body.machineId } }))?.id ?? null
      : null;
    const sessionRepoId = codingSession.commit?.repoId ?? null;

    // Collect commit messages from gitCapture for COMMIT_MESSAGE policy
    const commitMessages: string[] = [];
    if (gitCapture?.commitDetails && Array.isArray(gitCapture.commitDetails)) {
      for (const d of gitCapture.commitDetails) {
        if (d.message) commitMessages.push(d.message);
      }
    }

    // Get diff content for CONTENT_FILTER policy
    const diffContentForPolicy: string | null = gitCapture?.diff || null;

    // Run policy engine enforcement in background
    enforceSessionEnd({
      sessionId,
      orgId,
      model: codingSession.model,
      costUsd: costUsd ?? codingSession.costUsd ?? 0,
      tokensUsed: tokensUsed ?? codingSession.tokensUsed ?? 0,
      toolCalls: toolCalls ?? codingSession.toolCalls ?? 0,
      linesAdded: linesAdded ?? codingSession.linesAdded ?? 0,
      linesRemoved: linesRemoved ?? codingSession.linesRemoved ?? 0,
      durationMs: durationMs ?? codingSession.durationMs ?? 0,
      filesChanged: parsedFiles,
      diffContent: diffContentForPolicy,
      commitMessages,
      agentId: codingSession.agentId,
      machineId: endMachineId,
      repoId: sessionRepoId,
    }).then(async (result) => {
      if (result.violations.length > 0) {
        await applyEnforcementActions({
          sessionId,
          orgId,
          model: codingSession.model,
          costUsd: costUsd ?? codingSession.costUsd ?? 0,
          tokensUsed: tokensUsed ?? codingSession.tokensUsed ?? 0,
          toolCalls: toolCalls ?? codingSession.toolCalls ?? 0,
          linesAdded: linesAdded ?? codingSession.linesAdded ?? 0,
          linesRemoved: linesRemoved ?? codingSession.linesRemoved ?? 0,
          durationMs: durationMs ?? codingSession.durationMs ?? 0,
          filesChanged: parsedFiles,
          agentId: codingSession.agentId,
          machineId: endMachineId,
          repoId: sessionRepoId,
        }, result);
      }
      // Update GitHub PR status checks for any PRs linked to this session's commits
      const prsUpdated = await updateSessionPRChecks(sessionId, orgId);
      if (prsUpdated > 0) {
        console.log(`[pr-checks] Updated ${prsUpdated} PR(s) after session ${sessionId} enforcement`);
      }
      // Also update GitLab MR status checks
      const mrsUpdated = await updateSessionMRChecks(sessionId, orgId);
      if (mrsUpdated > 0) {
        console.log(`[mr-checks] Updated ${mrsUpdated} MR(s) after session ${sessionId} enforcement`);
      }
    }).catch(err => console.error('[policy-engine] Background error:', err));

    // Run agent-level limits enforcement in background
    enforceAgentLimits({
      sessionId,
      orgId,
      model: codingSession.model,
      costUsd: costUsd ?? codingSession.costUsd ?? 0,
      tokensUsed: tokensUsed ?? codingSession.tokensUsed ?? 0,
      toolCalls: toolCalls ?? codingSession.toolCalls ?? 0,
      linesAdded: linesAdded ?? codingSession.linesAdded ?? 0,
      linesRemoved: linesRemoved ?? codingSession.linesRemoved ?? 0,
      durationMs: durationMs ?? codingSession.durationMs ?? 0,
      filesChanged: parsedFiles,
      agentId: codingSession.agentId,
      machineId: endMachineId,
      repoId: sessionRepoId,
    }).then(async (result) => {
      // If agent limits were violated, also update PR/MR checks
      if (result.violations.length > 0) {
        await updateSessionPRChecks(sessionId, orgId);
        await updateSessionMRChecks(sessionId, orgId);
      }
    }).catch(err => console.error('[agent-limits] Background error:', err));

    res.json({ success: true });
  } catch (err: any) {
    console.error('End session error:', err?.message || err, err?.code, err?.meta);
    // Return more detail so CLI can debug
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /violations — report a policy violation
router.post('/violations', async (req: McpRequest, res: Response) => {
  try {
    const { machineId, policyId, description, filepath } = req.body;

    if (!machineId || !policyId || !description) {
      return res.status(400).json({ error: 'Missing required fields: machineId, policyId, description' });
    }

    // Sanitize metadata to prevent injection / storage abuse
    const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '');
    const safeDescription = stripHtml(String(description)).slice(0, 500);
    const safeFilepath = filepath ? stripHtml(String(filepath)).slice(0, 255) : undefined;

    const orgId = req.orgId as string;

    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'POLICY_VIOLATION',
        resource: policyId,
        metadata: JSON.stringify({ policyId, description: safeDescription, filepath: safeFilepath, machineId }),
      },
    });

    // Notify admins of policy violation
    await notifyOrgAdmins(
      orgId,
      'POLICY_VIOLATION',
      'Policy Violation Detected',
      `${safeDescription}${safeFilepath ? ` — ${safeFilepath}` : ''}`,
      '/audit',
      { policyId, description: safeDescription, filepath: safeFilepath, machineId }
    );

    res.json({ logged: true });
  } catch (err) {
    console.error('Report violation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /policies/:id/rules — add a rule to a policy (MCP auth)
router.post('/policies/:id/rules', async (req: McpRequest, res: Response) => {
  try {
    const policyId = req.params.id as string;
    const { condition, action, severity } = req.body;
    const orgId = req.orgId as string;

    const policy = await prisma.policy.findFirst({ where: { id: policyId, orgId } });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const rule = await prisma.policyRule.create({
      data: {
        policyId,
        condition: typeof condition === 'string' ? condition : JSON.stringify(condition),
        action: action || 'BLOCK',
        severity: severity || 'HIGH',
      },
    });

    res.status(201).json(rule);
  } catch (err) {
    console.error('Create MCP policy rule error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
