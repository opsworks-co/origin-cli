/**
 * Rewrite pairs git reported before the commit they rewrite was recorded.
 *
 * post-rewrite records a pair only on a session that already owns the old sha
 * (`owns` in commands/hooks/post-rewrite.ts) — a pair nobody owns is somebody
 * else's rewrite and is left alone. That rule has a hole the shell opens every
 * day: `git commit -m wip && git rebase origin/main`. The commit's post-commit
 * hook is backgrounded and slow to start under load; the rebase runs at once,
 * and ITS post-rewrite hook asks "who owns the old sha?" before post-commit has
 * written the answer. Session c085f0af, 2026-09-26 04:45 UTC: 2099d0d9 was
 * committed at :25 and rebased to 47dbb095 at :57; post-rewrite ran at ~:57.7
 * and recorded nothing (it also logged nothing, so the log read like a hook
 * that never fired); post-commit recorded 2099d0d9 at :58.1. The copy rendered
 * "NOT LINKED TO A TURN" beside the original on the session page.
 *
 * So a pair no live session owns is HELD here, keyed by the repository, and
 * post-commit folds it in the moment it records the old sha. A held pair that
 * never meets its commit is pruned after a day. Nothing is invented: the pair
 * is git's own word, and it is applied only to a session that records the
 * exact sha it rewrites.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCanonicalRepoPath } from './session-state.js';

export interface HeldRewrite { from: string; to: string; at: string }

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const SHA = /^[a-fA-F0-9]{7,40}$/;

function heldFileFor(repoPath: string): string {
  const key = crypto.createHash('sha1').update(getCanonicalRepoPath(repoPath)).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'held-rewrites', `${key}.json`);
}

function readHeld(file: string): HeldRewrite[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    const fresh = Date.now() - MAX_AGE_MS;
    return raw.filter((p): p is HeldRewrite =>
      !!p && typeof p.from === 'string' && typeof p.to === 'string' && typeof p.at === 'string'
      && Date.parse(p.at) >= fresh);
  } catch {
    return [];
  }
}

function writeHeld(file: string, pairs: HeldRewrite[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (pairs.length === 0) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return;
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pairs.slice(-MAX_ENTRIES)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sameSha = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
};

/** Keep pairs no live session owned. Returns how many are now held. */
export function holdRewrites(repoPath: string, pairs: ReadonlyArray<{ from: string; to: string }>): number {
  const valid = pairs.filter((p) => SHA.test(p?.from || '') && SHA.test(p?.to || '') && p.from !== p.to);
  if (valid.length === 0) return 0;
  const file = heldFileFor(repoPath);
  const held = readHeld(file);
  const at = new Date().toISOString();
  for (const p of valid) {
    // git's latest word for a sha replaces an earlier one, as in applyRewritePairsToState.
    const i = held.findIndex((h) => sameSha(h.from, p.from));
    if (i >= 0) held.splice(i, 1);
    held.push({ from: p.from, to: p.to, at });
  }
  try { writeHeld(file, held); } catch { /* best-effort: the rescue's content rungs remain */ }
  return valid.length;
}

/**
 * The held pairs that rewrite `sha`, removed from the hold. Called by
 * post-commit right after it records `sha` on a session.
 */
export function takeHeldRewritesFor(repoPath: string, sha: string): Array<{ from: string; to: string }> {
  if (!SHA.test(sha || '')) return [];
  const file = heldFileFor(repoPath);
  const held = readHeld(file);
  if (held.length === 0) return [];
  const taken = held.filter((h) => sameSha(h.from, sha));
  if (taken.length === 0) return [];
  try { writeHeld(file, held.filter((h) => !sameSha(h.from, sha))); } catch { /* re-applying a pair is idempotent */ }
  return taken.map((h) => ({ from: h.from, to: h.to }));
}
