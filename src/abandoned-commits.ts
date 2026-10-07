/**
 * The session's own commits that git proves were thrown away.
 *
 * Session 874ff028 committed "wip", ran `git reset --soft HEAD~1 && git reset`,
 * and committed again under the same subject; a background job it started did
 * the same to a WIP commit of its own. Post-commit had recorded every one of
 * them, so each Stop and session end kept sending them in the session's
 * `commitShas`. The server linked them to the session, and the read path —
 * finding commits no turn row held — badged them onto turn 1: a turn showed
 * a WIP commit turn 2 made and reset away, and the session listed four commits
 * for two.
 *
 * #1681 gave the server `gitCapture.abandonedCommits` to take such commits off a
 * session. Nothing sent it. This is the CLI half.
 *
 * Unreachable is NOT abandoned: a branch deleted after its PR merged leaves its
 * commits unreachable and still the turns' work (see
 * commit-patch-survives-a-deleted-branch). A recorded commit is abandoned only
 * when every one of these holds:
 *   - HEAD cannot reach it, no user branch, remote-tracking branch or tag
 *     contains it, and no other worktree stands on it;
 *   - it is not the OLD side of a rewrite pair — an amended, rebased or
 *     squashed commit is superseded, which the server handles separately. The
 *     NEW side is a commit like any other and can be thrown away in turn:
 *     session 507dca76 rebased "wip" (fe96a3f1 -> 8c9964cc), then reset off
 *     8c9964cc and committed its work again with a version bump (7590cb76,
 *     squash-merged as 8017df53). Skipping both sides kept 8c9964cc as live
 *     work, and the turn showed it beside the squash: "2 commits total
 *     +599/-11" for +301/-7;
 *   - a `reset:` in the reflog of the branch this tree is on (its HEAD's,
 *     when detached) moved off it: from a commit containing it to a strict
 *     ancestor of it. A reset on another branch, or on one since deleted — the
 *     cleanup after a squash-merge — proves nothing about this line of work,
 *     with one exception: a branch another worktree still stands on, where a
 *     commit FOLLOWED the reset (a sub-agent's worktree resetting its WIP and
 *     redoing it — session df8cc9aa);
 *   - no commit HEAD reached since its parent carries its tree or its patch —
 *     that is a squash or a replay, which is supersession's to prove.
 * Anything short of that proof is kept, and so is anything git could not
 * answer: a read that failed — a timeout, an output past the buffer, an
 * unreadable object — is not a "no".
 */
import { execFileSync } from 'child_process';
import { commitsHeldByRefs } from './refs-holding.js';
import type { ReflogRewrites } from './rewrite-proof.js';

const gitOpts = (cwd: string) => ({
  windowsHide: true,
  cwd,
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  timeout: 5000,
});

const HEX = /^[0-9a-fA-F]{7,64}$/;

// Origin's own refs are built on top of HEAD (shadow and snapshot commits take
// it as a parent), so they contain every commit HEAD ever stood on.
const ORIGIN_REF = /^refs\/(?:heads|remotes\/[^/]+)\/(?:origin\/shadow\/|origin\/snapshots\/|origin-sessions$)/;

/**
 * true / false / null when git could not answer. `merge-base --is-ancestor`
 * says "no" with exit code 1 and ONLY that; every other status is an error
 * (a missing object, a broken repository), which proves nothing either way.
 */
function isAncestor(repoPath: string, ancestor: string, of: string): boolean | null {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, of], gitOpts(repoPath));
    return true;
  } catch (err: unknown) {
    return (err as { status?: number } | null)?.status === 1 ? false : null;
  }
}

function fullSha(repoPath: string, sha: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], gitOpts(repoPath)).toString().trim().toLowerCase();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : '';
  } catch { return ''; }
}

