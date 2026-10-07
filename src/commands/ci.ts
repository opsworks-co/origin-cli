import chalk from 'chalk';
import { git, gitDetailed, runDetailed } from '../utils/exec.js';
import { getGitRoot } from '../session-state.js';

const HEX = /^[a-fA-F0-9]{4,64}$/;
const SAFE_REF = /^[a-zA-Z0-9_./~^-]+$/;
import {
  generateCIReport,
  formatCIReport,
  squashMergeAttribution,
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
 * `origin ci squash-merge --range <base-before-merge>..<source-tip> --target <squash-sha>`
 * — carry the attribution of a squashed pull request's original commits to the
 * squash commit. Both ends are explicit: after the merge HEAD is the squash
 * commit, so `<base>..HEAD` no longer names the original commits, and guessing
 * would write an empty or somebody else's note.
 */
export async function ciSquashMergeCommand(
  baseBranch: string | undefined,
  opts: { range?: string; target?: string; skipUnlessSquash?: boolean; warnOnly?: boolean } = {},
): Promise<void> {
  const repoPath = getGitRoot();
  if (!repoPath) {
    console.error(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  if (!opts.range || !opts.target || baseBranch) {
    console.error(chalk.red('  origin ci squash-merge needs the original commits and the squash commit:'));
    console.error(chalk.red('    origin ci squash-merge --range <base-before-merge>..<source-tip> --target <squash-sha>'));
    if (baseBranch) {
      console.error(chalk.gray(`  "${baseBranch}" alone is ambiguous: after a squash merge <base>..HEAD holds no original commits.`));
    }
    process.exit(1);
  }

  console.log(chalk.bold(`\nCarrying attribution from ${opts.range} to ${opts.target}...\n`));
  const result = squashMergeAttribution(repoPath, { range: opts.range, target: opts.target, skipUnlessSquash: opts.skipUnlessSquash });
  for (const w of result.warnings || []) {
    console.log(chalk.gray(`  note: ${w.code}${w.sha ? ` ${w.sha.slice(0, 12)}` : ''}${w.sessionId ? ` session ${w.sessionId}` : ''} — ${w.detail}`));
  }
  if (!result.success) {
    // --warn-only (post-merge automation): the repository could not carry the
    // attribution this time. Say so loudly, write nothing, do not fail the
    // merged pull request. A wrong invocation is never masked.
    if (opts.warnOnly && result.failure === 'operational') {
      console.warn(chalk.yellow(`  warning: attribution was not carried (--warn-only): ${result.message}`));
      return;
    }
    console.error(chalk.red(`  ${result.message}`));
    process.exit(1);
  }
  console.log(result.outcome === 'written' ? chalk.green(`  ${result.message}`) : chalk.gray(`  ${result.message}`));
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

  const gitOpts = { cwd: repoPath, timeoutMs: 30000 };

  // Determine the base: --since flag, or auto-detect branch point from main/master
  let base = opts.since || '';
  if (base && !SAFE_REF.test(base) && !HEX.test(base)) {
    console.error(chalk.red(`Invalid --since value: ${base}`));
    process.exit(1);
  }
  if (!base) {
    // Find the merge base with main or master
    for (const candidate of ['main', 'master', 'develop']) {
      const verify = gitDetailed(['rev-parse', '--verify', candidate], gitOpts);
      if (verify.status === 0) {
        const mb = gitDetailed(['merge-base', candidate, 'HEAD'], gitOpts);
        if (mb.status === 0) {
          base = mb.stdout.trim();
          break;
        }
      }
    }
    if (!base) {
      // Fallback: root commit
      const r = gitDetailed(['rev-list', '--max-parents=0', 'HEAD'], gitOpts);
      if (r.status === 0) {
        base = r.stdout.trim().split('\n')[0] || '';
      }
    }
  }

  // Get commits from base to HEAD
  let commitLog: string;
  try {
    if (!base || (!HEX.test(base) && !SAFE_REF.test(base))) throw new Error('invalid base');
    commitLog = git(
      ['log', '--format=%H|%h|%s|%an', `${base}..HEAD`],
      gitOpts,
    ).trim();
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
  gitDetailed(['fetch', 'origin', 'refs/notes/origin:refs/notes/origin'], gitOpts);

  for (const line of commits) {
    const [sha, shortSha, message, author] = line.split('|');
    const result: SessionCheckResult = { sha, shortSha, message, author, hasSession: false };

    try {
      if (!HEX.test(sha)) throw new Error('invalid sha');
      const r = gitDetailed(['notes', '--ref=origin', 'show', sha], gitOpts);
      if (r.status !== 0) throw new Error('no note');
      const noteRaw = r.stdout.trim();

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
