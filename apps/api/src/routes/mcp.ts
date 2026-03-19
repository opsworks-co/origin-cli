import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
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
  apiKeyName?: string; // Name of the API key (for standalone key attribution)
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
        repoScopes: { select: { repoId: true } },
        agentScopes: { select: { agentId: true } },
      },
    });

    if (!found) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.orgId = found.orgId;
    req.apiKeyName = found.name;
    req.repoScopes = found.repoScopes.map((s: { repoId: string }) => s.repoId);
    req.agentScopes = found.agentScopes.map((s: { agentId: string }) => s.agentId);
    // Standalone key (has role, no userId): no user attribution
    // Linked key: use the key's userId, fall back to org owner
    if (found.role && !found.userId) {
      req.mcpUserId = undefined;
    } else {
      req.mcpUserId = found.userId ?? found.org.users[0]?.id ?? undefined;
    }
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
    const { machineId, prompt, model, repoPath, repoUrl, agentSlug, branch } = req.body;

    if (!machineId || !model || !repoPath) {
      return res.status(400).json({ error: 'Missing required fields: machineId, model, repoPath' });
    }

    const orgId = req.orgId as string;
    console.log('[session/start]', { orgId, repoPath, repoUrl: repoUrl || '(none)', agentSlug, machineId });

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

    // Fall back to matching by directory name (includes partial match)
    if (!repo) {
      const dirName = repoPath.split('/').filter(Boolean).pop()?.toLowerCase();
      if (dirName) {
        const orgRepos = await prisma.repo.findMany({ where: { orgId } });
        repo = orgRepos.find((r) => {
          const repoName = r.path.split('/').pop()?.toLowerCase();
          // Exact match or one contains the other (worktrust-test ↔ worktrust)
          return repoName === dirName
            || dirName.includes(repoName || '')
            || (repoName || '').includes(dirName);
        }) || null;
      }
    }

    if (!repo) {
      const orgRepos = await prisma.repo.findMany({ where: { orgId }, select: { path: true } });
      console.log('[session/start] REPO NOT FOUND', { repoPath, repoUrl, orgRepoPaths: orgRepos.map(r => r.path) });
      return res.status(403).json({
        error: 'Repository not registered',
        message: `"${repoPath}" is not registered in Origin. Ask your admin to add it first.`,
      });
    }

    // Enforce repo-scoped API key access — no scopes = no access
    if (!req.repoScopes || req.repoScopes.length === 0 || !req.repoScopes.includes(repo.id)) {
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

    // Enforce API key → agent scope: no scopes = no access
    if (!req.agentScopes || req.agentScopes.length === 0) {
      return res.status(403).json({
        error: 'No agent access',
        message: 'This API key has no agent assignments. Assign agents in Settings → API Keys.',
      });
    }

    // Get all agents this API key has access to
    const allowedAgents = await prisma.agent.findMany({
      where: { orgId, id: { in: req.agentScopes }, status: 'ACTIVE' },
      select: agentSelect,
    });

    if (allowedAgents.length === 0) {
      return res.status(403).json({
        error: 'No active agents',
        message: 'This API key is assigned to agents that no longer exist or are inactive.',
      });
    }

    if (agentSlug) {
      // Try to match the tool type (claude-code, gemini, etc.) to an allowed agent
      const slugLower = agentSlug.toLowerCase();
      const prefix = slugLower.split('-')[0]; // "claude-code" → "claude"
      // Exact match first
      agent = allowedAgents.find((a) => {
        const n = (a.name || '').toLowerCase();
        const s = (a.slug || '').toLowerCase();
        return s === slugLower || s === prefix || n === slugLower || n === prefix;
      }) || null;
      // Fuzzy: name or slug contains the tool prefix
      if (!agent) {
        agent = allowedAgents.find((a) => {
          const n = (a.name || '').toLowerCase();
          const s = (a.slug || '').toLowerCase();
          return n.includes(prefix) || s.includes(prefix);
        }) || null;
      }
    }

    // If no match by slug, and key has exactly one agent, use that
    if (!agent && allowedAgents.length === 1) {
      agent = allowedAgents[0];
    }

    // If still no match and multiple agents, pick the best match or reject
    if (!agent) {
      return res.status(400).json({
        error: 'Ambiguous agent',
        message: `Could not determine which agent to use for tool "${agentSlug || 'unknown'}". This API key has access to: ${allowedAgents.map((a) => a.name).join(', ')}. Ensure agent names match the tool type (e.g. "Claude" for claude-code, "Gemini" for gemini).`,
      });
    }

    // Check model allowlist policies (with agent/machine/repo scope)
    const modelCheck = await enforceSessionStart(orgId, model, {
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

    // ── Server-side dedup: if a RUNNING or recently-ended session already exists
    //    for this machine + agent + repo, reuse it instead of creating a new one.
    //    Claude Code fires session-start on open AND on resume from idle, and the
    //    stale cleanup may have ended the session during idle. Reopen it.
    const dedupCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour window
    const existingSession = await prisma.codingSession.findFirst({
      where: {
        agentId: agent?.id || null,
        commit: { repoId: repo.id },
        startedAt: { gte: dedupCutoff },
        status: { in: ['RUNNING', 'COMPLETED'] },
      },
      include: { commit: { select: { repoId: true } } },
      orderBy: { startedAt: 'desc' },
    });

    if (existingSession) {
      // Check machine match via audit log (machineId is stored in metadata)
      const existingAudit = await prisma.auditLog.findFirst({
        where: {
          resource: existingSession.id,
          action: 'SESSION_STARTED',
        },
        orderBy: { createdAt: 'desc' },
      });
      const existingMachineId = existingAudit?.metadata
        ? JSON.parse(existingAudit.metadata as string)?.machineId
        : null;

      if (existingMachineId === machineId) {
        // Reopen the session if it was auto-ended
        if (existingSession.status === 'COMPLETED') {
          await prisma.codingSession.update({
            where: { id: existingSession.id },
            data: { status: 'RUNNING', endedAt: null },
          });
          console.log('[session/start] REOPEN: reopening auto-ended session', {
            existingId: existingSession.id, machineId,
          });
        } else {
          console.log('[session/start] DEDUP: returning existing running session', {
            existingId: existingSession.id, machineId,
          });
        }
        // Re-evaluate system prompt from live agent settings (not stale snapshot)
        let dedupPrompt = agent?.systemPrompt || existingSession.agentSystemPrompt || null;
        if (agent?.securityRulesEnabled === true) {
          const securityBlock = agent?.securityRules?.trim() || DEFAULT_SECURITY_RULES;
          dedupPrompt = dedupPrompt
            ? `${dedupPrompt}\n\n<security-rules>\n${securityBlock}\n</security-rules>`
            : `<security-rules>\n${securityBlock}\n</security-rules>`;
        }
        // Update the snapshot so future resumes also get the latest prompt
        if (dedupPrompt !== existingSession.agentSystemPrompt) {
          await prisma.codingSession.update({
            where: { id: existingSession.id },
            data: { agentSystemPrompt: dedupPrompt },
          });
        }
        // Return the existing session instead of creating a duplicate
        return res.json({
          sessionId: existingSession.id,
          agentSystemPrompt: dedupPrompt || undefined,
          activePolicies: [],
        });
      }
    }

    // Generate a placeholder SHA (random 40-char hex)
    const placeholderSha = crypto.randomBytes(20).toString('hex');

    // Create a commit with placeholder SHA (mark as session-detected AI)
    // Use API key name for standalone tokens so sessions show the token name
    const commitAuthor = req.mcpUserId ? 'mcp-agent' : (req.apiKeyName || 'mcp-agent');
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
        userId: req.mcpUserId || null,
        agentId: agent?.id || null,
        agentSystemPrompt: fullSystemPrompt,
        agentVersion: agent?.versions?.[0]?.version || null,
        branch: branch || null,
      },
    });

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

    res.json({ sessionId: codingSession.id, activePolicies, enforcementRules, agentSystemPrompt: fullSystemPrompt });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/:id/resume — resume an existing session (returns fresh agent prompt + policies)