function heldByAUserRef(repoPath: string, sha: string): boolean {
  let out: string;
  try {
    out = execFileSync(
      'git', ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
      gitOpts(repoPath),
    ).toString();
  } catch { return true; } // cannot tell — keep it
  return out.split('\n').map((l) => l.trim()).some((ref) => ref && !ORIGIN_REF.test(ref));
}

// Past this many commits between the orphan's parent and HEAD the rewrite
// check is not attempted, and the commit is kept.
const REWRITE_WINDOW_CAP = 500;

function gitText(repoPath: string, args: string[], input?: string): string | null {
  try {
    return execFileSync('git', args, { ...gitOpts(repoPath), maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) }).toString();
  } catch { return null; }
}

/**
 * The patch-ids of a patch, or null when it could not be computed: the patch
 * itself unreadable, or `patch-id` unable to run. An EMPTY set is a real
 * answer (an empty commit has no patch); null is "the comparison did not
 * happen", which must never read as "the patch is not there".
 */
function patchIdsOf(repoPath: string, patchText: string | null): Set<string> | null {
  if (patchText === null) return null;
  const ids = gitText(repoPath, ['patch-id', '--stable'], patchText);
  if (ids === null) return null;
  return new Set(ids.split('\n').map((l) => l.split(' ')[0]).filter(Boolean));
}

/**
 * true when HEAD reached, since `sha`'s parent, a commit carrying its tree or
 * its patch; false when it provably did not; null when git could not say.
 */
