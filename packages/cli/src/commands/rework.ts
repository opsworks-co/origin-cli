import chalk from 'chalk';
import { gitDetailed } from '../utils/exec.js';
import { isAiCommit } from '../attribution.js';
import { getGitRoot } from '../session-state.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;

// ─── Types ────────────────────────────────────────────────────────────────

interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

interface ReworkEntry {
  file: string;
  aiAgent: string;
  reworkCount: number;
  churnPercent: number;
  aiCommitSha: string;
}

// ─── Git Helpers ──────────────────────────────────────────────────────────

const gitOpts = (cwd: string) => ({
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});

function getCommitsInRange(repoPath: string, days: number): CommitInfo[] {
  if (!Number.isInteger(days) || days <= 0 || days > 10000) return [];
  const r = gitDetailed(
    ['log', `--since=${days} days ago`, '--format=%H %ae %ai %s'],
    gitOpts(repoPath),
  );
  if (r.status !== 0) return [];
  const output = r.stdout.trim();
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.match(/^([0-9a-f]+)\s+(\S+)\s+(\S+\s\S+\s\S+)\s+(.*)$/);
    if (!parts) return null;
    return { sha: parts[1], author: parts[2], date: parts[3], subject: parts[4] };
  }).filter(Boolean) as CommitInfo[];
}

function getCommitFiles(repoPath: string, sha: string): string[] {
  if (!HEX.test(sha)) return [];
  const r = gitDetailed(
    ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
    gitOpts(repoPath),
  );
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean);
}

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  if (!HEX.test(sha)) return null;
  const r = gitDetailed(['notes', '--ref=origin', 'show', sha], gitOpts(repoPath));
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

function detectAgentName(repoPath: string, sha: string): string {
  const rawNote = readOriginNote(repoPath, sha);
  const note = rawNote?.origin || rawNote;

  // Try model from note
  if (note?.model) {
    const m = note.model.toLowerCase();
    if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'Claude';
    if (m.includes('gemini') || m.includes('gemma')) return 'Gemini';
    if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'GPT';
    if (m.includes('codex')) return 'Codex';
    if (m.includes('copilot')) return 'Copilot';
    if (m.includes('windsurf')) return 'Windsurf';
    if (m.includes('aider')) return 'Aider';
    if (m.includes('cursor')) return 'Cursor';
    return note.model;
  }

  // Try agent from note
  if (note?.agent) return note.agent;

  // Fallback: check commit message
  if (HEX.test(sha)) {
    const r = gitDetailed(['log', '-1', '--format=%B', sha], gitOpts(repoPath));
    if (r.status === 0) {
      const message = r.stdout.trim();
      const lower = message.toLowerCase();
      if (lower.includes('claude')) return 'Claude';
      if (lower.includes('gemini')) return 'Gemini';
      if (lower.includes('codex') || message.trim() === '-') return 'Codex';
      if (lower.includes('cursor')) return 'Cursor';
      if (lower.includes('copilot')) return 'Copilot';
    }
  }

  return 'AI';
}

function countAiLinesInCommit(repoPath: string, sha: string, file: string): number {
  if (!HEX.test(sha)) return 0;
  const r = gitDetailed(
    ['diff-tree', '-p', sha, '--', file],
    gitOpts(repoPath),
  );
  if (r.status !== 0) return 0;
  const diff = r.stdout.trim();
  let added = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    }
  }
  return added;
}

