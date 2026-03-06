import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { syncCheckpoints } from '../services/checkpoint.js';
import { generateWebhookSecret } from '../services/webhook.js';
import {
  getIntegrationConfig,
  listGitHubRepos,
  createGitHubWebhook,
  deleteGitHubWebhook,
  parseRepoFullName,
} from '../services/github-integration.js';
import { detectAITool } from '../services/ai-commit-detector.js';
import { parseGitHubUrl } from '../services/github.js';

const router = Router();
router.use(requireAuth);

// GET / — list repos for org
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const repos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId },
      include: {
        _count: { select: { commits: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Count sessions per repo
    let sessionsPerRepo = new Map<string, number>();
    try {
      const repoIds = repos.map((r) => r.id);
      if (repoIds.length > 0) {
        const sessionRows = await prisma.$queryRawUnsafe<Array<{ repoId: string; cnt: number }>>(
          `SELECT c."repoId" as "repoId", COUNT(s.id) as cnt
           FROM "CodingSession" s
           JOIN "Commit" c ON c.id = s."commitId"
           WHERE c."repoId" IN (${repoIds.map((_, i) => `$${i + 1}`).join(',')})
           GROUP BY c."repoId"`,
          ...repoIds
        );
        for (const row of sessionRows) {
          sessionsPerRepo.set(row.repoId, Number(row.cnt));
        }
      }
    } catch {
      // Gracefully handle if raw query fails (e.g. in test env)
    }

    const result = repos.map((r) => ({
      ...r,
      _count: { ...r._count, sessions: sessionsPerRepo.get(r.id) || 0 },
    }));
    res.json(result);
  } catch (err) {
    console.error('List repos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create repo (MEMBER+)
router.post('/', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, path, provider } = req.body;

    if (!name || !path) {
      return res.status(400).json({ error: 'Missing required fields: name, path' });
    }

    const repo = await prisma.repo.create({
      data: {
        orgId: req.user!.orgId,
        name,
        path,
        provider: provider || 'local',
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_CREATED',
        resource: repo.id,
        metadata: JSON.stringify({ name, path, provider }),
      },
    });

    res.status(201).json(repo);
  } catch (err) {
    console.error('Create repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /github/discover — list GitHub repos available to org's token
router.get('/github/discover', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const integration = await getIntegrationConfig(req.user!.orgId, 'github');
    if (!integration) {
      return res.status(400).json({ error: 'GitHub not connected. Add a GitHub token in Settings → Integrations.' });
    }

    const result = await listGitHubRepos(integration.token, integration.apiBaseUrl);
    if (!result.success || !result.repos) {
      return res.status(502).json({ error: result.error || 'Failed to fetch repos from GitHub' });
    }

    // Load existing Origin repos to mark which are already imported
    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId, provider: 'github' },
      select: { id: true, path: true },
    });

    const discoveredRepos = result.repos.map((ghRepo) => {
      const match = existingRepos.find((r) => {
        const parsed = parseRepoFullName(r.path);
        return parsed && parsed.owner.toLowerCase() === ghRepo.owner.toLowerCase()
          && parsed.repo.toLowerCase() === ghRepo.name.toLowerCase();
      });
      return {
        ...ghRepo,
        alreadyImported: !!match,
        originRepoId: match?.id || undefined,
      };
    });

    res.json({ repos: discoveredRepos });
  } catch (err) {
    console.error('GitHub discover error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /github/import — import selected GitHub repos with auto-webhook creation
router.post('/github/import', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { repos: reposToImport, originBaseUrl } = req.body as {
      repos: Array<{ fullName: string; name?: string }>;
      originBaseUrl: string;
    };

    if (!reposToImport || !Array.isArray(reposToImport) || reposToImport.length === 0) {
      return res.status(400).json({ error: 'No repos specified for import' });
    }
    if (!originBaseUrl) {
      return res.status(400).json({ error: 'Missing originBaseUrl' });
    }

    const integration = await getIntegrationConfig(req.user!.orgId, 'github');
    if (!integration) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    // Load existing repos to skip duplicates
    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId, provider: 'github' },
      select: { id: true, path: true },
    });

    const results: Array<{ fullName: string; success: boolean; repoId?: string; error?: string }> = [];

    for (const item of reposToImport) {
      const parsed = parseRepoFullName(item.fullName);
      if (!parsed) {
        results.push({ fullName: item.fullName, success: false, error: 'Invalid repo path' });
        continue;
      }

      // Check if already imported
      const alreadyExists = existingRepos.find((r) => {
        const rp = parseRepoFullName(r.path);
        return rp && rp.owner.toLowerCase() === parsed.owner.toLowerCase()
          && rp.repo.toLowerCase() === parsed.repo.toLowerCase();
      });

      if (alreadyExists) {
        results.push({ fullName: item.fullName, success: true, repoId: alreadyExists.id, error: 'Already imported' });
        continue;
      }

      try {
        // 1. Create Repo record
        const repoName = item.name || parsed.repo;
        const repo = await prisma.repo.create({
          data: {
            orgId: req.user!.orgId,
            name: repoName,
            path: `github.com/${parsed.owner}/${parsed.repo}`,
            provider: 'github',
          },
        });

        // 2. Create Webhook record with generated secret
        const secret = generateWebhookSecret();
        const webhookUrl = `${originBaseUrl}/api/webhooks/github/${repo.id}`;

        const webhook = await prisma.webhook.create({
          data: { repoId: repo.id, secret },
        });

        // 3. Create webhook on GitHub
        const ghResult = await createGitHubWebhook(
          integration.token,
          parsed.owner,
          parsed.repo,
          webhookUrl,
          secret,
          integration.apiBaseUrl,
        );

        if (ghResult.success && ghResult.hookId) {
          await prisma.webhook.update({
            where: { id: webhook.id },
            data: { githubWebhookId: ghResult.hookId },
          });
        }

        // 4. Audit log
        await prisma.auditLog.create({
          data: {
            orgId: req.user!.orgId,
            userId: req.user!.id,
            action: 'REPO_IMPORTED',
            resource: repo.id,
            metadata: JSON.stringify({
              name: repoName,
              fullName: item.fullName,
              webhookCreated: ghResult.success,
              githubWebhookId: ghResult.hookId,
            }),
          },
        });

        results.push({
          fullName: item.fullName,
          success: true,
          repoId: repo.id,
          error: ghResult.success ? undefined : `Repo created but webhook failed: ${ghResult.error}`,
        });
      } catch (importErr: any) {
        console.error(`Failed to import ${item.fullName}:`, importErr.message);
        results.push({ fullName: item.fullName, success: false, error: importErr.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('GitHub import error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/sync — sync a repo
router.post('/:id/sync', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const result = await syncCheckpoints({ ...repo, orgId: req.user!.orgId });

    await prisma.repo.update({
      where: { id },
      data: { syncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_SYNCED',
        resource: repo.id,
        metadata: JSON.stringify({ synced: result.synced, total: result.total }),
      },
    });

    res.json(result);
  } catch (err) {
    console.error('Sync repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/rescan — re-fetch full commit messages from GitHub and run AI detection
router.post('/:id/rescan', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Fetch full commit messages from GitHub
    const parsed = parseGitHubUrl(repo.path);
    let fullMessages: Map<string, string> = new Map();

    if (parsed) {
      try {
        const integration = await getIntegrationConfig(req.user!.orgId, 'github');
        const token = integration?.token || process.env.GITHUB_TOKEN;
        const apiBase = integration?.apiBaseUrl || 'https://api.github.com';

        if (token) {
          const ghRes = await fetch(
            `${apiBase}/repos/${parsed.owner}/${parsed.repo}/commits?per_page=100`,
            {
              headers: {
                Accept: 'application/vnd.github.v3+json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'Origin-App',
              },
            }
          );
          if (ghRes.ok) {
            const data = await ghRes.json() as any[];
            for (const c of data) {
              if (c.sha && c.commit?.message) {
                fullMessages.set(c.sha, c.commit.message);
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch GitHub commits for rescan:', err);
      }
    }

    // Process all commits in the repo
    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: { session: { select: { model: true } } },
    });

    let updated = 0;
    for (const commit of commits) {
      const updates: any = {};

      // Update message from GitHub if we have a fuller version
      const ghMessage = fullMessages.get(commit.sha);
      if (ghMessage && ghMessage.length > commit.message.length) {
        updates.message = ghMessage;
      }

      // Run AI detection
      const messageToScan = updates.message || commit.message;
      if (commit.session) {
        // Session-linked: mark with session method
        updates.aiToolDetected = commit.session.model;
        updates.aiDetectionMethod = 'session';
      } else {
        const detection = detectAITool(messageToScan, commit.author);
        if (detection.aiToolDetected) {
          updates.aiToolDetected = detection.aiToolDetected;
          updates.aiDetectionMethod = detection.aiDetectionMethod;
        }
      }

      if (Object.keys(updates).length > 0) {
        await prisma.commit.update({
          where: { id: commit.id },
          data: updates,
        });
        updated++;
      }
    }

    res.json({ total: commits.length, updated, githubMessages: fullMessages.size });
  } catch (err) {
    console.error('Rescan commits error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — single repo
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
      include: { _count: { select: { commits: true } } },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    res.json(repo);
  } catch (err) {
    console.error('Get repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id — update repo
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, path, provider } = req.body;

    const existing = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    const repo = await prisma.repo.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(path !== undefined && { path }),
        ...(provider !== undefined && { provider }),
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_UPDATED',
        resource: id,
        metadata: JSON.stringify({ name, path, provider }),
      },
    });

    res.json(repo);
  } catch (err) {
    console.error('Update repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — delete repo and all commits/sessions (ADMIN+)
router.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const existing = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    // Clean up GitHub webhooks if auto-created
    const webhooks = await prisma.webhook.findMany({ where: { repoId: id } });
    for (const wh of webhooks) {
      if (wh.githubWebhookId) {
        const integration = await getIntegrationConfig(req.user!.orgId, 'github');
        const parsed = parseRepoFullName(existing.path);
        if (integration && parsed) {
          await deleteGitHubWebhook(
            integration.token,
            parsed.owner,
            parsed.repo,
            wh.githubWebhookId,
            integration.apiBaseUrl,
          );
        }
      }
    }
    await prisma.webhook.deleteMany({ where: { repoId: id } });
    await prisma.pullRequest.deleteMany({ where: { repoId: id } });

    // Delete in order: reviews -> sessions -> commits -> repo
    const commits = await prisma.commit.findMany({ where: { repoId: id }, select: { id: true } });
    const commitIds = commits.map((c) => c.id);

    if (commitIds.length > 0) {
      await prisma.sessionReview.deleteMany({
        where: { session: { commitId: { in: commitIds } } },
      });
      await prisma.codingSession.deleteMany({
        where: { commitId: { in: commitIds } },
      });
      await prisma.commit.deleteMany({ where: { repoId: id } });
    }

    await prisma.repo.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_DELETED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete repo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/commits/:sha/diff — get commit diff
router.get('/:id/commits/:sha/diff', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const sha = (req.params as any).sha as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    if (repo.provider === 'github') {
      // Parse GitHub URL to get owner/repo
      const parsed = parseRepoFullName(repo.path);
      if (!parsed) return res.status(400).json({ error: 'Invalid GitHub repo path' });

      // Try org integration token first, then fall back to env var
      let token: string | undefined;
      const integration = await getIntegrationConfig(req.user!.orgId, 'github');
      if (integration?.token) {
        token = integration.token;
      } else if (process.env.GITHUB_TOKEN) {
        token = process.env.GITHUB_TOKEN;
      }

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Origin-App',
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const apiBase = integration?.apiBaseUrl || 'https://api.github.com';
      const ghRes = await fetch(
        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/commits/${sha}`,
        { headers },
      );

      if (!ghRes.ok) {
        return res.status(ghRes.status).json({ error: `GitHub API error: ${ghRes.status}` });
      }

      const data = await ghRes.json() as any;
      const files = (data.files || []).map((f: any) => ({
        filename: f.filename,
        status: f.status,          // added, modified, removed, renamed
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch || '',       // unified diff for the file
        previousFilename: f.previous_filename || null,
      }));

      return res.json({
        sha: data.sha,
        message: data.commit?.message || '',
        author: data.commit?.author?.name || 'unknown',
        date: data.commit?.author?.date || '',
        stats: data.stats || { additions: 0, deletions: 0, total: 0 },
        files,
        htmlUrl: data.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/commit/${sha}`,
      });
    }

    // For local repos, return minimal info (diffs not available remotely)
    return res.json({
      sha,
      message: '',
      author: '',
      date: '',
      stats: { additions: 0, deletions: 0, total: 0 },
      files: [],
      htmlUrl: null,
    });
  } catch (err) {
    console.error('Get commit diff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/commits — list commits for a repo
router.get('/:id/commits', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: {
        session: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
          },
        },
      },
      orderBy: { committedAt: 'desc' },
    });

    // Map promptChanges; fall back to parsing transcript for prompt texts
    const mapped = commits.map((c: any) => {
      if (!c.session) return { ...c, session: null };

      const dbPrompts = (c.session.promptChanges || []).map((pc: any) => ({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged: JSON.parse(pc.filesChanged || '[]'),
        diff: pc.diff || '',
      }));

      // If no PromptChange records exist, extract prompts from transcript
      let promptChanges = dbPrompts;
      if (dbPrompts.length === 0 && c.session.transcript) {
        try {
          const msgs = JSON.parse(c.session.transcript);
          if (Array.isArray(msgs)) {
            let idx = 0;
            promptChanges = msgs
              .filter((m: any) => m.role === 'user' || m.role === 'human')
              .map((m: any) => ({
                promptIndex: idx++,
                promptText: (typeof m.content === 'string' ? m.content : '').slice(0, 1000),
                filesChanged: [],
                diff: '',
              }));
          }
        } catch {
          // transcript not valid JSON – ignore
        }
      }

      // Don't send full transcript in commits list (too large)
      const { transcript, ...sessionWithoutTranscript } = c.session;

      return {
        ...c,
        session: {
          ...sessionWithoutTranscript,
          promptChanges,
        },
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('List commits error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/webhooks — create webhook for repo
router.post('/:id/webhooks', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Check if webhook already exists
    const existing = await prisma.webhook.findFirst({ where: { repoId: id } });
    if (existing) {
      return res.status(409).json({ error: 'Webhook already exists for this repo' });
    }

    const secret = generateWebhookSecret();
    const webhook = await prisma.webhook.create({
      data: { repoId: id, secret },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'WEBHOOK_CREATED',
        resource: id,
        metadata: JSON.stringify({ repoName: repo.name }),
      },
    });

    // Return the secret only on creation (it won't be shown again)
    res.status(201).json({
      id: webhook.id,
      repoId: webhook.repoId,
      active: webhook.active,
      secret,
      webhookUrl: `/api/webhooks/github/${id}`,
      createdAt: webhook.createdAt,
    });
  } catch (err) {
    console.error('Create webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/webhooks — list webhooks for repo
router.get('/:id/webhooks', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const webhooks = await prisma.webhook.findMany({
      where: { repoId: id },
      select: { id: true, repoId: true, active: true, events: true, createdAt: true, updatedAt: true },
    });

    res.json(webhooks.map(w => ({
      ...w,
      webhookUrl: `/api/webhooks/github/${id}`,
    })));
  } catch (err) {
    console.error('List webhooks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/webhooks/:webhookId — delete a webhook
router.delete('/:id/webhooks/:webhookId', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const webhookId = (req.params as any).webhookId as string;

    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, repoId: id } });
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

    await prisma.webhook.delete({ where: { id: webhookId } });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'WEBHOOK_DELETED',
        resource: id,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
