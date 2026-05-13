import { Router, Response } from 'express';
import { prisma } from '../db.js';
import { AuthRequest, requireAuth, resolveOrgContext, requireRole } from '../middleware/auth.js';
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
import { importOriginSessionsFromGit } from '../services/origin-sessions-import.js';
import { readableRepoIds, type RepoLevel } from '../services/access.js';
import { requireRepoAccess } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(resolveOrgContext);

// Map a refs/notes/origin payload's `agent` slug (and optional `model`) to
// the same display name the CLI's prepare-commit-msg trailer uses. Mirrors
// resolveAgentDisplayName in packages/cli/src/commands/hooks.ts so the web
// blame view labels lines the same way regardless of whether attribution
// came from our DB or the on-repo note.
function resolveAgentDisplayFromNote(o: { agent?: unknown; model?: unknown }): string | undefined {
  const m = `${typeof o.agent === 'string' ? o.agent : ''} ${typeof o.model === 'string' ? o.model : ''}`.toLowerCase();
  if (!m.trim()) return undefined;
  if (m.includes('copilot')) return 'Copilot';
  if (m.includes('codex')) return 'Codex CLI';
  if (m.includes('gemini')) return 'Gemini CLI';
  if (m.includes('cursor')) return 'Cursor';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'Claude Code';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'AI';
  return typeof o.agent === 'string' ? o.agent : undefined;
}

