/**
 * The paths a MUTATING git command in a shell command names.
 *
 * `fileNamedInCommand` (commands/hooks/stop.ts) matches repo-relative paths
 * containing `/` anywhere in the text, and deliberately never a bare name: `cat
 * hooks.ts` must not claim a root hooks.ts, and a directory mentioned in passing
 * (`ls src`, `cd src`) must not claim a sibling session's writes under it.
 *
 * A git command that rewrites paths is different: it touches exactly the paths
 * it names. `git checkout HEAD~1 -- package.json` names the root file;
 * `git checkout HEAD~1 -- lib` and `git rm -r src/legacy` name every file under
 * the directory; `git revert --no-commit HEAD` names the files of the commit it
 * reverts. Review of #1684: without this an interrupted turn running those went
 * out empty at the next prompt, and turn 1's `git checkout -- config.py` of the
 * user's between-turn edit read as a background restoration.
 *
 * Only these subcommands, only their path arguments. Globs are ignored. Any
 * failure names nothing.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const MUTATING = new Set(['checkout', 'restore', 'rm', 'mv', 'reset', 'revert', 'apply']);
/** Options that consume the next argument, per subcommand. */
const TAKES_VALUE: Record<string, Set<string>> = {
  checkout: new Set(['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file']),
  restore: new Set(['-s', '--source', '--pathspec-from-file']),
  rm: new Set(['--pathspec-from-file']),
  mv: new Set(),
  reset: new Set(['--pathspec-from-file']),
  revert: new Set(['-m', '--mainline', '--strategy', '-X', '--strategy-option', '--gpg-sign']),
  apply: new Set(['-p', '-C', '--directory', '--exclude', '--include', '--whitespace']),
};
/** git's own global options that consume the next argument. */
const GLOBAL_TAKES_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const cache = new Map<string, string[]>();

function segments(command: string): string[][] {
  const out: string[][] = [];
  for (const part of command.split(/\n|&&|\|\||;|\|/)) {
    const words = (part.match(/'[^']*'|"[^"]*"|[^\s]+/g) || [])
      .map((w) => w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1'));
    if (words.length > 0) out.push(words);
  }
  return out;
}

function readQuiet(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true });
  } catch {
    return '';
  }
}

