/**
 * git's own record of a commit rewrite.
 *
 * Session 874ff028 committed "wip", ran `git reset --soft HEAD~1 && git reset`,
 * and later made a different commit on the same parent. The amend rescue paired
 * the two because they shared a parent and it could not tell their turns apart;
 * the server then moved turn rows onto a commit another turn made. A rewrite is
 * now only what git proves: the reflog records `commit (amend)` from one to the
 * other, a rebase or cherry-pick step replayed that very commit, or the two
 * carry the same patch or the same tree (those two are read in hooks.ts).
 *
 * The reflog is read THROUGH git (`git log -g`), never from `.git/logs/` files:
 * a reftable repo (git 3.0's planned default) has no such files, and every
 * rewrite in one went unpaired. `git log -g` prints no old sha, so each
 * entry's old sha is the previous entry's new sha on the same ref. An expired
 * entry in between makes that wrong, so an amend is checked against the
 * parents, and a fold chain that does not link up proves nothing.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { kindOfReflogSubject } from './commit-replay.js';

const gitOptsFor = (cwd: string, extra: Record<string, unknown> = {}) => ({
  windowsHide: true,
  cwd,
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  timeout: 5000,
  ...extra,
});

function gitOut(cwd: string, args: string[], extra: Record<string, unknown> = {}): string | null {
  try { return execFileSync('git', args, gitOptsFor(cwd, extra)).toString(); } catch { return null; }
}

// ─── Reflog proof of a rewrite ────────────────────────────────────────────

/** What the reflog walk printed about a commit an entry moved a ref to. */
export interface ReflogCommit {
  parents: string;
  /** `name <email> <author time>` — what a rebase or cherry-pick carries over. */
  author: string;
  subject: string;
}

interface ReplayStep { tag: string; old: string; product: string }

/** One `rebase (start)` … `rebase (finish)` run in a HEAD reflog. */
export interface RebaseRun {
  /** The tip whose commits were replayed: the branch's tip before the rebase, else HEAD's. */
  oldTip: string;
  /** Where `(start)` checked out — the new base, or past commits kept as they were. */
  startNew: string;
  /** The base named by the branch's `(finish): refs/heads/x onto <sha>`, when there is one. */
  onto: string;
  finalTip: string;
  steps: ReplayStep[];
}

export interface ReflogRewrites {
  /** old → new for every `commit (amend)` entry. */
  amendNext: Map<string, Set<string>>;
  /** Commits a rebase step produced, and every amend made on top of one. */
  rebaseDerived: Set<string>;
  /** Finished rebase runs, oldest first. */
  rebases: RebaseRun[];
  /** Commits a cherry-pick made. */
  cherryPicks: string[];
  commits: Map<string, ReflogCommit>;
}

// Entries read per call. `git log -g` walks every named reflog newest first, so
// the cap drops the oldest entries — the ones a live session least needs.
const REFLOG_ENTRY_CAP = 50_000;
const RS = '\x1e';
const US = '\x1f';
const FULL_SHA = /^[0-9a-f]{40}$/;

/** `rebase (pick): …` → 'pick'; `rebase: fast-forward` → 'fast-forward'; not a rebase → ''. */
function rebaseTag(message: string): string {
  if (kindOfReflogSubject(message) !== 'rebase') return '';
  const prefix = message.split(':', 1)[0];
  const tag = /\(([\w-]+)\)\s*$/.exec(prefix)?.[1];
  if (tag) return tag;
  return message.slice(prefix.length + 1).trim().split(/\s/)[0] || 'step';
}

const emptyRewrites = (): ReflogRewrites => ({
  amendNext: new Map(), rebaseDerived: new Set(), rebases: [], cherryPicks: [], commits: new Map(),
});

