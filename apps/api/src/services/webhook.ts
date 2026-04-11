import crypto from 'crypto';
import { prisma } from '../db.js';
import { updatePRGitHubStatus, listPRCommits, getIntegrationConfig, parseRepoFullName } from './github-integration.js';
import { updateMRGitLabStatus, listMRCommits, getGitLabIntegrationConfig, parseGitLabProjectPath } from './gitlab-integration.js';
import { detectAITool } from './ai-commit-detector.js';
import { isGitNotesMetadataCommit } from '../utils/commit-filter.js';

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function verifyGitHubSignature(payload: string | Buffer, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expected = 'sha256=' + hmac.digest('hex');
  // timingSafeEqual requires equal-length buffers. Reject length mismatch
  // explicitly — comparing equal-length buffers is the only scenario
  // where the timing-safe guarantee actually matters, and feeding
  // unequal lengths would throw, leaking "valid prefix" info via the
  // exception path. A hash-based length check is still constant time
  // relative to the signature content.
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const receivedBuf = Buffer.from(signature, 'utf-8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
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

  // Extract branch name from ref (e.g., "refs/heads/main" → "main")
  const branch = payload.ref?.replace('refs/heads/', '') || null;

  // Cap the commit loop. A single webhook can legally carry ~2000 commits
  // (GitHub's own limit), but a malicious or catastrophically misconfigured
  // sender could post many more, turning one request into thousands of
  // sequential DB writes. Process the first N and log the rest; we can
  // still resync the tail later via the manual sync path.
  const MAX_COMMITS_PER_PUSH = 2000;
  const commits = Array.isArray(payload.commits)
    ? payload.commits.slice(0, MAX_COMMITS_PER_PUSH)
    : [];
  if (Array.isArray(payload.commits) && payload.commits.length > MAX_COMMITS_PER_PUSH) {
    console.warn(`[webhook] GitHub push truncated: ${payload.commits.length} > ${MAX_COMMITS_PER_PUSH}`);
  }

  for (const commit of commits) {
    // Drop git-notes metadata commits at the ingest boundary. These leak
    // in when refs/notes/origin gets mirrored alongside refs/heads/*.
    // They're Origin's own bookkeeping, not user work — keeping them out
    // of the Commit table prevents UI noise and duplicate rows for the
    // same underlying SHA.
    if (isGitNotesMetadataCommit(commit.message)) {
      results.skipped++;
      continue;
    }

    // Atomic upsert on the (repoId, sha) unique index: concurrent webhook
    // deliveries for the same push collapse into a single row instead of
    // racing between findFirst() and create(). On a "first write wins"
    // concurrent push, the second delivery will take the update branch and
    // only fill in `branch` if it was empty.
    const detection = detectAITool(commit.message, commit.author.name);
    const result = await prisma.commit.upsert({
      where: { repoId_sha: { repoId, sha: commit.id } },
      create: {
        repoId,
        sha: commit.id,
        message: commit.message,
        author: commit.author.name,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        branch,
        committedAt: new Date(commit.timestamp),
      },
      update: {}, // on collision keep existing row; branch backfill below
    });
    if (branch && !result.branch) {
      // Backfill branch only when it was previously unknown. updateMany with
      // a `branch: null` guard makes this safe under concurrency.
      await prisma.commit.updateMany({
        where: { id: result.id, branch: null },
        data: { branch },
      });
    }
    // Rough created/skipped signal — upsert doesn't tell us which path ran.
    // Treat rows whose createdAt matches the upsert as "created".
    if (Math.abs(Date.now() - new Date(result.createdAt).getTime()) < 5_000) {
      results.created++;
    } else {
      results.skipped++;
    }
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

  // Build commit SHAs list — fetch all PR commits from GitHub API if possible
  let commitShas: string[] = [];
  if (existing) {
    try {
      commitShas = JSON.parse(existing.commitShas);
    } catch {
      commitShas = [];
    }
  }

  // Try to fetch full PR commit list from GitHub API
  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (repo) {
    const integration = await getIntegrationConfig(repo.orgId);
    const parsed = parseRepoFullName(repo.path);
    if (integration && parsed) {
      const prCommits = await listPRCommits(
        integration.token,
        parsed.owner,
        parsed.repo,
        payload.number,
        integration.apiBaseUrl,
      );
      if (prCommits.success && prCommits.shas) {
        // Merge GitHub API SHAs with existing ones
        for (const sha of prCommits.shas) {
          if (!commitShas.includes(sha)) {
            commitShas.push(sha);
          }
        }
      }
    }
  }

  // Add head SHA if not already present
  if (pr.head.sha && !commitShas.includes(pr.head.sha)) {
    commitShas.push(pr.head.sha);
  }

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

  // Get the repo to find the org (may already have it from above)
  const repoForStatus = repo || await prisma.repo.findUnique({ where: { id: repoId } });

  // Post status check + comment to GitHub (if integration is configured)
  if (repoForStatus && (action === 'opened' || action === 'synchronize' || action === 'reopened')) {
    const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';
    try {
      await updatePRGitHubStatus(
        repoForStatus.orgId,
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

// ── GitLab Webhook Support ────────────────────────────────────────

/**
 * GitLab uses a plain-text token header (X-Gitlab-Token) instead of HMAC.
 */
export function verifyGitLabToken(headerToken: string, secret: string): boolean {
  if (!headerToken || !secret) return false;
  // Length-check up front so timingSafeEqual doesn't throw on mismatched
  // buffer lengths (which would reveal *secret length* via timing: the
  // throw path is faster than the constant-time compare path). By
  // returning false on length mismatch *without* attempting compare,
  // we leak the same bit either way and avoid the try/catch shortcut.
  const headerBuf = Buffer.from(headerToken, 'utf8');
  const secretBuf = Buffer.from(secret, 'utf8');
  if (headerBuf.length !== secretBuf.length) return false;
  try {
    return crypto.timingSafeEqual(headerBuf, secretBuf);
  } catch {
    return false;
  }
}

// ── GitLab Push Events ────────────────────────────────────────────

interface GitLabCommit {
  id: string;
  message: string;
  author: { name: string; email: string };
  timestamp: string;
  added: string[];
  modified: string[];
  removed: string[];
}

interface GitLabPushPayload {
  ref: string;
  commits: GitLabCommit[];
  project: { path_with_namespace: string };
}

export async function processGitLabPush(repoId: string, payload: GitLabPushPayload) {
  const results = { created: 0, skipped: 0 };
  const branch = payload.ref?.replace('refs/heads/', '') || null;

  // Same cap as the GitHub path — see processGitHubPush for rationale.
  const MAX_COMMITS_PER_PUSH = 2000;
  const commits = Array.isArray(payload.commits)
    ? payload.commits.slice(0, MAX_COMMITS_PER_PUSH)
    : [];
  if (Array.isArray(payload.commits) && payload.commits.length > MAX_COMMITS_PER_PUSH) {
    console.warn(`[webhook] GitLab push truncated: ${payload.commits.length} > ${MAX_COMMITS_PER_PUSH}`);
  }

  for (const commit of commits) {
    // Same filter as GitHub: git-notes metadata commits never belong in
    // the Commits table — they're Origin's own bookkeeping.
    if (isGitNotesMetadataCommit(commit.message)) {
      results.skipped++;
      continue;
    }

    // Atomic upsert — see GitHub path above for rationale.
    const detection = detectAITool(commit.message, commit.author.name);
    const result = await prisma.commit.upsert({
      where: { repoId_sha: { repoId, sha: commit.id } },
      create: {
        repoId,
        sha: commit.id,
        message: commit.message,
        author: commit.author.name,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        branch,
        committedAt: new Date(commit.timestamp),
      },
      update: {}, // on collision keep existing row; branch backfill below
    });
    if (branch && !result.branch) {
      // Backfill branch only when it was previously unknown. updateMany with
      // a `branch: null` guard makes this safe under concurrency.
      await prisma.commit.updateMany({
        where: { id: result.id, branch: null },
        data: { branch },
      });
    }
    if (Math.abs(Date.now() - new Date(result.createdAt).getTime()) < 5_000) {
      results.created++;
    } else {
      results.skipped++;
    }
  }

  await prisma.repo.update({
    where: { id: repoId },
    data: { syncedAt: new Date() },
  });

  return results;
}

// ── GitLab Merge Request Events ──────────────────────────────────

interface GitLabMRPayload {
  object_kind: string;
  object_attributes: {
    iid: number;
    title: string;
    url: string;
    state: string;
    action: string;
    source_branch: string;
    target_branch: string;
    last_commit: { id: string };
    author_id: number;
  };
  user: { username: string };
  project: { path_with_namespace: string };
}

/** Map GitLab MR action to a normalized state */
function mapGitLabMRState(action: string, state: string): string {
  if (action === 'merge') return 'merged';
  if (action === 'close') return 'closed';
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
}

export async function processGitLabMR(repoId: string, payload: GitLabMRPayload) {
  const attrs = payload.object_attributes;
  const action = attrs.action;
  const state = mapGitLabMRState(action, attrs.state);

  const existing = await prisma.pullRequest.findFirst({
    where: { repoId, number: attrs.iid },
  });

  let commitShas: string[] = [];
  if (existing) {
    try {
      commitShas = JSON.parse(existing.commitShas);
    } catch {
      commitShas = [];
    }
  }

  // Fetch full MR commit list from GitLab API
  const repo = await prisma.repo.findUnique({ where: { id: repoId } });
  if (repo) {
    const integration = await getGitLabIntegrationConfig(repo.orgId);
    const projectPath = parseGitLabProjectPath(repo.path);
    if (integration && projectPath) {
      const mrCommits = await listMRCommits(
        integration.token,
        projectPath,
        attrs.iid,
        integration.apiBaseUrl,
      );
      if (mrCommits.success && mrCommits.shas) {
        for (const sha of mrCommits.shas) {
          if (!commitShas.includes(sha)) {
            commitShas.push(sha);
          }
        }
      }
    }
  }

  // Add head SHA if not present
  const headSha = attrs.last_commit?.id;
  if (headSha && !commitShas.includes(headSha)) {
    commitShas.push(headSha);
  }

  const mrRecord = existing
    ? await prisma.pullRequest.update({
        where: { id: existing.id },
        data: {
          title: attrs.title,
          url: attrs.url,
          state,
          author: payload.user.username,
          baseBranch: attrs.target_branch,
          headBranch: attrs.source_branch,
          commitShas: JSON.stringify(commitShas),
        },
      })
    : await prisma.pullRequest.create({
        data: {
          repoId,
          number: attrs.iid,
          title: attrs.title,
          url: attrs.url,
          state,
          author: payload.user.username,
          baseBranch: attrs.target_branch,
          headBranch: attrs.source_branch,
          commitShas: JSON.stringify(commitShas),
        },
      });

  // Post status check + comment to GitLab
  const repoForStatus = repo || await prisma.repo.findUnique({ where: { id: repoId } });
  if (repoForStatus && (action === 'open' || action === 'update' || action === 'reopen')) {
    const originBaseUrl = process.env.ORIGIN_WEB_URL || 'https://getorigin.io';
    try {
      await updateMRGitLabStatus(
        repoForStatus.orgId,
        repoId,
        attrs.iid,
        headSha,
        originBaseUrl,
      );
    } catch (err) {
      console.error('Failed to update GitLab MR status:', err);
    }
  }

  return {
    action,
    mrId: mrRecord.id,
    number: attrs.iid,
    state,
    commitShas: commitShas.length,
  };
}