function countChangedLines(repoPath: string, aiSha: string, laterSha: string, file: string): number {
  if (!HEX.test(aiSha) || !HEX.test(laterSha)) return 0;
  const r = gitDetailed(
    ['diff', aiSha, laterSha, '--', file],
    gitOpts(repoPath),
  );
  if (r.status !== 0) return 0;
  const diff = r.stdout.trim();
  if (!diff) return 0;
  let changed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changed++;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      changed++;
    }
  }
  return changed;
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function reworkCommand(opts: { days?: string; limit?: string }) {
  const repoPath = getGitRoot(process.cwd());
  if (!repoPath) {
    console.error(chalk.red('Not a git repository.'));
    process.exit(1);
  }

  const days = parseInt(opts.days || '7', 10);
  const limit = parseInt(opts.limit || '20', 10);

  const commits = getCommitsInRange(repoPath, days);
  if (commits.length === 0) {
    console.log(chalk.gray(`No commits found in the last ${days} days.`));
    return;
  }

  // Identify AI commits and their files
  const aiCommits: Array<CommitInfo & { files: string[]; agent: string }> = [];
  for (const commit of commits) {
    if (isAiCommit(repoPath, commit.sha)) {
      const files = getCommitFiles(repoPath, commit.sha);
      const agent = detectAgentName(repoPath, commit.sha);
      aiCommits.push({ ...commit, files, agent });
    }
  }

  if (aiCommits.length === 0) {
    console.log(chalk.gray(`No AI commits found in the last ${days} days.`));
    return;
  }

  // For each AI commit's files, check if a different commit modified the same file later
  const reworkMap = new Map<string, ReworkEntry>(); // file -> rework data

  for (const aiCommit of aiCommits) {
    for (const file of aiCommit.files) {
      // Find later commits that touch the same file
      const laterCommits = commits.filter(c =>
        c.sha !== aiCommit.sha &&
        new Date(c.date) > new Date(aiCommit.date) &&
        getCommitFiles(repoPath, c.sha).includes(file)
      );

      if (laterCommits.length === 0) continue;

      const aiLines = countAiLinesInCommit(repoPath, aiCommit.sha, file);
      if (aiLines === 0) continue;

      // Use the latest later commit for churn calculation
      const latestLater = laterCommits[laterCommits.length - 1];
      const changedLines = countChangedLines(repoPath, aiCommit.sha, latestLater.sha, file);
      const churn = Math.min(100, Math.round((changedLines / (aiLines * 2)) * 100));

      const key = file;
      const existing = reworkMap.get(key);
      if (existing) {
        existing.reworkCount += laterCommits.length;
        existing.churnPercent = Math.max(existing.churnPercent, churn);
      } else {
        reworkMap.set(key, {
          file,
          aiAgent: aiCommit.agent,
          reworkCount: laterCommits.length,
          churnPercent: churn,
          aiCommitSha: aiCommit.sha,
        });
      }
    }
  }

  // Sort by churn descending and limit
  const entries = Array.from(reworkMap.values())
    .sort((a, b) => b.churnPercent - a.churnPercent)
    .slice(0, limit);

  // Output
  console.log(`\n${chalk.bold(`Rework Hotspots`)} ${chalk.gray(`\u2014 last ${days} days`)}\n`);

  if (entries.length === 0) {
    console.log(chalk.green('  No rework detected — AI code held up well!'));
  } else {
    // Table header
    const colFile = 30;
    const colAgent = 12;
    const colRework = 12;
    const colChurn = 8;

    console.log(
      '  ' +
      chalk.gray('File'.padEnd(colFile)) +
      chalk.gray('AI Agent'.padEnd(colAgent)) +
      chalk.gray('Reworked'.padEnd(colRework)) +
      chalk.gray('Churn')
    );

    for (const entry of entries) {
      const fileName = entry.file.length > colFile - 2
        ? '...' + entry.file.slice(-(colFile - 5))
        : entry.file;

      const reworkStr = entry.reworkCount === 1
        ? '1 time'
        : `${entry.reworkCount} times`;

      const churnColor = entry.churnPercent >= 70
        ? chalk.red
        : entry.churnPercent >= 40
          ? chalk.yellow
          : chalk.green;

      console.log(
        '  ' +
        chalk.white(fileName.padEnd(colFile)) +
        chalk.cyan(entry.aiAgent.padEnd(colAgent)) +
        chalk.white(reworkStr.padEnd(colRework)) +
        churnColor(`${entry.churnPercent}%`)
      );
    }
  }

  // Summary
  const reworkedCount = entries.length;
  const totalAi = aiCommits.length;
  const reworkRate = totalAi > 0 ? Math.round((reworkedCount / totalAi) * 100) : 0;
  const avgChurn = entries.length > 0
    ? Math.round(entries.reduce((sum, e) => sum + e.churnPercent, 0) / entries.length)
    : 0;

  console.log(
    `\n${chalk.gray('Summary:')} ${totalAi} AI commits, ${reworkedCount} had rework (${reworkRate}% rework rate)`
  );
  if (entries.length > 0) {
    console.log(
      `${chalk.gray('Avg churn:')} ${avgChurn}% of AI lines modified within ${days} days`
    );
  }
  console.log();
}