const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Every rewrite git's reflogs recorded, across this repo's worktrees and branches. Two git processes. */
export function readReflogRewrites(repoPath: string): ReflogRewrites {
  const result = emptyRewrites();
  const where = gitOut(repoPath, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (where === null) return result;
  const [gitDirRaw = '', commonRaw = ''] = where.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!gitDirRaw || !commonRaw) return result;
  const gitDir = realpath(path.resolve(repoPath, gitDirRaw));
  const common = realpath(path.resolve(repoPath, commonRaw));
  // Every worktree's HEAD by the names git resolves from anywhere in the repo.
  // The worktree ids are directory names; the reflogs themselves are git's.
  const heads = ['HEAD'];
  if (gitDir !== common) heads.push('main-worktree/HEAD');
  try {
    for (const id of fs.readdirSync(path.join(common, 'worktrees'))) {
      if (realpath(path.join(common, 'worktrees', id)) !== gitDir) heads.push(`worktrees/${id}/HEAD`);
    }
  } catch { /* no linked worktrees */ }
  // Branches are enumerated by `--branches` inside the walk, never listed by
  // name: `rev-parse --symbolic-full-name --branches` drops every branch whose
  // short name is ambiguous (`origin/x` next to the `origin` remote). Origin's
  // own snapshot branches replay nothing and are skipped.
  const out = gitOut(
    repoPath,
    [
      'log', '-g', '--stdin', `-n${REFLOG_ENTRY_CAP}`,
      '--exclude=origin/shadow/*', '--exclude=origin/snapshots/*', '--branches',
      `--format=${RS}%gD${US}%H${US}%P${US}%an <%ae> %at${US}%s${US}%gs`,
    ],
    { input: `${heads.join('\n')}\n`, timeout: 15000, maxBuffer: 256 * 1024 * 1024 },
  );
  if (!out) return result;

  // Per ref, newest first as git prints them.
  const byRef = new Map<string, Array<{ sha: string; message: string }>>();
  for (const record of out.split(RS)) {
    const [selector = '', sha = '', parents = '', author = '', subject = '', message = ''] = record.replace(/\n$/, '').split(US);
    if (!FULL_SHA.test(sha)) continue;
    const at = selector.lastIndexOf('@{');
    const ref = at > 0 ? selector.slice(0, at) : selector;
    if (!result.commits.has(sha)) result.commits.set(sha, { parents: parents.trim(), author, subject });
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref)!.push({ sha, message });
  }

  const parentsOf = (sha: string) => result.commits.get(sha)?.parents ?? null;
  const rebaseProducts = new Set<string>();
  // A branch's `(finish): refs/heads/x onto <base>`, by the tip it finished on:
  // the base, and the branch's tip before the rebase.
  const branchFinish = new Map<string, { onto: string; oldTip: string }>();
  for (const [ref, newestFirst] of byRef) {
    const entries = [...newestFirst].reverse();
    const isHead = heads.includes(ref);
    let run: RebaseRun | null = null;
    entries.forEach(({ sha: newSha, message }, i) => {
      const oldSha = i > 0 ? entries[i - 1].sha : '';
      if (message.startsWith('commit (amend)')) {
        // An amend keeps the parents. If they differ, the previous entry is not
        // what was amended (an expired entry in between) — no proof.
        if (!oldSha || oldSha === newSha || parentsOf(oldSha) === null || parentsOf(oldSha) !== parentsOf(newSha)) return;
        if (!result.amendNext.has(oldSha)) result.amendNext.set(oldSha, new Set());
        result.amendNext.get(oldSha)!.add(newSha);
        return;
      }
      if (/^(?:commit \(cherry-pick\)|cherry-pick):/.test(message)) {
        if (isHead) result.cherryPicks.push(newSha);
        return;
      }
      const tag = rebaseTag(message);
      if (!tag) return;
      // Every step and `(finish)` is a product. Not `(start)` — that entry
      // checks out the NEW BASE, which is somebody else's commit — and not
      // `(abort)`. `(finish)` repeats the last step's sha; it still ends the run.
      if (tag !== 'start' && tag !== 'abort') rebaseProducts.add(newSha);
      if (!isHead) {
        const onto = /\(finish\):.* onto ([0-9a-f]{40})/.exec(message)?.[1];
        if (onto) branchFinish.set(newSha, { onto, oldTip: oldSha });
        return;
      }
      if (tag === 'start') {
        run = oldSha ? { oldTip: oldSha, startNew: newSha, onto: '', finalTip: '', steps: [] } : null;
      } else if (tag === 'abort') {
        run = null;
      } else if (tag === 'finish') {
        if (run) { run.finalTip = newSha; result.rebases.push(run); }
        run = null;
      } else if (run && oldSha && oldSha !== newSha) {
        run.steps.push({ tag, old: oldSha, product: newSha });
      }
    });
  }
  for (const r of result.rebases) {
    const finish = branchFinish.get(r.finalTip);
    if (!finish) continue;
    r.onto = finish.onto;
    // `git rebase main feat` run on another branch: HEAD before `(start)` was
    // that other branch, while the branch's own reflog holds feat's old tip.
    if (finish.oldTip) r.oldTip = finish.oldTip;
  }

  // A rebase's copy amended afterwards (the version re-bump after a conflict)
  // is still the rebase's product.
  const rebaseDerived = new Set<string>(rebaseProducts);
  const queue = [...rebaseProducts];
  while (queue.length > 0) {
    for (const n of result.amendNext.get(queue.pop()!) || []) {
      if (!rebaseDerived.has(n)) { rebaseDerived.add(n); queue.push(n); }
    }
  }
  result.rebaseDerived = rebaseDerived;
  return result;
}

