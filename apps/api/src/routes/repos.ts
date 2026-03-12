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
    const showArchived = req.query.archived === 'true';
    const repos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId, ...(!showArchived && { archived: false }) },
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

    const result = await listGitHubRepos(integration.token, integration.apiBaseUrl, integration.authType);
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

        // 2. Create webhook — only for PAT integrations (GitHub App handles webhooks centrally)
        let webhookCreated = false;
        let githubWebhookId: number | undefined;

        if (integration.authType !== 'github_app') {
          const secret = generateWebhookSecret();
          const webhookUrl = `${originBaseUrl}/api/webhooks/github/${repo.id}`;

          const webhook = await prisma.webhook.create({
            data: { repoId: repo.id, secret },
          });

          const ghResult = await createGitHubWebhook(
            integration.token,
            parsed.owner,
            parsed.repo,
            webhookUrl,
            secret,
            integration.apiBaseUrl,
          );

          webhookCreated = ghResult.success;
          if (ghResult.success && ghResult.hookId) {
            githubWebhookId = ghResult.hookId;
            await prisma.webhook.update({
              where: { id: webhook.id },
              data: { githubWebhookId: ghResult.hookId },
            });
          }
        } else {
          // GitHub App: webhooks are handled via /api/webhooks/github-app
          webhookCreated = true; // No per-repo webhook needed
        }

        // 3. Audit log
        await prisma.auditLog.create({
          data: {
            orgId: req.user!.orgId,
            userId: req.user!.id,
            action: 'REPO_IMPORTED',
            resource: repo.id,
            metadata: JSON.stringify({
              name: repoName,
              fullName: item.fullName,
              webhookCreated,
              githubWebhookId,
              authType: integration.authType,
            }),
          },
        });

        results.push({
          fullName: item.fullName,
          success: true,
          repoId: repo.id,
          error: webhookCreated ? undefined : 'Repo created but webhook failed',
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

// POST /:id/import-sessions — import sessions from the origin-sessions git branch
router.post('/:id/import-sessions', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Get GitHub token
    let token: string | undefined;
    const integration = await getIntegrationConfig(req.user!.orgId, 'github');
    if (integration?.token) token = integration.token;
    else if (process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Origin-App',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    // Determine owner/repo for GitHub API
    let owner: string;
    let repoName: string;
    if (repo.provider === 'github') {
      const parsed = parseRepoFullName(repo.path);
      if (!parsed) return res.status(400).json({ error: 'Invalid GitHub repo path' });
      owner = parsed.owner;
      repoName = parsed.repo;
    } else {
      // For local repos, try to get the GitHub remote
      return res.status(400).json({
        error: 'Import from branch only works for GitHub repos. Push the origin-sessions branch to GitHub first: git push origin origin-sessions',
      });
    }

    const apiBase = integration?.apiBaseUrl || 'https://api.github.com';

    // 1. List files in the origin-sessions branch
    let treeData: any;
    try {
      const treeRes = await fetch(
        `${apiBase}/repos/${owner}/${repoName}/git/trees/origin-sessions?recursive=1`,
        { headers },
      );
      if (!treeRes.ok) {
        if (treeRes.status === 404) {
          return res.status(404).json({
            error: 'No origin-sessions branch found. Make sure the CLI has written session data and the branch is pushed to GitHub.',
          });
        }
        return res.status(treeRes.status).json({ error: `GitHub API error: ${treeRes.status}` });
      }
      treeData = await treeRes.json();
    } catch (err: any) {
      return res.status(500).json({ error: `Failed to read origin-sessions branch: ${err.message}` });
    }

    // 2. Filter for session JSON files
    const sessionFiles = (treeData.tree || []).filter(
      (f: any) => f.path?.startsWith('sessions/') && f.path?.endsWith('.json') && f.type === 'blob',
    );

    if (sessionFiles.length === 0) {
      return res.json({ imported: 0, skipped: 0, message: 'No session files found in origin-sessions branch' });
    }

    // 3. Get existing session IDs to skip duplicates
    const existingSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId: req.user!.orgId } },
      },
      select: { id: true },
    });
    const existingIds = new Set(existingSessions.map((s) => s.id));

    let imported = 0;
    let skipped = 0;

    // 4. Fetch and import each session file
    for (const file of sessionFiles) {
      try {
        const blobRes = await fetch(
          `${apiBase}/repos/${owner}/${repoName}/git/blobs/${file.sha}`,
          { headers },
        );
        if (!blobRes.ok) { skipped++; continue; }

        const blobData = await blobRes.json() as any;
        const content = Buffer.from(blobData.content, 'base64').toString('utf-8');
        const session = JSON.parse(content) as {
          sessionId: string;
          model: string;
          startedAt: string;
          endedAt: string;
          durationMs: number;
          costUsd: number;
          tokensUsed: number;
          inputTokens: number;
          outputTokens: number;
          toolCalls: number;
          linesAdded: number;
          linesRemoved: number;
          prompts: string[];
          filesChanged: string[];
          promptChanges: Array<{ prompt: string; files: string[] }>;
          git: { headBefore: string; headAfter: string; commitShas: string[] };
          summary: string;
        };

        // Skip if already imported
        if (existingIds.has(session.sessionId)) { skipped++; continue; }

        // Find or create the commit for this session
        const commitSha = session.git.commitShas?.[0] || session.git.headAfter || '';
        if (!commitSha) { skipped++; continue; }

        let commit = await prisma.commit.findFirst({
          where: { repoId: id, sha: commitSha },
        });

        if (!commit) {
          // Create the commit record
          commit = await prisma.commit.create({
            data: {
              repoId: id,
              sha: commitSha,
              message: session.summary || session.prompts[0]?.slice(0, 200) || '',
              author: 'ai-agent',
              aiToolDetected: session.model || 'claude-code',
              aiDetectionMethod: 'session',
              committedAt: new Date(session.endedAt || session.startedAt),
            },
          });
        }

        // Check if commit already has a session
        const existingSession = await prisma.codingSession.findUnique({
          where: { commitId: commit.id },
        });
        if (existingSession) { skipped++; continue; }

        // Build transcript from prompts
        const transcript = session.prompts.map((p, i) => ([
          { role: 'user' as const, content: p },
          { role: 'assistant' as const, content: `Completed task ${i + 1}.` },
        ])).flat();

        // Create the coding session
        const codingSession = await prisma.codingSession.create({
          data: {
            id: session.sessionId,
            commitId: commit.id,
            model: session.model || 'unknown',
            prompt: session.prompts[0] || '',
            transcript: JSON.stringify(transcript),
            filesChanged: JSON.stringify(session.filesChanged || []),
            tokensUsed: session.tokensUsed || 0,
            inputTokens: session.inputTokens || 0,
            outputTokens: session.outputTokens || 0,
            toolCalls: session.toolCalls || 0,
            durationMs: session.durationMs || 0,
            linesAdded: session.linesAdded || 0,
            linesRemoved: session.linesRemoved || 0,
            costUsd: session.costUsd || 0,
          },
        });

        // Create promptChange records
        for (let i = 0; i < (session.promptChanges || []).length; i++) {
          const pc = session.promptChanges[i];
          await prisma.promptChange.create({
            data: {
              sessionId: codingSession.id,
              promptIndex: i,
              promptText: (pc.prompt || '').slice(0, 1000),
              filesChanged: JSON.stringify(pc.files || []),
              diff: '',
            },
          });
        }

        // If no promptChanges, create from prompts array
        if (!session.promptChanges?.length && session.prompts?.length) {
          for (let i = 0; i < session.prompts.length; i++) {
            await prisma.promptChange.create({
              data: {
                sessionId: codingSession.id,
                promptIndex: i,
                promptText: session.prompts[i].slice(0, 1000),
                filesChanged: JSON.stringify([]),
                diff: '',
              },
            });
          }
        }

        // Create sessionDiff if git data available
        if (session.git.headBefore && session.git.headAfter) {
          await prisma.sessionDiff.create({
            data: {
              sessionId: codingSession.id,
              headBefore: session.git.headBefore,
              headAfter: session.git.headAfter,
              commitShas: JSON.stringify(session.git.commitShas || []),
              diff: '',
              linesAdded: session.linesAdded || 0,
              linesRemoved: session.linesRemoved || 0,
            },
          });
        }

        // Create individual Commit records for additional SHAs in this session
        if (session.git.commitShas && session.git.commitShas.length > 1) {
          for (const sha of session.git.commitShas.slice(1)) {
            const exists = await prisma.commit.findFirst({ where: { repoId: id, sha } });
            if (!exists) {
              await prisma.commit.create({
                data: {
                  repoId: id,
                  sha,
                  message: '',
                  author: 'ai-agent',
                  aiToolDetected: session.model || 'claude-code',
                  aiDetectionMethod: 'session',
                  committedAt: new Date(session.endedAt || session.startedAt),
                  sessionId: codingSession.id,
                },
              });
            }
          }
        }

        // Update commit AI detection
        if (!commit.aiToolDetected) {
          await prisma.commit.update({
            where: { id: commit.id },
            data: {
              aiToolDetected: session.model || 'claude-code',
              aiDetectionMethod: 'session',
            },
          });
        }

        existingIds.add(session.sessionId);
        imported++;
      } catch (err: any) {
        console.error(`Failed to import session file ${file.path}:`, err.message);
        skipped++;
      }
    }

    res.json({ imported, skipped, total: sessionFiles.length });
  } catch (err) {
    console.error('Import sessions error:', err);
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
      include: {
        session: { select: { model: true } },
        codingSession: { select: { model: true } },
      },
    });

    let updated = 0;
    for (const commit of commits) {
      const updates: any = {};
      const sess = (commit as any).session || (commit as any).codingSession;

      // Update message from GitHub if we have a fuller version
      const ghMessage = fullMessages.get(commit.sha);
      if (ghMessage && ghMessage.length > commit.message.length) {
        updates.message = ghMessage;
      }

      // Run AI detection
      const messageToScan = updates.message || commit.message;
      if (sess) {
        // Session-linked: mark with session method
        updates.aiToolDetected = sess.model;
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

// PATCH /:id/archive — archive or unarchive a repo
router.patch('/:id/archive', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { archived } = req.body;

    const existing = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    const repo = await prisma.repo.update({
      where: { id },
      data: { archived: !!archived },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: archived ? 'REPO_ARCHIVED' : 'REPO_UNARCHIVED',
        resource: id,
        metadata: JSON.stringify({ name: existing.name }),
      },
    });

    res.json(repo);
  } catch (err) {
    console.error('Archive repo error:', err);
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

    // Delete in order: clear session refs -> reviews -> prompt changes -> secret findings -> session diffs -> sessions -> commits -> repo
    const commits = await prisma.commit.findMany({ where: { repoId: id }, select: { id: true } });
    const commitIds = commits.map((c) => c.id);

    if (commitIds.length > 0) {
      // Clear sessionId FK on commits before deleting sessions
      await prisma.commit.updateMany({
        where: { repoId: id, sessionId: { not: null } },
        data: { sessionId: null },
      });

      // Find all sessions linked to these commits
      const sessions = await prisma.codingSession.findMany({
        where: { commitId: { in: commitIds } },
        select: { id: true },
      });
      const sessionIds = sessions.map(s => s.id);

      if (sessionIds.length > 0) {
        await prisma.secretFinding.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await prisma.promptChange.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await prisma.sessionDiff.deleteMany({ where: { sessionId: { in: sessionIds } } });
        await prisma.sessionReview.deleteMany({ where: { sessionId: { in: sessionIds } } });
      }
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

    // For local repos, use stored sessionDiff if available
    const commit = await prisma.commit.findFirst({
      where: { repoId: id, sha },
      include: {
        session: {
          include: { sessionDiff: true },
        },
        codingSession: {
          include: { sessionDiff: true },
        },
      },
    });

    // Use session (1:1 primary) or codingSession (many:1 via sessionId)
    const sess = (commit as any)?.session || (commit as any)?.codingSession;

    // Gather diff from sessionDiff or combine all promptChange diffs
    let rawDiff = sess?.sessionDiff?.diff || '';
    if (!rawDiff && sess) {
      // Combine per-prompt diffs
      const pcs = await prisma.promptChange.findMany({
        where: { sessionId: sess.id },
        orderBy: { promptIndex: 'asc' },
      });
      rawDiff = pcs.map((pc: any) => pc.diff || '').filter(Boolean).join('\n');
    }

    if (rawDiff) {
      // Parse unified diff into per-file patches
      const files: any[] = [];
      const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

      for (const section of fileSections) {
        const lines = section.split('\n');
        // Extract filename from "a/path b/path"
        const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
        if (!headerMatch) continue;

        const filenameA = headerMatch[1];
        const filenameB = headerMatch[2];
        const filename = filenameB;

        // Determine status
        let status = 'modified';
        if (section.includes('new file mode')) status = 'added';
        else if (section.includes('deleted file mode')) status = 'removed';
        else if (filenameA !== filenameB) status = 'renamed';

        // Extract patch (everything from first @@ onward)
        const patchStart = section.indexOf('@@');
        const patch = patchStart >= 0 ? section.slice(patchStart) : '';

        // Count additions/deletions
        let additions = 0;
        let deletions = 0;
        for (const patchLine of patch.split('\n')) {
          if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) additions++;
          if (patchLine.startsWith('-') && !patchLine.startsWith('---')) deletions++;
        }

        files.push({
          filename,
          status,
          additions,
          deletions,
          changes: additions + deletions,
          patch,
          previousFilename: filenameA !== filenameB ? filenameA : null,
        });
      }

      const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
      const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

      return res.json({
        sha,
        message: commit?.message || '',
        author: commit?.author || '',
        date: commit?.committedAt?.toISOString() || '',
        stats: { additions: totalAdditions, deletions: totalDeletions, total: totalAdditions + totalDeletions },
        files,
        htmlUrl: null,
      });
    }

    // No diff data available
    return res.json({
      sha,
      message: commit?.message || '',
      author: commit?.author || '',
      date: commit?.committedAt?.toISOString() || '',
      stats: { additions: 0, deletions: 0, total: 0 },
      files: [],
      htmlUrl: null,
    });
  } catch (err) {
    console.error('Get commit diff error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/branches — list distinct branches for a repo
router.get('/:id/branches', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const commits = await prisma.commit.findMany({
      where: { repoId: id, branch: { not: null } },
      select: { branch: true },
      distinct: ['branch'],
      orderBy: { committedAt: 'desc' },
    });

    const branches = commits.map((c) => c.branch).filter(Boolean) as string[];
    res.json({ branches });
  } catch (err) {
    console.error('List branches error:', err);
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

    const commitWhere: any = { repoId: id };
    if (req.query.branch) {
      commitWhere.branch = req.query.branch as string;
    }

    const commits = await prisma.commit.findMany({
      where: commitWhere,
      include: {
        session: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
          },
        },
        codingSession: {
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
      // Use session (1:1 via commitId) or codingSession (many:1 via sessionId)
      const sess = c.session || c.codingSession;
      // Remove codingSession from output to keep API shape consistent
      const { codingSession: _cs, ...commitWithout } = c;

      if (!sess) return { ...commitWithout, session: null };

      const dbPrompts = (sess.promptChanges || []).map((pc: any) => ({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged: JSON.parse(pc.filesChanged || '[]'),
        diff: pc.diff || '',
      }));

      // If no PromptChange records exist, extract prompts from transcript
      let promptChanges = dbPrompts;
      if (dbPrompts.length === 0 && sess.transcript) {
        try {
          const msgs = JSON.parse(sess.transcript);
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

      // Filter promptChanges by file overlap with this commit's files
      let commitFiles: string[] = [];
      try { commitFiles = JSON.parse(c.filesChanged || '[]'); } catch {}

      if (commitFiles.length > 0 && promptChanges.length > 0) {
        const relevant = promptChanges.filter((pc: any) => {
          const pcFiles: string[] = pc.filesChanged || [];
          return pcFiles.some((f: string) => commitFiles.some((cf: string) =>
            f === cf || f.endsWith(cf) || cf.endsWith(f)
          ));
        });
        // Use filtered prompts if any match; otherwise keep all (fallback)
        if (relevant.length > 0) {
          promptChanges = relevant;
        }
      }

      // Don't send full transcript in commits list (too large)
      const { transcript, ...sessionWithoutTranscript } = sess;

      return {
        ...commitWithout,
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

// DELETE /:id/backfilled-sessions — remove sessions that have 0 tokens (backfilled placeholder data)
router.delete('/:id/backfilled-sessions', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Find sessions with 0 tokens (placeholder backfills)
    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: { session: true, codingSession: true },
    });

    let deleted = 0;
    for (const commit of commits) {
      const sess = (commit as any).session || (commit as any).codingSession;
      if (sess && sess.tokensUsed === 0) {
        // Clear sessionId FK on commits before deleting session
        await prisma.commit.updateMany({
          where: { sessionId: sess.id },
          data: { sessionId: null },
        });
        await prisma.promptChange.deleteMany({ where: { sessionId: sess.id } });
        await prisma.sessionDiff.deleteMany({ where: { sessionId: sess.id } });
        await prisma.sessionReview.deleteMany({ where: { sessionId: sess.id } });
        await prisma.secretFinding.deleteMany({ where: { sessionId: sess.id } });
        await prisma.codingSession.delete({ where: { id: sess.id } });
        deleted++;
      }
    }

    res.json({ deleted });
  } catch (err) {
    console.error('Delete backfilled sessions error:', err);
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

// GET /:id/health — repo health score
router.get('/:id/health', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const orgId = req.user!.orgId;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    // Get all sessions for this repo
    const sessions = await prisma.codingSession.findMany({
      where: {
        commit: { repoId: id },
      },
      select: {
        id: true,
        costUsd: true,
        linesAdded: true,
        linesRemoved: true,
        createdAt: true,
        review: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sessionCount = sessions.length;

    // AI percentage for this repo
    const totalCommits = await prisma.commit.count({
      where: { repoId: id },
    });
    const aiCommits = await prisma.commit.count({
      where: {
        repoId: id,
        OR: [
          { session: { isNot: null } },
          { aiToolDetected: { not: null } },
        ],
      },
    });
    const aiPercentage = totalCommits > 0
      ? parseFloat(((aiCommits / totalCommits) * 100).toFixed(1))
      : 0;

    // Review coverage
    const reviewedCount = sessions.filter((s) => s.review !== null).length;
    const reviewCoverage = sessionCount > 0
      ? parseFloat(((reviewedCount / sessionCount) * 100).toFixed(1))
      : 100;

    // Violations for this repo
    const violations = await prisma.auditLog.count({
      where: {
        orgId,
        action: { contains: 'VIOLATION' },
        resource: id,
      },
    });

    // Last session date
    const lastSession = sessions.length > 0 ? sessions[0].createdAt : null;

    // Health score calculation (0-100)
    // Factors: review coverage (40%), low violations (30%), activity recency (20%), base (10%)
    let healthScore = 10; // Base

    // Review coverage (0-40)
    healthScore += Math.min(40, (reviewCoverage / 100) * 40);

    // Violation rate (0-30, inversely proportional)
    if (sessionCount > 0) {
      const violationRate = violations / sessionCount;
      healthScore += Math.max(0, 30 * (1 - Math.min(1, violationRate * 5)));
    } else {
      healthScore += 30;
    }

    // Activity recency (0-20)
    if (lastSession) {
      const daysSinceLastSession =
        (Date.now() - lastSession.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceLastSession < 1) healthScore += 20;
      else if (daysSinceLastSession < 7) healthScore += 15;
      else if (daysSinceLastSession < 30) healthScore += 10;
      else if (daysSinceLastSession < 90) healthScore += 5;
    }

    healthScore = Math.round(Math.min(100, Math.max(0, healthScore)));

    res.json({
      repoId: id,
      repoName: repo.name,
      healthScore,
      aiPercentage,
      sessionCount,
      reviewCoverage,
      violations,
      lastSession,
      totalCommits,
    });
  } catch (err) {
    console.error('Repo health error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Repo Members (User↔Repo access control) ────────────────────────────────

// GET /:id/members — list users assigned to a repo
router.get('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const members = await prisma.repoMember.findMany({
      where: { repoId: id },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });

    res.json(members.map((m) => ({ ...m.user, assignedAt: m.createdAt })));
  } catch (err) {
    console.error('Get repo members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id/members — admin: replace all members for a repo
router.put('/:id/members', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { userIds } = req.body;

    if (!Array.isArray(userIds)) {
      return res.status(400).json({ error: 'userIds must be an array' });
    }

    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Verify all users belong to same org
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, orgId: req.user!.orgId },
    });
    if (users.length !== userIds.length) {
      return res.status(400).json({ error: 'Some user IDs are invalid or not in your org' });
    }

    // Replace: delete all existing, insert new
    await prisma.repoMember.deleteMany({ where: { repoId: id } });
    if (userIds.length > 0) {
      await prisma.repoMember.createMany({
        data: userIds.map((userId: string) => ({ repoId: id, userId })),
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_MEMBERS_UPDATED',
        resource: id,
        metadata: JSON.stringify({ repoName: repo.name, memberCount: userIds.length }),
      },
    });

    res.json({ success: true, memberCount: userIds.length });
  } catch (err) {
    console.error('Update repo members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Repo Agent Access (Agent↔Repo access control) ──────────────────────────

// GET /:id/agents — list agents that can access this repo
router.get('/:id/agents', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const access = await prisma.agentRepo.findMany({
      where: { repoId: id },
      include: { agent: { select: { id: true, name: true, slug: true, model: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });

    res.json(access.map((a) => ({ ...a.agent, assignedAt: a.createdAt })));
  } catch (err) {
    console.error('Get repo agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id/agents — admin: set agent list for a repo
router.put('/:id/agents', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { agentIds } = req.body;

    if (!Array.isArray(agentIds)) {
      return res.status(400).json({ error: 'agentIds must be an array' });
    }

    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Verify all agents belong to same org
    const agents = await prisma.agent.findMany({
      where: { id: { in: agentIds }, orgId: req.user!.orgId },
    });
    if (agents.length !== agentIds.length) {
      return res.status(400).json({ error: 'Some agent IDs are invalid or not in your org' });
    }

    // Replace: delete all existing, insert new
    await prisma.agentRepo.deleteMany({ where: { repoId: id } });
    if (agentIds.length > 0) {
      await prisma.agentRepo.createMany({
        data: agentIds.map((agentId: string) => ({ repoId: id, agentId })),
      });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_AGENTS_UPDATED',
        resource: id,
        metadata: JSON.stringify({ repoName: repo.name, agentCount: agentIds.length }),
      },
    });

    res.json({ success: true, agentCount: agentIds.length });
  } catch (err) {
    console.error('Update repo agents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
