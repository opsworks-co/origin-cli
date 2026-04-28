// Compute the AI-authorship summary for a pull request and post it as a
// GitHub Check Run (or commit status fallback). The "Trojan-horse" feature:
// every reviewer on every PR sees the AI % even if they've never touched
// Origin, which is how the product reaches developers who didn't install
// the CLI themselves.
//
// Idempotent: stores `authorshipCheckRunId` on the PR row and PATCHes that
// check on subsequent pushes instead of creating duplicates.

import { prisma } from '../db.js';
import {
  getIntegrationConfig,
  parseRepoFullName,
} from './github-integration.js';

const GITHUB_API = 'https://api.github.com';

interface AuthorshipSummary {
  totalCommits: number;
  aiCommits: number;
  humanCommits: number;
  aiLines: number;
  humanLines: number;
  aiPercent: number;
  totalPrompts: number;
  totalCost: number;
  byAgent: Array<{ agent: string; lines: number; percent: number; cost: number; prompts: number }>;
}

/**
 * Walk a PR's commits and summarise AI authorship for the GitHub Check
 * payload. Uses the per-commit attribution that's already populated by
 * existing webhook + session paths — no new ingestion required.
 */
export async function computePRAuthorship(prId: string): Promise<AuthorshipSummary | null> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: prId },
    select: { commitShas: true, repoId: true },
  });
  if (!pr) return null;

  let shas: string[] = [];
  try {
    const parsed = JSON.parse(pr.commitShas || '[]');
    if (Array.isArray(parsed)) shas = parsed.filter((s: any) => typeof s === 'string');
  } catch { /* malformed */ }

  // Cap the per-PR walk. GitHub's PR commits endpoint paginates at 250 so
  // anything past that wouldn't have been ingested in the first place.
  shas = shas.slice(0, 250);
  if (shas.length === 0) {
    return {
      totalCommits: 0,
      aiCommits: 0,
      humanCommits: 0,
      aiLines: 0,
      humanLines: 0,
      aiPercent: 0,
      totalPrompts: 0,
      totalCost: 0,
      byAgent: [],
    };
  }

  const commits = await prisma.commit.findMany({
    where: { repoId: pr.repoId, sha: { in: shas } },
    include: {
      session: {
        select: {
          costUsd: true,
          model: true,
          agent: { select: { slug: true, name: true } },
          promptChanges: { select: { id: true } },
        },
      },
    },
  });

  let aiCommits = 0;
  let humanCommits = 0;
  let aiLines = 0;
  let humanLines = 0;
  let totalPrompts = 0;
  let totalCost = 0;
  const agentMap = new Map<string, { lines: number; cost: number; prompts: number }>();

  for (const c of commits) {
    const isAi = !!c.aiToolDetected || !!c.session;
    const lines = (c.additions || 0) + (c.deletions || 0);
    if (isAi) {
      aiCommits++;
      aiLines += lines;
      // Bucket by agent. Prefer the explicit Agent record name (so
      // "Claude Code" stays consistent), fall back to detected tool, then
      // model. Lower-case for grouping, title-cased on render.
      const rawAgent = c.session?.agent?.name
        || c.session?.agent?.slug
        || c.aiToolDetected
        || c.session?.model
        || 'AI';
      const key = rawAgent.toLowerCase();
      const entry = agentMap.get(key) || { lines: 0, cost: 0, prompts: 0 };
      entry.lines += lines;
      entry.cost += c.session?.costUsd || 0;
      entry.prompts += c.session?.promptChanges?.length || 0;
      agentMap.set(key, entry);
      totalCost += c.session?.costUsd || 0;
      totalPrompts += c.session?.promptChanges?.length || 0;
    } else {
      humanCommits++;
      humanLines += lines;
    }
  }

  const totalLines = aiLines + humanLines;
  const aiPercent = totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0;

  // Title-case the bucket keys for display: "claude code" -> "Claude Code"
  const titleCase = (s: string) =>
    s.split(/[\s\-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const byAgent = Array.from(agentMap.entries())
    .map(([agent, e]) => ({
      agent: titleCase(agent),
      lines: e.lines,
      percent: totalLines > 0 ? Math.round((e.lines / totalLines) * 100) : 0,
      cost: e.cost,
      prompts: e.prompts,
    }))
    .sort((a, b) => b.lines - a.lines);

  return {
    totalCommits: commits.length,
    aiCommits,
    humanCommits,
    aiLines,
    humanLines,
    aiPercent,
    totalPrompts,
    totalCost,
    byAgent,
  };
}

function formatStatusLine(summary: AuthorshipSummary): string {
  if (summary.totalCommits === 0) return 'No commits ingested yet';
  // Top 2 agents by lines. Anything past that joins as "+N more".
  const head = summary.byAgent.slice(0, 2);
  const rest = summary.byAgent.length - head.length;
  const agents = head.map((a) => `${a.agent} ${a.percent}%`).join(' / ')
    + (rest > 0 ? ` · +${rest} more` : '');
  const cost = summary.totalCost > 0 ? ` · $${summary.totalCost.toFixed(2)}` : '';
  const prompts = summary.totalPrompts > 0 ? ` · ${summary.totalPrompts} prompt${summary.totalPrompts === 1 ? '' : 's'}` : '';
  if (agents) {
    return `AI ${summary.aiPercent}% · ${agents}${prompts}${cost}`;
  }
  return `AI ${summary.aiPercent}%${prompts}${cost}`;
}

function formatCheckSummary(summary: AuthorshipSummary, pullRequestPageUrl: string): string {
  const lines: string[] = [];
  lines.push('### AI authorship across this PR');
  lines.push('');
  lines.push('| Source | Lines | %  |');
  lines.push('|--------|------:|---:|');
  lines.push(`| AI     | ${summary.aiLines} | ${summary.aiPercent} |`);
  lines.push(`| Human  | ${summary.humanLines} | ${100 - summary.aiPercent} |`);
  lines.push('');
  if (summary.byAgent.length > 0) {
    lines.push('**By agent:**');
    for (const a of summary.byAgent) {
      const cost = a.cost > 0 ? ` · $${a.cost.toFixed(2)}` : '';
      const prompts = a.prompts > 0 ? ` · ${a.prompts} prompt${a.prompts === 1 ? '' : 's'}` : '';
      lines.push(`- **${a.agent}** — ${a.percent}%${prompts}${cost}`);
    }
    lines.push('');
  }
  lines.push(`[Open in Origin →](${pullRequestPageUrl})`);
  return lines.join('\n');
}

interface PostCheckArgs {
  token: string;
  owner: string;
  repo: string;
  headSha: string;
  detailsUrl: string;
  summary: AuthorshipSummary;
  pullRequestPageUrl: string;
  existingCheckRunId: number | null;
  apiBaseUrl?: string;
}

/**
 * Create or update the GitHub Check Run for AI authorship. Returns the
 * check_run_id on success so callers can persist it for idempotent
 * updates on the next push.
 */
async function postCheckRun(args: PostCheckArgs): Promise<{ checkRunId: number | null; error?: string }> {
  const apiBase = args.apiBaseUrl || GITHUB_API;
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Origin-AI-Governance/1.0',
  };

  const titleStatus = formatStatusLine(args.summary);
  const body = {
    name: 'Origin / AI authorship',
    head_sha: args.headSha,
    status: 'completed',
    conclusion: 'success', // informational — never gates a merge
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    details_url: args.detailsUrl,
    output: {
      title: titleStatus,
      summary: formatCheckSummary(args.summary, args.pullRequestPageUrl),
    },
  };

  try {
    let res: Response;
    if (args.existingCheckRunId) {
      // PATCH existing — idempotent on synchronize / reopen
      res = await fetch(`${apiBase}/repos/${args.owner}/${args.repo}/check-runs/${args.existingCheckRunId}`, {
        method: 'PATCH',
        headers: baseHeaders,
        body: JSON.stringify(body),
      });
      // If the run no longer exists upstream, fall through to create.
      if (res.status === 404) {
        res = await fetch(`${apiBase}/repos/${args.owner}/${args.repo}/check-runs`, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(body),
        });
      }
    } else {
      res = await fetch(`${apiBase}/repos/${args.owner}/${args.repo}/check-runs`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[pr-authorship] check-run ${res.status}:`, errText.slice(0, 300));
      return { checkRunId: null, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { id?: number };
    return { checkRunId: typeof data.id === 'number' ? data.id : null };
  } catch (err: any) {
    console.error('[pr-authorship] check-run network error:', err?.message);
    return { checkRunId: null, error: err?.message };
  }
}

/**
 * Fallback path for orgs whose integration is a PAT (not a GitHub App).
 * Commit Status API works on any token with `repo` scope but only renders
 * a single line — no markdown summary, no breakdown table.
 */
async function postCommitStatus(args: PostCheckArgs): Promise<{ posted: boolean; error?: string }> {
  const apiBase = args.apiBaseUrl || GITHUB_API;
  try {
    const res = await fetch(`${apiBase}/repos/${args.owner}/${args.repo}/statuses/${args.headSha}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Origin-AI-Governance/1.0',
      },
      body: JSON.stringify({
        state: 'success',
        target_url: args.detailsUrl,
        description: formatStatusLine(args.summary).slice(0, 140), // GitHub caps at 140
        context: 'origin/ai-authorship',
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[pr-authorship] commit-status ${res.status}:`, errText.slice(0, 200));
      return { posted: false, error: `HTTP ${res.status}` };
    }
    return { posted: true };
  } catch (err: any) {
    console.error('[pr-authorship] commit-status network error:', err?.message);
    return { posted: false, error: err?.message };
  }
}

interface IntegrationSettings {
  prCheckEnabled?: boolean;
  [k: string]: any;
}

/**
 * End-to-end: compute the summary, decide which API to post to, and
 * persist the resulting check_run_id (if any) for next time.
 *
 * Fire-and-forget from the webhook hot path — never throws.
 */
export async function postPRAuthorshipCheck(prId: string): Promise<void> {
  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      select: {
        id: true,
        repoId: true,
        url: true,
        commitShas: true,
        authorshipCheckRunId: true,
        repo: { select: { orgId: true, path: true } },
      },
    });
    if (!pr) return;

    const integration = await getIntegrationConfig(pr.repo.orgId, 'github');
    if (!integration?.token) {
      // No GitHub integration on this org — silently skip. The webhook
      // wouldn't have fired in the first place under normal flow but
      // covers the case where the integration was disconnected.
      return;
    }

    let settings: IntegrationSettings = {};
    try { settings = JSON.parse((integration as any).settings || '{}'); } catch { /* ignore */ }
    if (settings.prCheckEnabled === false) {
      return; // toggled off in Settings
    }

    const parsed = parseRepoFullName(pr.repo.path);
    if (!parsed) return;

    const summary = await computePRAuthorship(prId);
    if (!summary || summary.totalCommits === 0) return;

    // Resolve the head SHA — use the last commit in the PR's commit list.
    let headSha: string | null = null;
    try {
      const shas = JSON.parse(pr.commitShas || '[]');
      if (Array.isArray(shas) && shas.length > 0) headSha = shas[shas.length - 1];
    } catch { /* ignore */ }
    if (!headSha) return;

    const dashboardUrl = process.env.PUBLIC_APP_URL || 'https://getorigin.io';
    const detailsUrl = `${dashboardUrl}/pull-requests`;
    const pullRequestPageUrl = `${dashboardUrl}/pull-requests`;

    const authType = (integration as any).authType || 'pat';

    if (authType === 'github_app') {
      const r = await postCheckRun({
        token: integration.token,
        owner: parsed.owner,
        repo: parsed.repo,
        headSha,
        detailsUrl,
        pullRequestPageUrl,
        summary,
        existingCheckRunId: pr.authorshipCheckRunId ?? null,
        apiBaseUrl: integration.apiBaseUrl,
      });
      if (r.checkRunId && r.checkRunId !== pr.authorshipCheckRunId) {
        await prisma.pullRequest.update({
          where: { id: pr.id },
          data: { authorshipCheckRunId: r.checkRunId },
        }).catch(() => { /* best effort */ });
      }
    } else {
      // PAT path — commit status only. No idempotent ID to persist.
      await postCommitStatus({
        token: integration.token,
        owner: parsed.owner,
        repo: parsed.repo,
        headSha,
        detailsUrl,
        pullRequestPageUrl,
        summary,
        existingCheckRunId: null,
        apiBaseUrl: integration.apiBaseUrl,
      });
    }
  } catch (err: any) {
    console.error('[pr-authorship] postPRAuthorshipCheck error:', err?.message);
  }
}
