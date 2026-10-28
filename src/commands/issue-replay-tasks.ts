// Closed issues become replay tasks: `origin benchmark replay-tasks`.
//
// An issue closed by a merged pull request is a benchmark task that grades
// itself: the merge commit is the answer, the issue is the request, and the
// tests that commit added or changed are the grader. This turns those issues
// into the task file `origin benchmark replay` runs (context-replay.ts):
//
//   commit       the PR's merge commit (GitHub's merge_commit_sha)
//   prompt       the issue's title and body: the request, never the diff
//   tests        test files the commit added or changed (not deleted)
//   testCommand  inferred from the nearest package.json at that commit and the
//                repo's lockfile (vitest / jest), or pytest for Python tests;
//                anything else needs --test-command
//
// An issue whose fix touched no tests is skipped, with the reason: without a
// grader it is not a task. Run `origin benchmark replay --tasks <file>
// --validate` next — a test that does not fail on the parent grades nothing.
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { missingImports, type ReplayTask, type ReplayTaskFile } from '../context-replay.js';

export interface ReplayCandidate {
  shortId: string;
  title: string;
  description: string | null;
  prNumber: number;
  mergeCommitSha: string;
}

export type TaskOrSkip = { task: ReplayTask } | { skip: string };

/** Git, as these functions use it; a seam for tests. */
export interface GitReader {
  /** Paths the commit added or modified, against its first parent. */
  changed(sha: string): string[];
  /** A file's content at the commit, or null when it isn't there. */
  show(sha: string, file: string): string | null;
  /** Whether the commit is in this clone. */
  has(sha: string): boolean;
}

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file) && !/(^|\/)(fixtures?|__snapshots__|__mocks__)\//.test(file) && /\.([cm]?[jt]sx?|py)$/.test(file);
}

/**
 * The request, as the issue put it — plus, when the tests import names the
 * code before the fix does not have, one line naming that interface (what the
 * hand-written tasks in bench/context-replay do: "export the threshold as X
 * from Y"). The interface, never the implementation: without it no agent can
 * pass, and the validator rightly refuses the task.
 */
