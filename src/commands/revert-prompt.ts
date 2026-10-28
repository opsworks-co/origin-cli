// `origin revert-prompt <session> <turn>` — undo the lines ONE prompt wrote,
// as a branch ready for a pull request.
//
// GitHub can revert a commit. Origin knows which lines each prompt wrote, so
// it can revert one prompt: the turn's own diff (as Origin captured it),
// applied in reverse on top of the default branch.
//
// It never touches the checkout. The revert commit is built in a temporary
// index (GIT_INDEX_FILE) from the default branch's tree, so HEAD, the index,
// the working tree — and an agent still running in it — are left alone, dirty
// or not. `git apply -R --cached --3way` does the work: a line a later commit
// changed again is a conflict, and a conflict stops it before anything is
// written. Then a branch at the new commit, and a push.

import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { gitDetailed } from '../utils/exec.js';

export interface RevertPatch {
  sessionId: string;
  promptIndex: number;
  /** The prompt's first line, for the commit message. */
  promptTitle: string | null;
  diff: string;
  files: string[];
  branchName: string;
}

export interface RevertResult {
  ok: boolean;
  message: string;
  branch?: string;
  commitSha?: string;
  base?: string;
  /** Files where a later change conflicts with the revert. */
  conflicts?: string[];
  pushed?: boolean;
}

type Git = (args: string[], env?: Record<string, string>) => { ok: boolean; out: string; err: string };

function makeGit(cwd: string): Git {
  return (args, env) => {
    const r = gitDetailed(args, { cwd, timeoutMs: 60_000, ...(env && { env: { ...process.env, ...env } as Record<string, string> }) });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
}

/** origin/<default branch>, else a local main/master. */
function defaultBase(git: Git): string | null {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const names = head.ok && head.out ? [head.out.replace(/^origin\//, '')] : ['main', 'master'];
  for (const n of names) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${n}`]).ok) return `origin/${n}`;
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${n}`]).ok) return n;
  }
  return null;
}

/**
 * Build the revert as a commit on top of `base` and point a new branch at it.
 * Touches nothing but the new branch ref (and a temporary index file).
 */
