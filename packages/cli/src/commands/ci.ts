import chalk from 'chalk';
import { execSync } from 'child_process';
import { getGitRoot, getHeadSha } from '../session-state.js';
import {
  generateCIReport,
  formatCIReport,
  collectSquashMergeAttribution,
  writeCombinedNote,
  generateGitHubActionsWorkflow,
} from '../ci-integration.js';

/**
 * `origin ci check` — Report attribution statistics for CI output.
 * Walks recent commits and reports AI vs human attribution.
 */
export async function ciCheckCommand(opts: { range?: string }): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const report = generateCIReport(repoPath, opts.range);
  const formatted = formatCIReport(report);

  // Output plain text for CI parsing
  console.log(formatted);

  // Exit with non-zero if configured thresholds are exceeded
  // (Future: make thresholds configurable via .origin.json)
}

/**
 * `origin ci squash-merge <base-branch>` — Collect attribution from all commits
 * being squashed and write a combined note to the merge commit.
 */
export async function ciSquashMergeCommand(baseBranch: string): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  console.log(chalk.bold(`\nCollecting attribution from commits since ${baseBranch}...\n`));

  const result = collectSquashMergeAttribution(repoPath, baseBranch);

  if (!result.success) {
    console.error(chalk.red(`  ${result.message}`));
    process.exit(1);
  }

  console.log(chalk.gray(`  ${result.message}`));

  if (result.combinedNote) {
    // Write the combined note to HEAD (the squash merge commit)
    const headSha = getHeadSha();
    if (headSha) {
      const written = writeCombinedNote(repoPath, headSha, result.combinedNote);
      if (written) {
        console.log(chalk.green(`\n  Combined attribution note written to ${headSha.slice(0, 8)}`));
      } else {
        console.log(chalk.yellow(`\n  Warning: Could not write combined note to ${headSha.slice(0, 8)}`));
      }
    } else {
      console.log(chalk.yellow('\n  Warning: Could not determine HEAD SHA.'));
      console.log(chalk.gray('  Combined note:'));
      console.log(chalk.gray('  ' + result.combinedNote.split('\n').join('\n  ')));
    }
  }
}

/**
 * `origin ci generate-workflow` — Output a GitHub Actions YAML snippet
 * for integrating Origin attribution checks into CI.
 */
export async function ciGenerateWorkflowCommand(): Promise<void> {
  const workflow = generateGitHubActionsWorkflow();

  console.log(chalk.bold('\nGitHub Actions Workflow for Origin CI Integration:\n'));
  console.log(chalk.gray('Save this as .github/workflows/origin-attribution.yml\n'));
  console.log(workflow);
  console.log(chalk.gray('\nRequired secrets:'));
  console.log(chalk.gray('  ORIGIN_API_KEY — Your Origin API key (from `origin login`)'));
}

// ─── Tamper Detection: Session-Required Check ────────────────────────────

interface SessionCheckResult {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  hasSession: boolean;
  sessionId?: string;
  agent?: string;
  model?: string;
}

/**
 * `origin ci session-check` — Verify every commit on the current branch
 * has a linked Origin session (via git notes).
 *
 * Exit code 1 if any commit lacks a session note, unless --warn-only.
 */
export async function ciSessionCheckCommand(opts: {
  since?: string;
  warnOnly?: boolean;
  json?: boolean;
}): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const execOpts = {
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 30000,
    encoding: 'utf-8' as const,
  };

  // Determine the base: --since flag, or auto-detect branch point from main/master
  let base = opts.since || '';
  if (!base) {
    // Find the merge base with main or master
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        execSync(`git rev-parse --verify ${candidate}`, { ...execOpts, stdio: 'pipe' });
        base = execSync(`git merge-base ${candidate} HEAD`, { ...execOpts, stdio: 'pipe' }).toString().trim();
        break;
      } catch {
        // branch doesn't exist, try next
      }
    }
    if (!base) {
      // Fallback: check last 20 commits
      base = execSync('git rev-list --max-parents=0 HEAD | head -1', execOpts).toString().trim();
    }
  }

  // Get commits from base to HEAD
  let commitLog: string;
  try {
    commitLog = execSync(
      `git log --format="%H|%h|%s|%an" ${base}..HEAD`,
      execOpts,
    ).toString().trim();
  } catch {
    console.error(chalk.red('Failed to read git log.'));
    process.exit(1);
  }

  if (!commitLog) {
    console.log(chalk.green('No commits to check (branch is up to date with base).'));
    process.exit(0);
  }

  const commits = commitLog.split('\n').filter(Boolean);
  const results: SessionCheckResult[] = [];
  let failures = 0;

  // Fetch origin notes ref so git notes show works
  try {
    execSync('git fetch origin refs/notes/origin:refs/notes/origin 2>/dev/null', { ...execOpts, stdio: 'pipe' });
  } catch {
    // Notes ref may not exist on remote yet
  }

  for (const line of commits) {
    const [sha, shortSha, message, author] = line.split('|');
    const result: SessionCheckResult = { sha, shortSha, message, author, hasSession: false };

    try {
      const noteRaw = execSync(
        `git notes --ref=origin show ${sha} 2>/dev/null`,
        { ...execOpts, stdio: 'pipe' },
      ).toString().trim();

      const note = JSON.parse(noteRaw);
      if (note?.origin?.sessionId) {
        result.hasSession = true;
        result.sessionId = note.origin.sessionId;
        result.agent = note.origin.agent;
        result.model = note.origin.model;
      }
    } catch {
      // No note found — commit has no session
    }

    if (!result.hasSession) {
      failures++;
    }
    results.push(result);
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify({ commits: results, total: results.length, untracked: failures }, null, 2));
  } else {
    console.log(chalk.bold(`\nOrigin Session Check — ${results.length} commits\n`));

    for (const r of results) {
      if (r.hasSession) {
        console.log(
          chalk.green('  ✓ ') +
          chalk.gray(r.shortSha) + ' ' +
          r.message.slice(0, 60) +
          chalk.gray(` (${r.agent || r.model || 'origin'})`)
        );
      } else {
        console.log(
          chalk.red('  ✗ ') +
          chalk.white(r.shortSha) + ' ' +
          r.message.slice(0, 60) +
          chalk.red(' — no Origin session')
        );
      }
    }

    console.log('');
    if (failures > 0) {
      const msg = `${failures}/${results.length} commit(s) have no linked Origin session.`;
      if (opts.warnOnly) {
        console.log(chalk.yellow('  ⚠ ' + msg));
        console.log(chalk.gray('  (--warn-only: exiting with code 0)\n'));
      } else {
        console.log(chalk.red('  ✗ ' + msg));
        console.log(chalk.gray('  AI governance policy requires all commits to have a tracked session.'));
        console.log(chalk.gray('  Use --warn-only to make this non-blocking.\n'));
      }
    } else {
      console.log(chalk.green(`  ✓ All ${results.length} commits have Origin sessions.\n`));
    }
  }

  // Exit code
  if (failures > 0 && !opts.warnOnly) {
    process.exit(1);
  }
}