router.post('/session/:id/resume', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const session = await prisma.codingSession.findUnique({
      where: { id },
      include: { agent: true },
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

    // Fetch active policies
    let activePolicies: string[] = [];
    try {
      const allPolicies = await prisma.policy.findMany({ where: { active: true } });
      activePolicies = allPolicies
        .map((p: any) => `[${p.type}] ${p.name}: ${p.description || ''}`.trim());
    } catch { /* non-critical */ }

    res.json({ sessionId: id, status: session.status, activePolicies, agentSystemPrompt });
  } catch (err) {
    console.error('Resume session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/:id/ping — lightweight keepalive heartbeat
router.post('/session/:id/ping', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.codingSession.updateMany({
      where: { id, status: 'RUNNING' },
      data: { updatedAt: new Date() },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'ping failed' });
  }
});

// PATCH /session/:id — incremental session update (during active session)
router.patch('/session/:id', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const {
      prompt, transcript, filesChanged, tokensUsed, toolCalls,
      linesAdded, linesRemoved, model, inputTokens, outputTokens,
      durationMs, costUsd, promptChanges, branch, status,
    } = req.body;

    await prisma.codingSession.update({
      where: { id },
      data: {
        ...(prompt !== undefined && { prompt }),
        ...(transcript !== undefined && { transcript }),
        ...(filesChanged !== undefined && { filesChanged: JSON.stringify(filesChanged) }),
        ...(tokensUsed !== undefined && { tokensUsed }),
        ...(toolCalls !== undefined && { toolCalls }),
        ...(linesAdded !== undefined && { linesAdded }),
        ...(linesRemoved !== undefined && { linesRemoved }),
        ...(model !== undefined && { model }),
        ...(inputTokens !== undefined && { inputTokens }),
        ...(outputTokens !== undefined && { outputTokens }),
        ...(durationMs !== undefined && { durationMs }),
        ...(costUsd !== undefined && { costUsd }),
        ...(branch !== undefined && { branch }),
        ...(status !== undefined && { status }),
        // Re-opening a completed session clears endedAt
        ...(status === 'RUNNING' && { endedAt: null }),
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
        const commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }> =
          gitCapture.commitDetails || [];

        // Create or link Commit records for each new commit
        for (const detail of commitDetails) {
          const existing = await prisma.commit.findFirst({ where: { sha: detail.sha, repoId: session.commit.repoId } });
          if (existing) {
            // Commit already exists (e.g., created by GitHub webhook) — link it to this session
            if (!existing.sessionId) {
              await prisma.commit.update({
                where: { id: existing.id },
                data: {
                  sessionId: id,
                  aiToolDetected: existing.aiToolDetected || session.model || 'unknown',
                  aiDetectionMethod: existing.aiDetectionMethod || 'session',
                },
              });
            }
          } else {
            await prisma.commit.create({
              data: {
                repoId: session.commit.repoId,
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
        const existingDiff = await prisma.sessionDiff.findUnique({ where: { sessionId: id } });
        if (existingDiff) {
          // Merge: append new diff, update headAfter, merge commitShas
          const existingShas = JSON.parse(existingDiff.commitShas || '[]') as string[];
          const newShas = (gitCapture.commitShas || []) as string[];
          const mergedShas = [...new Set([...existingShas, ...newShas])];
          await prisma.sessionDiff.update({
            where: { sessionId: id },
            data: {
              headAfter: gitCapture.headAfter || existingDiff.headAfter,
              commitShas: JSON.stringify(mergedShas),
              diff: existingDiff.diff + '\n' + (gitCapture.diff || ''),
              linesAdded: (existingDiff.linesAdded || 0) + (gitCapture.linesAdded || 0),
              linesRemoved: (existingDiff.linesRemoved || 0) + (gitCapture.linesRemoved || 0),
            },
          });
        } else {
          await prisma.sessionDiff.create({
            data: {
              sessionId: id,
              headBefore: gitCapture.headBefore || '',
              headAfter: gitCapture.headAfter || '',
              commitShas: JSON.stringify(gitCapture.commitShas || []),
              diff: gitCapture.diff || '',
              diffTruncated: gitCapture.diffTruncated || false,
              linesAdded: gitCapture.linesAdded || 0,
              linesRemoved: gitCapture.linesRemoved || 0,
            },
          });
        }

        // Update session line counts
        if (gitCapture.linesAdded || gitCapture.linesRemoved) {
          await prisma.codingSession.update({
            where: { id },
            data: {
              linesAdded: { increment: gitCapture.linesAdded || 0 },
              linesRemoved: { increment: gitCapture.linesRemoved || 0 },
            },
          });
        }

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

    // Replace prompt→file change mappings (delete old, create new)
    if (promptChanges && Array.isArray(promptChanges) && promptChanges.length > 0) {
      await prisma.promptChange.deleteMany({ where: { sessionId: id } });
      for (const pc of promptChanges) {
        await prisma.promptChange.create({
          data: {
            sessionId: id,
            promptIndex: pc.promptIndex ?? 0,
            promptText: (pc.promptText || '').slice(0, 1000),
            filesChanged: JSON.stringify(pc.filesChanged || []),
            diff: (pc.diff || '').slice(0, 200_000),
          },
        });
      }
    }

    emitSessionEvent({
      type: 'session:updated',
      sessionId: id,
      orgId: req.orgId as string,
      timestamp: new Date().toISOString(),
    });

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

    // Check session exists first
    const existingSession = await prisma.codingSession.findUnique({ where: { id: sessionId } });
    if (!existingSession) {
      return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const codingSession = await prisma.codingSession.update({
      where: { id: sessionId },
      data: {
        ...(prompt !== undefined && { prompt }),
        ...(transcriptValue !== undefined && { transcript: transcriptValue }),
        ...(tokensUsed !== undefined && { tokensUsed }),
        ...(inputTokens !== undefined && { inputTokens }),
        ...(outputTokens !== undefined && { outputTokens }),
        ...(toolCalls !== undefined && { toolCalls }),
        ...(linesAdded !== undefined && { linesAdded }),
        ...(linesRemoved !== undefined && { linesRemoved }),
        ...(costUsd !== undefined && { costUsd }),
        ...(filesChanged !== undefined && { filesChanged: JSON.stringify(filesChanged) }),
        ...(durationMs !== undefined && { durationMs }),
        ...(branch !== undefined && { branch }),
        status: 'COMPLETED',
        endedAt: new Date(),
      },
      include: { commit: { select: { repoId: true } } },
    });

    // Update the commit message — use summary or first 200 chars of prompt
    const commitMessage = summary || (prompt ? prompt.slice(0, 200) : '');
    if (commitMessage) {
      // Re-run AI detection on the real commit message (may have Co-Authored-By trailers)
      const detection = detectAITool(commitMessage, '');
      await prisma.commit.update({
        where: { id: codingSession.commitId },
        data: {
          message: commitMessage,
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
      const commitDetails: Array<{ sha: string; message: string; author: string; filesChanged: string[] }> =
        gitCapture.commitDetails || [];

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
              message: firstDetail?.message || commitMessage || '',
              author: firstDetail?.author || 'ai-agent',
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

      // Create or update SessionDiff record with full diff
      await prisma.sessionDiff.upsert({
        where: { sessionId },
        create: {
          sessionId,
          headBefore: gitCapture.headBefore || '',
          headAfter: gitCapture.headAfter || '',
          commitShas: JSON.stringify(gitCapture.commitShas || []),
          diff: gitCapture.diff || '',
          diffTruncated: gitCapture.diffTruncated || false,
          linesAdded: gitCapture.linesAdded || 0,
          linesRemoved: gitCapture.linesRemoved || 0,
        },
        update: {
          headBefore: gitCapture.headBefore || '',
          headAfter: gitCapture.headAfter || '',
          commitShas: JSON.stringify(gitCapture.commitShas || []),
          diff: gitCapture.diff || '',
          diffTruncated: gitCapture.diffTruncated || false,
          linesAdded: gitCapture.linesAdded || 0,
          linesRemoved: gitCapture.linesRemoved || 0,
        },
      });

      // Update session lines from actual diff counts (more accurate than estimates)
      if (gitCapture.linesAdded || gitCapture.linesRemoved) {
        await prisma.codingSession.update({
          where: { id: sessionId },
          data: {
            linesAdded: gitCapture.linesAdded || 0,
            linesRemoved: gitCapture.linesRemoved || 0,
          },
        });
      }
    }

    // Create PromptChange records for prompt → file change mappings
    if (promptChanges && Array.isArray(promptChanges)) {
      for (const pc of promptChanges) {
        await prisma.promptChange.create({
          data: {
            sessionId,
            promptIndex: pc.promptIndex ?? 0,
            promptText: (pc.promptText || '').slice(0, 1000),
            filesChanged: JSON.stringify(pc.filesChanged || []),
            diff: (pc.diff || '').slice(0, 200_000),
          },
        });
      }
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
    try { parsedFiles = Array.isArray(filesChanged) ? filesChanged : JSON.parse(filesChanged || '[]'); } catch {}

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
    }).catch(() => {});

    runAIReview({
      sessionId,
      orgId,
      model: codingSession.model,
      prompt: prompt || codingSession.prompt || '',
      filesChanged: parsedFiles,
      tokensUsed: tokensUsed ?? codingSession.tokensUsed ?? 0,
      toolCalls: toolCalls ?? codingSession.toolCalls ?? 0,
      linesAdded: linesAdded ?? codingSession.linesAdded ?? 0,
      linesRemoved: linesRemoved ?? codingSession.linesRemoved ?? 0,
      costUsd: costUsd ?? codingSession.costUsd ?? 0,
      durationMs: durationMs ?? codingSession.durationMs ?? 0,
      transcript: transcriptValue?.slice(0, 5000),
      diff: gitCapture?.diff?.slice(0, 10000),
      promptChanges: promptChanges?.map((pc: any) => ({
        promptText: (pc.promptText || '').slice(0, 200),
        filesChanged: pc.filesChanged || [],
      })),
    }).catch(err => console.error('[ai-review] Background error:', err));

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
    res.status(500).json({ error: 'Internal server error', detail: err?.message || 'unknown' });
  }
});

// POST /violations — report a policy violation
router.post('/violations', async (req: McpRequest, res: Response) => {
  try {
    const { machineId, policyId, description, filepath } = req.body;

    if (!machineId || !policyId || !description) {
      return res.status(400).json({ error: 'Missing required fields: machineId, policyId, description' });
    }

    const orgId = req.orgId as string;

    await prisma.auditLog.create({
      data: {
        orgId,
        action: 'POLICY_VIOLATION',
        resource: policyId,
        metadata: JSON.stringify({ policyId, description, filepath, machineId }),
      },
    });

    // Notify admins of policy violation
    await notifyOrgAdmins(
      orgId,
      'POLICY_VIOLATION',
      'Policy Violation Detected',
      `${description}${filepath ? ` — ${filepath}` : ''}`,
      '/audit',
      { policyId, description, filepath, machineId }
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