// ─── Which commit a replay step replayed ──────────────────────────────────

export interface ReplayProof {
  /** original → copy, for every step whose source git's data pins down. */
  next: Map<string, Set<string>>;
  /** The commits each examined rebase replayed, with everything it produced. */
  runs: Array<{ members: Set<string>; products: Set<string> }>;
}

// A rebase run costs one git process to list what it replayed; older runs only
// matter when a newer one replayed their copies.
const RUN_READ_CAP = 6;

function addEdge(next: Map<string, Set<string>>, from: string, to: string) {
  if (from === to) return;
  if (!next.has(from)) next.set(from, new Set());
  next.get(from)!.add(to);
}

/** The one commit carrying `copy`'s author and author time; subject breaks a tie. */
function uniqueSource(copy: ReflogCommit | undefined, pool: Array<[string, ReflogCommit]>): string {
  if (!copy) return '';
  let hits = pool.filter(([, c]) => c.author === copy.author);
  if (hits.length > 1) hits = hits.filter(([, c]) => c.subject === copy.subject);
  return hits.length === 1 ? hits[0][0] : '';
}

/**
 * Which commit each rebase and cherry-pick step replayed.
 *
 * A step's reflog entry names the COPY; the original is the one commit, among
 * those the run replayed, with the copy's author and author time — both survive
 * a rebase, a reword and a conflict resolution. A fixup or squash copies the
 * target's author, so the commits it folded in are named by elimination: when
 * every other step's original is known, and exactly as many replayed commits
 * are left over as there were fixup/squash steps, all folding into one commit,
 * the leftovers are those. Anything less certain proves nothing — a false pair
 * moves a turn onto another turn's commit, a missed one only shows a duplicate.
 *
 * `interesting` are the reachable commits a pair could end on; `orphans` the
 * session's unreachable commits a cherry-pick could have copied.
 */
