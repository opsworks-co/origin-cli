import { prisma } from '../db.js';
import {
  buildSessionSummaryComment,
  computeCheckStatus,
  getSessionsForPR,
  type StatusState,
} from './github-integration.js';

// ── GitLab API helpers ────────────────────────────────────────────

const GITLAB_API = 'https://gitlab.com/api/v4';

function gitlabHeaders(token: string, authType?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Origin-AI-Governance/1.0',
  };
  if (authType === 'gitlab_oauth') {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['PRIVATE-TOKEN'] = token;
  }
  return headers;
}

// ── GitLab OAuth Token Management ────────────────────────────────

const oauthTokenCache = new Map<string, { token: string; expiresAt: Date }>();

export function getGitLabOAuthConfig() {
  const clientId = process.env.GITLAB_APP_ID;
  const clientSecret = process.env.GITLAB_APP_SECRET;
  const redirectUri = process.env.GITLAB_APP_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return { configured: false } as const;
  }
  return { configured: true, clientId, clientSecret, redirectUri } as const;
}

/** Strip /api/v4 from a GitLab API base URL to get the instance root for OAuth endpoints. */
export function getGitLabOAuthBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/v4\/?$/, '') || 'https://gitlab.com';
}

export async function exchangeGitLabOAuthCode(
  code: string,
  baseUrl: string = 'https://gitlab.com',
): Promise<{ access_token: string; refresh_token: string; expires_in: number; created_at: number }> {
  const config = getGitLabOAuthConfig();
  if (!config.configured) throw new Error('GitLab OAuth not configured');

  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitLab OAuth token exchange failed (${res.status}): ${err}`);
  }

  return res.json() as any;
}

export async function refreshGitLabOAuthToken(
  refreshToken: string,
  baseUrl: string = 'https://gitlab.com',
): Promise<{ access_token: string; refresh_token: string; expires_in: number; created_at: number }> {
  const config = getGitLabOAuthConfig();
  if (!config.configured) throw new Error('GitLab OAuth not configured');

  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: config.redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitLab OAuth token refresh failed (${res.status}): ${err}`);
  }

  return res.json() as any;
}

/**
 * Get a valid GitLab OAuth token, refreshing if expired.
 * Mirrors getValidInstallationToken from github-app.ts.
 */
export async function getValidGitLabOAuthToken(config: {
  id: string;
  token: string;
  settings: string;
  baseUrl: string;
}): Promise<string> {
  const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

  // 1. Check in-memory cache
  const cached = oauthTokenCache.get(config.id);
  if (cached && cached.expiresAt.getTime() - Date.now() > SAFETY_MARGIN_MS) {
    return cached.token;
  }

  // 2. Parse settings
  let settings: { refreshToken?: string; tokenExpiresAt?: string; [key: string]: any };
  try {
    settings = JSON.parse(config.settings);
  } catch {
    throw new Error('Invalid GitLab OAuth settings in IntegrationConfig');
  }

  // 3. Check if DB-stored token is still valid
  if (settings.tokenExpiresAt && config.token) {
    const expiresAt = new Date(settings.tokenExpiresAt);
    if (expiresAt.getTime() - Date.now() > SAFETY_MARGIN_MS) {
      oauthTokenCache.set(config.id, { token: config.token, expiresAt });
      return config.token;
    }
  }

  // 4. Token expired — refresh
  if (!settings.refreshToken) {
    throw new Error('No refresh token stored — user needs to re-authorize GitLab OAuth');
  }

  const oauthBaseUrl = getGitLabOAuthBaseUrl(config.baseUrl || GITLAB_API);
  const result = await refreshGitLabOAuthToken(settings.refreshToken, oauthBaseUrl);

  // 5. Update cache
  const expiresAt = new Date((result.created_at + result.expires_in) * 1000);
  oauthTokenCache.set(config.id, { token: result.access_token, expiresAt });

  // 6. Update DB (async, non-blocking)
  const updatedSettings = {
    ...settings,
    refreshToken: result.refresh_token, // GitLab may rotate refresh tokens
    tokenExpiresAt: expiresAt.toISOString(),
  };
  prisma.integrationConfig
    .update({
      where: { id: config.id },
      data: {
        token: result.access_token,
        settings: JSON.stringify(updatedSettings),
      },
    })
    .catch((err) => console.error('[gitlab-oauth] Failed to persist refreshed token:', err));

  return result.access_token;
}

