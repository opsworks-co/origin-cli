// "Restore this turn" — put a turn's saved state back without losing anything.
//
// Runs the web's `restore-turn` command (heartbeat / transcript watcher) and
// `origin snapshot restore <ref> --branch|--hard`. Two modes, and two rules
// neither breaks: uncommitted work is never discarded, and nothing is stashed.
//
//   soft (default) — a NEW branch at the turn's state. `git branch` only: HEAD,
//                    the index and the working tree are not touched.
//   hard           — reset the CURRENT branch to the turn: HEAD goes back to
//                    the commit the turn sat on, and the turn's uncommitted
//                    files come back as uncommitted. Refused when the tree has
//                    any tracked change, when an untracked file would be
//                    overwritten, or when that commit is not in this branch's
//                    history (a reset there would not be a rewind).
//
// The target is a tree (PromptChange.treeSha — `git stash create`'s tree, so
// tracked files only) or a commit (the session's starting HEAD).

import { gitDetailed } from './utils/exec.js';

const HEX = /^[0-9a-f]{4,64}$/i;
const ORIGIN_IDENTITY = {
  GIT_AUTHOR_NAME: 'Origin', GIT_AUTHOR_EMAIL: 'restore@origin.local',
  GIT_COMMITTER_NAME: 'Origin', GIT_COMMITTER_EMAIL: 'restore@origin.local',
};

export interface RestoreTurnCommand {
  mode?: 'soft' | 'hard';
  treeSha?: string | null;
  commitSha?: string | null;
  /** The commit the turn sat on: the restore commit's parent, and Hard's reset point. */
  baseSha?: string | null;
  branchName?: string | null;
  /** 0-based turn index, for messages; null = the session's starting commit. */
  targetPromptIndex?: number | null;
  sessionId?: string | null;
}

export interface RestoreTurnResult {
  status: 'success' | 'failed';
  message: string;
  mode: 'soft' | 'hard';
  branch?: string;
  commitSha?: string;
  files?: string[];
}

type Git = (args: string[], env?: Record<string, string>) => { ok: boolean; out: string; err: string };

function makeGit(repoPath: string): Git {
  return (args, env) => {
    const r = gitDetailed(args, { cwd: repoPath, timeoutMs: 30_000, ...(env && { env }) });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
}

const short = (s: string) => s.slice(0, 7);
const turnLabel = (cmd: RestoreTurnCommand) =>
  Number.isInteger(cmd.targetPromptIndex) && (cmd.targetPromptIndex as number) >= 0
    ? `the end of turn ${(cmd.targetPromptIndex as number) + 1}`
    : 'the commit the session started on';

function objectType(git: Git, sha: string): string | null {
  const r = git(['cat-file', '-t', sha]);
  return r.ok ? r.out : null;
}

function resolveTree(git: Git, cmd: RestoreTurnCommand): string | null {
  const ref = cmd.treeSha || cmd.commitSha;
  if (!ref || !HEX.test(ref)) return null;
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  return r.ok && HEX.test(r.out) ? r.out : null;
}

function resolveCommit(git: Git, sha: string | null | undefined): string | null {
  if (!sha || (sha !== 'HEAD' && !HEX.test(sha))) return null;
  const r = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  return r.ok && HEX.test(r.out) ? r.out : null;
}

function listOf(files: string[], cap = 12): string {
  return files.length > cap ? `${files.slice(0, cap).join(', ')} and ${files.length - cap} more` : files.join(', ');
}

/** `restore/x-t3`, then `restore/x-t3-2`, … — never moves a branch that exists. */
function freeBranchName(git: Git, wanted: string): string | null {
  const base = wanted.replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/.]+|[/.]+$/g, '').slice(0, 80) || 'restore/turn';
  for (let i = 1; i <= 50; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!git(['check-ref-format', '--branch', name]).ok) return null;
    if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name;
  }
  return null;
}

/** The commit holding the target state, with `parent` as its parent (reused when the trees already match). */
function restoreCommit(git: Git, tree: string, parent: string | null, cmd: RestoreTurnCommand): string | null {
  if (parent) {
    const pt = git(['rev-parse', `${parent}^{tree}`]);
    if (pt.ok && pt.out === tree) return parent;
  }
  const msg = `Origin restore: ${turnLabel(cmd)}${cmd.sessionId ? ` of session ${cmd.sessionId.slice(0, 8)}` : ''}`;
  const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg];
  let r = git(args);
  // No user.name/user.email on this box: commit-tree refuses. The commit is a
  // local restore point, so a fixed identity is fine.
  if (!r.ok) r = git(args, ORIGIN_IDENTITY);
  return r.ok && HEX.test(r.out) ? r.out : null;
}