/** Files a revision (or range) changed: what `git revert` of it rewrites. */
function filesOfRevision(tree: string, rev: string): string[] {
  const text = rev.includes('..')
    ? readQuiet(['log', '--format=', '--name-only', '--no-renames', rev, '--'], tree)
    : readQuiet(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '--root', rev, '--'], tree);
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Files a patch touches: what `git apply` of it rewrites. */
function filesOfPatch(tree: string, patch: string): string[] {
  try {
    const text = fs.readFileSync(path.isAbsolute(patch) ? patch : path.join(tree, patch), 'utf-8');
    const out: string[] = [];
    for (const m of text.matchAll(/^diff --git a\/(.*?) b\/(.*)$/gm)) {
      if (m[1]) out.push(m[1]);
      if (m[2] && m[2] !== m[1]) out.push(m[2]);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Repo-relative path specs (`''` = the whole tree) the mutating git commands in
 * `command` name. Revisions a revert names and patches an apply reads are
 * resolved against `tree` when one is given.
 */
export function gitPathspecsNamed(command: string, tree?: string): string[] {
  if (!command || !/\bgit\b/.test(command)) return [];
  const key = `${tree || ''}\0${command}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Set<string>();
  const toRel = (p: string, cwd: string): string | null => {
    if (!p || /[*?[]/.test(p)) return null;
    let q = p.replace(/\\/g, '/');
    if (path.isAbsolute(q) || /^[A-Za-z]:\//.test(q)) {
      if (!tree) return null;
      const rel = path.relative(tree, q).replace(/\\/g, '/');
      if (rel.startsWith('..')) return null;
      q = rel;
    } else if (cwd) {
      q = path.posix.normalize(`${cwd}/${q}`);
    }
    q = path.posix.normalize(q).replace(/^\.(\/|$)/, '').replace(/\/+$/, '');
    return q.startsWith('..') ? null : q;
  };
  try {
    for (const words of segments(command.replace(/\\/g, '/'))) {
      let i = 0;
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
      if (words[i] === 'sudo' || words[i] === 'command' || words[i] === 'exec') i++;
      if (i >= words.length || path.posix.basename(words[i]) !== 'git') continue;
      i++;
      let cwd = '';
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-C' && words[i + 1]) {
          const c = toRel(words[i + 1], '');
          if (c === null) { cwd = '\0'; break; }
          cwd = c;
        }
        i += GLOBAL_TAKES_VALUE.has(words[i]) && !words[i].includes('=') ? 2 : 1;
      }
      if (cwd === '\0') continue;
      const sub = words[i];
      if (!sub || !MUTATING.has(sub)) continue;
      const rest = words.slice(i + 1);
      const dashes = rest.indexOf('--');
      const takes = TAKES_VALUE[sub];
      const positional: string[] = [];
      const scan = dashes >= 0 ? rest.slice(0, dashes) : rest;
      for (let k = 0; k < scan.length; k++) {
        const w = scan[k];
        if (w.startsWith('-')) { if (takes.has(w)) k++; continue; }
        positional.push(w);
      }
      const afterDashes = dashes >= 0 ? rest.slice(dashes + 1) : [];

      let paths: string[] = [];
      if (sub === 'rm' || sub === 'mv') paths = [...positional, ...afterDashes];
      else if (sub === 'restore') paths = [...positional, ...afterDashes];
      else if (sub === 'checkout' || sub === 'reset') paths = afterDashes; // without `--` an argument may be a branch
      else if (sub === 'revert') {
        if (tree) for (const rev of positional) for (const f of filesOfRevision(tree, rev)) out.add(f);
      } else if (sub === 'apply') {
        if (tree) for (const patch of positional) for (const f of filesOfPatch(tree, patch)) out.add(f);
      }
      for (const p of paths) {
        const rel = toRel(p, cwd);
        if (rel !== null) out.add(rel);
      }
    }
  } catch { /* names nothing more */ }
  const result = [...out];
  if (cache.size > 256) cache.clear();
  cache.set(key, result);
  return result;
}

/** Does a mutating git command in `command` name `file` (repo-relative) or a directory it lives under? */
export function fileNamedByGitPathspec(command: string, file: string, tree?: string): boolean {
  const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel) return false;
  return gitPathspecsNamed(command, tree).some((p) => p === '' || p === rel || rel.startsWith(`${p}/`));
}

/** Paths per turn kept in state; a turn naming more is kept to its first N. */
const MAX_PATHSPECS_PER_TURN = 200;

type PathspecState = { gitPathspecsByTurn?: Array<{ promptIndex: number; paths: string[] }> };

/**
 * Record, against LOCAL turn `promptIndex`, the paths a mutating git command
 * the turn runs names — at pre-tool-use, so a revert's revision resolves to the
 * files it is about to rewrite. The shell probe's own evidence does not survive
 * for a file the write journal also saw (its edit is upserted over), so Stop
 * reads this instead when deciding whether a file the turn put back was its
 * own doing (filesPutBackAcrossTheGap). The last 64 turns are kept.
 */
export function recordGitPathspecs(state: PathspecState, promptIndex: number, command: string, tree?: string): void {
  try {
    if (!Number.isInteger(promptIndex) || promptIndex < 0) return;
    const named = gitPathspecsNamed(command, tree);
    if (named.length === 0) return;
    // Carried rows are re-checked on every later Stop, so earlier turns keep
    // their record; only the oldest go once the list is long.
    const keep = (state.gitPathspecsByTurn || []).filter((e) => e.promptIndex !== promptIndex).slice(-63);
    const prev = (state.gitPathspecsByTurn || []).find((e) => e.promptIndex === promptIndex)?.paths || [];
    const paths = [...new Set([...prev, ...named])].slice(0, MAX_PATHSPECS_PER_TURN);
    state.gitPathspecsByTurn = [...keep, { promptIndex, paths }];
  } catch { /* records nothing */ }
}

/** Files among `files` a mutating git command of LOCAL turn `promptIndex` named. */
export function filesTurnNamedByGitPathspec(state: PathspecState, promptIndex: number, files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const specs = (state.gitPathspecsByTurn || []).find((e) => e.promptIndex === promptIndex)?.paths || [];
  if (specs.length === 0) return out;
  for (const f of files) {
    const rel = String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel && specs.some((p) => p === '' || p === rel || rel.startsWith(`${p}/`))) out.add(f);
  }
  return out;
}