export function buildRevertCommit(repo: string, patch: RevertPatch, opts: { base?: string; fetch?: boolean } = {}): RevertResult {
  const git = makeGit(repo);
  if (!git(['rev-parse', '--git-dir']).ok) return { ok: false, message: 'Not inside a git repository.' };
  if (!patch.diff.trim()) return { ok: false, message: 'Origin has no diff for this prompt — it changed no committed lines, so there is nothing to revert.' };
  if (opts.fetch !== false) git(['fetch', '--quiet', 'origin']);
  const base = opts.base || defaultBase(git);
  if (!base || !git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    return { ok: false, message: `No base to revert on${opts.base ? `: "${opts.base}" is not a commit here` : ' (no origin/main or main)'}. Pass --base <branch>.` };
  }
  const branch = patch.branchName;
  if (!git(['check-ref-format', '--branch', branch]).ok) return { ok: false, message: `"${branch}" is not a valid branch name.` };
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    return { ok: false, message: `The branch ${branch} already exists here. Delete it (git branch -D ${branch}) or pass --branch <name>.` };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-revert-'));
  const index = path.join(tmp, 'index');
  const patchFile = path.join(tmp, 'turn.diff');
  try {
    fs.writeFileSync(patchFile, patch.diff.endsWith('\n') ? patch.diff : `${patch.diff}\n`);
    const env = { GIT_INDEX_FILE: index };
    const read = git(['read-tree', base], env);
    if (!read.ok) return { ok: false, message: `Could not read ${base}: ${read.err}` };
    const applied = git(['apply', '-R', '--cached', '--3way', '--whitespace=nowarn', patchFile], env);
    if (!applied.ok) {
      const unmerged = git(['ls-files', '--unmerged'], env).out.split('\n').map((l) => l.split('\t')[1]).filter(Boolean);
      const conflicts = [...new Set(unmerged)];
      return {
        ok: false, base, conflicts,
        message: conflicts.length > 0
          ? `Later changes on ${base} overlap this prompt's lines in ${conflicts.join(', ')}. Nothing was changed. Revert those files by hand.`
          : `This prompt's diff no longer applies in reverse on ${base} (${applied.err.split('\n')[0] || 'git apply failed'}). Nothing was changed.`,
      };
    }
    const tree = git(['write-tree'], env);
    if (!tree.ok) return { ok: false, message: `Could not write the reverted tree: ${tree.err}` };
    const baseTree = git(['rev-parse', `${base}^{tree}`]).out;
    if (tree.out === baseTree) return { ok: false, base, message: `Nothing to revert: none of this prompt's lines are on ${base} any more.` };

    const turn = patch.promptIndex + 1;
    const title = (patch.promptTitle || '').split('\n')[0].trim().slice(0, 60);
    const msg = [
      `Revert prompt #${turn}${title ? `: ${title}` : ''}`,
      '',
      `Undoes the lines prompt #${turn} of Origin session ${patch.sessionId.slice(0, 8)} wrote (${patch.files.length} file${patch.files.length === 1 ? '' : 's'}).`,
      '',
      `Origin-Revert: ${patch.sessionId} | turn ${turn}`,
    ].join('\n');
    const commit = git(['commit-tree', tree.out, '-p', base, '-m', msg]);
    if (!commit.ok) return { ok: false, message: `Could not commit the revert: ${commit.err} (is git user.name / user.email set?)` };
    const ref = git(['update-ref', `refs/heads/${branch}`, commit.out, '']);
    if (!ref.ok) return { ok: false, message: `Could not create ${branch}: ${ref.err}` };
    return { ok: true, branch, commitSha: commit.out, base, message: `Created ${branch} with the revert of prompt #${turn}, on ${base}.` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export interface RevertPromptOptions { base?: string; branch?: string; push?: boolean }

export interface RevertPromptDeps {
  cwd: string;
  fetchPatch: (sessionId: string, promptIndex: number) => Promise<RevertPatch>;
  push: (repo: string, branch: string) => { ok: boolean; err: string };
  log: (s: string) => void;
  error: (s: string) => void;
}

const defaultDeps = async (): Promise<RevertPromptDeps> => {
  const { request } = await import('../api.js');
  return {
    cwd: process.cwd(),
    fetchPatch: (s, i) => request(`/api/sessions/${encodeURIComponent(s)}/turns/${i}/revert-patch`) as Promise<RevertPatch>,
    push: (repo, branch) => {
      const r = gitDetailed(['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: repo, timeoutMs: 120_000 });
      return { ok: r.status === 0, err: (r.stderr || '').trim() };
    },
    log: (s) => console.log(s),
    error: (s) => console.error(s),
  };
};

/** `origin revert-prompt <session> <turn>` — turn is 1-based, as the dashboard numbers prompts. */
export async function revertPromptCommand(
  sessionId: string,
  turnArg: string,
  opts: RevertPromptOptions = {},
  injected?: Partial<RevertPromptDeps>,
): Promise<RevertResult> {
  const deps = { ...(await defaultDeps()), ...(injected || {}) };
  const turn = Number(turnArg);
  if (!Number.isInteger(turn) || turn < 1) {
    deps.error(chalk.red('The turn is the prompt number shown on the session page (1, 2, 3 …).'));
    process.exitCode = 2;
    return { ok: false, message: 'bad turn' };
  }
  let patch: RevertPatch;
  try {
    patch = await deps.fetchPatch(sessionId, turn - 1);
  } catch (err: any) {
    const msg = err?.status === 404 ? `Origin has no session ${sessionId} you may revert, or no prompt #${turn} in it.` : `Could not read the prompt from Origin: ${err?.message || err}`;
    deps.error(chalk.red(msg));
    process.exitCode = 1;
    return { ok: false, message: msg };
  }
  if (opts.branch) patch = { ...patch, branchName: opts.branch };

  const top = gitDetailed(['rev-parse', '--show-toplevel'], { cwd: deps.cwd });
  const repo = top.status === 0 ? top.stdout.trim() : deps.cwd;
  const result = buildRevertCommit(repo, patch, { base: opts.base });
  if (!result.ok) {
    deps.error(chalk.red(result.message));
    process.exitCode = 1;
    return result;
  }
  deps.log(chalk.green(`✓ ${result.message}`));
  if (opts.push === false) {
    deps.log(chalk.gray(`  Not pushed (--no-push). Push it with: git push -u origin ${result.branch}`));
    return { ...result, pushed: false };
  }
  const pushed = deps.push(repo, result.branch!);
  if (!pushed.ok) {
    deps.error(chalk.yellow(`The branch is ready but the push failed: ${pushed.err.split('\n')[0]}`));
    deps.error(chalk.gray(`  Push it with: git push -u origin ${result.branch}`));
    process.exitCode = 1;
    return { ...result, pushed: false };
  }
  deps.log(chalk.green(`✓ Pushed ${result.branch}.`) + chalk.gray(' Open the pull request from the session page in Origin, or: gh pr create --head ' + result.branch));
  return { ...result, pushed: true };
}
