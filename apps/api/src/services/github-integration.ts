import { prisma } from '../db.js';
import { getValidInstallationToken, listGitHubAppRepos } from './github-app.js';
import { describeCondition, describeAction, policyTypeLabel } from '../utils/policy-descriptions.js';

// ── GitHub API helpers ────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Origin-AI-Governance/1.0',
  };
}

/**
 * Parse "github.com/owner/repo", "https://github.com/owner/repo",
 * or "owner/repo" into { owner, repo }.
 */
export function parseRepoFullName(repoPath: string): { owner: string; repo: string } | null {
  // Strip protocol + domain
  let cleaned = repoPath.replace(/^https?:\/\//, '').replace(/^github\.com\//, '');
  // Remove trailing .git
  cleaned = cleaned.replace(/\.git$/, '');
  // Remove leading/trailing slashes
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');

  const parts = cleaned.split('/');
  if (parts.length >= 2) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

// ── Commit Status ─────────────────────────────────────────────────

export type StatusState = 'pending' | 'success' | 'failure' | 'error';

export async function postCommitStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  state: StatusState,
  description: string,
  targetUrl?: string,
  baseUrl: string = GITHUB_API,
) {
  const url = `${baseUrl}/repos/${owner}/${repo}/statuses/${sha}`;
  const body: Record<string, string> = {
    state,
    description,
    context: 'origin/ai-governance',
  };
  if (targetUrl) body.target_url = targetUrl;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub status API error (${res.status}):`, err);
      return { success: false, error: err };
    }
    return { success: true };
  } catch (err: any) {
    console.error('Failed to post commit status:', err.message);
    return { success: false, error: err.message };
  }
}

// ── PR Comments ───────────────────────────────────────────────────

export async function postPRComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; commentId?: string; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub comment API error (${res.status}):`, err);
      return { success: false, error: err };
    }
    const data = (await res.json()) as { id: number };
    return { success: true, commentId: String(data.id) };
  } catch (err: any) {
    console.error('Failed to post PR comment:', err.message);
    return { success: false, error: err.message };
  }
}