/** Get a valid token for a GitLab integration, handling both PAT and OAuth. */
export async function getValidGitLabToken(integration: {
  id: string;
  token: string;
  settings: string;
  baseUrl: string;
  authType?: string;
}): Promise<{ token: string; authType: string }> {
  const authType = (integration as any).authType || 'pat';
  if (authType === 'gitlab_oauth') {
    const token = await getValidGitLabOAuthToken(integration);
    return { token, authType };
  }
  return { token: integration.token, authType: 'pat' };
}

/**
 * Encode a GitLab project path for use in API URLs.
 * GitLab API uses URL-encoded `namespace/project` as the project identifier.
 */
function encodeProjectPath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Parse "gitlab.com/group/repo", "https://gitlab.com/group/subgroup/repo",
 * or "group/repo" into the full project path (e.g., "group/repo" or "group/subgroup/repo").
 */
export function parseGitLabProjectPath(repoPath: string): string | null {
  let cleaned = repoPath.replace(/^https?:\/\//, '');
  // Remove gitlab.com or any gitlab self-hosted domain prefix
  cleaned = cleaned.replace(/^[^/]+\.com\//, '');
  cleaned = cleaned.replace(/^[^/]+\.io\//, '');
  cleaned = cleaned.replace(/^[^/]+\.org\//, '');
  // Also handle explicit gitlab domain
  cleaned = cleaned.replace(/^gitlab\.[^/]+\//, '');
  cleaned = cleaned.replace(/\.git$/, '');
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');

  // Need at least group/project
  if (cleaned.split('/').length >= 2) {
    return cleaned;
  }
  return null;
}

// ── Commit Status ─────────────────────────────────────────────────

/** Map Origin status states to GitLab pipeline status names */
function mapStatusToGitLab(state: StatusState): string {
  switch (state) {
    case 'pending': return 'pending';
    case 'success': return 'success';
    case 'failure': return 'failed';
    case 'error': return 'failed';
    default: return 'pending';
  }
}

export async function postCommitStatus(
  token: string,
  projectPath: string,
  sha: string,
  state: StatusState,
  description: string,
  targetUrl?: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
) {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/statuses/${sha}`;
  const body: Record<string, string> = {
    state: mapStatusToGitLab(state),
    description: description.slice(0, 140),
    context: 'origin/ai-governance',
    name: 'origin/ai-governance',
  };
  if (targetUrl) body.target_url = targetUrl;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: gitlabHeaders(token, authType),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitLab status API error (${res.status}):`, err);
      return { success: false, error: err };
    }
    return { success: true };
  } catch (err: any) {
    console.error('Failed to post GitLab commit status:', err.message);
    return { success: false, error: err.message };
  }
}

// ── MR Notes (Comments) ──────────────────────────────────────────

export async function postMRComment(
  token: string,
  projectPath: string,
  mrIid: number,
  body: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; noteId?: string; error?: string }> {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/merge_requests/${mrIid}/notes`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: gitlabHeaders(token, authType),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitLab MR note API error (${res.status}):`, err);
      return { success: false, error: err };
    }
    const data = (await res.json()) as { id: number };
    return { success: true, noteId: String(data.id) };
  } catch (err: any) {
    console.error('Failed to post MR comment:', err.message);
    return { success: false, error: err.message };
  }
}