function filesBetween(git: Git, from: string, to: string): string[] {
  const r = git(['diff', '--name-only', '--no-renames', from, to]);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

export function runRestoreTurn(repoPath: string, cmd: RestoreTurnCommand, git: Git = makeGit(repoPath)): RestoreTurnResult {
  const mode: 'soft' | 'hard' = cmd.mode === 'hard' ? 'hard' : 'soft';
  const fail = (message: string): RestoreTurnResult => ({ status: 'failed', mode, message: `${message} Nothing was changed.` });

  const ref = cmd.treeSha || cmd.commitSha || '';
  if (!HEX.test(ref)) return fail('Invalid or missing snapshot ref.');
  const tree = resolveTree(git, cmd);
  if (!tree) {
    return fail(`Snapshot ${short(ref)} is not in this clone — it was captured on another machine or clone, or git has garbage-collected it.`);
  }
  const head = resolveCommit(git, 'HEAD');
  const base = resolveCommit(git, cmd.baseSha) ?? resolveCommit(git, cmd.commitSha);

  if (mode === 'soft') {
    const parent = base ?? head;
    const sha = restoreCommit(git, tree, parent, cmd);
    if (!sha) return fail('Could not write the restore commit.');
    const name = freeBranchName(git, cmd.branchName || `restore/${short(tree)}`);
    if (!name) return fail(`"${cmd.branchName}" is not a usable branch name.`);
    // `git branch` writes one ref — HEAD, the index and the working tree are untouched.
    const b = git(['branch', name, sha]);
    if (!b.ok) return fail(`git branch failed: ${b.err || 'unknown error'}.`);
    const files = head ? filesBetween(git, head, sha) : [];
    const diffNote = !head
      ? ''
      : files.length === 0
        ? ' It matches your HEAD.'
        : ` ${files.length} file${files.length === 1 ? ' differs' : 's differ'} from your HEAD: ${listOf(files)}.`;
    return {
      status: 'success', mode, branch: name, commitSha: sha, files,
      message: `Created branch ${name} at ${short(sha)} (${turnLabel(cmd)}). Your checkout and uncommitted work are untouched.${diffNote} ` +
        `Open it beside this checkout with: git worktree add ../${name.replace(/\//g, '-')} ${name}`,
    };
  }

  // ── Hard ──────────────────────────────────────────────────────────────
  if (!head) return fail('This repository has no commits to reset.');
  if (!base) return fail('The commit this turn sat on is not in this clone, so there is nothing to reset the branch to. Use Soft instead.');
  if (!git(['merge-base', '--is-ancestor', base, head]).ok) {
    return fail(`${short(base)} is not in this branch's history, so resetting to it would not be a rewind. Use Soft — it makes a new branch instead.`);
  }
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) return fail('Could not check the working tree for uncommitted changes.');
  if (status.out) {
    const n = status.out.split('\n').filter(Boolean).length;
    return fail(`Your working tree has ${n} uncommitted change${n === 1 ? '' : 's'}. Hard restore never discards work and never stashes — commit them, or use Soft.`);
  }
  // Untracked files survive a reset unless the target has a file at the same path.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked.ok) return fail('Could not list untracked files.');
  const untrackedSet = new Set(untracked.out.split('\0').filter(Boolean));
  if (untrackedSet.size > 0) {
    const inTargets = new Set<string>();
    for (const t of [base, tree]) {
      const ls = git(['ls-tree', '-r', '--name-only', '-z', t]);
      if (!ls.ok) return fail('Could not read the snapshot tree.');
      for (const p of ls.out.split('\0')) if (untrackedSet.has(p)) inTargets.add(p);
    }
    if (inTargets.size > 0) {
      return fail(`Untracked file${inTargets.size === 1 ? '' : 's'} ${listOf([...inTargets])} would be overwritten. Move ${inTargets.size === 1 ? 'it' : 'them'} aside, or use Soft.`);
    }
  }

  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const where = branch.ok ? branch.out : 'detached HEAD';
  const reset = git(['reset', '--hard', '--quiet', base]);
  if (!reset.ok) return fail(`git reset failed: ${reset.err || 'unknown error'}.`);
  // The turn's uncommitted files: switch the (now clean) tree from the base
  // commit to the snapshot, then put the index back on HEAD so they read as
  // uncommitted again — exactly how the turn left them.
  const baseTree = git(['rev-parse', `${base}^{tree}`]).out;
  let restored: string[] = [];
  if (baseTree !== tree) { // path-compare-ok — git tree shas, not paths
    const rt = git(['read-tree', '-m', '-u', base, tree]);
    if (!rt.ok) {
      git(['reset', '--hard', '--quiet', head]);
      return fail(`Could not write the turn's files (${rt.err || 'read-tree failed'}); the branch was put back at ${short(head)}.`);
    }
    git(['reset', '--quiet']);
    restored = filesBetween(git, base, tree);
  }
  const dropped = git(['rev-list', '--count', `${base}..${head}`]).out || '0';
  return {
    status: 'success', mode, commitSha: base, files: restored,
    message: `Reset ${where} from ${short(head)} to ${short(base)} (${turnLabel(cmd)}); ${dropped} commit${dropped === '1' ? '' : 's'} left this branch.` +
      (restored.length ? ` The turn's ${restored.length} uncommitted file${restored.length === 1 ? ' is' : 's are'} back: ${listOf(restored)}.` : '') +
      ` Undo with: git reset --hard ${short(head)}`,
  };
}
