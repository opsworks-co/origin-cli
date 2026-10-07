/**
 * Which commit a cherry-pick copied — the one fact git states only while the
 * pick is being prepared.
 *
 * `git cherry-pick` runs no post-rewrite hook, so it hands Origin no old→new
 * pair. Its source is in `CHERRY_PICK_HEAD`, and that file's lifetime was
 * measured against git 2.54 (history-rewrite-git-signals.test.ts):
 *
 *  - prepare-commit-msg runs in the FOREGROUND and always sees it — clean
 *    pick, each pick of a multi-commit pick, and the commit that concludes a
 *    conflicted pick (`cherry-pick --continue` or a plain `git commit`);
 *  - post-commit sees it for a clean pick only: after a conflict git removes it
 *    before post-commit runs, and Origin's post-commit handler is backgrounded
 *    and may start after any later git command anyway.
 *
 * So prepare-commit-msg (already synchronous in the global and the repo-local
 * installation) writes the source down, keyed by the commit the new commit will
 * sit on — its parent — and post-commit takes it for the commit it was given.
 * The key keeps the picks of `git cherry-pick A B C` apart even when their
 * backgrounded post-commits run late: each pick has a different parent.
 *
 * Two git-owned checks guard against a stale marker: every other commit
 * prepared on the same parent clears it, and post-commit uses it only when the
 * HEAD reflog entry that created the commit says a cherry-pick made it
 * (`cherry-pick: …`, or `commit (cherry-pick): …` after a conflict). Nothing
 * is matched by subject, patch-id or path set.
 *
 * The marker directory is removed once it is empty again, so an ordinary
 * commit keeps its fast path (no directory → no extra git call). Only an EMPTY
 * directory is removed (rmdir), never a marker; a pick that loses its freshly
 * made directory to that removal makes it again.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { reflogSubjectThatCreated, replayInProgress } from './commit-replay.js';
import { debugLog } from './debug-log.js';
import { preserveAttributionBatch, type RewriteBatchResult } from './history-preservation.js';

const READ = { encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true };
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const MARKER_DIR = 'origin-cherry-picks';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { ...READ, cwd }).trim();
  } catch {
    return null;
  }
}

function markerDir(cwd: string): string | null {
  const gitDir = gitOut(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return null;
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir), MARKER_DIR);
}

function fullCommit(cwd: string, rev: string): string | null {
  const out = (gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) || '').toLowerCase();
  return FULL_SHA.test(out) ? out : null;
}

/**
 * prepare-commit-msg: remember the pick's source for the commit about to be
 * made on HEAD, or clear a stale one when this commit is not a pick. Never
 * throws; returns the source it recorded, for the log.
 */
export function rememberCherryPickSource(hookCwd: string): string | null {
  try {
    const dir = markerDir(hookCwd);
    if (!dir) return null;
    const picking = replayInProgress(hookCwd) === 'cherry-pick';
    // The common case — an ordinary commit and no marker anywhere — costs no more git calls.
    if (!picking && !fs.existsSync(dir)) return null;
    const head = fullCommit(hookCwd, 'HEAD');
    if (!head) return null;
    const file = path.join(dir, head);
    if (!picking) {
      try { fs.unlinkSync(file); } catch { /* none */ }
      prune(dir);
      removeIfEmpty(dir);
      return null;
    }
    const gitDir = path.dirname(dir);
    const raw = fs.readFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'utf-8').trim().toLowerCase();
    if (!FULL_SHA.test(raw) || raw === head) return null;
    const body = JSON.stringify({ source: raw, at: new Date().toISOString() });
    for (let attempt = 0; ; attempt++) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(file, body);
        break;
      } catch (err: any) {
        // Another hook removed the directory as it emptied: make it again.
        if (err?.code !== 'ENOENT' || attempt >= 2) throw err;
      }
    }
    prune(dir);
    return raw;
  } catch {
    return null;
  }
}

/**
 * post-commit: the source of `commitSha` when a cherry-pick made it, consumed.
 * Null for every other commit.
 */
export function takeCherryPickSource(hookCwd: string, commitSha: string): string | null {
  try {
    const commit = (commitSha || '').toLowerCase();
    if (!FULL_SHA.test(commit)) return null;
    const dir = markerDir(hookCwd);
    if (!dir || !fs.existsSync(dir)) return null;
    const parent = fullCommit(hookCwd, `${commit}^1`);
    if (!parent) return null;
    const file = path.join(dir, parent);
    let marker: { source?: unknown; at?: unknown };
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
    const subject = reflogSubjectThatCreated(hookCwd, commit) || '';
    if (!/^(?:cherry-pick|commit \(cherry-pick\)):/.test(subject)) return null;
    try { fs.unlinkSync(file); } catch { /* another hook took it */ }
    prune(dir);
    removeIfEmpty(dir);
    const source = typeof marker.source === 'string' ? fullCommit(hookCwd, marker.source) : null;
    return source && source !== commit ? source : null;
  } catch {
    return null;
  }
}

/**
 * post-commit: when a cherry-pick made `commitSha`, carry its source's
 * attribution to it — the same rebuild as a post-rewrite pair (commit-level,
 * the new sha, the target's own note kept). Never throws.
 */
export function carryCherryPickAttribution(hookCwd: string, commitSha: string): RewriteBatchResult | null {
  const source = takeCherryPickSource(hookCwd, commitSha);
  if (!source) return null;
  try {
    const result = preserveAttributionBatch(hookCwd, [{ oldSha: source, newSha: commitSha }]);
    debugLog('post-commit', 'cherry-pick attribution carried', {
      source: source.slice(0, 12), commit: commitSha.slice(0, 12),
      written: result.written, unchanged: result.unchanged, skipped: result.skipped, failed: result.failed,
    });
    return result;
  } catch {
    return null;
  }
}

/** Remove the marker directory if — and only if — it is empty. Never a marker. */
function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch { /* ENOTEMPTY/EEXIST: a pick's marker is in it; ENOENT: already gone */ }
}

function prune(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* gone */ }
    }
  } catch { /* best-effort */ }
}
