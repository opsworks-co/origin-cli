import crypto from 'crypto';
import { prisma } from '../db.js';
import { updatePRGitHubStatus } from './github-integration.js';
import { detectAITool } from './ai-commit-detector.js';

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function verifyGitHubSignature(payload: string | Buffer, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : payload);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Push Events ───────────────────────────────────────────────────

interface GitHubCommit {
  id: string;
  message: string;
  author: { name: string; email: string };
  timestamp: string;
  added: string[];
  modified: string[];
  removed: string[];
}

interface GitHubPushPayload {
  ref: string;
  commits: GitHubCommit[];
  repository: { full_name: string };
}

export async function processGitHubPush(repoId: string, payload: GitHubPushPayload) {
  const results = { created: 0, skipped: 0 };

  for (const commit of payload.commits) {
    // Check for duplicate by SHA
    const existing = await prisma.commit.findFirst({
      where: { repoId, sha: commit.id },
    });

    if (existing) {
      results.skipped++;
      continue;
    }

    const detection = detectAITool(commit.message, commit.author.name);
    await prisma.commit.create({
      data: {
        repoId,
        sha: commit.id,
        message: commit.message,
        author: commit.author.name,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(commit.timestamp),
      },
    });
    results.created++;
  }

  // Update repo syncedAt
  await prisma.repo.update({
    where: { id: repoId },
    data: { syncedAt: new Date() },
  });

  return results;
}

// ── Pull Request Events ───────────────────────────────────────────

interface GitHubPRPayload {
  action: string;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    state: string;
    user: { login: string };
    base: { ref: string };
    head: { ref: string; sha: string };
    merged?: boolean;
  };
  repository: { full_name: string };
}

export async function processGitHubPR(repoId: string, payload: GitHubPRPayload) {
  const pr = payload.pull_request;
  const action = payload.action;

  // Determine PR state
  let state = pr.state; // "open" or "closed"
  if (pr.merged) state = 'merged';

  // Upsert the PullRequest record
  const existing = await prisma.pullRequest.findFirst({
    where: { repoId, number: payload.number },
  });

  // Build commit SHAs list — include the head SHA and any existing ones
  let commitShas: string[] = [];
  if (existing) {
    try {
      commitShas = JSON.parse(existing.commitShas);
    } catch {
      commitShas = [];
    }
  }

  // Add head SHA if not already present
  if (pr.head.sha && !commitShas.includes(pr.head.sha)) {
    commitShas.push(pr.head.sha);
  }

  // Also find all commits in the repo that match any of the SHAs
  // (to link sessions that were created via push events)
  const repoCommits = await prisma.commit.findMany({
    where: { repoId },
    select: { sha: true },
    orderBy: { committedAt: 'desc' },
    take: 100,
  });

  const prRecord = existing
    ? await prisma.pullRequest.update({
        where: { id: existing.id },
        data: {
          title: pr.title,
          url: pr.html_url,
          state,
          author: pr.user.login,
          baseBranch: pr.base.ref,
          headBranch: pr.head.ref,
          commitShas: JSON.stringify(commitShas),
        },
      })
    : await prisma.pullRequest.create({
        data: {
          repoId,
          number: payload.number,
          title: pr.title,
          url: pr.html_url,
          state,
          author: pr.user.login,
          baseBranch: pr.base.ref,
          headBranch: pr.head.ref,
          commitShas: JSON.stringify(commitShas),
        },
      });

  // Get the repo to find the org
  const repo = await prisma.repo.findUnique({ where: { id: repoId } });

  // Post status check + comment to GitHub (if integration is configured)
  if (repo && (action === 'opened' || action === 'synchronize' || action === 'reopened')) {
    const originBaseUrl = process.env.ORIGIN_WEB_URL || 'http://localhost:5176';
    try {
      await updatePRGitHubStatus(
        repo.orgId,
        repoId,
        payload.number,
        pr.head.sha,
        originBaseUrl,
      );
    } catch (err) {
      console.error('Failed to update GitHub PR status:', err);
    }
  }

  return {
    action,
    prId: prRecord.id,
    number: payload.number,
    state,
    commitShas: commitShas.length,
  };
}