export async function updatePRComment(
  token: string,
  owner: string,
  repo: string,
  commentId: string,
  body: string,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/issues/comments/${commentId}`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: githubHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub update comment error (${res.status}):`, err);
      return { success: false, error: err };
    }
    return { success: true };
  } catch (err: any) {
    console.error('Failed to update PR comment:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Test Connection ───────────────────────────────────────────────

export async function testGitHubConnection(
  token: string,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; login?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/user`, {
      headers: githubHeaders(token),
    });
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { login: string };
    return { success: true, login: data.login };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── List Repos (Auto-Discovery) ──────────────────────────────────

export interface GitHubRepoInfo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  defaultBranch: string;
}

/**
 * List all repos accessible by the token (includes private repos).
 * Paginates through all pages automatically.
 * For GitHub App tokens, uses /installation/repositories endpoint.
 */
export async function listGitHubRepos(
  token: string,
  baseUrl: string = GITHUB_API,
  authType: string = 'pat',
): Promise<{ success: boolean; repos?: GitHubRepoInfo[]; error?: string }> {
  // GitHub App installation tokens use a different endpoint
  if (authType === 'github_app') {
    return listGitHubAppRepos(token, baseUrl);
  }

  const allRepos: GitHubRepoInfo[] = [];
  let url: string | null = `${baseUrl}/user/repos?per_page=100&sort=updated&type=all`;

  try {
    while (url) {
      const currentUrl: string = url;
      const res: Response = await fetch(currentUrl, {
        headers: githubHeaders(token),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`GitHub list repos error (${res.status}):`, err);
        return { success: false, error: `HTTP ${res.status}` };
      }

      const data = (await res.json()) as Array<{
        owner: { login: string };
        name: string;
        full_name: string;
        private: boolean;
        html_url: string;
        default_branch: string;
      }>;

      for (const r of data) {
        allRepos.push({
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          url: r.html_url,
          defaultBranch: r.default_branch,
        });
      }

      // Parse Link header for pagination
      const linkHeader: string | null = res.headers.get('link');
      url = null;
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          url = nextMatch[1];
        }
      }
    }

    return { success: true, repos: allRepos };
  } catch (err: any) {
    console.error('Failed to list GitHub repos:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Create Webhook on GitHub ─────────────────────────────────────

/**
 * Creates a webhook on a GitHub repo via the API.
 * Requires token with `admin:repo_hook` or `repo` scope.
 */
export async function createGitHubWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; hookId?: number; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/hooks`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push', 'pull_request'],
        config: {
          url: webhookUrl,
          content_type: 'application/json',
          secret,
          insecure_ssl: '0',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub create webhook error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}: ${err}` };
    }

    const data = (await res.json()) as { id: number };
    return { success: true, hookId: data.id };
  } catch (err: any) {
    console.error('Failed to create GitHub webhook:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Delete Webhook on GitHub ─────────────────────────────────────

/**
 * Deletes a webhook from a GitHub repo via the API.
 */
export async function deleteGitHubWebhook(
  token: string,
  owner: string,
  repo: string,
  hookId: number,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/hooks/${hookId}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: githubHeaders(token),
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      console.error(`GitHub delete webhook error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}: ${err}` };
    }

    return { success: true };
  } catch (err: any) {
    console.error('Failed to delete GitHub webhook:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Integration Config ────────────────────────────────────────────

export interface IntegrationSettings {
  postChecks: boolean;
  postComments: boolean;
  checkOnReview: boolean;
}

export interface GitHubAppSettings {
  appId?: string;
  installationId?: string;
  privateKey?: string;
  tokenExpiresAt?: string;
  appSlug?: string;
  appWebhookSecret?: string;
}

const DEFAULT_SETTINGS: IntegrationSettings = {
  postChecks: true,
  postComments: true,
  checkOnReview: true,
};

export async function getIntegrationConfig(orgId: string, provider: string = 'github') {
  const config = await prisma.integrationConfig.findFirst({
    where: { orgId, provider },
  });
  if (!config) return null;

  let settings: IntegrationSettings & GitHubAppSettings;
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(config.settings) };
  } catch {
    settings = DEFAULT_SETTINGS as IntegrationSettings & GitHubAppSettings;
  }

  let token = config.token;
  const authType = (config as any).authType || 'pat';

  // For GitHub App integrations, auto-refresh the installation access token
  if (authType === 'github_app' && settings.appId && settings.installationId && settings.privateKey) {
    try {
      token = await getValidInstallationToken(config);
    } catch (err) {
      console.error('[github-app] Token refresh failed, using cached token:', err);
    }
  }

  return {
    ...config,
    token,
    parsedSettings: settings,
    apiBaseUrl: config.baseUrl || GITHUB_API,
    authType,
  };
}

// ── List PR Commits from GitHub ───────────────────────────────────

/**
 * Fetch all commit SHAs for a pull request via the GitHub API.
 * Returns up to 250 commit SHAs (GitHub paginates at 250 per page).
 */
export async function listPRCommits(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; shas?: string[]; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=250`;

  try {
    const res = await fetch(url, {
      headers: githubHeaders(token),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub list PR commits error (${res.status}):`, err);
      return { success: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as Array<{ sha: string }>;
    return { success: true, shas: data.map((c) => c.sha) };
  } catch (err: any) {
    console.error('Failed to list PR commits:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Session Summary Comment Builder ───────────────────────────────

export interface SessionForComment {
  id: string;
  agentName: string | null;
  model: string;
  costUsd: number;
  tokensUsed: number;
  linesAdded: number;
  linesRemoved: number;
  reviewStatus: string | null;
  reviewNote: string | null;
  promptCount: number;
  promptDescription: string | null;
  durationMs: number;
  filesChangedCount: number;
  violations?: Array<{
    policyName: string;
    policyType: string;
    condition: string;
    action: string;
    message: string;
  }>;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function statusEmoji(status: string | null): string {
  switch (status?.toUpperCase()) {
    case 'APPROVED': return '✅';
    case 'REJECTED': return '❌';
    case 'FLAGGED': return '⚠️';
    default: return '⏳';
  }
}

function statusLabel(status: string | null): string {
  switch (status?.toUpperCase()) {
    case 'APPROVED': return 'Approved';
    case 'REJECTED': return 'Rejected';
    case 'FLAGGED': return 'Flagged';
    default: return 'Pending Review';
  }
}

export function buildSessionSummaryComment(
  sessions: SessionForComment[],
  originBaseUrl: string,
  orgSlug?: string,
): string {
  if (sessions.length === 0) {
    return [
      '## 🔍 Origin — AI Governance Report',
      '',
      'No AI coding sessions linked to this pull request.',
      '',
      `📊 [View Dashboard](${originBaseUrl}/dashboard)`,
    ].join('\n');
  }

  const totalTurns = sessions.reduce((sum, s) => sum + (s.promptCount || 0), 0);
  const humanCorrections = sessions.filter(s => s.reviewStatus?.toUpperCase() === 'FLAGGED').length;

  const rows = sessions.map((s) => {
    const agent = s.agentName || '—';
    const cost = `$${s.costUsd.toFixed(2)}`;
    const tokens = s.tokensUsed >= 1000 ? `${(s.tokensUsed / 1000).toFixed(1)}k` : String(s.tokensUsed);
    const status = `${statusEmoji(s.reviewStatus)} ${statusLabel(s.reviewStatus)}`;
    const link = `[View](${originBaseUrl}/sessions/${s.id})`;
    const turns = s.promptCount || 0;
    return `| ${link} | ${agent} | ${s.model} | ${turns} | ${cost} | ${tokens} | ${status} |`;
  });

  const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);
  const totalLines = sessions.reduce((sum, s) => sum + s.linesAdded, 0);
  const allApproved = sessions.every((s) => s.reviewStatus?.toUpperCase() === 'APPROVED');
  const anyRejected = sessions.some((s) => s.reviewStatus?.toUpperCase() === 'REJECTED');
  const anyFlagged = sessions.some((s) => s.reviewStatus?.toUpperCase() === 'FLAGGED');

  let overallStatus = '⏳ Pending review';
  if (allApproved) overallStatus = '✅ All sessions approved';
  else if (anyRejected) overallStatus = '❌ Session(s) rejected';
  else if (anyFlagged) overallStatus = '⚠️ Session(s) flagged';

  const totalFilesChanged = sessions.reduce((sum, s) => sum + (s.filesChangedCount || 0), 0);
  const totalDurationMs = sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);

  const parts = [
    '## 🔍 Origin — AI Governance Report',
    '',
    `> **${sessions.length} session${sessions.length > 1 ? 's' : ''}** · **${totalTurns} agent turns**${humanCorrections > 0 ? ` · **${humanCorrections} flagged**` : ''}`,
    '',
    '| Session | Agent | Model | Turns | Cost | Tokens | Status |',
    '|---------|-------|-------|-------|------|--------|--------|',
    ...rows,
    '',
    `**Summary:** ${sessions.length} AI session${sessions.length > 1 ? 's' : ''} linked to this PR · $${totalCost.toFixed(2)} total cost · +${totalLines.toLocaleString()} lines added`,
    '',
    `**Overall:** ${overallStatus}`,
  ];

  // Session Details section — per-session breakdown with duration, files, and key decisions
  if (sessions.length > 0) {
    parts.push('', '<details>', '<summary>Session Details</summary>', '');
    for (const s of sessions) {
      const agent = s.agentName || 'Unknown Agent';
      const duration = formatDuration(s.durationMs);
      const files = s.filesChangedCount || 0;
      const turns = s.promptCount || 0;
      parts.push(`#### ${agent} — ${s.model}`);
      parts.push(`- **Turns:** ${turns} · **Duration:** ${duration} · **Files changed:** ${files}`);
      parts.push(`- **Lines:** +${s.linesAdded.toLocaleString()} / -${s.linesRemoved.toLocaleString()} · **Cost:** $${s.costUsd.toFixed(2)}`);

      // Extract key decisions from review notes
      if (s.reviewNote) {
        const decisionLines = s.reviewNote
          .split('\n')
          .filter((l) => /considered|decided|chose|opted|selected|reasoning|because/i.test(l))
          .slice(0, 3);
        if (decisionLines.length > 0) {
          parts.push('- **Key decisions:**');
          for (const line of decisionLines) {
            const cleaned = line.replace(/^[-*]\s*/, '').trim();
            parts.push(`  - ${cleaned}`);
          }
        }
      }

      parts.push('');
    }

    if (totalDurationMs > 0 || totalFilesChanged > 0) {
      parts.push(`**Totals:** ${formatDuration(totalDurationMs)} total duration · ${totalFilesChanged} files changed`);
      parts.push('');
    }

    parts.push('</details>');
  }

  // Collect policy violations — prefer structured data, fall back to review notes
  const hasStructuredViolations = sessions.some(s => s.violations && s.violations.length > 0);

  if (hasStructuredViolations) {
    parts.push('', '### Policy Violations', '');
    const seen = new Set<string>();
    for (const s of sessions) {
      for (const v of (s.violations || [])) {
        const key = `${v.policyName}:${v.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const desc = describeCondition(v.policyType, v.condition);
        parts.push(`**${v.policyName}** (${policyTypeLabel(v.policyType)})`);
        parts.push(`- ${v.message}`);
        parts.push(`- Action: ${describeAction(v.action)}`);
        parts.push(`- How to fix: ${desc.fixHint}`);
        parts.push('');
      }
    }
    if (orgSlug) {
      parts.push(`[View all policies](${originBaseUrl}/org/${orgSlug}/policies)`);
      parts.push('');
    }
  } else {
    // Fallback: parse violation lines from review notes
    const violationLines: string[] = [];
    for (const s of sessions) {
      if (s.reviewNote && (s.reviewStatus?.toUpperCase() === 'FLAGGED' || s.reviewStatus?.toUpperCase() === 'REJECTED')) {
        const lines = s.reviewNote.split('\n').filter((l) => l.startsWith('- **'));
        for (const line of lines) {
          violationLines.push(line);
        }
      }
    }
    if (violationLines.length > 0) {
      parts.push('', '### Policy Violations', '');
      for (const line of violationLines) {
        parts.push(line);
      }
    }
  }

  parts.push(
    '',
    `📊 [View in Origin](${originBaseUrl}/dashboard)`,
    '',
    '---',
    '*Powered by [Origin](https://github.com/dolobanko/origin) — AI Coding Agent Governance*',
  );

  return parts.join('\n');
}

// ── Check Runs (Commit Annotations) ──────────────────────────────

interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title: string;
}

/**
 * Create a GitHub Check Run with annotations showing AI attribution.
 * Shows [AI 73%] badge on each commit in the GitHub PR view.
 *
 * @see https://docs.github.com/en/rest/checks/runs#create-a-check-run
 */
export async function createCheckRun(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  opts: {
    conclusion: 'success' | 'failure' | 'neutral' | 'action_required';
    title: string;
    summary: string;
    annotations?: CheckRunAnnotation[];
    detailsUrl?: string;
  },
  baseUrl: string = GITHUB_API,
): Promise<{ success: boolean; checkRunId?: number; error?: string }> {
  const url = `${baseUrl}/repos/${owner}/${repo}/check-runs`;

  const body: Record<string, any> = {
    name: 'Origin AI Attribution',
    head_sha: headSha,
    status: 'completed',
    conclusion: opts.conclusion,
    output: {
      title: opts.title,
      summary: opts.summary,
      annotations: opts.annotations || [],
    },
  };
  if (opts.detailsUrl) body.details_url = opts.detailsUrl;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...githubHeaders(token),
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`GitHub check-run API error (${res.status}):`, err);
      return { success: false, error: err };
    }
    const data = (await res.json()) as { id: number };
    return { success: true, checkRunId: data.id };
  } catch (err: any) {
    console.error('Failed to create check run:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Build AI attribution check run for a PR.
 * Computes per-commit AI percentage and creates a check run with a summary table.
 */
export async function postAIAttributionCheckRun(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  sessions: SessionForComment[],
  commitShas: string[],
  repoId: string,
  originBaseUrl: string,
  baseUrl: string = GITHUB_API,
) {
  // Calculate overall AI stats
  const totalAILines = sessions.reduce((sum, s) => sum + s.linesAdded, 0);

  // Fetch all commits from DB to check which are AI-authored
  const commits = await prisma.commit.findMany({
    where: { repoId, sha: { in: commitShas } },
    select: { sha: true, aiToolDetected: true, message: true, author: true },
  });

  const totalCommits = commitShas.length;
  const aiCommits = commits.filter((c) => c.aiToolDetected).length;
  const aiPercent = totalCommits > 0 ? Math.round((aiCommits / totalCommits) * 100) : 0;

  // Build summary markdown table
  const summaryLines = [
    `### AI Attribution Report`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| AI Commits | ${aiCommits}/${totalCommits} (${aiPercent}%) |`,
    `| AI Sessions | ${sessions.length} |`,
    `| AI Lines Added | +${totalAILines.toLocaleString()} |`,
    `| Models | ${[...new Set(sessions.map((s) => s.model))].join(', ') || '—'} |`,
    `| Agents | ${[...new Set(sessions.map((s) => s.agentName).filter(Boolean))].join(', ') || '—'} |`,
    '',
  ];

  // Per-commit breakdown
  if (commits.length > 0) {
    summaryLines.push('### Per-Commit Breakdown', '');
    summaryLines.push('| Commit | Author | AI | Tool |');
    summaryLines.push('|--------|--------|----|------|');
    for (const c of commits) {
      const tag = c.aiToolDetected ? `**[AI]**` : `[Human]`;
      const tool = c.aiToolDetected || '—';
      const msg = (c.message || '').slice(0, 60);
      summaryLines.push(`| \`${c.sha.slice(0, 8)}\` ${msg} | ${c.author || '—'} | ${tag} | ${tool} |`);
    }
  }

  const title = `[AI ${aiPercent}%] ${aiCommits} of ${totalCommits} commits are AI-authored`;
  const conclusion = aiPercent > 0 ? 'neutral' : 'success';

  return createCheckRun(token, owner, repo, headSha, {
    conclusion,
    title,
    summary: summaryLines.join('\n'),
    detailsUrl: `${originBaseUrl}/sessions`,
  }, baseUrl);
}

// ── Compute Check Status from Sessions ────────────────────────────

export function computeCheckStatus(sessions: SessionForComment[]): {
  state: StatusState;
  description: string;
} {
  if (sessions.length === 0) {
    return { state: 'success', description: 'No AI sessions linked to this PR' };
  }

  const anyRejected = sessions.some((s) => s.reviewStatus?.toUpperCase() === 'REJECTED');
  const anyFlagged = sessions.some((s) => s.reviewStatus?.toUpperCase() === 'FLAGGED');
  const allApproved = sessions.every((s) => s.reviewStatus?.toUpperCase() === 'APPROVED');
  const pending = sessions.filter((s) => !s.reviewStatus).length;

  if (anyRejected) {
    const rejected = sessions.find((s) => s.reviewStatus?.toUpperCase() === 'REJECTED');
    const firstViolation = rejected?.violations?.[0];
    let detail: string | null;
    if (firstViolation) {
      detail = `${firstViolation.policyName}: ${firstViolation.message}`;
    } else {
      detail = extractFirstViolation(rejected?.reviewNote) || `${sessions.length} AI session(s) — rejected`;
    }
    return { state: 'failure', description: detail.length > 130 ? detail.slice(0, 127) + '...' : detail };
  }
  if (anyFlagged) {
    const flagged = sessions.find((s) => s.reviewStatus?.toUpperCase() === 'FLAGGED');
    const firstViolation = flagged?.violations?.[0];
    let detail: string | null;
    if (firstViolation) {
      detail = `${firstViolation.policyName}: ${firstViolation.message}`;
    } else {
      detail = extractFirstViolation(flagged?.reviewNote) || `${sessions.length} AI session(s) — policy violation`;
    }
    return { state: 'failure', description: detail.length > 130 ? detail.slice(0, 127) + '...' : detail };
  }
  if (allApproved) {
    return { state: 'success', description: `${sessions.length} AI session(s) — all approved` };
  }
  return {
    state: 'pending',
    description: `${sessions.length} AI session(s) — ${pending} awaiting review`,
  };
}

/** Extract first violation detail from a review note for the status description. */
function extractFirstViolation(note: string | null | undefined): string | null {
  if (!note) return null;
  // Look for "- **PolicyName** (TYPE): message" format
  const match = note.match(/- \*\*([^*]+)\*\*[^:]*:\s*(.+)/);
  if (match) {
    const msg = match[2].trim();
    // GitHub status descriptions have a 140-char limit
    return msg.length > 130 ? msg.slice(0, 127) + '...' : msg;
  }
  return null;
}

// ── Get Sessions for a PR ─────────────────────────────────────────

export async function getSessionsForPR(repoId: string, commitShas: string[]): Promise<SessionForComment[]> {
  if (commitShas.length === 0) return [];

  const commits = await prisma.commit.findMany({
    where: {
      repoId,
      sha: { in: commitShas },
    },
    include: {
      // "primaryCommit" relation: CodingSession.commitId → Commit.id
      session: {
        include: {
          agent: true,
          review: true,
          _count: { select: { promptChanges: true } },
        },
      },
      // "sessionCommits" relation: Commit.sessionId → CodingSession.id
      // This is the link created by post-commit hooks when real commits are captured
      codingSession: {
        include: {
          agent: true,
          review: true,
          _count: { select: { promptChanges: true } },
        },
      },
    },
  });

  // Deduplicate sessions (multiple commits can link to same session)
  const sessionMap = new Map<string, SessionForComment>();

  function addSession(s: { id: string; agent?: { name: string } | null; model: string; prompt?: string | null; costUsd: number; tokensUsed: number; linesAdded: number; linesRemoved: number; durationMs?: number | null; filesChanged?: string | null; review?: { status: string; note?: string | null } | null }) {
    if (!sessionMap.has(s.id)) {
      let filesChangedCount = 0;
      if (s.filesChanged) {
        try {
          const parsed = JSON.parse(s.filesChanged);
          filesChangedCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch { /* ignore */ }
      }
      sessionMap.set(s.id, {
        id: s.id,
        agentName: s.agent?.name || null,
        model: s.model,
        costUsd: s.costUsd,
        tokensUsed: s.tokensUsed,
        linesAdded: s.linesAdded,
        linesRemoved: s.linesRemoved,
        reviewStatus: s.review?.status || null,
        reviewNote: s.review?.note || null,
        promptCount: (s as any)._count?.promptChanges || 0,
        promptDescription: s.prompt ? (s.prompt.length > 60 ? s.prompt.slice(0, 60) + '...' : s.prompt) : null,
        durationMs: s.durationMs || 0,
        filesChangedCount,
      });
    }
  }

  for (const c of commits) {
    // Primary commit relation (placeholder SHA → session)
    if (c.session) addSession(c.session);
    // Secondary commit relation (real SHA → session via sessionId)
    if (c.codingSession) addSession(c.codingSession);
  }

  // Load policy violations from audit log for each session
  const sessionIds = Array.from(sessionMap.keys());
  if (sessionIds.length > 0) {
    const violationLogs = await prisma.auditLog.findMany({
      where: {
        action: 'POLICY_VIOLATION',
        resource: { in: sessionIds },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const log of violationLogs) {
      try {
        const meta = JSON.parse(log.metadata);
        const sessionId = meta.sessionId || log.resource;
        const session = sessionMap.get(sessionId as string);
        if (session) {
          if (!session.violations) session.violations = [];
          session.violations.push({
            policyName: meta.policyName || 'Unknown Policy',
            policyType: meta.policyType || 'UNKNOWN',
            condition: meta.condition || '{}',
            action: meta.action || 'WARN',
            message: meta.message || '',
          });
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return Array.from(sessionMap.values());
}

// ── Post Status + Comment for a PR ────────────────────────────────

export async function updatePRGitHubStatus(
  orgId: string,
  repoId: string,
  prNumber: number,
  headSha: string,
  originBaseUrl: string,
) {
  const integration = await getIntegrationConfig(orgId);
  if (!integration) return;

  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo) return;

  const parsed = parseRepoFullName(repo.path);
  if (!parsed) return;

  const pr = await prisma.pullRequest.findFirst({
    where: { repoId, number: prNumber },
  });
  if (!pr) return;

  let commitShas: string[];
  try {
    commitShas = JSON.parse(pr.commitShas);
  } catch {
    commitShas = [];
  }

  const sessions = await getSessionsForPR(repoId, commitShas);
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { slug: true } });

  // Post status check
  if (integration.parsedSettings.postChecks) {
    const { state, description } = computeCheckStatus(sessions);
    await postCommitStatus(
      integration.token,
      parsed.owner,
      parsed.repo,
      headSha,
      state,
      description,
      `${originBaseUrl}/sessions`,
      integration.apiBaseUrl,
    );

    // Post AI attribution check run (shows [AI 73%] on commits)
    try {
      await postAIAttributionCheckRun(
        integration.token,
        parsed.owner,
        parsed.repo,
        headSha,
        sessions,
        commitShas,
        repoId,
        originBaseUrl,
        integration.apiBaseUrl,
      );
    } catch (err) {
      console.error('Failed to post AI attribution check run:', err);
    }

    await prisma.pullRequest.update({
      where: { id: pr.id },
      data: { checkStatus: state },
    });
  }

  // Post or update comment
  if (integration.parsedSettings.postComments) {
    const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);

    if (pr.commentId) {
      await updatePRComment(
        integration.token,
        parsed.owner,
        parsed.repo,
        pr.commentId,
        commentBody,
        integration.apiBaseUrl,
      );
    } else {
      const result = await postPRComment(
        integration.token,
        parsed.owner,
        parsed.repo,
        prNumber,
        commentBody,
        integration.apiBaseUrl,
      );
      if (result.commentId) {
        await prisma.pullRequest.update({
          where: { id: pr.id },
          data: { commentId: result.commentId },
        });
      }
    }
  }
}

// ── Update PR Checks After Session Enforcement ────────────────────

/**
 * After a session is flagged/reviewed, find all PRs that include commits
 * from this session and update their GitHub status checks + comments.
 * Returns the number of PRs updated.
 */
export async function updateSessionPRChecks(
  sessionId: string,
  orgId: string,
): Promise<number> {
  const integration = await getIntegrationConfig(orgId);
  if (!integration) return 0;

  // Find the session and its commits
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

  // Find all open PRs for this repo
  const openPRs = await prisma.pullRequest.findMany({
    where: { repoId, state: 'open' },
  });

  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (!repo) return 0;

  const parsed = parseRepoFullName(repo.path);
  if (!parsed) return 0;

  const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { slug: true } });
  let updated = 0;

  for (const pr of openPRs) {
    let prShas: string[];
    try {
      prShas = JSON.parse(pr.commitShas);
    } catch {
      prShas = [];
    }

    // Check if any of this session's commits are in the PR
    const hasMatch = sessionShas.some((sha) => prShas.includes(sha));
    if (!hasMatch) continue;

    // Find the latest SHA for posting the status check (head of PR)
    const headSha = prShas[prShas.length - 1];
    if (!headSha) continue;

    try {
      const sessions = await getSessionsForPR(repoId, prShas);
      const { state, description } = computeCheckStatus(sessions);

      // Post status check
      if (integration.parsedSettings.postChecks) {
        await postCommitStatus(
          integration.token,
          parsed.owner,
          parsed.repo,
          headSha,
          state,
          description,
          `${originBaseUrl}/sessions`,
          integration.apiBaseUrl,
        );

        // Post AI attribution check run
        try {
          await postAIAttributionCheckRun(
            integration.token,
            parsed.owner,
            parsed.repo,
            headSha,
            sessions,
            prShas,
            repoId,
            originBaseUrl,
            integration.apiBaseUrl,
          );
        } catch (err) {
          console.error('Failed to post AI attribution check run:', err);
        }
      }

      // Update comment
      if (integration.parsedSettings.postComments) {
        const commentBody = buildSessionSummaryComment(sessions, originBaseUrl, org?.slug);
        if (pr.commentId) {
          await updatePRComment(
            integration.token,
            parsed.owner,
            parsed.repo,
            pr.commentId,
            commentBody,
            integration.apiBaseUrl,
          );
        } else {
          const result = await postPRComment(
            integration.token,
            parsed.owner,
            parsed.repo,
            pr.number,
            commentBody,
            integration.apiBaseUrl,
          );
          if (result.commentId) {
            await prisma.pullRequest.update({
              where: { id: pr.id },
              data: { commentId: result.commentId },
            });
          }
        }
      }

      // Update check status on PR record
      const { state: newState } = computeCheckStatus(sessions);
      await prisma.pullRequest.update({
        where: { id: pr.id },
        data: { checkStatus: newState },
      });

      updated++;
    } catch (err) {
      console.error(`Failed to update PR #${pr.number} status:`, err);
    }
  }

  return updated;
}
