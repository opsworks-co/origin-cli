// `origin isolate` — give this session its own git worktree.
//
// The only arrangement in which concurrent attribution is exact rather than
// heuristic. Everything else in capture narrows the guess; separate trees mean
// there is nothing to guess: each session's writes land somewhere only it is
// writing.
//
// This PRINTS the steps instead of performing them. Moving a running agent is
// not something a CLI can do — the agent already has a working directory, and
// changing it out from under a session in flight would break the thing it is
// in the middle of. So Origin makes the worktree and tells the user how to
// point their next session at it; whether to do that is their call.
import { execFileSync } from 'child_process';
import * as path from 'path';
import chalk from 'chalk';
import { getWorkingGitRoot, getCanonicalRepoPath } from '../session-state.js';

export interface IsolateOptions {
  /** Branch for the new worktree. Defaults to a name derived from the tree. */
  branch?: string;
  /** Where to put it. Defaults to a sibling of the repo. */
  at?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { windowsHide: true, cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export async function isolateCommand(opts: IsolateOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const workRoot = getWorkingGitRoot(cwd);
  if (!workRoot) {
    console.log(chalk.yellow('  Not inside a git repository — nothing to isolate.'));
    return;
  }
  const repo = getCanonicalRepoPath(workRoot);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const branch = opts.branch || `session/${stamp}`;
  const target = path.resolve(opts.at || path.join(path.dirname(repo), `${path.basename(repo)}-${stamp}`));

  try {
    git(repo, ['worktree', 'add', '-b', branch, target]);
  } catch (err: unknown) {
    console.log(chalk.red(`  Could not create the worktree: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  console.log('');
  console.log(chalk.green('  ✓ Worktree created'));
  console.log(`    ${chalk.bold(target)}`);
  console.log(`    branch ${chalk.cyan(branch)}`);
  console.log('');
  console.log('  Start your next agent session there:');
  console.log(chalk.cyan(`    cd ${target}`));
  console.log('');
  console.log(chalk.gray('  Why: two agents writing into one checkout cannot be told apart —'));
  console.log(chalk.gray('  no filesystem API reports which process wrote a file. A separate'));
  console.log(chalk.gray('  tree per session makes each turn\'s attribution exact instead of'));
  console.log(chalk.gray('  inferred.'));
  console.log('');
  console.log(chalk.gray(`  When finished:  git worktree remove ${target}`));
  console.log('');
}
