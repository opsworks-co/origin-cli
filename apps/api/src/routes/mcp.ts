import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { notifyOrgAdmins } from '../services/notifications.js';
import { runAIReview } from '../services/ai-review.js';
import { checkBudget, recordSpend } from '../services/budget.js';
import { emitSessionEvent } from '../services/session-events.js';
import { enforceSessionStart, enforceSessionEnd, applyEnforcementActions } from '../services/policy-engine.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { detectAITool } from '../services/ai-commit-detector.js';

const router = Router();

interface McpRequest extends Request {
  orgId?: string;
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
    });

    if (!found) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.orgId = found.orgId;
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
    const { machineId, prompt, model, repoPath, agentSlug } = req.body;

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
      // If no agent exists for this slug, auto-create one
      if (!agent) {
        const agentName = agentSlug
          .split('-')
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        agent = await prisma.agent.create({
          data: {
            orgId,
            name: agentName,
            slug: agentSlug,
            model,
          },
          select: { id: true },
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
    const commit = await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: placeholderSha,
        message: '',
        author: 'mcp-agent',
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
        userId: (req as any).user?.id || null,
        agentId: agent?.id || null,
        agentSystemPrompt: agent?.systemPrompt || null,
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
      durationMs, costUsd, promptChanges,
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
      },
    });

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
      // Update placeholder commit SHA with real value
      const realSha = (gitCapture.commitShas?.length > 0)
        ? gitCapture.commitShas[0]         // First real commit SHA
        : (gitCapture.headAfter || null);  // Or HEAD at session end

      if (realSha) {
        await prisma.commit.update({
          where: { id: codingSession.commitId },
          data: {
            sha: realSha,
            author: gitCapture.commitShas?.length > 0 ? 'ai-agent' : 'mcp-agent',
          },
        });
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
    }).then(result => {
      if (result.violations.length > 0) {
        return applyEnforcementActions({
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
    }).catch(err => console.error('[policy-engine] Background error:', err));

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