function survivesElsewhere(repoPath: string, sha: string, tip = 'HEAD'): boolean | null {
  const parent = (gitText(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^`]) ?? '').trim();
  if (!parent) return true;
  const trees = gitText(repoPath, ['log', `-n${REWRITE_WINDOW_CAP + 1}`, '--format=%T', `${parent}..${tip}`]);
  if (trees === null) return true;
  const windowTrees = trees.split('\n').filter(Boolean);
  if (windowTrees.length > REWRITE_WINDOW_CAP) return true;
  if (windowTrees.length === 0) return false;
  const tree = (gitText(repoPath, ['rev-parse', `${sha}^{tree}`]) ?? '').trim();
  if (!tree || windowTrees.includes(tree)) return true;
  const own = patchIdsOf(repoPath, gitText(repoPath, ['show', '--format=commit %H', sha]));
  if (own === null) return null;
  // A successful empty answer: the commit carries no patch to find elsewhere.
  if (own.size === 0) return false;
  const window = patchIdsOf(repoPath, gitText(repoPath, ['log', '-p', '--format=commit %H', `${parent}..${tip}`]));
  if (window === null) return null;
  return [...own].some((id) => window.has(id));
}

/** The reflog a reset of this tree's own line of work is recorded in. */
function currentRef(repoPath: string): string {
  return (gitText(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? '').trim() || 'HEAD';
}

/**
 * The branch every worktree of this repository stands on (short name) and the
 * commit it stands on, or null when git could not list them. Detached trees
 * have no branch and are left out.
 */
function worktreeBranches(repoPath: string): Map<string, string> | null {
  let out: string;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], gitOpts(repoPath)).toString();
  } catch { return null; }
  const branches = new Map<string, string>();
  let head = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('HEAD ')) head = line.slice(5).trim();
    else if (line.startsWith('branch refs/heads/') && HEX.test(head)) branches.set(line.slice('branch refs/heads/'.length).trim(), head);
    else if (line.trim() === '') head = '';
  }
  return branches;
}

/** The HEAD of every worktree of this repository, or null when git could not list them. */
function worktreeHeads(repoPath: string): string[] | null {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], gitOpts(repoPath)).toString()
      .split('\n')
      .filter((l) => l.startsWith('HEAD '))
      .map((l) => l.slice(5).trim())
      .filter((h) => HEX.test(h));
  } catch { return null; }
}

/**
 * Full shas of the `recorded` commits git proves were reset away. `rewrites`
 * are the session's known rewrite pairs; `reflog` is readReflogRewrites' walk,
 * taken lazily only when an orphan needs it.
 */
export function provenAbandonedCommits(
  repoPath: string,
  recorded: readonly string[],
  rewrites: ReadonlyArray<{ from?: string; to?: string }>,
  reflog: () => ReflogRewrites,
): string[] {
  const out: string[] = [];
  // Each read once, and only when an orphan first needs it.
  let rewritten: Set<string> | null = null;
  let heads: string[] | null | undefined;
  let walk: ReflogRewrites | null = null;
  let ref: string | null = null;
  let branches: Map<string, string> | null | undefined;
  // Every recorded commit's "does a user ref hold it?" in one rev-list
  // (refs-holding.ts), asked the first time an orphan needs it. A commit the
  // batch did not answer falls back to heldByAUserRef.
  let heldBatch: Map<string, boolean> | null | undefined;
  const heldByUserRef = (full: string): boolean => {
    if (heldBatch === undefined) {
      const all = [...new Set(recorded.filter((s) => HEX.test(s)).map((s) => fullSha(repoPath, s)).filter(Boolean))];
      heldBatch = commitsHeldByRefs(repoPath, all, { namespaces: ['refs/heads', 'refs/remotes', 'refs/tags'], excludeRef: (r) => ORIGIN_REF.test(r) });
    }
    const hit = heldBatch?.get(full);
    return hit !== undefined ? hit : heldByAUserRef(repoPath, full);
  };
  const rewrittenShas = (): Set<string> => (rewritten ??= new Set(
    rewrites.map((r) => r.from).filter((s): s is string => !!s).map((s) => fullSha(repoPath, s) || s.toLowerCase()),
  ));
  // Every step is asked for a PROVEN no. A step git could not run keeps the
  // commit: the session's real work must never be unlinked on a failed read.
  for (const sha of new Set(recorded.filter((s) => HEX.test(s)))) {
    if (isAncestor(repoPath, sha, 'HEAD') !== false) continue;
    const full = fullSha(repoPath, sha);
    if (!full || out.includes(full) || rewrittenShas().has(full)) continue;
    if (heldByUserRef(full)) continue;
    if (heads === undefined) heads = worktreeHeads(repoPath);
    if (heads === null) continue;
    if (heads.some((h) => isAncestor(repoPath, full, h) !== false)) continue;
    ref ??= currentRef(repoPath);
    if (branches === undefined) branches = worktreeBranches(repoPath);
    const movedOff = (r: { from: string; to: string }) => r.to !== full
      && isAncestor(repoPath, full, r.from) === true
      && isAncestor(repoPath, r.to, full) === true;
    walk ??= reflog();
    if (walk.resets.some((r) => r.ref === ref && movedOff(r))) {
      if (survivesElsewhere(repoPath, full) === false) out.push(full);
      continue;
    }
    // The commit was made in ANOTHER worktree of this session — a sub-agent's
    // isolated worktree — and reset away and redone there. Session df8cc9aa
    // turn 30: a sub-agent committed "WIP" 87c4cc36 on its own branch,
    // `reset HEAD~1`, and committed the work again (rebased, squash-merged as
    // #2087). The reset sat in that branch's reflog, never in the reflog of
    // the branch the session's own tree was on, so 87c4cc36 stayed live work
    // and the turn listed it beside the real commits ("3 commits net
    // +680/-91" for +462/-60). Accepted only when a worktree still stands on
    // that branch AND a commit followed the reset there — a cleanup after a
    // squash-merge resets and stops — and when neither that branch nor this
    // tree's HEAD carries the commit's tree or patch.
    const other = walk.resets.find((r) => r.ref !== ref && r.redone && branches?.has(r.ref) && movedOff(r));
    if (!other) continue;
    const tip = branches!.get(other.ref)!;
    if (survivesElsewhere(repoPath, full, tip) === false && survivesElsewhere(repoPath, full) === false) out.push(full);
  }
  return out;
}