// GET / — list repos for org. For non-privileged users (MEMBER/VIEWER),
// the list is filtered to repos they have an explicit RepoMember row for.
// OWNER/ADMIN get the full list (readableRepoIds returns null).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const showArchived = req.query.archived === 'true';
    const accessible = await readableRepoIds(req.user!.id, req.activeOrgId!, req.activeRole);
    const accessFilter = accessible === null ? {} : { id: { in: accessible } };
    const repos = await prisma.repo.findMany({
      where: {
        orgId: req.activeOrgId!,
        ...(!showArchived && { archived: false }),
        ...accessFilter,
      },
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
      hasGitHub = !!(await getIntegrationConfig(req.activeOrgId!, 'github'));
    } catch { /* treat as disconnected */ }
    try {
      hasGitLab = !!(await getGitLabIntegrationConfig(req.activeOrgId!));
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
        orgId: req.activeOrgId!,
        name,
        path,
        provider: provider || 'local',
      },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
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
    const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
    if (!integration) {
      return res.status(400).json({ error: 'GitHub not connected. Add a GitHub token in Settings → Integrations.' });
    }

    const result = await listGitHubRepos(integration.token, integration.apiBaseUrl, integration.authType);
    if (!result.success || !result.repos) {
      return res.status(502).json({ error: result.error || 'Failed to fetch repos from GitHub' });
    }

    // Load existing Origin repos to mark which are already imported
    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.activeOrgId!, provider: 'github' },
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

    const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
    if (!integration) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    // Load existing repos to skip duplicates
    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.activeOrgId!, provider: 'github' },
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
            orgId: req.activeOrgId!,
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
            orgId: req.activeOrgId!,
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

        // Fire-and-forget: pull any prompts/snapshots that already exist
        // on the origin-sessions branch + git notes. Newly imported repos
        // get instant context for past sessions captured on other machines.
        importOriginSessionsFromGit(repo.id, req.activeOrgId!).catch((e) => {
          console.error('[github-import] auto import-sessions failed:', e);
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
    const integration = await getGitLabIntegrationConfig(req.activeOrgId!);
    if (!integration) {
      return res.status(400).json({ error: 'GitLab not connected. Add a GitLab token in Settings → Integrations.' });
    }

    const { token, authType } = await getValidGitLabToken(integration);
    const result = await listGitLabRepos(token, integration.apiBaseUrl, authType);
    if (!result.success || !result.repos) {
      return res.status(502).json({ error: result.error || 'Failed to fetch repos from GitLab' });
    }

    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.activeOrgId!, provider: 'gitlab' },
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

    const integration = await getGitLabIntegrationConfig(req.activeOrgId!);
    if (!integration) {
      return res.status(400).json({ error: 'GitLab not connected' });
    }

    const { token: glToken, authType: glAuthType } = await getValidGitLabToken(integration);

    const existingRepos = await prisma.repo.findMany({
      where: { orgId: req.activeOrgId!, provider: 'gitlab' },
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
            orgId: req.activeOrgId!,
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
            orgId: req.activeOrgId!,
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

        // Fire-and-forget: pull any session data already on the
        // origin-sessions branch (e.g. pushed from a developer's machine
        // before this admin connected GitLab to Origin).
        importOriginSessionsFromGit(repo.id, req.activeOrgId!).catch((e) => {
          console.error('[gitlab-import] auto import-sessions failed:', e);
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
      where: { id, orgId: req.activeOrgId! },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }

    const result = await syncSnapshots({ ...repo, orgId: req.activeOrgId! });

    // Pick up any new sessions/notes pushed since the last sync. Fire and
    // forget so /sync stays fast for the UI.
    importOriginSessionsFromGit(id, req.activeOrgId!).catch((e) => {
      console.error('[repo-sync] auto import-sessions failed:', e);
    });

    await prisma.repo.update({
      where: { id },
      data: { syncedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
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
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.activeOrgId! } });
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
      const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
      if (integration?.token) token = integration.token;
      else if (process.env.GITHUB_TOKEN) token = process.env.GITHUB_TOKEN;
      const parsed = parseRepoFullName(repo.path);
      if (!parsed) return res.status(400).json({ error: 'Unable to parse GitHub repo path' });
      projectOrOwnerRepo = parsed;
      apiBase = integration?.apiBaseUrl || 'https://api.github.com';
      headers.Accept = 'application/vnd.github.v3+json';
      if (token) headers.Authorization = `Bearer ${token}`;
    } else {
      const integration = await getGitLabIntegrationConfig(req.activeOrgId!);
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
        orgId: req.activeOrgId!,
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

// POST /:id/import-sessions — import sessions from the origin-sessions git
// branch + git notes. Works for both GitHub and GitLab, public or private
// (uses the org's integration token if configured, falls back to the public
// API for public repos).
router.post('/:id/import-sessions', expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    const result = await importOriginSessionsFromGit(id, req.activeOrgId!);
    if (result.imported === 0 && result.total === 0 && result.message) {
      return res.json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Import sessions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /:id/rescan — re-fetch full commit messages from GitHub and run AI detection
router.post('/:id/rescan', requireRole('ADMIN'), expensiveLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    // Fetch full commit messages from GitHub
    const parsed = parseGitHubUrl(repo.path);
    let fullMessages: Map<string, string> = new Map();

    if (parsed) {
      try {
        const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
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
      where: { id, orgId: req.activeOrgId! },
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
      where: { id, orgId: req.activeOrgId! },
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
        orgId: req.activeOrgId!,
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
      where: { id, orgId: req.activeOrgId! },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    const repo = await prisma.repo.update({
      where: { id },
      data: { archived: !!archived },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
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
      where: { id, orgId: req.activeOrgId! },
    });
    if (!existing) return res.status(404).json({ error: 'Repo not found' });

    // Clean up provider webhooks if auto-created
    const webhooks = await prisma.webhook.findMany({ where: { repoId: id } });
    for (const wh of webhooks) {
      if (wh.githubWebhookId) {
        if (existing.provider === 'gitlab') {
          const glIntegration = await getGitLabIntegrationConfig(req.activeOrgId!);
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
          const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
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
        orgId: req.activeOrgId!,
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
      where: { id, orgId: req.activeOrgId! },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });

    if (repo.provider === 'github') {
      // Parse GitHub URL to get owner/repo
      const parsed = parseRepoFullName(repo.path);
      if (!parsed) return res.status(400).json({ error: 'Invalid GitHub repo path' });

      // Try org integration token first, then fall back to env var
      let token: string | undefined;
      const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
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
      where: { id, orgId: req.activeOrgId! },
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
      where: { id, orgId: req.activeOrgId! },
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

// GET /:id/files — file directory view with per-file attribution.
//
// File existence is sourced from GitHub's tree API (the ground truth —
// "what files are actually in this repo right now"). Attribution is then
// merged in from our local Commit rows: per-path commit count, dominant
// agent, top contributor, sessions touched. Files that exist on the
// remote but have zero local activity still appear (with empty
// attribution). Files in our DB that no longer exist on the remote drop
// out — fixes the stale local-only-session ghost-file problem.
router.get('/:id/files', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    if (repo.provider !== 'github') {
      return res.status(400).json({ error: 'Files view currently supports GitHub repos only' });
    }
    const parsed = parseRepoFullName(repo.path);
    if (!parsed) return res.status(400).json({ error: 'Unable to parse repo path' });

    const config = await getIntegrationConfig(req.activeOrgId!, 'github');
    if (!config?.token) {
      return res.status(503).json({ error: 'GitHub integration not configured for this org' });
    }
    const apiBase = config.apiBaseUrl || 'https://api.github.com';
    const ghHeaders: Record<string, string> = {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'origin',
    };

    // Resolve which ref to walk:
    //   • explicit ?branch — use that
    //   • else — repo's default branch (GET /repos/{owner}/{repo})
    let ref: string = ((req.query.branch as string | undefined)?.trim() || '');
    if (!ref) {
      const repoResp = await fetch(`${apiBase}/repos/${parsed.owner}/${parsed.repo}`, { headers: ghHeaders });
      if (!repoResp.ok) {
        const t = await repoResp.text();
        console.error('[files] repo lookup failed', repoResp.status, t.slice(0, 200));
        return res.status(502).json({ error: `GitHub repo lookup failed (${repoResp.status})` });
      }
      const repoJson = await repoResp.json();
      ref = repoJson?.default_branch || 'main';
    }

    // Fetch the recursive tree. GitHub returns up to ~100k entries per
    // call; on monorepos that exceed this, the response is flagged with
    // `truncated: true` and we surface the warning to the client.
    const treeResp = await fetch(`${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: ghHeaders });
    if (!treeResp.ok) {
      const t = await treeResp.text();
      console.error('[files] tree fetch failed', treeResp.status, t.slice(0, 200));
      return res.status(502).json({ error: `GitHub tree fetch failed (${treeResp.status})` });
    }
    const treeJson = await treeResp.json();
    interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }
    const blobs: TreeEntry[] = (treeJson?.tree || []).filter((e: any) => e?.type === 'blob' && typeof e?.path === 'string');
    const truncated = !!treeJson?.truncated;

    // ── Local attribution ────────────────────────────────────────────────
    const where: any = { repoId: id };
    if (req.query.branch) where.branch = req.query.branch as string;
    const commitSelect = {
      id: true,
      sha: true,
      message: true,
      author: true,
      committedAt: true,
      filesChanged: true,
      aiToolDetected: true,
      session: {
        select: {
          id: true,
          agent: { select: { slug: true, name: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      },
      codingSession: {
        select: {
          id: true,
          agent: { select: { slug: true, name: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      },
    };
    let rawCommits = await prisma.commit.findMany({
      where,
      select: commitSelect,
      orderBy: { committedAt: 'desc' },
      take: 2000,
    });

    // ── Self-healing inline backfill ────────────────────────────────────
    // The dominant cause of "header says 52% AI but every file shows 0%"
    // is commits whose `filesChanged` was never populated at ingest time
    // (older webhook path, non-CLI commits, force-pushed branches, etc.).
    // Without per-commit file paths, the per-path aggregation has nothing
    // to attribute. Fix it on read: any commit that's flagged AI but has
    // an empty file list gets its files fetched from GitHub right here,
    // capped at 50 per request to bound rate-limit burn. Idempotent —
    // once filled, future calls skip these rows.
    const stale = rawCommits.filter((c) => {
      const isAi = !!c.aiToolDetected || !!c.session || !!c.codingSession;
      const empty = !c.filesChanged || c.filesChanged === '[]';
      return isAi && empty;
    }).slice(0, 50);
    if (stale.length > 0) {
      await Promise.all(stale.map(async (c) => {
        try {
          const r = await fetch(
            `${apiBase}/repos/${parsed.owner}/${parsed.repo}/commits/${c.sha}`,
            { headers: ghHeaders },
          );
          if (!r.ok) return;
          const data = await r.json() as any;
          const filenames: string[] = [];
          let additions = 0;
          let deletions = 0;
          for (const f of (data.files || [])) {
            if (typeof f?.filename === 'string') filenames.push(f.filename);
            additions += f?.additions || 0;
            deletions += f?.deletions || 0;
          }
          if (filenames.length === 0) return;
          await prisma.commit.update({
            where: { id: c.id },
            data: {
              filesChanged: JSON.stringify(filenames),
              fileCount: filenames.length,
              additions,
              deletions,
            },
          });
        } catch { /* per-commit best-effort — don't block /files */ }
      }));
      // Re-read the rows we just patched so the aggregator sees fresh data.
      rawCommits = await prisma.commit.findMany({
        where,
        select: commitSelect,
        orderBy: { committedAt: 'desc' },
        take: 2000,
      });
    }

    interface FileAgg {
      totalCommits: number;
      aiCommits: number;
      humanCommits: number;
      lastCommittedAt: string;
      lastSha: string;
      lastMessage: string;
      lastAuthor: string;
      agentTally: Map<string, { slug: string; name: string; count: number }>;
      userTally: Map<string, { id: string; name: string; email: string | null; count: number }>;
      sessionIds: Set<string>;
    }
    const aggByPath = new Map<string, FileAgg>();
    for (const c of rawCommits) {
      if (isGitNotesMetadataCommit(c.message)) continue;
      let files: string[] = [];
      try {
        files = JSON.parse(c.filesChanged || '[]');
        if (!Array.isArray(files)) files = [];
      } catch { /* skip bad JSON */ }
      if (files.length === 0) continue;

      const sess = c.session || c.codingSession || null;
      const isAi = !!sess || !!c.aiToolDetected;
      const agentSlug = sess?.agent?.slug || c.aiToolDetected || (isAi ? 'ai' : null);
      const agentName = sess?.agent?.name || c.aiToolDetected || (isAi ? 'AI' : null);

      for (const p of files) {
        let agg = aggByPath.get(p);
        if (!agg) {
          agg = {
            totalCommits: 0,
            aiCommits: 0,
            humanCommits: 0,
            lastCommittedAt: c.committedAt.toISOString(),
            lastSha: c.sha,
            lastMessage: (c.message || '').split('\n')[0].slice(0, 200),
            lastAuthor: c.author || 'unknown',
            agentTally: new Map(),
            userTally: new Map(),
            sessionIds: new Set(),
          };
          aggByPath.set(p, agg);
        }
        agg.totalCommits++;
        if (isAi) agg.aiCommits++;
        else agg.humanCommits++;
        if (agentSlug && agentName) {
          const cur = agg.agentTally.get(agentSlug) || { slug: agentSlug, name: agentName, count: 0 };
          cur.count++;
          agg.agentTally.set(agentSlug, cur);
        }
        const u = sess?.user;
        if (u?.id) {
          const cur = agg.userTally.get(u.id) || { id: u.id, name: u.name, email: u.email, count: 0 };
          cur.count++;
          agg.userTally.set(u.id, cur);
        }
        if (sess?.id) agg.sessionIds.add(sess.id);
      }
    }

    // ── Merge: tree drives existence, agg drives attribution ────────────
    const files = blobs.map((b) => {
      const a = aggByPath.get(b.path);
      const topAgent = a ? Array.from(a.agentTally.values()).sort((x, y) => y.count - x.count)[0] || null : null;
      const topUser = a ? Array.from(a.userTally.values()).sort((x, y) => y.count - x.count)[0] || null : null;
      return {
        path: b.path,
        // Pin to the file's blob SHA so the /file endpoint hits the right
        // ref even when the path was renamed since the last commit. Falls
        // back to the branch ref otherwise.
        blobSha: b.sha,
        size: b.size ?? 0,
        totalCommits: a?.totalCommits ?? 0,
        aiCommits: a?.aiCommits ?? 0,
        humanCommits: a?.humanCommits ?? 0,
        aiPct: a && a.totalCommits > 0 ? Math.round((a.aiCommits / a.totalCommits) * 100) : 0,
        topAgent,
        topUser: topUser ? { id: topUser.id, name: topUser.name, email: topUser.email } : null,
        sessionCount: a?.sessionIds.size ?? 0,
        lastCommittedAt: a?.lastCommittedAt ?? null,
        lastSha: a?.lastSha ?? null,
        lastMessage: a?.lastMessage ?? '',
        lastAuthor: a?.lastAuthor ?? '',
      };
    }).sort((a, b) => a.path.localeCompare(b.path));

    // Aggregate summary across the current snapshot's files only. Used
    // by RepoDetail's header so the AI% pill matches the per-file
    // rows — historical commits whose only filesChanged are deleted
    // files (and thus never appear in a row here) are correctly
    // excluded. Same convention as the per-file aiPct (each commit
    // counted once per file it touched), so the summary is the
    // weighted average over visible files.
    let sumAi = 0;
    let sumTotal = 0;
    for (const f of files) {
      sumAi += f.aiCommits || 0;
      sumTotal += f.totalCommits || 0;
    }
    const summary = {
      aiCommits: sumAi,
      totalCommits: sumTotal,
      humanCommits: sumTotal - sumAi,
      aiPct: sumTotal > 0 ? Math.round((sumAi / sumTotal) * 100) : 0,
    };
    res.json({ files, totalFiles: files.length, ref, truncated, summary });
  } catch (err) {
    console.error('List repo files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/file?path=<path>&ref=<branch-or-sha> — file contents + per-line
// authorship for the Files tree drilldown. Pulls blame ranges from GitHub
// GraphQL and joins them against our local Commit rows so each line carries
// the originating agent / user / session.
router.get('/:id/file', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const filePath = (req.query.path as string | undefined)?.trim();
    const requestedRef = (req.query.ref as string | undefined)?.trim();
    if (!filePath) return res.status(400).json({ error: 'path query param required' });

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.activeOrgId! },
    });
    if (!repo) return res.status(404).json({ error: 'Repo not found' });
    if (repo.provider !== 'github') {
      return res.status(400).json({ error: 'File view currently supports GitHub repos only' });
    }
    const parsed = parseRepoFullName(repo.path);
    if (!parsed) return res.status(400).json({ error: 'Unable to parse repo path' });

    const config = await getIntegrationConfig(req.activeOrgId!, 'github');
    if (!config?.token) {
      return res.status(503).json({ error: 'GitHub integration not configured for this org' });
    }
    const apiBase = config.apiBaseUrl || 'https://api.github.com';
    const authHeader = `Bearer ${config.token}`;

    // ── Build a list of refs to try, in priority order ──────────────────
    // The frontend pins lastSha (most recent commit-that-touched-this-file
    // in our DB), but that SHA can be a local-only commit that never
    // landed on the remote — fall through to the branches we've seen the
    // file on, then to the repo's default branch (HEAD).
    const candidateRefs: string[] = [];
    if (requestedRef) candidateRefs.push(requestedRef);
    // Pull every branch our DB has recorded for commits that touched this
    // path. Cheap query — small index on (repoId, sha), filesChanged is a
    // small JSON column.
    const localCommitsForPath = await prisma.commit.findMany({
      where: { repoId: id, filesChanged: { contains: JSON.stringify(filePath).slice(1, -1) } },
      select: { branch: true },
      take: 50,
    });
    const seenBranches = new Set<string>();
    for (const c of localCommitsForPath) {
      if (c.branch && !seenBranches.has(c.branch) && !candidateRefs.includes(c.branch)) {
        seenBranches.add(c.branch);
        candidateRefs.push(c.branch);
      }
    }
    if (!candidateRefs.includes('HEAD')) candidateRefs.push('HEAD');

    // ── Fetch raw file contents — first ref that 200s wins ──────────────
    let contentsJson: any = null;
    let usedRef: string = candidateRefs[0];
    let lastStatus = 0;
    for (const ref of candidateRefs) {
      const contentsUrl = `${apiBase}/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`;
      const resp = await fetch(contentsUrl, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'origin',
        },
      });
      lastStatus = resp.status;
      if (resp.status === 404) continue;
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('[file] contents fetch failed', resp.status, errText.slice(0, 200));
        return res.status(502).json({ error: `GitHub contents fetch failed (${resp.status})` });
      }
      const json = await resp.json();
      if (Array.isArray(json) || json.type !== 'file') {
        return res.status(400).json({ error: 'Path does not point at a file' });
      }
      contentsJson = json;
      usedRef = ref;
      break;
    }
    if (!contentsJson) {
      return res.status(404).json({
        error: 'File not on the remote',
        message:
          'Origin tracked this file from session history, but it isn’t on GitHub at any of the refs we’ve seen for it. ' +
          'Most often this means a session committed locally and never pushed (e.g. a fall-back from a blocked policy), ' +
          'or the branch was force-pushed/deleted upstream.',
        triedRefs: candidateRefs,
      });
    }
    if (typeof contentsJson.size === 'number' && contentsJson.size > 1024 * 1024) {
      return res.status(413).json({ error: 'File exceeds 1MB blame limit' });
    }
    let raw = '';
    try {
      raw = Buffer.from(contentsJson.content || '', 'base64').toString('utf-8');
    } catch {
      return res.status(500).json({ error: 'Failed to decode file contents' });
    }
    const lines = raw.split(/\r?\n/);
    const ref = usedRef;

    // ── Fetch blame via GraphQL ─────────────────────────────────────────
    // GraphQL `blame(path:)` returns ranges per author/commit, which is
    // dramatically cheaper than reconstructing line-by-line history. We
    // walk the ranges once, expand them into a per-line array, then enrich
    // each line with our local Commit/CodingSession data.
    const graphqlQuery = `
      query($owner:String!, $name:String!, $expr:String!, $path:String!) {
        repository(owner:$owner, name:$name) {
          object(expression:$expr) {
            ... on Commit {
              blame(path:$path) {
                ranges {
                  startingLine
                  endingLine
                  commit { oid author { name email } }
                }
              }
            }
          }
        }
      }
    `;
    const blameResp = await fetch(`${apiBase}/graphql`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'origin',
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { owner: parsed.owner, name: parsed.repo, expr: ref, path: filePath },
      }),
    });
    let ranges: Array<{ startingLine: number; endingLine: number; sha: string; authorName?: string }> = [];
    if (blameResp.ok) {
      const blameJson = await blameResp.json();
      const rawRanges = blameJson?.data?.repository?.object?.blame?.ranges as any[] | undefined;
      if (Array.isArray(rawRanges)) {
        ranges = rawRanges.map((r) => ({
          startingLine: r.startingLine,
          endingLine: r.endingLine,
          sha: r.commit?.oid,
          authorName: r.commit?.author?.name,
        })).filter((r) => r.sha);
      }
    } else {
      console.warn('[file] blame fetch failed', blameResp.status);
    }

    // Resolve commit metadata locally — agent, user, session — for any
    // SHA the blame returns. Lines whose SHA we don't have locally fall
    // back to {isAi: false, agent: null} unless we can hydrate from a
    // refs/notes/origin git note (fallback below).
    const shas = Array.from(new Set(ranges.map((r) => r.sha)));
    const localCommits = shas.length === 0 ? [] : await prisma.commit.findMany({
      where: { repoId: id, sha: { in: shas } },
      select: {
        sha: true,
        aiToolDetected: true,
        author: true,
        session: {
          select: {
            id: true,
            agent: { select: { slug: true, name: true } },
            user: { select: { id: true, name: true } },
          },
        },
        codingSession: {
          select: {
            id: true,
            agent: { select: { slug: true, name: true } },
            user: { select: { id: true, name: true } },
          },
        },
      },
    });
    const commitBySha = new Map<string, typeof localCommits[number]>();
    for (const c of localCommits) commitBySha.set(c.sha, c);

    // ── refs/notes/origin fallback ─────────────────────────────────────
    // For SHAs we don't have in our DB (cloned-in repo, commits made by
    // another team before they joined this org, etc.), pull the Origin
    // git note from GitHub. The note carries the same {sessionId, agent,
    // model, ...} payload the CLI writes — that's the durable on-repo
    // attribution we already advertise as "travels with the repo".
    //
    // One tree fetch + N blob fetches per request, capped to 50 unknowns
    // so a touchy file (lots of one-line authors) can't fan out the
    // GitHub rate limit. The 200s of unique SHAs case is rare in practice.
    interface NoteAttribution {
      sessionId?: string;
      agentSlug?: string;
      agentName?: string;
      model?: string;
    }
    const noteBySha = new Map<string, NoteAttribution>();
    const unknownShas = shas.filter((s) => !commitBySha.has(s));
    if (unknownShas.length > 0) {
      try {
        const refResp = await fetch(
          `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/refs/notes/origin`,
          { headers: { 'Authorization': authHeader, 'Accept': 'application/vnd.github+json', 'User-Agent': 'origin' } },
        );
        if (refResp.ok) {
          const refData = await refResp.json() as { object?: { sha?: string } };
          const noteCommitSha = refData.object?.sha;
          if (noteCommitSha) {
            const commitResp = await fetch(
              `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/commits/${noteCommitSha}`,
              { headers: { 'Authorization': authHeader, 'Accept': 'application/vnd.github+json', 'User-Agent': 'origin' } },
            );
            if (commitResp.ok) {
              const commitData = await commitResp.json() as { tree?: { sha?: string } };
              const treeSha = commitData.tree?.sha;
              if (treeSha) {
                const treeResp = await fetch(
                  `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${treeSha}?recursive=1`,
                  { headers: { 'Authorization': authHeader, 'Accept': 'application/vnd.github+json', 'User-Agent': 'origin' } },
                );
                if (treeResp.ok) {
                  const treeData = await treeResp.json() as { tree?: any[] };
                  // git-notes path layout is either flat (`<sha>`) or
                  // fanned (`<sha[:2]>/<sha[2:]>`) depending on note count.
                  // Normalize both into a sha→blobSha map.
                  const noteBlobBySha = new Map<string, string>();
                  for (const e of (treeData.tree || [])) {
                    if (e?.type !== 'blob' || typeof e?.path !== 'string' || !e?.sha) continue;
                    const flat = e.path.toLowerCase();
                    if (/^[a-f0-9]{40}$/.test(flat)) {
                      noteBlobBySha.set(flat, e.sha);
                    } else if (/^[a-f0-9]{2}\/[a-f0-9]{38}$/.test(flat)) {
                      noteBlobBySha.set(flat.replace('/', ''), e.sha);
                    }
                  }
                  // Fetch matching blobs in parallel, cap at 50 to bound
                  // GitHub API spend per request.
                  const targets = unknownShas
                    .map((s) => ({ sha: s, blobSha: noteBlobBySha.get(s.toLowerCase()) }))
                    .filter((t): t is { sha: string; blobSha: string } => !!t.blobSha)
                    .slice(0, 50);
                  await Promise.all(targets.map(async (t) => {
                    try {
                      const blobResp = await fetch(
                        `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/blobs/${t.blobSha}`,
                        { headers: { 'Authorization': authHeader, 'Accept': 'application/vnd.github+json', 'User-Agent': 'origin' } },
                      );
                      if (!blobResp.ok) return;
                      const blobJson = await blobResp.json() as { content?: string; encoding?: string };
                      if (!blobJson.content) return;
                      const text = Buffer.from(blobJson.content, (blobJson.encoding as BufferEncoding) || 'base64').toString('utf-8');
                      let noteJson: any = null;
                      try { noteJson = JSON.parse(text); } catch { return; }
                      const o = noteJson?.origin;
                      if (!o) return;
                      noteBySha.set(t.sha, {
                        sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
                        agentSlug: typeof o.agent === 'string' ? o.agent : undefined,
                        agentName: resolveAgentDisplayFromNote(o),
                        model: typeof o.model === 'string' ? o.model : undefined,
                      });
                    } catch { /* per-blob best-effort */ }
                  }));
                }
              }
            }
          }
        }
      } catch (err) {
        // Notes fallback is best-effort — keep blame rendering even when
        // GitHub git-refs API is rate-limited or the ref doesn't exist.
        console.warn('[file] notes fallback failed:', (err as any)?.message);
      }
    }

    // Build per-line attribution. lines.length is from the file contents;
    // ranges from GraphQL. A trailing newline can produce an extra empty
    // line — tolerate by falling off the end gracefully.
    const lineAttr: Array<{
      sha: string | null;
      isAi: boolean;
      agentSlug: string | null;
      agentName: string | null;
      userName: string | null;
      sessionId: string | null;
    }> = new Array(lines.length).fill(null).map(() => ({
      sha: null, isAi: false, agentSlug: null, agentName: null, userName: null, sessionId: null,
    }));
    for (const r of ranges) {
      const dbCommit = commitBySha.get(r.sha);
      const sess = dbCommit?.session || dbCommit?.codingSession;
      const aiToolDetected = dbCommit?.aiToolDetected;
      const note = noteBySha.get(r.sha);
      // DB session/agent wins; refs/notes/origin fills in for SHAs we
      // never ingested locally (other team's commits, pre-Origin history).
      const isAi = !!sess || !!aiToolDetected || !!note;
      const agentSlug = sess?.agent?.slug || aiToolDetected || note?.agentSlug || (isAi ? 'ai' : null);
      const agentName = sess?.agent?.name || aiToolDetected || note?.agentName || (isAi ? 'AI' : null);
      const userName = sess?.user?.name || r.authorName || dbCommit?.author || null;
      const sessionId = sess?.id || note?.sessionId || null;
      const start = Math.max(1, r.startingLine);
      const end = Math.min(lines.length, r.endingLine);
      for (let i = start; i <= end; i++) {
        lineAttr[i - 1] = {
          sha: r.sha,
          isAi,
          agentSlug,
          agentName,
          userName,
          sessionId,
        };
      }
    }

    res.json({
      path: filePath,
      ref,
      size: contentsJson.size ?? raw.length,
      lineCount: lines.length,
      // Encode as JSON-safe strings; the client renders <pre> with each line
      lines: lines.map((content, i) => ({
        lineNumber: i + 1,
        content,
        ...lineAttr[i],
      })),
    });
  } catch (err) {
    console.error('Get repo file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/commit/:sha — full commit detail: metadata, session, prompts, diff (one call)
router.get('/:id/commit/:sha', async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const sha = (req.params as any).sha as string;

    const repo = await prisma.repo.findFirst({
      where: { id, orgId: req.activeOrgId! },
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

      // Show prompts whose commitSha matches this commit. If no prompts have
      // been attributed to a SHA yet (Codex/Gemini sessions populate prompts
      // at session-end, not on per-prompt-submit) AND this commit is the
      // session's primary commit, show all prompts — better than the empty
      // "no per-prompt diffs captured yet" placeholder for sessions where
      // per-prompt attribution is structurally unavailable.
      const exactMatch = promptChanges.filter((pc: any) => pc.commitSha === sha);
      const anyAttributed = promptChanges.some((pc: any) => pc.commitSha);
      if (exactMatch.length > 0) {
        promptChanges = exactMatch;
      } else if (!anyAttributed && sess.commitId === commit.id) {
        // No per-prompt attribution exists for this session — surface all
        // session prompts under this commit. promptText comes from the
        // transcript fallback above so users see what was asked.
        // Leave promptChanges as-is.
      } else {
        promptChanges = exactMatch; // empty
      }
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
        const integration = await getGitLabIntegrationConfig(req.activeOrgId!);
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
          const integration = await getIntegrationConfig(req.activeOrgId!, 'github');
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
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.activeOrgId! } });
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
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.activeOrgId! } });
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
        orgId: req.activeOrgId!,
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
    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.activeOrgId! } });
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

    const repo = await prisma.repo.findFirst({ where: { id, orgId: req.activeOrgId! } });
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
        orgId: req.activeOrgId!,
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
    const orgId = req.activeOrgId!;

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

    // AI percentage for this repo.
    //
    // Match the same filter the per-file `/files` aggregator uses
    // (isGitNotesMetadataCommit, merge subjects, AND
    // `files.length === 0` skip) so a repo where every file shows
    // "100% AI" doesn't display "AI 52%" in the summary just
    // because the denominator includes auto-generated origin-notes
    // commits, `Merge pull request` rows, and empty/file-less
    // commits that the per-file view never counts. Fetch the
    // messages + filesChanged so we apply exactly the same
    // predicate.
    const allCommitMessages = await prisma.commit.findMany({
      where: { repoId: id },
      select: { message: true, sessionId: true, aiToolDetected: true, filesChanged: true },
    });
    const isMergeMsg = (msg: string | null | undefined) =>
      !!msg && /^Merge (pull request|branch|remote-tracking|tag) /m.test(msg);
    const hasFiles = (raw: string | null | undefined) => {
      if (!raw) return false;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && arr.length > 0;
      } catch { return false; }
    };
    const realCommits = allCommitMessages.filter((c) =>
      !isGitNotesMetadataCommit(c.message) &&
      !isMergeMsg(c.message) &&
      hasFiles(c.filesChanged),
    );
    const totalCommits = realCommits.length;
    const aiCommits = realCommits.filter(
      (c) => c.sessionId !== null || c.aiToolDetected !== null,
    ).length;
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

// ── Per-(repo, model) budget overrides ─────────────────────────────────────
// IDOR-safe: every read/write scopes the target repo to the calling user's
// org first. `:modelKey` is URL-encoded model string ((repoId, model) is the
// natural unique key).

router.get('/:id/models', async (req: AuthRequest, res: Response) => {
  try {
    const owned = await prisma.repo.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Repository not found in your organization' });

    const models = await prisma.repoModelLimit.findMany({
      where: { repoId: owned.id },
      orderBy: { model: 'asc' },
    });
    res.json(models);
  } catch (err) {
    console.error('List repo models error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/models', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const owned = await prisma.repo.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Repository not found in your organization' });

    const { model, monthlyLimit, tokenLimit, maxCostPerSession, maxTokensPerSession, period } = req.body || {};
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'model is required' });
    }
    if (model.length > 200) {
      return res.status(413).json({ error: 'model exceeds max length of 200' });
    }
    if (period !== undefined && period !== 'daily' && period !== 'weekly' && period !== 'monthly') {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
    }
    try {
      const created = await prisma.repoModelLimit.create({
        data: {
          repoId: owned.id,
          model: model.trim(),
          monthlyLimit: typeof monthlyLimit === 'number' && monthlyLimit > 0 ? monthlyLimit : null,
          tokenLimit: typeof tokenLimit === 'number' && tokenLimit > 0 ? tokenLimit : null,
          maxCostPerSession: typeof maxCostPerSession === 'number' && maxCostPerSession > 0 ? maxCostPerSession : null,
          maxTokensPerSession: typeof maxTokensPerSession === 'number' && maxTokensPerSession > 0 ? maxTokensPerSession : null,
          ...(period ? { period } : {}),
        },
      });
      res.json(created);
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return res.status(409).json({ error: 'Model already configured for this repo. PUT to update.' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Create repo model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const owned = await prisma.repo.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Repository not found in your organization' });

    const model = decodeURIComponent(req.params.modelKey as string);
    const data: Record<string, unknown> = {};
    const body = req.body || {};
    for (const key of ['monthlyLimit', 'tokenLimit', 'maxCostPerSession', 'maxTokensPerSession'] as const) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const v = body[key];
        data[key] = typeof v === 'number' && v > 0 ? v : null;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'period')) {
      const p = (body as any).period;
      if (p !== 'daily' && p !== 'weekly' && p !== 'monthly') {
        return res.status(400).json({ error: 'period must be daily, weekly, or monthly' });
      }
      data.period = p;
    }
    try {
      const updated = await prisma.repoModelLimit.update({
        where: { repoId_model: { repoId: owned.id, model } },
        data,
      });
      res.json(updated);
    } catch (e: any) {
      if (e?.code === 'P2025') return res.status(404).json({ error: 'Model not configured for this repo' });
      throw e;
    }
  } catch (err) {
    console.error('Update repo model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/models/:modelKey', requireRole('ADMIN'), async (req: AuthRequest, res: Response) => {
  try {
    const owned = await prisma.repo.findFirst({
      where: { id: req.params.id as string, orgId: req.activeOrgId! },
      select: { id: true },
    });
    if (!owned) return res.status(404).json({ error: 'Repository not found in your organization' });

    const model = decodeURIComponent(req.params.modelKey as string);
    try {
      await prisma.repoModelLimit.delete({
        where: { repoId_model: { repoId: owned.id, model } },
      });
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.code === 'P2025') return res.status(404).json({ error: 'Model not configured for this repo' });
      throw e;
    }
  } catch (err) {
    console.error('Delete repo model error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Repo Member Management ──────────────────────────────────────────────
//
// Per-user access grants on a single repo. Org OWNER/ADMIN have implicit
// admin on every repo and don't need rows here; they appear in the list
// with `inherited: true` so the UI can show them as locked-in.

const VALID_REPO_LEVELS = ['read', 'write', 'admin'] as const;

router.get('/:id/members', requireRepoAccess('read'), async (req: AuthRequest, res: Response) => {
  try {
    const repoId = req.params.id as string;

    // Explicit grants in the RepoMember table.
    const direct = await prisma.repoMember.findMany({
      where: { repoId },
      select: {
        level: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Inherited from org role: every OWNER / ADMIN of the active org
    // gets implicit admin. Surface them in the list so the UI can show
    // who has access without requiring a separate fetch.
    const privileged = await prisma.membership.findMany({
      where: { orgId: req.activeOrgId!, role: { in: ['OWNER', 'ADMIN'] } },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    const directIds = new Set(direct.map((d) => d.user.id));
    const inherited = privileged
      .filter((p) => !directIds.has(p.user.id))
      .map((p) => ({
        ...p.user,
        level: 'admin' as RepoLevel,
        inherited: true,
        orgRole: p.role,
      }));

    res.json({
      members: [
        ...direct.map((d) => ({ ...d.user, level: d.level, inherited: false, grantedAt: d.createdAt })),
        ...inherited,
      ],
    });
  } catch (err) {
    console.error('List repo members error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /:id/members/:userId — set/upgrade/downgrade a user's access level.
// Idempotent: re-running with the same level is a no-op. Caller must have
// repo admin (which org OWNER/ADMIN inherit automatically).
router.put('/:id/members/:userId', requireRepoAccess('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const repoId = req.params.id as string;
    const targetUserId = req.params.userId as string;
    const { level } = req.body as { level?: string };

    if (!level || !VALID_REPO_LEVELS.includes(level as RepoLevel)) {
      return res.status(400).json({ error: 'level must be read | write | admin' });
    }

    // Target must be a member of the active org. Otherwise we'd be
    // granting access to a user outside the org boundary, which breaks
    // org-level isolation.
    const targetMembership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetUserId, orgId: req.activeOrgId! } },
      select: { role: true },
    });
    if (!targetMembership) {
      return res.status(400).json({ error: 'User is not a member of this org' });
    }

    // Inherited OWNER/ADMIN don't need explicit RepoMember rows; saving
    // one would just be noise. Reject with a clarifying message.
    if (targetMembership.role === 'OWNER' || targetMembership.role === 'ADMIN') {
      return res.status(400).json({
        error: `${targetMembership.role}s have implicit admin on every repo. Change their org role instead.`,
      });
    }

    const row = await prisma.repoMember.upsert({
      where: { userId_repoId: { userId: targetUserId, repoId } },
      update: { level, grantedBy: req.user!.id },
      create: { userId: targetUserId, repoId, level, grantedBy: req.user!.id },
    });

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'REPO_ACCESS_GRANTED',
        resource: repoId,
        metadata: JSON.stringify({ targetUserId, level }),
      },
    });

    res.json({ userId: row.userId, repoId: row.repoId, level: row.level });
  } catch (err) {
    console.error('Update repo member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/members/:userId', requireRepoAccess('admin'), async (req: AuthRequest, res: Response) => {
  try {
    const repoId = req.params.id as string;
    const targetUserId = req.params.userId as string;

    const { count } = await prisma.repoMember.deleteMany({
      where: { userId: targetUserId, repoId },
    });
    if (count === 0) {
      return res.status(404).json({ error: 'No explicit access on this repo (org admins inherit access)' });
    }

    await prisma.auditLog.create({
      data: {
        orgId: req.activeOrgId!,
        userId: req.user!.id,
        action: 'REPO_ACCESS_REVOKED',
        resource: repoId,
        metadata: JSON.stringify({ targetUserId }),
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete repo member error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
