import chalk from 'chalk';
import readline from 'readline';
import { getGitRoot, loadSessionState } from '../session-state.js';
import { git, gitDetailed } from '../utils/exec.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_REF = /^[a-zA-Z0-9_./~^-]+$/;

// ─── Types ────────────────────────────────────────────────────────────────

interface Snapshot {
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

const gitOpts = (cwd: string) => ({
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});

/**
 * Get snapshots (commits) from the session's commit range.
 */
function getSnapshots(repoPath: string, range: string): Snapshot[] {
  const snapshots: Snapshot[] = [];
  try {
    // Validate range: allow "a..b", "a..HEAD", "HEAD~50..HEAD", or a single ref
    const parts = range.split('..');
    for (const p of parts) {
      if (!p) continue;
      if (!HEX.test(p) && !SAFE_REF.test(p)) return snapshots;
    }
    const log = git(
      ['log', '--format=%H%x00%h%x00%s%x00%an%x00%aI', range],
      gitOpts(repoPath),
    ).trim();

    if (!log) return snapshots;

    const lines = log.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split('\0');
      if (parts.length < 5) continue;

      const [sha, shortSha, message, author, timestamp] = parts;

      // Get files changed
      let filesChanged: string[] = [];
      if (HEX.test(sha)) {
        try {
          const files = git(
            ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
            gitOpts(repoPath),
          ).trim();
          filesChanged = files ? files.split('\n').filter(Boolean) : [];
        } catch { /* ignore */ }
      }

      // Check for Origin note (model/session info)
      let model: string | undefined;
      let sessionId: string | undefined;
      if (HEX.test(sha)) {
        const r = gitDetailed(['notes', '--ref=origin', 'show', sha], gitOpts(repoPath));
        if (r.status === 0) {
          try {
            const noteData = JSON.parse(r.stdout.trim());
            model = noteData?.origin?.model || noteData?.model;
            sessionId = noteData?.origin?.sessionId || noteData?.sessionId;
          } catch { /* ignore */ }
        }
      }
      snapshots.push({
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

  return snapshots;
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
 * Prompt user to select a snapshot by number.
 */
function selectSnapshot(prompt: string): Promise<number | null> {
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
 * Lists snapshots (commits from the session) with timestamp, files, model.
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

  // Determine commit range from session state or scan recent commits
  const state = loadSessionState(cwd);
  let range: string;
  if (state?.headShaAtStart) {
    range = `${state.headShaAtStart}..HEAD`;
  } else {
    // No active session — scan last 50 commits for any with Origin notes
    range = 'HEAD~50..HEAD';
  }

  let snapshots = getSnapshots(repoPath, range);

  // Filter to only AI snapshots (commits with Origin notes) unless in active session
  if (!state?.headShaAtStart) {
    snapshots = snapshots.filter(c => c.sessionId || c.model);
  }

  if (snapshots.length === 0) {
    console.log(chalk.gray('No snapshots found. AI commits are automatically tracked as snapshots.'));
    console.log(chalk.gray('Run an AI session and make commits — they\'ll appear here.'));
    return;
  }

  // If --to is specified, restore to that commit
  if (opts?.to) {
    const targetSha = opts.to;

    // Verify the SHA exists
    if (!HEX.test(targetSha) && !SAFE_REF.test(targetSha)) {
      console.error(chalk.red(`Error: Invalid commit: ${targetSha}`));
      return;
    }
    {
      const r = gitDetailed(['cat-file', '-e', `${targetSha}^{commit}`], gitOpts(repoPath));
      if (r.status !== 0) {
        console.error(chalk.red(`Error: Commit ${targetSha} not found.`));
        return;
      }
    }

    // Safety: stash any uncommitted changes
    let hasStashed = false;
    try {
      const status = git(['status', '--porcelain'], gitOpts(repoPath)).trim();
      if (status) {
        console.log(chalk.yellow('Stashing uncommitted changes...'));
        git(['stash', 'push', '-m', 'origin-rewind-backup'], gitOpts(repoPath));
        hasStashed = true;
      }
    } catch { /* ignore */ }

    // Ask for confirmation
    const targetSnapshot = snapshots.find(c => c.sha === targetSha || c.shortSha === targetSha);
    const desc = targetSnapshot
      ? `${targetSnapshot.shortSha} — "${targetSnapshot.message}"`
      : targetSha.slice(0, 8);

    const confirmed = await confirm(
      chalk.yellow(`\nRewind to ${desc}? This will reset your working directory. [y/N] `),
    );

    if (!confirmed) {
      console.log(chalk.gray('Cancelled.'));
      if (hasStashed) {
        console.log(chalk.gray('Restoring stashed changes...'));
        try {
          git(['stash', 'pop'], gitOpts(repoPath));
        } catch { /* ignore */ }
      }
      return;
    }

    try {
      git(['checkout', targetSha, '--', '.'], gitOpts(repoPath));
      console.log(chalk.green(`Rewound to ${desc}.`));
      if (hasStashed) {
        console.log(chalk.gray(`Your uncommitted changes are stashed. Run "git stash pop" to restore them.`));
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      if (hasStashed) {
        console.log(chalk.gray('Restoring stashed changes...'));
        try {
          git(['stash', 'pop'], gitOpts(repoPath));
        } catch { /* ignore */ }
      }
    }
    return;
  }

  // No --to: show interactive snapshot list
  console.log(chalk.bold('\n  Session Snapshots\n'));
  console.log(chalk.gray(`  Range: ${range}\n`));

  for (const cp of snapshots) {
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
  const selection = await selectSnapshot(
    chalk.white('  Enter snapshot number to rewind to (or press Enter to cancel): '),
  );

  if (selection === null || selection < 1 || selection > snapshots.length) {
    console.log(chalk.gray('  Cancelled.'));
    return;
  }

  const selected = snapshots[selection - 1];

  // Re-run with --to
  await rewindCommand({ to: selected.sha });
}