export function taskPrompt(c: Pick<ReplayCandidate, 'title' | 'description'>, expects: Array<{ name: string; module: string }> = []): string {
  const body = (c.description || '').trim();
  const base = body ? `${c.title.trim()}\n\n${body}` : c.title.trim();
  const byModule = new Map<string, string[]>();
  for (const { name, module } of expects) {
    const names = byModule.get(module) || [];
    if (!names.includes(name)) names.push(name);
    byModule.set(module, names);
  }
  if (byModule.size === 0) return base;
  const lines = [...byModule.entries()].map(([module, names]) => `${names.map((n) => `\`${n}\``).join(', ')} exported from ${module}`);
  return `${base}\n\nThe tests expect ${lines.join('; ')}.`;
}

/** The JS package a file belongs to at `sha`: the nearest directory with a package.json. */
function packageDirOf(git: GitReader, sha: string, file: string): string | null {
  let dir = path.posix.dirname(file);
  for (;;) {
    const pj = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (git.show(sha, pj) !== null) return dir;
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

/** How tests run at `sha`: the command, where, and what to install first. */
export function inferTestRun(git: GitReader, sha: string, tests: string[]): { testDir?: string; testCommand: string; setupCommand?: string; tests: string[] } | { skip: string } {
  const py = tests.filter((t) => t.endsWith('.py'));
  const js = tests.filter((t) => !t.endsWith('.py'));
  if (js.length === 0 && py.length > 0) return { testCommand: 'python -m pytest {tests}', tests: py };

  // Tests from several packages: the package holding most of them.
  const byPkg = new Map<string, string[]>();
  for (const t of js) {
    const dir = packageDirOf(git, sha, t);
    if (dir === null) continue;
    byPkg.set(dir, [...(byPkg.get(dir) || []), t]);
  }
  const [dir, own] = [...byPkg.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  if (dir === null) return { skip: 'its tests are in no package (no package.json above them); pass --test-command' };
  let pkg: any = {};
  try { pkg = JSON.parse(git.show(sha, dir === '.' ? 'package.json' : `${dir}/package.json`) || '{}'); } catch { /* not JSON */ }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const rootPkg = (() => { try { return JSON.parse(git.show(sha, 'package.json') || '{}'); } catch { return {}; } })();
  const rootDeps = { ...(rootPkg.dependencies || {}), ...(rootPkg.devDependencies || {}) };
  const runner = deps.vitest || rootDeps.vitest ? 'vitest run' : deps.jest || rootDeps.jest ? 'jest' : null;
  if (!runner) return { skip: `no vitest or jest in ${dir === '.' ? 'package.json' : `${dir}/package.json`}; pass --test-command` };
  const pm = git.show(sha, 'pnpm-lock.yaml') !== null ? 'pnpm' : git.show(sha, 'yarn.lock') !== null ? 'yarn' : 'npm';
  const exec = pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn' : 'npx';
  const setup = pm === 'pnpm' ? 'pnpm install --frozen-lockfile --prefer-offline >/dev/null'
    : pm === 'yarn' ? 'yarn install --frozen-lockfile >/dev/null'
    : git.show(sha, 'package-lock.json') !== null ? 'npm ci >/dev/null' : 'npm install >/dev/null';
  return {
    ...(dir === '.' ? {} : { testDir: dir }),
    testCommand: `${exec} ${runner} {tests}`,
    setupCommand: setup,
    // Repo-relative: the replay runner gives {tests} relative to testDir.
    tests: own,
  };
}

/** One closed issue → its replay task, or why it can't be one. Pure but for `git`. */
export function replayTaskFor(c: ReplayCandidate, git: GitReader, overrides: { testCommand?: string; testDir?: string; setupCommand?: string } = {}): TaskOrSkip {
  if (!/^[0-9a-f]{7,40}$/i.test(c.mergeCommitSha)) return { skip: 'its PR has no merge commit on record' };
  if (!git.has(c.mergeCommitSha)) return { skip: `merge commit ${c.mergeCommitSha.slice(0, 8)} is not in this clone (git fetch)` };
  const tests = git.changed(c.mergeCommitSha).filter(isTestFile);
  if (tests.length === 0) return { skip: `PR #${c.prNumber} added or changed no tests, so nothing grades a replay` };
  const run = overrides.testCommand
    ? { testCommand: overrides.testCommand, ...(overrides.testDir ? { testDir: overrides.testDir } : {}), ...(overrides.setupCommand ? { setupCommand: overrides.setupCommand } : {}), tests }
    : inferTestRun(git, c.mergeCommitSha, tests);
  if ('skip' in run) return run;
  // Names the tests import that the code before the fix does not export.
  const testSources: Record<string, string> = {};
  for (const t of run.tests) testSources[t] = git.show(c.mergeCommitSha, t) ?? '';
  const expects = missingImports(testSources, (f) => git.show(`${c.mergeCommitSha}^1`, f));
  return {
    task: {
      id: `issue-${c.shortId}`,
      commit: c.mergeCommitSha,
      prompt: taskPrompt(c, expects),
      tests: run.tests,
      testCommand: run.testCommand,
      ...(run.testDir ? { testDir: run.testDir } : {}),
      ...(overrides.setupCommand || run.setupCommand ? { setupCommand: overrides.setupCommand || run.setupCommand } : {}),
    },
  };
}

export function gitReader(repo: string): GitReader {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  return {
    changed(sha) {
      // Against the first parent: a merge commit's own change, not its branch's history.
      return git(['diff', '--name-status', '--no-renames', `${sha}^1`, sha]).split('\n')
        .map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[AM]/.test(p[0])).map((p) => p[1]);
    },
    show(sha, file) { try { return git(['show', `${sha}:${file}`]); } catch { return null; } },
    has(sha) { try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } },
  };
}

