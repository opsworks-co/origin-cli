import chalk from 'chalk';
import { execSync } from 'child_process';
import readline from 'readline';
import { getGitRoot, loadSessionState } from '../session-state.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface Checkpoint {
  index: number;
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
  filesChanged: string[];
  model?: string;
  sessionId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const execOpts = (cwd: string) => ({
  encoding: 'utf-8' as const,
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 10 * 1024 * 1024,
});

/**
 * Get checkpoints (commits) from the session's commit range.
 */
function getCheckpoints(repoPath: string, range: string): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  try {
    const log = execSync(
      `git log --format=%H%x00%h%x00%s%x00%an%x00%aI ${range}`,
      execOpts(repoPath),
    ).trim();

    if (!log) return checkpoints;

    const lines = log.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split('\0');
      if (parts.length < 5) continue;

      const [sha, shortSha, message, author, timestamp] = parts;

      // Get files changed
      let filesChanged: string[] = [];
      try {
        const files = execSync(
          `git diff-tree --no-commit-id --name-only -r ${sha}`,
          execOpts(repoPath),
        ).trim();
        filesChanged = files ? files.split('\n').filter(Boolean) : [];
      } catch { /* ignore */ }

      // Check for Origin note (model/session info)
      let model: string | undefined;
      let sessionId: string | undefined;
      try {
        const note = execSync(
          `git notes --ref=origin show ${sha}`,
          execOpts(repoPath),
        ).trim();
        const noteData = JSON.parse(note);
        model = noteData?.origin?.model || noteData?.model;
        sessionId = noteData?.origin?.sessionId || noteData?.sessionId;
      } catch { /* no note */ }

      checkpoints.push({
        index: i + 1,
        sha,
        shortSha,
        message,
        author,
        timestamp,
        filesChanged,
        model,
        sessionId,
      });
    }
  } catch { /* ignore */ }

  return checkpoints;
}

/**
 * Prompt user for confirmation via readline.
 */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

/**
 * Prompt user to select a checkpoint by number.
 */
function selectCheckpoint(prompt: string): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      resolve(isNaN(num) ? null : num);
    });
  });
}

// ─── Command ──────────────────────────────────────────────────────────────

/**
 * origin rewind [--to <sha>]
 *
 * Lists checkpoints (commits from the session) with timestamp, files, model.
 * --to restores the working directory to a specific commit.
 * Safety: git stash first, confirmation required.
 */
export async function rewindCommand(
  opts?: { to?: string },
): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.error(chalk.red('Error: Not in a git repository.'));
    return;
  }

  // Determine commit range from session state or use last 20 commits
  const state = loadSessionState(cwd);
  let range: string;
  if (state?.headShaAtStart) {
    range = `${state.headShaAtStart}..HEAD`;
  } else {
    range = 'HEAD~20..HEAD';
  }

  const checkpoints = getCheckpoints(repoPath, range);
  if (checkpoints.length === 0) {
    console.log(chalk.gray('No checkpoints found in this range.'));
    return;
  }

  // If --to is specified, restore to that commit
  if (opts?.to) {
    const targetSha = opts.to;

    // Verify the SHA exists
    try {
      execSync(`git cat-file -e ${targetSha}^{commit}`, execOpts(repoPath));
    } catch {
      console.error(chalk.red(`Error: Commit ${targetSha} not found.`));
      return;
    }

    // Safety: stash any uncommitted changes
    let hasStashed = false;
    try {
      const status = execSync('git status --porcelain', execOpts(repoPath)).trim();
      if (status) {
        console.log(chalk.yellow('Stashing uncommitted changes...'));
        execSync('git stash push -m "origin-rewind-backup"', execOpts(repoPath));
        hasStashed = true;
      }
    } catch { /* ignore */ }

    // Ask for confirmation
    const targetCheckpoint = checkpoints.find(c => c.sha === targetSha || c.shortSha === targetSha);
    const desc = targetCheckpoint
      ? `${targetCheckpoint.shortSha} — "${targetCheckpoint.message}"`
      : targetSha.slice(0, 8);

    const confirmed = await confirm(
      chalk.yellow(`\nRewind to ${desc}? This will reset your working directory. [y/N] `),
    );

    if (!confirmed) {
      console.log(chalk.gray('Cancelled.'));
      if (hasStashed) {
        console.log(chalk.gray('Restoring stashed changes...'));
        try {
          execSync('git stash pop', execOpts(repoPath));
        } catch { /* ignore */ }
      }
      return;
    }

    try {
      execSync(`git checkout ${targetSha} -- .`, execOpts(repoPath));
      console.log(chalk.green(`Rewound to ${desc}.`));
      if (hasStashed) {
        console.log(chalk.gray(`Your uncommitted changes are stashed. Run "git stash pop" to restore them.`));
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      if (hasStashed) {
        console.log(chalk.gray('Restoring stashed changes...'));
        try {
          execSync('git stash pop', execOpts(repoPath));
        } catch { /* ignore */ }
      }
    }
    return;
  }

  // No --to: show interactive checkpoint list
  console.log(chalk.bold('\n  Session Checkpoints\n'));
  console.log(chalk.gray(`  Range: ${range}\n`));

  for (const cp of checkpoints) {
    const date = new Date(cp.timestamp).toLocaleString();
    const modelStr = cp.model ? chalk.cyan(` [${cp.model}]`) : '';
    const fileCount = cp.filesChanged.length;
    const fileStr = fileCount > 0 ? chalk.gray(` (${fileCount} file${fileCount === 1 ? '' : 's'})`) : '';

    console.log(
      `  ${chalk.white(String(cp.index).padStart(3))}. ${chalk.yellow(cp.shortSha)} ${chalk.white(cp.message.slice(0, 60))}${modelStr}`,
    );
    console.log(
      `       ${chalk.gray(date)}${fileStr}`,
    );

    // Show first few files
    if (cp.filesChanged.length > 0) {
      const shown = cp.filesChanged.slice(0, 3);
      for (const f of shown) {
        console.log(chalk.gray(`         ${f}`));
      }
      if (cp.filesChanged.length > 3) {
        console.log(chalk.gray(`         ... +${cp.filesChanged.length - 3} more`));
      }
    }
    console.log('');
  }

  // Prompt for selection
  const selection = await selectCheckpoint(
    chalk.white('  Enter checkpoint number to rewind to (or press Enter to cancel): '),
  );

  if (selection === null || selection < 1 || selection > checkpoints.length) {
    console.log(chalk.gray('  Cancelled.'));
    return;
  }

  const selected = checkpoints[selection - 1];

  // Re-run with --to
  await rewindCommand({ to: selected.sha });
}
