import fs from 'fs';
import path from 'path';
import { prisma } from '../db.js';
import { simpleGit } from 'simple-git';
import {
  parseGitHubUrl,
  fetchGitHubCommits,
  fetchEntireCheckpoints,
  fetchFileContent,
} from './github.js';
import { getIntegrationConfig } from './github-integration.js';
import { detectAITool } from './ai-commit-detector.js';

interface Checkpoint {
  commitSha: string;
  message: string;
  author: string;
  committedAt: string;
  model: string;
  prompt: string;
  transcript: Array<{ role: string; content: string }>;
  filesChanged: string[];
  tokensUsed: number;
  toolCalls: number;
  durationMs: number;
  linesAdded?: number;
  linesRemoved?: number;
  costUsd?: number;
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function syncCheckpoints(repo: { id: string; path: string; provider: string; orgId: string }) {
  if (repo.provider === 'github') {
    return syncGitHubRepo(repo);
  }
  return syncLocalRepo(repo);
}

// ─── GitHub sync ───────────────────────────────────────────────────────────

async function syncGitHubRepo(repo: { id: string; path: string; orgId: string }) {
  const parsed = parseGitHubUrl(repo.path);
  if (!parsed) {
    console.error(`Invalid GitHub URL: ${repo.path}`);
    return { synced: 0, total: 0 };
  }

  const { owner, repo: repoName } = parsed;
  console.log(`Syncing GitHub repo: ${owner}/${repoName}`);

  // 1. Check for .entire/ checkpoints (real session data from Entire CLI)
  const entireFiles = await fetchEntireCheckpoints(owner, repoName);
  if (entireFiles.length > 0) {
    return syncGitHubEntireDir(repo, entireFiles);
  }

  // 2. Fetch real commit history (no fake sessions)
  return syncGitHubCommits(repo, owner, repoName);
}

async function syncGitHubEntireDir(
  repo: { id: string },
  files: Array<{ name: string; download_url: string | null }>
) {
  let synced = 0;
  for (const file of files) {
    if (!file.download_url) continue;
    try {
      const raw = await fetchFileContent(file.download_url);
      const checkpoint: Checkpoint = JSON.parse(raw);

      const existing = await prisma.commit.findFirst({
        where: { repoId: repo.id, sha: checkpoint.commitSha },
      });
      if (existing) continue;

      await prisma.commit.create({
        data: {
          repoId: repo.id,
          sha: checkpoint.commitSha,
          message: checkpoint.message,
          author: checkpoint.author,
          aiToolDetected: checkpoint.model,
          aiDetectionMethod: 'session',
          committedAt: new Date(checkpoint.committedAt),
          session: {
            create: {
              model: checkpoint.model,
              prompt: checkpoint.prompt,
              transcript: JSON.stringify(checkpoint.transcript),
              filesChanged: JSON.stringify(checkpoint.filesChanged),
              tokensUsed: checkpoint.tokensUsed,
              toolCalls: checkpoint.toolCalls,
              durationMs: checkpoint.durationMs,
              linesAdded: checkpoint.linesAdded ?? 0,
              linesRemoved: checkpoint.linesRemoved ?? 0,
              costUsd: checkpoint.costUsd ?? 0,
            },
          },
        },
      });
      synced++;
    } catch (err) {
      console.error(`Failed to process checkpoint ${file.name}:`, err);
    }
  }
  return { synced, total: files.length };
}

async function syncGitHubCommits(
  repo: { id: string; orgId: string },
  owner: string,
  repoName: string
) {
  // Try using the org's GitHub token first for private repos
  let commits;
  try {
    const integration = await getIntegrationConfig(repo.orgId, 'github');
    if (integration?.token) {
      // Use the org's token to fetch commits (works for private repos)
      const res = await fetch(
        `${integration.apiBaseUrl || 'https://api.github.com'}/repos/${owner}/${repoName}/commits?per_page=50`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${integration.token}`,
            'User-Agent': 'Origin-App',
          },
        }
      );
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data = await res.json();
      commits = data.map((c: any) => ({
        sha: c.sha,
        message: c.commit?.message || '',
        author: c.commit?.author?.name || 'unknown',
        date: c.commit?.author?.date || new Date().toISOString(),
      }));
    } else {
      // Fallback to public API (no token)
      commits = await fetchGitHubCommits(owner, repoName, 50);
    }
  } catch (err) {
    console.error(`Failed to fetch commits from GitHub:`, err);
    return { synced: 0, total: 0 };
  }

  let synced = 0;
  for (const entry of commits) {
    const existing = await prisma.commit.findFirst({
      where: { repoId: repo.id, sha: entry.sha },
    });
    if (existing) continue;

    // Create commit record with AI detection
    const detection = detectAITool(entry.message, entry.author);
    await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: entry.sha,
        message: entry.message,
        author: entry.author,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(entry.date),
      },
    });
    synced++;
  }

  return { synced, total: commits.length };
}

// ─── Local sync ────────────────────────────────────────────────────────────

async function syncLocalRepo(repo: { id: string; path: string }) {
  // Check if the local path exists before attempting sync
  if (!fs.existsSync(repo.path)) {
    console.warn(`Local repo path does not exist: ${repo.path} — skipping sync`);
    return { synced: 0, total: 0 };
  }

  const entireDir = path.join(repo.path, '.entire');
  const hasEntire = fs.existsSync(entireDir);

  if (hasEntire) {
    return syncFromEntireDir(repo, entireDir);
  }
  return syncFromGitLog(repo);
}

async function syncFromEntireDir(repo: { id: string; path: string }, entireDir: string) {
  let synced = 0;
  const files = fs.readdirSync(entireDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entireDir, file), 'utf-8');
      const checkpoint: Checkpoint = JSON.parse(raw);

      const existing = await prisma.commit.findFirst({
        where: { repoId: repo.id, sha: checkpoint.commitSha },
      });
      if (existing) continue;

      await prisma.commit.create({
        data: {
          repoId: repo.id,
          sha: checkpoint.commitSha,
          message: checkpoint.message,
          author: checkpoint.author,
          aiToolDetected: checkpoint.model,
          aiDetectionMethod: 'session',
          committedAt: new Date(checkpoint.committedAt),
          session: {
            create: {
              model: checkpoint.model,
              prompt: checkpoint.prompt,
              transcript: JSON.stringify(checkpoint.transcript),
              filesChanged: JSON.stringify(checkpoint.filesChanged),
              tokensUsed: checkpoint.tokensUsed,
              toolCalls: checkpoint.toolCalls,
              durationMs: checkpoint.durationMs,
              linesAdded: checkpoint.linesAdded ?? 0,
              linesRemoved: checkpoint.linesRemoved ?? 0,
              costUsd: checkpoint.costUsd ?? 0,
            },
          },
        },
      });
      synced++;
    } catch {
      // skip malformed checkpoints
    }
  }
  return { synced, total: files.length };
}

async function syncFromGitLog(repo: { id: string; path: string }) {
  const git = simpleGit(repo.path);
  let log;
  try {
    log = await git.log({ maxCount: 50 });
  } catch {
    return { synced: 0, total: 0 };
  }

  let synced = 0;
  for (const entry of log.all) {
    const existing = await prisma.commit.findFirst({
      where: { repoId: repo.id, sha: entry.hash },
    });
    if (existing) continue;

    // Concatenate first line + body for full message (simple-git splits them)
    const fullMessage = (entry as any).body
      ? `${entry.message}\n\n${(entry as any).body}`
      : entry.message;

    // Create commit record with AI detection
    const detection = detectAITool(fullMessage, entry.author_name);
    await prisma.commit.create({
      data: {
        repoId: repo.id,
        sha: entry.hash,
        message: fullMessage,
        author: entry.author_name,
        aiToolDetected: detection.aiToolDetected,
        aiDetectionMethod: detection.aiDetectionMethod,
        committedAt: new Date(entry.date),
      },
    });
    synced++;
  }

  return { synced, total: log.all.length };
}