export interface ReplayTasksOptions {
  issues?: string;
  out?: string;
  testCommand?: string;
  testDir?: string;
  setup?: string;
}

export interface ReplayTasksDeps {
  cwd: string;
  log: (l: string) => void;
  error: (l: string) => void;
  repoId: (cwd: string) => Promise<string | null>;
  candidates: (repoId: string, ids: string[] | null) => Promise<ReplayCandidate[]>;
  git: (repo: string) => GitReader;
}

export async function replayTasksCommand(opts: ReplayTasksOptions, injected?: Partial<ReplayTasksDeps>): Promise<ReplayTaskFile | null> {
  const deps: ReplayTasksDeps = { ...(await defaultDeps()), ...(injected || {}) };
  let root = deps.cwd;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || deps.cwd; } catch { /* not a repo */ }
  const repoId = await deps.repoId(root);
  if (!repoId) {
    deps.error(chalk.red('This repo is not on Origin (or you are not logged in): its closed issues live there. Run `origin login`, then retry here.'));
    process.exitCode = 1;
    return null;
  }
  const ids = opts.issues ? opts.issues.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const candidates = await deps.candidates(repoId, ids);
  if (candidates.length === 0) {
    deps.log(chalk.yellow(ids ? `None of ${ids.join(', ')} is closed by a merged PR.` : 'No closed issue here was closed by a merged PR yet.'));
    return { tasks: [] };
  }
  const git = deps.git(root);
  const tasks: ReplayTask[] = [];
  for (const c of candidates) {
    const r = replayTaskFor(c, git, { testCommand: opts.testCommand, testDir: opts.testDir, setupCommand: opts.setup });
    if ('task' in r) {
      tasks.push(r.task);
      deps.log(chalk.green(`✓ ${c.shortId}`) + chalk.gray(`  PR #${c.prNumber} · ${r.task.tests.length} test file(s) · ${r.task.testCommand}`));
    } else {
      deps.log(chalk.gray(`– ${c.shortId}  skipped: ${r.skip}`));
    }
  }
  const file: ReplayTaskFile = { tasks };
  const out = path.resolve(deps.cwd, opts.out || 'replay-tasks.json');
  if (tasks.length > 0) {
    fs.writeFileSync(out, JSON.stringify(file, null, 2) + '\n');
    deps.log('');
    deps.log(`Wrote ${tasks.length} task(s) to ${out}. Next:`);
    // Relative when the file is under here; else the absolute path, not a chain of ../
    const shown = path.relative(deps.cwd, out).startsWith('..') ? out : path.relative(deps.cwd, out) || out;
    deps.log(chalk.bold(`  origin benchmark replay --tasks ${shown} --validate`) + chalk.gray('   # each test must fail before the fix and pass after'));
    deps.log(chalk.bold(`  origin benchmark replay --tasks ${shown}`));
  } else {
    deps.log(chalk.yellow('No task could be made: see the reasons above.'));
  }
  return file;
}

async function defaultDeps(): Promise<ReplayTasksDeps> {
  const { api } = await import('../api.js');
  return {
    cwd: process.cwd(),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    async repoId(repo) {
      let remote = '';
      try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no remote */ }
      try {
        const route = await api.previewRoute({ repoPath: repo, ...(remote ? { repoUrl: remote } : {}) });
        return route?.repo?.id ?? null;
      } catch { return null; }
    },
    async candidates(repoId, ids) {
      const r = await api.getIssueReplayCandidates(repoId, ids);
      return Array.isArray(r?.candidates) ? r.candidates : [];
    },
    git: gitReader,
  };
}

export async function replayTasksAction(opts: ReplayTasksOptions): Promise<void> {
  await replayTasksCommand(opts);
}