export async function updateMRComment(
  token: string,
  projectPath: string,
  mrIid: number,
  noteId: string,
  body: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/merge_requests/${mrIid}/notes/${noteId}`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: gitlabHeaders(token, authType),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitLab update MR note error (${res.status}):`, err);
      return { success: false, error: err };
    }
    return { success: true };
  } catch (err: any) {
    console.error('Failed to update MR comment:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Test Connection ───────────────────────────────────────────────

export async function testGitLabConnection(
  token: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; login?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/user`, {
      headers: gitlabHeaders(token, authType),
    });
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { username: string };
    return { success: true, login: data.username };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── List Repos (Auto-Discovery) ──────────────────────────────────

export interface GitLabRepoInfo {
  id: number;
  name: string;
  fullPath: string;
  private: boolean;
  url: string;
  defaultBranch: string;
}

export async function listGitLabRepos(
  token: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; repos?: GitLabRepoInfo[]; error?: string }> {
  const allRepos: GitLabRepoInfo[] = [];
  let page = 1;

  try {
    while (true) {
      const res = await fetch(
        `${baseUrl}/projects?membership=true&per_page=100&page=${page}&order_by=updated_at`,
        { headers: gitlabHeaders(token, authType) },
      );

      if (!res.ok) {
        const err = await res.text();
        console.error(`GitLab list projects error (${res.status}):`, err);
        return { success: false, error: `HTTP ${res.status}` };
      }

      const data = (await res.json()) as Array<{
        id: number;
        name: string;
        path_with_namespace: string;
        visibility: string;
        web_url: string;
        default_branch: string;
      }>;

      if (data.length === 0) break;

      for (const r of data) {
        allRepos.push({
          id: r.id,
          name: r.name,
          fullPath: r.path_with_namespace,
          private: r.visibility !== 'public',
          url: r.web_url,
          defaultBranch: r.default_branch,
        });
      }

      // Check X-Next-Page header
      const nextPage = res.headers.get('x-next-page');
      if (!nextPage || nextPage === '') break;
      page = parseInt(nextPage, 10);
    }

    return { success: true, repos: allRepos };
  } catch (err: any) {
    console.error('Failed to list GitLab repos:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Create Webhook on GitLab ─────────────────────────────────────

export async function createGitLabWebhook(
  token: string,
  projectPath: string,
  webhookUrl: string,
  secret: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; hookId?: number; error?: string }> {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/hooks`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: gitlabHeaders(token, authType),
      body: JSON.stringify({
        url: webhookUrl,
        token: secret,
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`GitLab create webhook error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}: ${err}` };
    }

    const data = (await res.json()) as { id: number };
    return { success: true, hookId: data.id };
  } catch (err: any) {
    console.error('Failed to create GitLab webhook:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Delete Webhook on GitLab ─────────────────────────────────────

export async function deleteGitLabWebhook(
  token: string,
  projectPath: string,
  hookId: number,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/hooks/${hookId}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: gitlabHeaders(token, authType),
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      console.error(`GitLab delete webhook error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}: ${err}` };
    }

    return { success: true };
  } catch (err: any) {
    console.error('Failed to delete GitLab webhook:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Integration Config ────────────────────────────────────────────

export async function getGitLabIntegrationConfig(orgId: string) {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider: 'gitlab' },
  });
  if (!config) return null;

  let settings: { postChecks: boolean; postComments: boolean; checkOnReview: boolean; [key: string]: any };
  try {
    settings = {
      postChecks: true,
      postComments: true,
      checkOnReview: true,
      ...JSON.parse(config.settings),
    };
  } catch {
    settings = { postChecks: true, postComments: true, checkOnReview: true };
  }

  const authType = (config as any).authType || 'pat';

  return {
    ...config,
    authType,
    parsedSettings: settings,
    apiBaseUrl: config.baseUrl || GITLAB_API,
  };
}

// ── List MR Commits from GitLab ──────────────────────────────────

export async function listMRCommits(
  token: string,
  projectPath: string,
  mrIid: number,
  baseUrl: string = GITLAB_API,
  authType?: string,
): Promise<{ success: boolean; shas?: string[]; error?: string }> {
  const url = `${baseUrl}/projects/${encodeProjectPath(projectPath)}/merge_requests/${mrIid}/commits`;

  try {
    const res = await fetch(url, {
      headers: gitlabHeaders(token, authType),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`GitLab list MR commits error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as Array<{ id: string }>;
    return { success: true, shas: data.map((c) => c.id) };
  } catch (err: any) {
    console.error('Failed to list MR commits:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Post AI Attribution as MR Note ────────────────────────────────

export async function postAIAttributionNote(
  token: string,
  projectPath: string,
  mrIid: number,
  sessions: any[],
  commitShas: string[],
  repoId: string,
  originBaseUrl: string,
  baseUrl: string = GITLAB_API,
  authType?: string,
) {
  // Fetch all commits from DB to check which are AI-authored
  const commits = await prisma.commit.findMany({
    where: { repoId, sha: { in: commitShas } },
    select: { sha: true, aiToolDetected: true, message: true, author: true },
  });

  const totalCommits = commitShas.length;
  const aiCommits = commits.filter((c) => c.aiToolDetected).length;
  const aiPercent = totalCommits > 0 ? Math.round((aiCommits / totalCommits) * 100) : 0;

  const totalAILines = sessions.reduce((sum: number, s: any) => sum + s.linesAdded, 0);

  const lines = [
    `### :robot: Origin AI Attribution Report — [AI ${aiPercent}%]`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| AI Commits | ${aiCommits}/${totalCommits} (${aiPercent}%) |`,
    `| AI Sessions | ${sessions.length} |`,
    `| AI Lines Added | +${totalAILines.toLocaleString()} |`,
    `| Models | ${[...new Set(sessions.map((s: any) => s.model))].join(', ') || '—'} |`,
    `| Agents | ${[...new Set(sessions.map((s: any) => s.agentName).filter(Boolean))].join(', ') || '—'} |`,
    '',
  ];

  if (commits.length > 0) {
    lines.push('#### Per-Commit Breakdown', '');
    lines.push('| Commit | Author | AI | Tool |');
    lines.push('|--------|--------|----|------|');
    for (const c of commits) {
      const tag = c.aiToolDetected ? `**[AI]**` : `[Human]`;
      const tool = c.aiToolDetected || '—';
      const msg = (c.message || '').slice(0, 60);
      lines.push(`| \`${c.sha.slice(0, 8)}\` ${msg} | ${c.author || '—'} | ${tag} | ${tool} |`);
    }
  }

  lines.push('', `[View in Origin](${originBaseUrl}/sessions)`);

  return postMRComment(token, projectPath, mrIid, lines.join('\n'), baseUrl, authType);
}

// ── Post Status + Comment for a MR ────────────────────────────────

export async function updateMRGitLabStatus(
  orgId: string,
  repoId: string,
  mrIid: number,
  headSha: string,
  originBaseUrl: string,
) {
  const integration = await getGitLabIntegrationConfig(orgId);
  if (!integration) return;

  // Get valid token (handles OAuth refresh)
  const { token, authType } = await getValidGitLabToken(integration);

  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo) return;

  const projectPath = parseGitLabProjectPath(repo.path);
  if (!projectPath) return;

  const mr = await prisma.pullRequest.findFirst({
    where: { repoId, number: mrIid },
  });
  if (!mr) return;

  let commitShas: string[];
  try {
    commitShas = JSON.parse(mr.commitShas);
  } catch {
    commitShas = [];
  }

  const sessions = await getSessionsForPR(repoId, commitShas);
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { slug: true } });

  // Post commit status
  if (integration.parsedSettings.postChecks) {
    const { state, description } = computeCheckStatus(sessions);
    await postCommitStatus(
      token,
      projectPath,
      headSha,
      state,
      description,
      `${originBaseUrl}/sessions`,
      integration.apiBaseUrl,
      authType,
    );

    // Post AI attribution as a MR note (GitLab has no check runs)
    try {
      await postAIAttributionNote(
        token,
        projectPath,
        mrIid,
        sessions,
        commitShas,
        repoId,
        originBaseUrl,
        integration.apiBaseUrl,
        authType,
      );
    } catch (err) {
      console.error('Failed to post AI attribution note:', err);
    }

    await prisma.pullRequest.update({
      where: { id: mr.id },
      data: { checkStatus: state },
    });
  }

  // Post or update summary comment
  if (integration.parsedSettings.postComments) {
    const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);

    if (mr.commentId) {
      await updateMRComment(
        token,
        projectPath,
        mrIid,
        mr.commentId,
        commentBody,
        integration.apiBaseUrl,
        authType,
      );
    } else {
      const result = await postMRComment(
        token,
        projectPath,
        mrIid,
        commentBody,
        integration.apiBaseUrl,
        authType,
      );
      if (result.noteId) {
        await prisma.pullRequest.update({
          where: { id: mr.id },
          data: { commentId: result.noteId },
        });
      }
    }
  }
}

