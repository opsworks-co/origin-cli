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

const AI_MODELS = ['claude-code', 'cursor', 'gemini-cli', 'aider', 'copilot'];
const SAMPLE_PROMPTS = [
  'Add user authentication with JWT tokens',
  'Fix the broken pagination on the users list',
  'Refactor the database layer to use connection pooling',
  'Add unit tests for the payment processing module',
  'Implement dark mode toggle in settings',
  'Fix memory leak in WebSocket handler',
  'Add CSV export functionality to reports',
  'Optimize the search query performance',
  'Add input validation to all API endpoints',
  'Implement rate limiting middleware',
];

function generateFakeTranscript(prompt: string, _model: string, files: string[]): Array<{ role: string; content: string }> {
  return [
    { role: 'human', content: prompt },
    { role: 'assistant', content: `I'll help you with that. Let me analyze the codebase first.\n\nLooking at the relevant files: ${files.join(', ')}` },
    { role: 'human', content: 'Go ahead and implement it.' },
    { role: 'assistant', content: `I've made the following changes:\n\n${files.map((f) => `- Modified \`${f}\` — updated the implementation`).join('\n')}\n\nThe changes include proper error handling and follow the existing code patterns. Want me to add tests for this?` },
    { role: 'human', content: 'Looks good, thanks!' },
  ];
}

function generateFakeFiles(): string[] {
  const allFiles = [
    'src/index.ts', 'src/app.ts', 'src/config.ts',
    'src/routes/auth.ts', 'src/routes/users.ts', 'src/routes/api.ts',
    'src/models/user.ts', 'src/models/session.ts',
    'src/middleware/auth.ts', 'src/middleware/validate.ts',
    'src/utils/helpers.ts', 'src/utils/logger.ts',
    'tests/auth.test.ts', 'tests/users.test.ts',
    'package.json', 'README.md',
  ];
  const count = Math.floor(Math.random() * 5) + 1;
  const shuffled = [...allFiles].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

type SessionCreate = {
  model: string;
  prompt: string;
  transcript: string;
  filesChanged: string;
  tokensUsed: number;
  toolCalls: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  costUsd: number;
};

type CommitCreate = {
  repoId: string;
  sha: string;
  message: string;
  author: string;
  committedAt: Date;
  session?: { create: SessionCreate };
};

function buildSimulatedCommit(
  repoId: string,
  sha: string,
  message: string,
  author: string,
  date: Date
): CommitCreate {
  const isAI = Math.random() > 0.4;
  const model = AI_MODELS[Math.floor(Math.random() * AI_MODELS.length)];
  const prompt = SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)];
  const files = generateFakeFiles();
  const transcript = generateFakeTranscript(prompt, model, files);
  const linesAdded = Math.floor(Math.random() * 500) + 10;
  const linesRemoved = Math.floor(Math.random() * 200) + 5;
  const tokensUsed = Math.floor(Math.random() * 50000) + 5000;
  const costUsd = parseFloat((tokensUsed * 0.000015).toFixed(4));

  const data: CommitCreate = {
    repoId,
    sha,
    message,
    author,
    committedAt: date,
  };

  if (isAI) {
    data.session = {
      create: {
        model,
        prompt,
        transcript: JSON.stringify(transcript),
        filesChanged: JSON.stringify(files),
        tokensUsed,
        toolCalls: Math.floor(Math.random() * 30) + 1,
        durationMs: Math.floor(Math.random() * 300000) + 10000,
        linesAdded,
        linesRemoved,
        costUsd,
      },
    };
  }

  return data;
}

// ─── Main entry point ──────────────────────────────────────────────────────

export async function syncCheckpoints(repo: { id: string; path: string; provider: string }) {
  if (repo.provider === 'github') {
    return syncGitHubRepo(repo);
  }
  return syncLocalRepo(repo);
}

// ─── GitHub sync ───────────────────────────────────────────────────────────

async function syncGitHubRepo(repo: { id: string; path: string }) {
  const parsed = parseGitHubUrl(repo.path);
  if (!parsed) {
    console.error(`Invalid GitHub URL: ${repo.path}`);
    return { synced: 0, total: 0 };
  }

  const { owner, repo: repoName } = parsed;
  console.log(`Syncing GitHub repo: ${owner}/${repoName}`);

  // 1. Check for .entire/ checkpoints
  const entireFiles = await fetchEntireCheckpoints(owner, repoName);

  if (entireFiles.length > 0) {
    return syncGitHubEntireDir(repo, entireFiles);
  }

  // 2. Fall back to commit history with simulated sessions
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
  repo: { id: string },
  owner: string,
  repoName: string
) {
  let commits;
  try {
    commits = await fetchGitHubCommits(owner, repoName, 50);
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

    const data = buildSimulatedCommit(
      repo.id,
      entry.sha,
      entry.message,
      entry.author,
      new Date(entry.date)
    );

    await prisma.commit.create({ data });
    synced++;
  }

  return { synced, total: commits.length };
}

// ─── Local sync ────────────────────────────────────────────────────────────

async function syncLocalRepo(repo: { id: string; path: string }) {
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

    const data = buildSimulatedCommit(
      repo.id,
      entry.hash,
      entry.message,
      entry.author_name,
      new Date(entry.date)
    );

    await prisma.commit.create({ data });
    synced++;
  }

  return { synced, total: log.all.length };
}