export function proveReplays(
  repoPath: string,
  rewrites: ReflogRewrites,
  interesting: Set<string>,
  orphans: Set<string>,
): ReplayProof {
  const proof: ReplayProof = { next: new Map(), runs: [] };

  for (const copy of rewrites.cherryPicks) {
    const c = rewrites.commits.get(copy);
    if (!c) continue;
    const pool = [...orphans].filter((o) => o !== copy && rewrites.commits.has(o))
      .map((o) => [o, rewrites.commits.get(o)!] as [string, ReflogCommit]);
    const hits = pool.filter(([, o]) => o.author === c.author && o.subject === c.subject);
    if (hits.length === 1) addEdge(proof.next, hits[0][0], copy);
  }

  const wanted = new Set(interesting);
  let reads = 0;
  for (const run of [...rewrites.rebases].reverse()) {
    const products = new Set<string>(run.steps.map((s) => s.product));
    products.add(run.finalTip);
    for (const queue = [...products]; queue.length > 0;) {
      for (const n of rewrites.amendNext.get(queue.pop()!) || []) if (!products.has(n)) { products.add(n); queue.push(n); }
    }
    if (![...products].some((p) => wanted.has(p))) continue;
    if (reads++ >= RUN_READ_CAP) break;
    const base = run.onto || run.startNew;
    const listed = gitOut(
      repoPath,
      ['log', '-n1000', `--format=%H${US}%P${US}%an <%ae> %at${US}%s`, run.oldTip, '--not', base, '--'],
      { timeout: 10000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (listed === null) continue;
    const members = new Map<string, ReflogCommit>();
    for (const line of listed.split('\n')) {
      const [sha = '', parents = '', author = '', subject = ''] = line.split(US);
      if (FULL_SHA.test(sha)) members.set(sha, { parents: parents.trim(), author, subject });
    }
    if (members.size === 0) continue;
    proof.runs.push({ members: new Set(members.keys()), products });
    for (const m of members.keys()) wanted.add(m);

    // Commits the run left as they were: `(start)` or a fast-forward moved
    // HEAD onto them rather than copying them.
    const consumed = new Set<string>();
    const keep = (tip: string) => {
      for (let x = tip; members.has(x) && !consumed.has(x);) { consumed.add(x); x = members.get(x)!.parents.split(' ')[0] || ''; }
    };
    keep(run.startNew);
    const pool = [...members];
    let certain = true;
    const folds: ReplayStep[] = [];
    for (const step of run.steps) {
      if (step.tag === 'fast-forward') { keep(step.product); continue; }
      if (!['pick', 'reword', 'edit', 'continue', 'fixup', 'squash'].includes(step.tag)) { certain = false; continue; }
      if (step.tag === 'fixup' || step.tag === 'squash') folds.push(step);
      if (members.has(step.product)) { consumed.add(step.product); continue; }
      const source = uniqueSource(rewrites.commits.get(step.product), pool);
      if (!source) { certain = false; continue; }
      consumed.add(source);
      addEdge(proof.next, source, step.product);
    }
    if (!certain || folds.length === 0) continue;
    // The commit each fold ended in: later folds amend the previous one.
    const finalOf = (sha: string) => {
      let at = sha;
      for (const s of folds) if (s.old === at) at = s.product;
      return at;
    };
    const finals = new Set(folds.map((s) => finalOf(s.product)));
    const left = [...members.keys()].filter((m) => !consumed.has(m));
    if (finals.size !== 1 || left.length !== folds.length) continue;
    const [final] = finals;
    for (const m of left) addEdge(proof.next, m, final);
  }
  return proof;
}

/** Did git's record — amends, replay steps, chains of both — turn `from` into `to`? */
export function rewriteReaches(rewrites: ReflogRewrites, proof: ReplayProof | null, from: string, to: string): boolean {
  const start = from.toLowerCase();
  const target = to.toLowerCase();
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const edges of [rewrites.amendNext.get(at), proof?.next.get(at)]) {
      for (const n of edges || []) {
        if (n === target) return true;
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
  }
  return false;
}

/** Did a chain of `commit (amend)` entries turn `from` into `to`? */
export function amendReaches(rewrites: ReflogRewrites, from: string, to: string): boolean {
  return rewriteReaches(rewrites, null, from, to);
}

/** Was `orphan` among the commits a rebase run replayed, where that run produced `copy`? */
export function replayedInto(proof: ReplayProof, orphan: string, copy: string): boolean {
  const o = orphan.toLowerCase();
  const c = copy.toLowerCase();
  return proof.runs.some((r) => r.members.has(o) && r.products.has(c));
}
