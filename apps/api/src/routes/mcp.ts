import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { notifyOrgAdmins } from '../services/notifications.js';
import { runAIReview } from '../services/ai-review.js';
import { checkBudget, recordSpend } from '../services/budget.js';
import { emitSessionEvent } from '../services/session-events.js';
import { enforceSessionStart, enforceSessionEnd, applyEnforcementActions, enforceAgentLimits } from '../services/policy-engine.js';
import { updateSessionPRChecks } from '../services/github-integration.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { detectAITool } from '../services/ai-commit-detector.js';

const router = Router();

interface McpRequest extends Request {
  orgId?: string;
  mcpUserId?: string;  // User ID resolved from the API key (for per-member attribution)
  apiKeyName?: string; // Name of the API key (for standalone key attribution)
  repoScopes?: string[]; // Repo IDs this API key is scoped to (empty = unrestricted)
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
      },
    });

    if (!found) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.orgId = found.orgId;
    req.apiKeyName = found.name;
    req.repoScopes = found.repoScopes.map((s: { repoId: string }) => s.repoId);
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

// GET /policies — load active policies for the org
router.get('/policies', async (req: McpRequest, res: Response) => {
  try {
    const policies = await prisma.policy.findMany({
      where: { orgId: req.orgId as string, active: true },
      include: {
        rules: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = policies.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: p.type,
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
    const { machineId, prompt, model, repoPath, agentSlug, branch } = req.body;

    if (!machineId || !model || !repoPath) {
      return res.status(400).json({ error: 'Missing required fields: machineId, model, repoPath' });
    }

    const orgId = req.orgId as string;

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

    // Find or create repo from repoPath
    let repo = await prisma.repo.findFirst({
      where: { orgId, path: repoPath },
    });

    if (!repo) {
      const repoName = repoPath.split('/').filter(Boolean).pop() || repoPath;
      repo = await prisma.repo.create({
        data: {
          orgId,
          name: repoName,
          path: repoPath,
          provider: 'local',
        },
      });
    }

    // Enforce repo-scoped API key access
    if (req.repoScopes && req.repoScopes.length > 0 && !req.repoScopes.includes(repo.id)) {
      return res.status(403).json({
        error: 'Access denied',
        message: `This API key does not have access to repo "${repo.name}"`,
      });
    }

    // Look up machine DB id for policy scoping
    const machine = await prisma.machine.findFirst({
      where: { machineId },
    });

    // Resolve agent slug to Agent record (for policy scoping & session linking)
    let agent: { id: string; systemPrompt?: string | null } | null = null;
    if (agentSlug) {
      agent = await prisma.agent.findFirst({
        where: { orgId, slug: agentSlug, status: 'ACTIVE' },
        select: { id: true, systemPrompt: true },
      });
      // Strict mode: reject unknown agents (admins must create them in the dashboard first)
      if (!agent) {
        return res.status(403).json({
          error: 'Unknown agent',
          message: `Agent "${agentSlug}" is not registered. Ask your admin to create it in the Origin dashboard under Agents.`,
          agentSlug,
        });
      }
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
        agentSystemPrompt: agent?.systemPrompt || null,
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

    res.json({ sessionId: codingSession.id });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /session/:id — incremental session update (during active session)
router.patch('/session/:id', async (req: McpRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const {
      prompt, transcript, filesChanged, tokensUsed, toolCalls,
      linesAdded, linesRemoved, model, inputTokens, outputTokens,
      durationMs, costUsd, promptChanges, branch,
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

        // Create Commit records for each new commit
        for (const detail of commitDetails) {
          const existing = await prisma.commit.findFirst({ where: { sha: detail.sha, repoId: session.commit.repoId } });
          if (!existing) {
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
        // Find matching detail for the first commit
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

      // Create individual Commit records for remaining SHAs (linked via sessionId)
      if (commitDetails.length > 1) {
        for (const detail of commitDetails) {
          // Skip the first commit (already stored as the placeholder)
          if (detail.sha === realSha || detail.sha.startsWith(realSha?.slice(0, 7) || '___') || realSha?.startsWith(detail.sha.slice(0, 7))) {
            continue;
          }
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

      // Create SessionDiff record with full diff
      await prisma.sessionDiff.create({
        data: {
          sessionId,
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
    if (gitCapture?.diff) {
      scanForSecrets(sessionId, gitCapture.diff, orgId)
        .catch(err => console.error('[secret-scanner] Background error:', err));
    }

    // Look up machine DB id for policy scoping at session end
    const endMachineId = req.body.machineId
      ? (await prisma.machine.findFirst({ where: { machineId: req.body.machineId } }))?.id ?? null
      : null;
    const sessionRepoId = codingSession.commit?.repoId ?? null;

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
      // If agent limits were violated, also update PR checks
      if (result.violations.length > 0) {
        await updateSessionPRChecks(sessionId, orgId);
      }
    }).catch(err => console.error('[agent-limits] Background error:', err));

    res.json({ success: true });
  } catch (err) {
    console.error('End session error:', err);
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

export default router;