// ── Update MR Checks After Session Enforcement ────────────────────

export async function updateSessionMRChecks(
  sessionId: string,
  orgId: string,
): Promise<number> {
  const integration = await getGitLabIntegrationConfig(orgId);
  if (!integration) return 0;

  // Get valid token (handles OAuth refresh)
  const { token, authType } = await getValidGitLabToken(integration);

  const session = await prisma.codingSession.findUnique({
    where: { id: sessionId },
    include: {
      commit: { select: { repoId: true, sha: true } },
      commits: { select: { sha: true } },
    },
  });

  if (!session?.commit?.repoId) return 0;

  const repoId = session.commit.repoId;
  const sessionShas = [
    session.commit.sha,
    ...session.commits.map((c) => c.sha),
  ].filter(Boolean);

  if (sessionShas.length === 0) return 0;

  const openMRs = await prisma.pullRequest.findMany({
    where: { repoId, state: 'open' },
  });

  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo) return 0;

  const projectPath = parseGitLabProjectPath(repo.path);
  if (!projectPath) return 0;

  const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { slug: true } });
  let updated = 0;

  for (const mr of openMRs) {
    let mrShas: string[];
    try {
      mrShas = JSON.parse(mr.commitShas);
    } catch {
      mrShas = [];
    }

    const hasMatch = sessionShas.some((sha) => mrShas.includes(sha));
    if (!hasMatch) continue;

    const headSha = mrShas[mrShas.length - 1];
    if (!headSha) continue;

    try {
      const sessions = await getSessionsForPR(repoId, mrShas);
      const { state, description } = computeCheckStatus(sessions);

      if (integration.parsedSettings.postChecks) {
        await postCommitStatus(
          token,
          projectPath,
          headSha,
          state,
          description,
          `${originBaseUrl}/sessions`,
          integration.apiBaseUrl,
          authType,
        );
      }

      if (integration.parsedSettings.postComments) {
        const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);
        if (mr.commentId) {
          await updateMRComment(
            token,
            projectPath,
            mr.number,
            mr.commentId,
            commentBody,
            integration.apiBaseUrl,
            authType,
          );
        } else {
          const result = await postMRComment(
            token,
            projectPath,
            mr.number,
            commentBody,
            integration.apiBaseUrl,
            authType,
          );
          if (result.noteId) {
            await prisma.pullRequest.update({
              where: { id: mr.id },
              data: { commentId: result.noteId },
            });
          }
        }
      }

      const { state: newState } = computeCheckStatus(sessions);
      await prisma.pullRequest.update({
        where: { id: mr.id },
        data: { checkStatus: newState },
      });

      updated++;
    } catch (err) {
      console.error(`Failed to update MR !${mr.number} status:`, err);
    }
  }

  return updated;
}
