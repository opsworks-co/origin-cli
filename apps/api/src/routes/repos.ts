import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rate-limit.js';
import { syncSnapshots } from '../services/snapshot.js';
import { generateWebhookSecret } from '../services/webhook.js';
import {
  getIntegrationConfig,
  listGitHubRepos,
  createGitHubWebhook,
  deleteGitHubWebhook,
  parseRepoFullName,
} from '../services/github-integration.js';
import {
  getGitLabIntegrationConfig,
  getValidGitLabToken,
  listGitLabRepos,
  createGitLabWebhook,
  deleteGitLabWebhook,
  parseGitLabProjectPath,
} from '../services/gitlab-integration.js';
import { detectAITool } from '../services/ai-commit-detector.js';
import { safeParseArray } from '../utils/safe-json.js';
import { validateFieldLengths, COMMON_LIMITS } from '../utils/validate.js';
import { isGitNotesMetadataCommit } from '../utils/commit-filter.js';
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

    // Compute effective provider per repo. The stored `provider` column can
    // lie in two directions:
    //   1. A repo imported via CLI session upload gets provider='github' if
    //      its path starts with "github.com/…", even though the org may
    //      never have connected a GitHub integration — in that case we
    //      can't actually pull anything from GitHub, so it should behave
    //      like a local repo (UI grouping, sync semantics, etc).
    //   2. A repo whose GitHub/GitLab integration was later disconnected
    //      should also fall back to local until it's reconnected.
    //
    // Load integration state once per request rather than per-repo.
    let hasGitHub = false;
    let hasGitLab = false;
    try {
      hasGitHub = !!(await getIntegrationConfig(req.user!.orgId, 'github'));
    } catch { /* treat as disconnected */ }
    try {
      hasGitLab = !!(await getGitLabIntegrationConfig(req.user!.orgId));
    } catch { /* treat as disconnected */ }

    const result = repos.map((r) => {
      const path = r.path || '';
      const looksGitHub = /github\.com\//.test(path);
      const looksGitLab = /gitlab\.com\//.test(path);
      let effectiveProvider: 'github' | 'gitlab' | 'local';
      if (looksGitHub && hasGitHub) effectiveProvider = 'github';
      else if (looksGitLab && hasGitLab) effectiveProvider = 'gitlab';
      else effectiveProvider = 'local';
      return {
        ...r,
        effectiveProvider,
        // Preserve raw values so the UI can still show "would be X if you
        // connected the integration" hints.
        declaredProvider: r.provider,
        _count: { ...r._count, sessions: sessionsPerRepo.get(r.id) || 0 },
      };
    });
    res.json(result);
  } catch (err) {
    console.error('List repos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST / — create repo (ADMIN+ only)
router.post('/', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { name, path, provider } = req.body;

    if (!name || !path) {
      return res.status(400).json({ error: 'Missing required fields: name, path' });
    }
    const lenErr = validateFieldLengths(
      { name, path, provider },
      { name: COMMON_LIMITS.name, path: COMMON_LIMITS.path, provider: 50 },
    );
    if (lenErr) {
      return res.status(400).json({ error: lenErr });
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

// ── GitLab Repo Discovery & Import ──────────────────────────────────

// GET /gitlab/discover — list GitLab projects available to org's token
router.get('/gitlab/discover', requireRole('MEMBER'), async (req: AuthRequest, res: Response) => {
  try {
    const integration = await getGitLabIntegrationConfig(req.user!.orgId);
    if (!integration) {
      return res.status(400).json({ error: 'GitLab not connected. Add a GitLab token in Settings → Integrations.' });
    }

    const { token, authType } = await getValidGitLabToken(integration);
    const result = await listGitLabRepos(token, integration.apiBaseUrl, authType);
    if (!result.success || !result.repos) {
      return res.status(502).json({ error: result.error || 'Failed to fetch repos from GitLab' });
    }

    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId, provider: 'gitlab' },
      select: { id: true, path: true },
    });

    const discoveredRepos = result.repos.map((glRepo) => {
      const match = existingRepos.find((r) => {
        const rPath = parseGitLabProjectPath(r.path);
        return rPath && rPath.toLowerCase() === glRepo.fullPath.toLowerCase();
      });
      return {
        ...glRepo,
        alreadyImported: !!match,
        originRepoId: match?.id || undefined,
      };
    });

    res.json({ repos: discoveredRepos });
  } catch (err) {
    console.error('GitLab discover error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /gitlab/import — import selected GitLab repos with auto-webhook creation
router.post('/gitlab/import', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const { repos: reposToImport, originBaseUrl } = req.body as {
      repos: Array<{ fullPath: string; name?: string }>;
      originBaseUrl: string;
    };

    if (!reposToImport || !Array.isArray(reposToImport) || reposToImport.length === 0) {
      return res.status(400).json({ error: 'No repos specified for import' });
    }
    if (!originBaseUrl) {
      return res.status(400).json({ error: 'Missing originBaseUrl' });
    }

    const integration = await getGitLabIntegrationConfig(req.user!.orgId);
    if (!integration) {
      return res.status(400).json({ error: 'GitLab not connected' });
    }

    const { token: glToken, authType: glAuthType } = await getValidGitLabToken(integration);

    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.user!.orgId, provider: 'gitlab' },
      select: { id: true, path: true },
    });

    const results: Array<{ fullPath: string; success: boolean; repoId?: string; error?: string }> = [];

    for (const item of reposToImport) {
      const projectPath = parseGitLabProjectPath(item.fullPath);
      if (!projectPath) {
        results.push({ fullPath: item.fullPath, success: false, error: 'Invalid project path' });
        continue;
      }

      const alreadyExists = existingRepos.find((r) => {
        const rPath = parseGitLabProjectPath(r.path);
        return rPath && rPath.toLowerCase() === projectPath.toLowerCase();
      });

      if (alreadyExists) {
        results.push({ fullPath: item.fullPath, success: true, repoId: alreadyExists.id, error: 'Already imported' });
        continue;
      }

      try {
        const repoName = item.name || projectPath.split('/').pop() || projectPath;
        const repo = await prisma.repo.create({
          data: {
            orgId: req.user!.orgId,
            name: repoName,
            path: `gitlab.com/${projectPath}`,
            provider: 'gitlab',
          },
        });

        // Create webhook on GitLab
        let webhookCreated = false;
        const secret = generateWebhookSecret();
        const webhookUrl = `${originBaseUrl}/api/webhooks/gitlab/${repo.id}`;

        const webhook = await prisma.webhook.create({
          data: { repoId: repo.id, secret },
        });

        const glResult = await createGitLabWebhook(
          glToken,
          projectPath,
          webhookUrl,
          secret,
          integration.apiBaseUrl,
          glAuthType,
        );

        webhookCreated = glResult.success;
        if (glResult.success && glResult.hookId) {
          await prisma.webhook.update({
            where: { id: webhook.id },
            data: { githubWebhookId: glResult.hookId }, // reuse field for GitLab hook ID
          });
        }

        await prisma.auditLog.create({
          data: {
            orgId: req.user!.orgId,
            userId: req.user!.id,
            action: 'REPO_IMPORTED',
            resource: repo.id,
            metadata: JSON.stringify({
              name: repoName,
              fullPath: item.fullPath,
              webhookCreated,
              provider: 'gitlab',
            }),
          },
        });

        results.push({
          fullPath: item.fullPath,
          success: true,
          repoId: repo.id,
          error: webhookCreated ? undefined : 'Repo created but webhook failed',
        });
      } catch (importErr: any) {
        console.error(`Failed to import ${item.fullPath}:`, importErr.message);
        results.push({ fullPath: item.fullPath, success: false, error: importErr.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('GitLab import error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/sync — sync a repo
router.post('/:id/sync', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const result = await syncSnapshots({ ...repo, orgId: req.user!.orgId });

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

// POST /:id/backfill-files — fill in commit.filesChanged / additions /
// deletions from the GitHub or GitLab API for rows that were ingested before
// the webhook captured them (or via a code path that left them blank).
// This unsticks the commit-detail page for legacy commits without requiring
// a fresh push.
router.post('/:id/backfill-files', requireRole('ADMIN'), expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    if (repo.provider !== 'github' && repo.provider !== 'gitlab') {
      return res.status(400).json({ error: 'Backfill requires a GitHub or GitLab-backed repo' });
    }

    // Grab missing-file commits. Capped at 500 per call so a monorepo with
    // thousands of rows doesn't DoS the provider API; re-run to chip away.
    const MAX_PER_CALL = 500;
    const commits = await prisma.commit.findMany({
      where: {
        repoId: id,
        OR: [{ filesChanged: '[]' }, { filesChanged: '' }, { filesChanged: { equals: null as any } }],
      },
      orderBy: { committedAt: 'desc' },
      take: MAX_PER_CALL,
    });

    if (commits.length === 0) {
      return res.json({ scanned: 0, updated: 0, failed: 0, truncated: false });
    }

    let token: string | undefined;
    let apiBase = '';
    let projectOrOwnerRepo: { owner: string; repo: string } | string | null = null;
    const headers: Record<string, string> = { 'User-Agent': 'Origin-App' };

    if (repo.provider === 'github') {
      const integration = await getIntegrationConfig(req.user!.orgId, 'github');
      if (integration?.token) token = integration.token;
      else if (process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;
      const parsed = parseRepoFullName(repo.path);
      if (!parsed) return res.status(400).json({ error: 'Unable to parse GitHub repo path' });
      projectOrOwnerRepo = parsed;
      apiBase = integration?.apiBaseUrl || 'https://api.github.com';
      headers.Accept = 'application/vnd.github.v3+json';
      if (token) headers.Authorization = `Bearer ${token}`;
    } else {
      const integration = await getGitLabIntegrationConfig(req.user!.orgId);
      if (!integration) return res.status(400).json({ error: 'GitLab integration not configured' });
      const { token: glToken } = await getValidGitLabToken(integration);
      if (!glToken) return res.status(400).json({ error: 'GitLab token unavailable' });
      token = glToken;
      const projectPath = parseGitLabProjectPath(repo.path);
      if (!projectPath) return res.status(400).json({ error: 'Unable to parse GitLab project path' });
      projectOrOwnerRepo = projectPath;
      apiBase = (integration as any).apiBaseUrl || 'https://gitlab.com/api/v4';
      headers['PRIVATE-TOKEN'] = token;
      headers.Authorization = `Bearer ${token}`;
    }

    // Serial, not parallel — the provider rate-limits per-token and a 500-way
    // fan-out burns the budget fast. Small delay between calls keeps us well
    // under GitHub's 5k/h authenticated ceiling for typical repo sizes.
    let updated = 0;
    let failed = 0;
    for (const c of commits) {
      try {
        let files: string[] = [];
        let additions = 0;
        let deletions = 0;
        if (repo.provider === 'github') {
          const { owner, repo: name } = projectOrOwnerRepo as { owner: string; repo: string };
          const r = await fetch(`${apiBase}/repos/${owner}/${name}/commits/${c.sha}`, { headers });
          if (!r.ok) { failed++; continue; }
          const data = await r.json() as any;
          for (const f of (data.files || [])) {
            files.push(f.filename);
            additions += f.additions || 0;
            deletions += f.deletions || 0;
          }
        } else {
          const encoded = encodeURIComponent(projectOrOwnerRepo as string);
          const r = await fetch(`${apiBase}/projects/${encoded}/repository/commits/${c.sha}/diff?per_page=100`, { headers });
          if (!r.ok) { failed++; continue; }
          const diffs = await r.json() as any[];
          for (const d of (diffs || [])) {
            files.push(d.new_path || d.old_path);
            const patch = d.diff || '';
            for (const line of patch.split('\n')) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
          }
        }

        if (files.length > 0) {
          await prisma.commit.update({
            where: { id: c.id },
            data: {
              filesChanged: JSON.stringify(files),
              fileCount: files.length,
              // Only fill these if they were unset — preserve any values that
              // were stamped by a session-level capture.
              ...(c.additions == null && { additions }),
              ...(c.deletions == null && { deletions }),
            },
          });
          updated++;
        }
      } catch {
        failed++;
      }
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.user!.orgId,
        userId: req.user!.id,
        action: 'REPO_FILES_BACKFILLED',
        resource: repo.id,
        metadata: JSON.stringify({ scanned: commits.length, updated, failed }),
      },
    });

    res.json({
      scanned: commits.length,
      updated,
      failed,
      truncated: commits.length === MAX_PER_CALL,
    });
  } catch (err) {
    console.error('Backfill files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/import-sessions — import sessions from the origin-sessions git branch
router.post('/:id/import-sessions', expensiveLimiter, async (req: AuthRequest, res: Response) => {
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
      // Don't echo err.message back — it can contain request URLs,
      // internal hostnames, or stack traces from node-fetch. Log
      // server-side, return a generic failure to the caller.
      console.error('[repos] failed to read origin-sessions branch:', err);
      return res.status(500).json({ error: 'Failed to read origin-sessions branch' });
    }

    // 2. Filter for session JSON files
    const sessionFiles = (treeData.tree || []).filter(
      (f: any) => f.path?.startsWith('sessions/') && f.path?.endsWith('.json') && f.type === 'blob',
    );

    if (sessionFiles.length === 0) {
      return res.json({ imported: 0, skipped: 0, message: 'No session files found in origin-sessions branch' });
    }

    // 3. Get existing session IDs to skip duplicates. Cap at 500k — the
    // import path only dedupes against recently-seen ids, and pulling
    // every session across the org would OOM the process on large
    // tenants.
    const existingSessions = await prisma.codingSession.findMany({
      where: {
        commit: { repo: { orgId: req.user!.orgId } },
      },
      select: { id: true },
      take: 500_000,
      orderBy: { createdAt: 'desc' },
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
router.post('/:id/rescan', requireRole('ADMIN'), expensiveLimiter, async (req: AuthRequest, res: Response) => {
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

    // Process commits in the repo (cap 100k for DoS defense — rescan is
    // a CLI-triggered admin op but still runs in-request).
    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: {
        session: { select: { model: true } },
        codingSession: { select: { model: true } },
      },
      take: 100_000,
      orderBy: { committedAt: 'desc' },
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
    const { name, path, provider, verboseCapture } = req.body;

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
        ...(typeof verboseCapture === 'boolean' && { verboseCapture }),
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

    // Clean up provider webhooks if auto-created
    const webhooks = await prisma.webhook.findMany({ where: { repoId: id } });
    for (const wh of webhooks) {
      if (wh.githubWebhookId) {
        if (existing.provider === 'gitlab') {
          const glIntegration = await getGitLabIntegrationConfig(req.user!.orgId);
          const projectPath = parseGitLabProjectPath(existing.path);
          if (glIntegration && projectPath) {
            const { token: glTok, authType: glAt } = await getValidGitLabToken(glIntegration);
            await deleteGitLabWebhook(
              glTok,
              projectPath,
              wh.githubWebhookId,
              glIntegration.apiBaseUrl,
              glAt,
            );
          }
        } else {
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
        await prisma.issueSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
      }
      await prisma.codingSession.deleteMany({
        where: { commitId: { in: commitIds } },
      });
      await prisma.commit.deleteMany({ where: { repoId: id } });
    }

    await prisma.issueSession.deleteMany({ where: { issue: { repoId: id } } });
    await prisma.issue.deleteMany({ where: { repoId: id } });
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

    // Distinct branches — cap at 5000 branches worth of rows to scan.
    // Realistic repos have <500 branches; 5000 keeps headroom.
    const commits = await prisma.commit.findMany({
      where: { repoId: id, branch: { not: null } },
      select: { branch: true },
      distinct: ['branch'],
      orderBy: { committedAt: 'desc' },
      take: 5000,
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

    // Hard cap: /:id/commits returns the 1k most recent commits. The
    // UI paginates via its own cursor; this ceiling exists to stop a
    // single request from loading a monorepo's entire history (OOM).
    const rawCommits = await prisma.commit.findMany({
      where: commitWhere,
      include: {
        session: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
            // Include the Agent relation so the UI can render the agent
            // slug (e.g. "claude-code", "cursor") instead of the raw
            // provider model name ("gemini-3-flash-preview").
            agent: { select: { id: true, slug: true, name: true } },
            // Include the user so the list can show the human name instead
            // of the "mcp-agent" placeholder that session/start stamped on
            // the commit before the author was known.
            user: { select: { id: true, name: true, email: true } },
          },
        },
        codingSession: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
            agent: { select: { id: true, slug: true, name: true } },
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { committedAt: 'desc' },
      take: 1000,
    });

    // Filter out git-notes metadata commits, session-only placeholders,
    // and dedupe by SHA.
    //
    // Session placeholders: session/start stamps a Commit row with a random
    // SHA so the CodingSession has a FK target. If the session never
    // produces a real git commit (read-only / planning runs, or a session
    // that crashed before git-capture), that placeholder row stays in the
    // Commit table forever with no filesChanged / additions / deletions.
    // Those aren't commits the user ever made — they shouldn't appear in
    // the commits list. Keep them out via a strict "no real change data"
    // test so we don't accidentally hide real commits the webhook hasn't
    // fully hydrated yet (those have a non-random author and/or a real
    // message and/or a committedAt from the source).
    const isSessionPlaceholder = (c: any): boolean => {
      if (c.aiDetectionMethod !== 'session') return false;
      const filesChangedEmpty = !c.filesChanged || c.filesChanged === '[]';
      const noStats = c.additions == null && c.deletions == null && c.fileCount == null;
      const noMessage = !c.message || c.message.trim() === '';
      return filesChangedEmpty && noStats && noMessage;
    };
    const seen = new Set<string>();
    const commits: typeof rawCommits = [];
    for (const c of rawCommits) {
      if (isGitNotesMetadataCommit(c.message)) continue;
      if (isSessionPlaceholder(c)) continue;
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      commits.push(c);
    }

    // Map promptChanges; fall back to parsing transcript for prompt texts
    const mapped = commits.map((c: any) => {
      // Use session (1:1 via commitId) or codingSession (many:1 via sessionId)
      const sess = c.session || c.codingSession;
      // Remove codingSession from output to keep API shape consistent
      const { codingSession: _cs, ...commitWithout } = c;

      // Retroactive fallbacks for placeholder commits that were stamped
      // with author="mcp-agent" and message="" before session/end had the
      // data to fill them in. Keeps legacy rows readable without requiring
      // a DB migration.
      if (sess) {
        if (!commitWithout.message || commitWithout.message.trim() === '') {
          const fallbackMessage = sess.prompt
            ? sess.prompt.slice(0, 200)
            : (sess.promptChanges?.[0]?.promptText || '').slice(0, 200);
          if (fallbackMessage) commitWithout.message = fallbackMessage;
        }
        if (commitWithout.author === 'mcp-agent' || !commitWithout.author) {
          const fallbackAuthor = sess.user?.name || sess.user?.email || sess.apiKeyName;
          if (fallbackAuthor) commitWithout.author = fallbackAuthor;
        }
      }

      if (!sess) return { ...commitWithout, session: null };

      const dbPrompts = (sess.promptChanges || []).map((pc: any) => ({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged: safeParseArray<string>(pc.filesChanged, `repos.list prompt ${pc.promptIndex}`),
        diff: pc.diff || '',
        uncommittedDiff: pc.uncommittedDiff || '',
        commitSha: pc.commitSha || null,
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
                commitSha: null,
              }));
          }
        } catch {
          // transcript not valid JSON – ignore
        }
      }

      // Prefer exact commitSha attribution; fall back to file overlap.
      const byCommitSha = promptChanges.filter((pc: any) => pc.commitSha === c.sha);
      if (byCommitSha.length > 0) {
        promptChanges = byCommitSha;
      } else {
        const commitFiles = safeParseArray<string>(c.filesChanged, `repos.list commit ${c.sha}`);
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

// GET /:id/commit/:sha — full commit detail: metadata, session, prompts, diff (one call)
router.get('/:id/commit/:sha', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const sha = (req.params as any).sha as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.user!.orgId },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const commit = await prisma.commit.findFirst({
      where: { repoId: id, sha },
      include: {
        session: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
            sessionDiff: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
        codingSession: {
          include: {
            promptChanges: { orderBy: { promptIndex: 'asc' } },
            review: true,
            sessionDiff: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!commit) return res.status(404).json({ error: 'Commit not found' });

    let sess: any = (commit as any).session || (commit as any).codingSession;

    // Retroactive fallbacks — if the placeholder row was created before the
    // session had a user/prompt, fall back to those here so legacy commits
    // render a real name and message on the detail page too.
    if (sess) {
      if (!commit.message || commit.message.trim() === '') {
        const fallbackMessage = sess.prompt
          ? sess.prompt.slice(0, 200)
          : (sess.promptChanges?.[0]?.promptText || '').slice(0, 200);
        if (fallbackMessage) (commit as any).message = fallbackMessage;
      }
      if (commit.author === 'mcp-agent' || !commit.author) {
        const fallbackAuthor = sess.user?.name || sess.user?.email || sess.apiKeyName;
        if (fallbackAuthor) (commit as any).author = fallbackAuthor;
      }
    }

    // Fallback: if no direct FK link (e.g. commit synced from GitHub/GitLab
    // without an Origin hook), look up a session whose SessionDiff.commitShas
    // contains this SHA. This hydrates prompts/agent/model for provider-synced commits.
    if (!sess) {
      try {
        const linkedDiff = await prisma.sessionDiff.findFirst({
          where: {
            commitShas: { contains: sha },
            session: { commit: { repoId: id } },
          },
          include: {
            session: {
              include: {
                promptChanges: { orderBy: { promptIndex: 'asc' } },
                review: true,
                sessionDiff: true,
                agent: true,
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        });
        if (linkedDiff?.session) {
          sess = linkedDiff.session;
        } else {
          // Broader fallback: any session in this org whose sessionRepos points
          // at this repo and whose time window brackets the commit time.
          const commitTime = commit.committedAt.getTime();
          const windowMs = 4 * 60 * 60 * 1000; // ±4h
          const candidates = await prisma.codingSession.findMany({
            where: {
              commit: { repoId: id },
              startedAt: { lte: new Date(commitTime + windowMs) },
            },
            include: {
              promptChanges: { orderBy: { promptIndex: 'asc' } },
              review: true,
              sessionDiff: true,
              agent: true,
              user: { select: { id: true, name: true, email: true } },
            },
            orderBy: { startedAt: 'desc' },
            take: 10,
          });
          // Pick the session whose files overlap this commit's files
          const commitFiles = safeParseArray<string>(commit.filesChanged, `repos.detail commit ${commit.sha}`);
          const match = candidates.find((c) => {
            const sFiles = safeParseArray<string>(c.filesChanged, `repos.detail candidate ${c.id}`);
            return sFiles.some((sf) =>
              commitFiles.some((cf) => sf === cf || sf.endsWith(cf) || cf.endsWith(sf))
            );
          });
          if (match) sess = match;
        }
      } catch (e) {
        console.error('Session fallback lookup failed:', e);
      }
    }

    // Build promptChanges list (like the list endpoint)
    let promptChanges: any[] = [];
    if (sess) {
      promptChanges = (sess.promptChanges || []).map((pc: any) => ({
        promptIndex: pc.promptIndex,
        promptText: pc.promptText,
        filesChanged: (() => { try { return JSON.parse(pc.filesChanged || '[]'); } catch { return []; } })(),
        diff: pc.diff || '',
        commitSha: pc.commitSha || null,
      }));

      // Fallback: extract from transcript if no promptChanges
      if (promptChanges.length === 0 && sess.transcript) {
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
                commitSha: null,
              }));
          }
        } catch {/* ignore */}
      }

      // Show ONLY prompts whose commitSha matches this commit. Anything else
      // is a guess — the previous file-overlap fallback bundled every prompt
      // that touched any of the commit's files, which usually meant every
      // session prompt got listed. Empty is better than wrong; legacy commits
      // (pre commitSha-attribution) show no prompts here.
      promptChanges = promptChanges.filter((pc: any) => pc.commitSha === sha);
    }

    // Build per-file diff (reuse sessionDiff / prompt diff parsing)
    let rawDiff = sess?.sessionDiff?.diff || '';
    if (!rawDiff && sess) {
      const pcs = await prisma.promptChange.findMany({
        where: { sessionId: sess.id },
        orderBy: { promptIndex: 'asc' },
      });
      rawDiff = pcs.map((pc: any) => pc.diff || '').filter(Boolean).join('\n');
    }

    const files: any[] = [];
    if (rawDiff) {
      const sections = rawDiff.split(/^diff --git /m).filter(Boolean);
      for (const section of sections) {
        const lines = section.split('\n');
        const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
        if (!headerMatch) continue;
        const filenameA = headerMatch[1];
        const filenameB = headerMatch[2];
        const filename = filenameB;

        let status = 'modified';
        if (section.includes('new file mode')) status = 'added';
        else if (section.includes('deleted file mode')) status = 'removed';
        else if (filenameA !== filenameB) status = 'renamed';

        const patchStart = section.indexOf('@@');
        const patch = patchStart >= 0 ? section.slice(patchStart) : '';

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
    }

    // If no local diff and repo is GitLab-backed, fall back to GitLab API
    if (files.length === 0 && repo.provider === 'gitlab') {
      try {
        const projectPath = parseGitLabProjectPath(repo.path);
        const integration = await getGitLabIntegrationConfig(req.user!.orgId);
        if (projectPath && integration) {
          const { token } = await getValidGitLabToken(integration);
          if (token) {
            const apiBase = (integration as any).apiBaseUrl || 'https://gitlab.com/api/v4';
            const encodedPath = encodeURIComponent(projectPath);
            const headers: Record<string, string> = {
              'PRIVATE-TOKEN': token,
              Authorization: `Bearer ${token}`,
              'User-Agent': 'Origin-App',
            };
            const glRes = await fetch(
              `${apiBase}/projects/${encodedPath}/repository/commits/${sha}/diff?per_page=100`,
              { headers },
            );
            if (glRes.ok) {
              const diffs = await glRes.json() as any[];
              if (Array.isArray(diffs)) {
                for (const d of diffs) {
                  let status = 'modified';
                  if (d.new_file) status = 'added';
                  else if (d.deleted_file) status = 'removed';
                  else if (d.renamed_file) status = 'renamed';

                  // GitLab returns `diff` as a patch starting with @@
                  let patch: string = d.diff || '';
                  if (patch && !patch.startsWith('@@')) {
                    // GitLab sometimes omits @@ hunk header prefix; pass through as-is
                  }
                  let additions = 0;
                  let deletions = 0;
                  for (const line of patch.split('\n')) {
                    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
                    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
                  }

                  files.push({
                    filename: d.new_path || d.old_path,
                    status,
                    additions,
                    deletions,
                    changes: additions + deletions,
                    patch,
                    previousFilename: d.renamed_file ? d.old_path : null,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('GitLab commit detail fetch failed:', err);
      }
    }

    // If no local diff and repo is GitHub-backed, fall back to GitHub API
    if (files.length === 0 && repo.provider === 'github') {
      try {
        const parsed = parseRepoFullName(repo.path);
        if (parsed) {
          let token: string | undefined;
          const integration = await getIntegrationConfig(req.user!.orgId, 'github');
          if (integration?.token) token = integration.token;
          else if (process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;

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
          if (ghRes.ok) {
            const data = await ghRes.json() as any;
            for (const f of (data.files || [])) {
              files.push({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch || '',
                previousFilename: f.previous_filename || null,
              });
            }
          }
        }
      } catch {/* ignore */}
    }

    // Last-resort fallback: commits from purely local repos (no GitHub/GitLab
    // remote and no captured full session diff) may still have a file list
    // stamped on the CodingSession or Commit rows. Surface that so the UI can
    // at least show file names and totals instead of a blank "No files in
    // this commit." panel.
    if (files.length === 0) {
      // Prefer the session's filesChanged when available — it reflects what
      // the hook actually observed for this run. Fall back to the commit row.
      let storedFiles = sess
        ? safeParseArray<string>(sess.filesChanged, `repos.detail sess ${sess.id}`)
        : [];
      if (storedFiles.length === 0) {
        storedFiles = safeParseArray<string>(commit.filesChanged, `repos.detail stored ${commit.sha}`);
      }
      if (storedFiles.length > 0) {
        const totalAdd = sess?.linesAdded ?? commit.additions ?? 0;
        const totalDel = sess?.linesRemoved ?? commit.deletions ?? 0;
        // Distribute totals uniformly across files — real per-file splits
        // aren't recoverable without a diff, and the commit-level totals are
        // surfaced separately in the header.
        const perFileAdd = Math.floor(totalAdd / storedFiles.length);
        const perFileDel = Math.floor(totalDel / storedFiles.length);
        for (const filename of storedFiles) {
          files.push({
            filename,
            status: 'modified',
            additions: perFileAdd,
            deletions: perFileDel,
            changes: perFileAdd + perFileDel,
            patch: '',
            previousFilename: null,
          });
        }
      }
    }

    // Map each file to the prompt(s) that touched it
    const filesWithPromptIdx = files.map((f) => {
      const matchingPromptIndexes: number[] = [];
      for (const pc of promptChanges) {
        const pcFiles: string[] = pc.filesChanged || [];
        const touches = pcFiles.some((pf: string) =>
          pf === f.filename || pf.endsWith(f.filename) || f.filename.endsWith(pf)
        );
        if (touches) matchingPromptIndexes.push(pc.promptIndex);
      }
      return { ...f, promptIndexes: matchingPromptIndexes };
    });

    // Prefer summed file-level counts, but fall back to the commit-level
    // stats if file rows have 0/0 (e.g. the local-only stored-files fallback
    // above was used without additions/deletions on the commit row).
    const fileAdditions = filesWithPromptIdx.reduce((s, f) => s + f.additions, 0);
    const fileDeletions = filesWithPromptIdx.reduce((s, f) => s + f.deletions, 0);
    const totalAdditions = fileAdditions > 0 ? fileAdditions : (sess?.linesAdded ?? commit.additions ?? 0);
    const totalDeletions = fileDeletions > 0 ? fileDeletions : (sess?.linesRemoved ?? commit.deletions ?? 0);

    // Build minimal session payload (no transcript)
    const sessionPayload = sess ? (() => {
      const { transcript, promptChanges: _pc, sessionDiff: _sd, ...rest } = sess;
      return {
        ...rest,
        filesChanged: (() => { try { return JSON.parse(sess.filesChanged || '[]'); } catch { return []; } })(),
      };
    })() : null;

    return res.json({
      sha: commit.sha,
      message: commit.message,
      author: commit.author,
      branch: commit.branch,
      committedAt: commit.committedAt?.toISOString() || '',
      aiToolDetected: commit.aiToolDetected,
      aiDetectionMethod: commit.aiDetectionMethod,
      stats: {
        additions: totalAdditions,
        deletions: totalDeletions,
        total: totalAdditions + totalDeletions,
      },
      files: filesWithPromptIdx,
      session: sessionPayload,
      promptChanges,
      repo: { id: repo.id, name: repo.name, provider: repo.provider, path: repo.path },
    });
  } catch (err) {
    console.error('Get commit detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id/backfilled-sessions — remove sessions that have 0 tokens (backfilled placeholder data)
// Admin-only: bulk-deletes placeholder session rows for a repo. A regular
// member should not be able to erase audit history, even for zero-token
// placeholders.
router.delete('/:id/backfilled-sessions', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.user!.orgId } });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Find sessions with 0 tokens (placeholder backfills). Cap at 100k
    // per request; if the repo has more, re-run the cleanup.
    const commits = await prisma.commit.findMany({
      where: { repoId: id },
      include: { session: true, codingSession: true },
      take: 100_000,
      orderBy: { committedAt: 'desc' },
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
        await prisma.issueSession.deleteMany({ where: { sessionId: sess.id } });
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

    // Defense-in-depth: scope the delete by repoId so the two prechecks
    // above aren't the only barrier between a guessed webhookId and a
    // cross-repo webhook deletion.
    const { count } = await prisma.webhook.deleteMany({
      where: { id: webhookId, repoId: id },
    });
    if (count === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

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

    // Get sessions for this repo — cap 100k for DoS defense (health
    // score only needs a representative sample).
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
      take: 100_000,
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

export default router;
