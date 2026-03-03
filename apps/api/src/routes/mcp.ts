import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { notifyOrgAdmins } from '../services/notifications.js';

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
    const { machineId, prompt, model, repoPath } = req.body;

    if (!machineId || !prompt || !model || !repoPath) {
      return res.status(400).json({ error: 'Missing required fields: machineId, prompt, model, repoPath' });
    }

    const orgId = req.orgId as string;

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

    // Generate a placeholder SHA (random 40-char hex)
    const placeholderSha = crypto.randomBytes(20).toString('hex');

    // Create a commit with placeholder SHA
    const commit = await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: placeholderSha,
        message: '',
        author: 'mcp-agent',
        committedAt: new Date(),
      },
    });

    // Create the coding session
    const codingSession = await prisma.codingSession.create({
      data: {
        commitId: commit.id,
        model,
        prompt,
        transcript: '',
        filesChanged: '[]',
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
        metadata: JSON.stringify({ machineId, model, repoPath }),
      },
    });

    res.json({ sessionId: codingSession.id });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /session/end — end a coding session
router.post('/session/end', async (req: McpRequest, res: Response) => {
  try {
    const {
      sessionId,
      summary,
      tokensUsed,
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
    const codingSession = await prisma.codingSession.update({
      where: { id: sessionId },
      data: {
        ...(summary !== undefined && { transcript: summary }),
        ...(tokensUsed !== undefined && { tokensUsed }),
        ...(toolCalls !== undefined && { toolCalls }),
        ...(linesAdded !== undefined && { linesAdded }),
        ...(linesRemoved !== undefined && { linesRemoved }),
        ...(costUsd !== undefined && { costUsd }),
        ...(filesChanged !== undefined && { filesChanged: JSON.stringify(filesChanged) }),
        ...(durationMs !== undefined && { durationMs }),
      },
    });

    // Update the commit message to the summary
    if (summary) {
      await prisma.commit.update({
        where: { id: codingSession.commitId },
        data: { message: summary },
      });
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
