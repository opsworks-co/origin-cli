/**
 * A committed turn's diff is the commit's patch, not the ledger's rendering.
 *
 * The write journal observes what a turn wrote and renders it as a diff of its
 * own. That rendering is content-correct — it reproduces the committed file
 * byte for byte — but it is one of several valid diffs of the same change, and
 * git picks another. Prod vodka 5adc4b18 turn 8: the ledger aligned two blank
 * lines as context where git aligned them as a delete/insert pair, so the turn
 * card read +590/-630 under a commit badge reading +592/-632. Both were right
 * about the change and the page still contradicted itself.
 *
 * Post-commit had already sent the exact answer — the commit scoped to the
 * turn's baseline — and Stop then overwrote it, because the server keeps the
 * capture with the newer stamp and Stop's is always newer.
 *
 * So when a turn's work is entirely in its commits, Stop sends the same patch
 * post-commit did: `git diff` from the turn's baseline shadow to its last
 * reachable commit, over the files the turn touched. A turn with only a merge
 * uses its first parent and resolution files, even without a prompt shadow.
 * That is the diff the
 * commit badge, the commit detail and blame all read from, so every surface
 * shows one number.
 *
 * The rule stands down whenever the ledger knows more than the commit does:
 *   • a file the turn wrote is dirty against the commit (commit-and-go), or
 *     untracked — the ledger's diff carries the uncommitted part;
 *   • no commit of the turn is still reachable and none is stranded on a
 *     branch (an amend that the rescue has not yet mapped) — there is nothing
 *     exact to point at;
 *   • the scoped patch is empty — the commit only shipped an earlier turn's
 *     work, and the ledger's answer for THIS turn is the one to keep.
 *
 * A turn whose commits sit on SEVERAL branches is the exception to "one range
 * off HEAD" — see patchAcrossBranches.
 *
 * The pathspec is the COMMIT's files, not the mapping's. Stop rebuilds every
 * turn from `git diff <baseline>..HEAD` before this pass runs. A mid-turn
 * `git checkout` that fast-forwards (session 761adbe8 turn 5) puts the whole
 * range — 41 files / +2615 — on the mapping. Diffing baseline→commit over
 * those files reproduces the range, which is exactly the number the commit
 * badge disagrees with. `git show --name-only` of the turn's own commits is
 * what the badge counts; that is the pathspec.
 *
 * This pass runs on EVERY committed turn in the payload, not only the closing
 * one. Stop re-sends the whole list on every call (and again at session-end)
 * with a newer stamp. Skipping a settled turn left the reconstructed range
 * on the wire, so the card flapped: post-commit's 4 files, then Stop's 41.
 *
 * Provenance stays `ledger`: the content is still the turn's observed writes,
 * now in git's rendering, and every reader of that marker (the server's
 * editsJson stripping, keepRicherTurnCapture, the heartbeat) treats it as an
 * observation rather than a reconstruction — which it is.
 */
import { mergeOwnDiff } from './history-backfill.js';
import { commitsHeldByRefs } from './refs-holding.js';
import { execFileSync } from 'child_process';
import { isOriginAutoManagedPath } from './ignore-patterns.js';
import { commitDiffScopedToPrompt, MAX_DIFF_SIZE, MAX_PROMPT_DIFF_LEN, readFileAtRev, shadowHeadOf, startDirtOnInherited, writeBlob } from './git-capture.js';
import { localTurnForServerRow } from './turn-index.js';
import type { TurnObservation } from './resolve-turn.js';

const HEX = /^[a-fA-F0-9]{7,40}$/;
/** git's empty tree: the "parent" of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface CommittedTurnState {
  /** LOCAL-numbered: index L is this launch's turn L. */
  promptTurnIds?: string[];
  commitTurns?: Array<{ sha: string; turnId: string; at?: string }>;
  /** LOCAL-numbered, like the ids. */
  promptShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  /** LOCAL-numbered: the start of each prompt in the linked worktree it wrote in. */
  promptWorkTreeShadows?: Array<{ promptIndex: number; path?: string; shadowSha: string }>;
  /** The latest prompt's worktree start — see session-state.ts. */
  prePromptWorkTree?: { path?: string; sha: string; promptIndex: number } | null;
  prePromptSha?: string | null;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /** Squash / amend rewrites the session has seen: original → survivor. */
  rewrittenCommits?: Array<{ from: string; to: string }>;
  /** Each turn's own commit, one hop short of a squash that folded several
   *  turns' commits together — see foldCommitRecordsToSurvivors. */
  preSquashCommitTurns?: Array<{ sha: string; turnId: string; squash: string }>;
  /** A turn's commit a later rewrite replaced, kept with the turn that made it. */
  foldedCommitTurns?: Array<{ sha: string; turnId: string }>;
}

/** Recorded shas may be short or differently cased; seven hex digits is git's own floor. */
function sameSha(a: string, b: string): boolean {
  const x = String(a || '').toLowerCase(); const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || (x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

/** The survivors of `sha` through every recorded rewrite, nearest first. */
function rewritesOf(sha: string, rewrites: Array<{ from: string; to: string }>): string[] {
  const out: string[] = [];
  let cur = sha;
  for (let i = 0; i < 8; i++) {
    const next = rewrites.find((r) => r.from === cur && HEX.test(r.to || ''))?.to;
    if (!next || out.includes(next)) break;
    out.push(next);
    cur = next;
  }
  return out;
}

export interface CommittedTurnMapping {
  promptIndex: number;
  commitSha?: string | null;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  /** Files of the turn whose content the diff does not carry. */
  contentUnavailableFiles?: string[];
  /**
   * The diff IS the turn's commit patch. Sent on the wire so the server keeps
   * it against a later, smaller capture of the same turn. Set only by this
   * pass, and cleared at the start of it, so it always describes the content
   * the mapping carries now.
   */
  commitPatch?: boolean;
  /**
   * Every commit the patch stands for: the turn's own commits and their
   * rewrites. Sent beside `commitPatch` so the server can tell a patch of the
   * row's OWN commit from a patch of another one — a row stamped with the
   * turn's last commit is not "another commit" to a patch labelled with its
   * first (session 690e594c turn 6, 2026-09-27).
   */
  patchCommits?: string[];
  /** The row's content, even when empty, replaces what is stored. */
  contentAuthoritative?: boolean;
  /** An empty row's mark; a patch landing here contradicts it (chat-only-flag.ts). */
  chatOnly?: boolean;
}

export interface PreferCommitPatchDeps {
  /**
   * The newest commit in the turn's window that the turn did not author — see
   * inherited-window-baseline.ts. Injected rather than computed here: the
   * predicate lives in hooks.ts, which imports this module.
   *
   * Omit and the turn is measured from its shadow exactly as before.
   */
  inheritedBaseline?: (shadowSha: string, localTurn: number) => string | null;
  /**
   * Per-file inherited sources, matching post-commit's scoping. `endSha` is
   * the turn's own last commit, which bounds the window the resolver walks and
   * narrows it by pathspec — see `inheritedFileSourcesForTurn`.
   */
  inheritedFiles?: (shadowSha: string, localTurn: number, files: string[], endSha: string) => Map<string, string> | null;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** What this pass found for each row — see resolve-turn.ts. */
  observe?: (promptIndex: number, observation: TurnObservation) => void;
}

/** The paths a unified diff names, in order, without duplicates. */
export function pathsInDiff(diff: string): string[] {
  const out: string[] = [];
  for (const m of (diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const p = m[2];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function git(repoPath: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: repoPath, encoding: 'utf-8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    }).toString();
    return { ok: true, out };
  } catch {
    return { ok: false, out: '' };
  }
}

const isAncestor = (repoPath: string, a: string, b: string) =>
  git(repoPath, ['merge-base', '--is-ancestor', a, b]).ok;

function declined(deps: PreferCommitPatchDeps, pm: CommittedTurnMapping, reason: string): void {
  deps.observe?.(pm.promptIndex, { source: 'commit-patch', outcome: 'declined', reason });
}

/** Report the content this pass just put on the row. */
function applied(deps: PreferCommitPatchDeps, pm: CommittedTurnMapping): void {
  deps.observe?.(pm.promptIndex, {
    source: 'commit-patch', outcome: 'applied',
    files: ledgerFilesOf(pm), diff: pm.diff || '', added: pm.linesAdded ?? 0, removed: pm.linesRemoved ?? 0,
    contentUnavailable: [...(pm.contentUnavailableFiles || [])],
  });
}

/** The files a mapping's ledger capture named. */
function ledgerFilesOf(pm: CommittedTurnMapping): string[] {
  return Array.isArray(pm.filesChanged)
    ? (pm.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string' && !!f)
    : [];
}

/** The files the commits name, first-seen order. */
function filesOfCommits(repoPath: string, shas: string[]): string[] {
  const seen = new Set<string>();
  for (const sha of shas) {
    const named = git(repoPath, ['show', '--no-renames', '--name-only', '--format=', sha]);
    if (!named.ok) continue;
    for (const f of named.out.split('\n').map((l) => l.trim()).filter(Boolean)) seen.add(f);
  }
  return [...seen];
}

/** `git patch-id --stable` of patch text, per commit; '' when git cannot answer. */
function patchIds(repoPath: string, text: string): string[][] {
  if (!text.trim()) return [];
  try {
    return execFileSync('git', ['patch-id', '--stable'], {
      cwd: repoPath, input: text, encoding: 'utf-8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    }).toString().split('\n').map((l) => l.trim().split(/\s+/)).filter((cols) => cols.length === 2 && !!cols[0]);
  } catch { return []; }
}

/**
 * The commit on HEAD's line that carries exactly `chain`'s patch and is none
 * of the turn's own commits: the squash a forge made of that branch. Null when
 * there is none, or git cannot say. Searched from the chain's parent, merges
 * left out (a squash is a single-parent commit), and bounded.
 */
function forgeSquashOnHead(repoPath: string, chain: CommitChain, turnCommits: string[]): string | null {
  const parent = git(repoPath, ['rev-parse', '--verify', '-q', `${chain.first}^1`]).out.trim();
  if (!HEX.test(parent)) return null;
  const want = patchIds(repoPath, git(repoPath, ['diff', '--no-color', parent, chain.tip]).out)[0]?.[0];
  if (!want) return null;
  const log = git(repoPath, ['log', '--no-merges', '--no-color', '-p', '--format=commit %H', '--max-count=300', `${parent}..HEAD`]);
  if (!log.ok) return null;
  for (const [id, sha] of patchIds(repoPath, log.out)) {
    if (id === want && HEX.test(sha) && !turnCommits.some((t) => sameSha(t, sha))) return sha;
  }
  return null;
}

/** Commits of a turn that sit on one line of history: `first` is the oldest, `tip` the newest. */
interface CommitChain { first: string; tip: string; members: string[] }

/**
 * Group commits by ancestry. Input order does not matter: a child listed
 * before its parent joins the parent's chain rather than opening a second one,
 * which would count the parent's lines twice. One commit costs no git call.
 */
function chainsOf(repoPath: string, shas: string[]): CommitChain[] {
  const chains: CommitChain[] = [];
  for (const sha of shas) {
    const chain = chains.find((c) => isAncestor(repoPath, c.tip, sha) || isAncestor(repoPath, sha, c.tip));
    if (!chain) { chains.push({ first: sha, tip: sha, members: [sha] }); continue; }
    chain.members.push(sha);
    if (isAncestor(repoPath, chain.tip, sha)) chain.tip = sha;
    if (isAncestor(repoPath, sha, chain.first)) chain.first = sha;
  }
  return chains;
}

/**
 * Where a chain of the turn's commits stands relative to the tree at Stop.
 *
 *   • `reachable` — a member, or a recorded rewrite of one, is an ancestor of
 *     HEAD. One range off HEAD describes it.
 *   • `carried` — HEAD does not reach it, but its files read the same in HEAD
 *     as at its tip (a squash the session never saw as a rewrite).
 *   • `stranded` — work that sits on ANOTHER branch: HEAD neither reaches nor
 *     carries it, and it is still the turn's commit. Sent as that branch's own
 *     patch (patchAcrossBranches).
 *     Also a chain that was folded, together with OTHER turns' commits, into
 *     one squash: the squash is nobody's turn, so each is sent as its own.
 *   • `superseded` — an amended-away original. It sits on no branch, and its
 *     replacement — a commit of the same turn with the same parents — is what
 *     the turn actually made. Left out, or the amend counts twice.
 *
 * A branch still holding the tip settles `stranded` outright, remote-tracking
 * branches included: a pushed commit is real work whether or not the local
 * branch outlived the push. Origin's shadow refs do not count — a snapshot can
 * still hold an amended-away original. That is the same line the rescue draws
 * (`onLiveBranch` in hooks.ts).
 *
 * When NO branch holds the tip, the two remaining readings are told apart by
 * the turn's other commits. Session 674d384a turn 1 ran `git checkout -B
 * pr-1701 origin/<pr>`, committed +11/-3, pushed, checked the original branch
 * back out and deleted `pr-1701` — all before Stop. The commit was the turn's
 * only one, nothing of the turn was in HEAD, and the working tree was clean;
 * the old local-branch test read that as "no branch's work", declined, and
 * Stop sent {f:0, a:0, r:0, c:null} over post-commit's correct row. A commit
 * with no same-parent sibling that is reachable, held by a branch, recorded
 * as its rewrite, or simply newer, is not an amend of anything: it is the
 * turn's work with its branch gone.
 *
 * Two branches cut from the same commit and both deleted before Stop share a
 * parent, so only the newer is sent here. That trade is deliberate: an amend
 * pair looks exactly the same, and counting it twice is the worse error.
 */
type ChainStanding = 'reachable' | 'carried' | 'stranded' | 'superseded';

const SHADOW_REF = /(^|\/)shadow(\/|$)/;

/**
 * Answer heldByABranch for many commits at once (refs-holding.ts): one
 * rev-list for the whole pass instead of a `for-each-ref --contains` per
 * chain. A commit the batch could not answer is left out and falls through
 * to the per-commit query below.
 */
function prefillHeldByABranch(repoPath: string, shas: readonly string[], cache: Map<string, boolean>): void {
  const need = shas.filter((sha) => !cache.has(sha));
  if (need.length === 0) return;
  const held = commitsHeldByRefs(repoPath, need, { namespaces: ['refs/heads', 'refs/remotes'], excludeRef: (ref) => SHADOW_REF.test(ref) });
  if (!held) return;
  for (const [sha, isHeld] of held) cache.set(sha, isHeld);
}

/** Refs holding `sha`, cached per pass: one `for-each-ref` per chain. */
function heldByABranch(repoPath: string, sha: string, cache: Map<string, boolean>): boolean {
  const hit = cache.get(sha);
  if (hit !== undefined) return hit;
  const refs = git(repoPath, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const held = refs.out.split('\n').map((r) => r.trim()).some((r) => !!r && !SHADOW_REF.test(r));
  cache.set(sha, held);
  return held;
}

function chainStanding(
  repoPath: string,
  chain: CommitChain,
  siblings: CommitChain[],
  reachable: string[],
  rewrites: Array<{ from: string; to: string }>,
  refCache: Map<string, boolean>,
  intoSharedSquash = false,
): ChainStanding {
  if (chain.members.some((m) => reachable.includes(m) || rewritesOf(m, rewrites).some((r) => reachable.includes(r)))) return 'reachable';
  // Folded, with other turns' commits, into one squash. Every test below would
  // misread it: HEAD "carries" the last turn's tip, and the squash sits on the
  // first commit's parents exactly as an amend would. It is this turn's work
  // and is sent as its own patch.
  if (intoSharedSquash) return 'stranded';
  const files = filesOfCommits(repoPath, chain.members);
  if (files.length === 0) return 'carried';
  if (git(repoPath, ['diff', '--quiet', chain.tip, 'HEAD', '--', ...files]).ok) return 'carried';
  if (heldByABranch(repoPath, chain.tip, refCache)) return 'stranded';
  // No branch holds it. A recorded rewrite whose survivor still exists says
  // what replaced it, wherever that survivor sits.
  if (chain.members.some((m) => rewritesOf(m, rewrites).some((r) => git(repoPath, ['cat-file', '-e', `${r}^{commit}`]).ok))) return 'superseded';
  const facts = (sha: string) => {
    const line = git(repoPath, ['show', '-s', '--format=%P%n%ct', sha]).out.split('\n');
    return { parents: (line[0] || '').trim(), at: Number((line[1] || '').trim()) || 0 };
  };
  const own = facts(chain.first);
  if (!own.parents) return 'stranded';
  // Left behind by a rewrite of its own base. The commit this chain was built
  // on was rewritten (a rebase, an amend — post-rewrite recorded it), and the
  // chain was not: a rewrite that carries a commit along records that commit
  // too. So the line it sat on was replaced without it, and no branch holds it
  // (tested above). Whatever of it was kept lives in what replaced that line.
  //
  // Session 690e594c (CLI .1910): turn 1's bump f1e51e72 sat on f2c1714b; the
  // branch was rebased (f2c1714b → f400d05f) and the bump redone on the new
  // base as a2bed1ad, later squashed into 21b78c57. The same-parents test
  // below could not pair f1e51e72 with its redo — the parents differ by that
  // very rewrite — so it stood `stranded`, became a branch of its own, its
  // package.json a second section beside the squash's, and the row's primary
  // sha. Turn 2's bump 4a3e48f9 (on 2acb028d → a36bee48) was the same shape.
  const base = own.parents.split(' ')[0];
  const baseRewritten = rewrites.some((r) => HEX.test(r.to || '') && sameSha(r.from, base));
  const chainRewritten = chain.members.some((m) => rewrites.some((r) => sameSha(r.from, m)));
  if (baseRewritten && !chainRewritten) return 'superseded';
  for (const sibling of siblings) {
    if (sibling === chain) continue;
    const theirs = facts(sibling.first);
    if (theirs.parents !== own.parents) continue;
    const held = sibling.members.some((m) => reachable.includes(m)) || heldByABranch(repoPath, sibling.tip, refCache);
    if (held || theirs.at > own.at) return 'superseded';
  }
  // The replacement may not be attested to the turn at all — an amend the
  // rescue has not yet mapped. It is still on HEAD's line, as a child of the
  // same parents: `git commit --amend` keeps them. A parent HEAD does not
  // reach cannot have been amended into HEAD (the 674d384a commit sat on a
  // PR tip the tree never held).
  const parents = own.parents.split(' ');
  if (!parents.every((p) => isAncestor(repoPath, p, 'HEAD'))) return 'stranded';
  const line = git(repoPath, ['rev-list', '--parents', '--max-count=5000', `${parents[0]}..HEAD`]).out;
  const replacedOnHead = line.split('\n').some((l) => {
    const cols = l.trim().split(' ');
    return cols.length > 1 && cols.slice(1).join(' ') === own.parents;
  });
  return replacedOnHead ? 'superseded' : 'stranded';
}

/**
 * A turn that committed on several branches is the union of each branch's own
 * patch, not one range off HEAD.
 *
 * Session 049d69db row 15 opened four PR branches from the same main commit
 * and committed on each. Every Stop ran from whichever branch was checked out,
 * found one of the four reachable, and sent baseline→that commit — a different
 * single branch each time. Once the tree moved to a fifth branch none was
 * reachable, the pass declined, and the row fell back to a ledger the checkout
 * fences had cut: "+9 -1, 2 files" beside "4 commits total +866/-179".
 *
 * Each chain is diffed from its first commit's parent — the tree that branch's
 * work was written on — to its tip, over its own commits' files. Neither the
 * turn's shadow nor HEAD can serve as a base for a branch the tree is not on.
 * Two branches that both bump package.json send two sections for it; that is
 * the shape a concatenated multi-commit diff already has, and every reader
 * sums sections per path (see the server's diff-repeat-inflation.ts).
 *
 * Returns true when the mapping took the union.
 */
type ScopedPatch = NonNullable<ReturnType<typeof commitDiffScopedToPrompt>>;

/**
 * One branch's own patch: `base` → its tip, cut at every MERGE of the chain.
 *
 * A single range across a merge carries everything the merge brought in.
 * Session d027b430 turn 9 merged main into its PR branch and bumped the
 * version; the chain's range ran from the branch's pre-merge commit to the
 * bump and read +90/-1 — 89 of them #1922's and #1926's lines, which main
 * had and the turn never wrote. Post-commit had logged the right answer,
 * "crediting the session with its resolution only".
 *
 * So the ranges between merges are diffed as before, and each merge counts
 * its resolution only (mergeOwnDiff) — the same rule the single-range path
 * applies to a turn whose only commit is a merge. A clean merge adds nothing.
 * Sections repeat per path across segments, as they already do across
 * branches.
 *
 * Null when any piece cannot be diffed.
 */
function chainPatch(
  repoPath: string,
  chain: CommitChain,
  base: string,
  budget: number,
  /** The files this turn changed — see turnStart in patchAcrossBranches. */
  only: Set<string>,
  /** file → the shadow, for files measured from what the turn started with. */
  inheritedFrom: Map<string, string> | null,
): ScopedPatch | null {
  const EMPTY: ScopedPatch = { diff: '', linesAdded: 0, linesRemoved: 0, files: [], diffTruncated: false };
  const own = (files: string[]) => files.filter((f) => only.has(f));
  const isMerge = (sha: string) =>
    git(repoPath, ['rev-list', '--parents', '-n', '1', sha]).out.trim().split(/\s+/).length > 2;
  const merges = chain.members.filter(isMerge);
  if (merges.length === 0) {
    const files = own(filesOfCommits(repoPath, chain.members));
    return files.length === 0 ? EMPTY : commitDiffScopedToPrompt(repoPath, base, chain.tip, files, budget, inheritedFrom);
  }

  // Oldest first, by ancestry. `rev-list` of the tip lists every member.
  const order = git(repoPath, ['rev-list', '--topo-order', '--reverse', chain.tip]);
  if (!order.ok) return null;
  const members = order.out.split('\n').map((l) => l.trim())
    .filter((sha) => chain.members.some((m) => sameSha(m, sha)));
  if (members.length !== chain.members.length) return null;

  const pieces: ScopedPatch[] = [];
  let from = base;
  let run: string[] = [];
  const flush = (to: string): boolean => {
    const files = own(filesOfCommits(repoPath, run));
    if (run.length === 0 || files.length === 0) { run = []; return true; }
    const piece = commitDiffScopedToPrompt(repoPath, from, to, files, budget, from === base ? inheritedFrom : null);
    if (!piece) return false;
    pieces.push(piece);
    run = [];
    return true;
  };
  let prev = '';
  for (const sha of members) {
    if (!isMerge(sha)) { run.push(sha); prev = sha; continue; }
    if (!flush(prev)) return null;
    const resolution = mergeOwnDiff(repoPath, sha);
    if (!resolution) return null;
    const resolved = own(resolution.filesChanged);
    if (resolved.length > 0) {
      const mergeBase = resolution.baseline || git(repoPath, ['rev-parse', `${sha}^1`]).out.trim();
      const piece = commitDiffScopedToPrompt(repoPath, mergeBase, sha, resolved, budget);
      if (!piece) return null;
      pieces.push(piece);
    }
    from = sha;
    prev = sha;
  }
  if (!flush(prev)) return null;

  return {
    diff: pieces.map((p) => p.diff).filter((d) => d.trim()).map((d) => (d.endsWith('\n') ? d : `${d}\n`)).join(''),
    linesAdded: pieces.reduce((n, p) => n + p.linesAdded, 0),
    linesRemoved: pieces.reduce((n, p) => n + p.linesRemoved, 0),
    files: [...new Set(pieces.flatMap((p) => p.files))],
    diffTruncated: pieces.some((p) => p.diffTruncated),
  };
}

/**
 * Inherited sources, with the turn's starting dirt laid over each file a move
 * brought in (inheritedWithStartDirt). A file both uncommitted at the turn's
 * start and changed by the commit it rebased onto is measured from that merge,
 * so the replayed earlier-turn work is not billed again (690e594c turn 1).
 * A file that cannot be merged keeps its source.
 */
function withStartDirt(
  repoPath: string,
  shadow: string | null,
  sources: Map<string, string>,
): Map<string, string> {
  const head = shadow ? shadowHeadOf(repoPath, shadow) : null;
  if (!head || !shadow || sources.size === 0) return sources;
  const out = new Map(sources);
  for (const [file, rev] of sources) {
    if (!HEX.test(rev)) continue;
    const merged = startDirtOnInherited(repoPath, head, file, readFileAtRev(repoPath, shadow, file), readFileAtRev(repoPath, rev, file));
    if (merged === null) continue;
    const blob = writeBlob(repoPath, merged);
    if (blob) out.set(file, `blob:${blob}`);
  }
  return out;
}

function patchAcrossBranches(
  repoPath: string,
  pm: CommittedTurnMapping,
  turnId: string,
  chains: CommitChain[],
  stranded: number,
  deps: PreferCommitPatchDeps,
  stampFor: (tip: string) => string = (tip) => tip,
  /** The turn's baseline shadow, when it has one. */
  shadow: string | null = null,
  /** The turn's start in each linked worktree it wrote in. */
  workTreeShadows: string[] = [],
): boolean {
  const perChain = chains
    .map((chain) => ({ chain, files: filesOfCommits(repoPath, chain.members) }))
    .filter((x) => x.files.length > 0);
  const commitFiles = [...new Set(perChain.flatMap((x) => x.files))];
  if (commitFiles.length === 0) {
    declined(deps, pm, 'the turn\'s commits name no files');
    return false;
  }
  const tips = perChain.map((x) => x.chain.tip.slice(0, 8));

  // Same stand-downs as the single range: uncommitted work of the turn stays
  // with the ledger. Against HEAD — a file only another branch holds is simply
  // absent here, which is not dirty.
  const watch = [...new Set([...ledgerFilesOf(pm), ...commitFiles])].filter(f => !isOriginAutoManagedPath(f));
  if (watch.length > 0 && !git(repoPath, ['diff', '--quiet', 'HEAD', '--', ...watch]).ok) {
    declined(deps, pm, 'a file of the turn is dirty against its commit');
    deps.log?.('commit patch declined: a file of the turn is dirty against its commit', {
      promptIndex: pm.promptIndex, commits: tips,
      dirty: git(repoPath, ['diff', '--name-only', 'HEAD', '--', ...watch]).out.split('\n').filter(Boolean).slice(0, 10),
    });
    return false;
  }
  const untracked = watch.length > 0
    ? git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...watch])
    : { ok: true, out: '' };
  if (!untracked.ok || untracked.out.trim()) {
    declined(deps, pm, 'a file of the turn is untracked');
    deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commits: tips });
    return false;
  }

  // What the turn started with is its SHADOW: HEAD then (`shadowHead`) plus
  // whatever was uncommitted — an earlier turn's work this turn may only have
  // committed. A branch's own parent knows nothing of that, so each file is
  // held against the shadow first (turnStart):
  //
  //   • the same bytes at the branch tip as in the shadow — the turn did not
  //     change the file, whatever the commit's parent says. Session c085f0af
  //     turn 19 ran `gh pr merge --squash`; the squash (5463a6ef4) was its
  //     only commit, its content equalled the shadow file for file, and it
  //     was sent as +93/-1 against the squash's parent — turn 18's work again.
  //   • uncommitted at the start, and the branch's parent holds the same
  //     version the turn's HEAD did — measured from the shadow's version.
  //     Session d027b430 turn 7 committed turn 6's +426 as 595bc711;
  //     post-commit scoped it to the shadow and sent +0/-0, and this pass,
  //     diffing from 595bc711's parent, sent the +426 again.
  //   • anything else — from the branch's parent, as before. Where that parent
  //     moved the file since the turn began, the shadow's version would bill
  //     the move instead.
  // A turn that started on a clean tree records HEAD itself as its shadow
  // (d027b430's rows 10-12 all hold 25027d71, a release commit). Only a
  // commit createShadowCommit wrote sits on top of HEAD with the dirt in it.
  //
  // Each branch is held against the start of the checkout it was cut in. The
  // turn's shadow is of repoPath; a branch cut in a linked worktree the session
  // also wrote in starts from THAT worktree's shadow. Session 9f3d6bd2 turn 2
  // (2026-09-27): turn 1's background sub-agent wrote a test in its own
  // worktree and committed it there during turn 2. Held against repoPath's
  // shadow — another checkout, another HEAD — the file read as new, and the
  // turn was sent its +139 again. The worktree's shadow, taken as turn 2
  // began, already held those bytes. The start whose head is the branch's
  // nearest ancestor is the one it was cut from; none fits, the turn's own.
  const startOf = (sha: string) => {
    const isShadow = /^origin shadow /.test(git(repoPath, ['show', '-s', '--format=%s', sha]).out.trim());
    const head = isShadow ? git(repoPath, ['rev-parse', '--verify', '-q', `${sha}^1`]).out.trim() : sha;
    return { shadow: sha, isShadow, shadowHead: head };
  };
  const own = shadow ? startOf(shadow) : null;
  const others = [...new Set(workTreeShadows.filter((s) => HEX.test(s) && s !== shadow))].map(startOf)
    .filter((s) => HEX.test(s.shadowHead));
  const isAncestor = (a: string, b: string) => git(repoPath, ['merge-base', '--is-ancestor', a, b]).ok;
  const startFor = (parent: string) => {
    if (others.length === 0 || !HEX.test(parent)) return own;
    const fits = [own, ...others].filter((s): s is NonNullable<typeof s> => !!s && HEX.test(s.shadowHead) && isAncestor(s.shadowHead, parent));
    return fits.find((s) => fits.every((o) => o === s || isAncestor(o.shadowHead, s.shadowHead))) || own;
  };
  const namesBetween = (a: string, b: string, files: string[]): Set<string> | null => {
    const out = git(repoPath, ['diff', '--no-renames', '--name-only', a, b, '--', ...files]);
    return out.ok ? new Set(out.out.split('\n').map((l) => l.trim()).filter(Boolean)) : null;
  };
  const turnStart = (tip: string, parent: string, files: string[]) => {
    const start = startFor(parent);
    if (!start || !HEX.test(start.shadowHead)) return { only: new Set(files), inheritedFrom: null };
    const { shadow, isShadow, shadowHead } = start;
    const changed = namesBetween(shadow, tip, files);
    const dirty = isShadow ? namesBetween(shadowHead, shadow, files) : new Set<string>();
    const moved = HEX.test(parent) ? namesBetween(shadowHead, parent, files) : null;
    // A read that failed is not an answer: every file stays, from the parent.
    if (!changed || !dirty) return { only: new Set(files), inheritedFrom: null };
    const inheritedFrom = new Map<string, string>();
    for (const f of files) if (changed.has(f) && dirty.has(f) && moved && !moved.has(f)) inheritedFrom.set(f, shadow);
    //   • uncommitted at the start AND moved by the parent — the parent's
    //     version with the turn's starting dirt merged in (withStartDirt).
    if (moved && HEX.test(parent)) {
      const both = new Map(files.filter((f) => changed.has(f) && dirty.has(f) && moved.has(f)).map((f) => [f, parent] as [string, string]));
      for (const [f, src] of withStartDirt(repoPath, shadow, both)) if (src !== parent) inheritedFrom.set(f, src);
    }
    return { only: new Set(files.filter((f) => changed.has(f))), inheritedFrom: inheritedFrom.size > 0 ? inheritedFrom : null };
  };
  const parts: Array<{ scoped: NonNullable<ReturnType<typeof commitDiffScopedToPrompt>>; chain: CommitChain }> = [];
  for (const { chain, files } of perChain) {
    const parent = git(repoPath, ['rev-parse', '--verify', '-q', `${chain.first}^1`]).out.trim();
    const base = HEX.test(parent) ? parent : EMPTY_TREE;
    const { only, inheritedFrom } = turnStart(chain.tip, parent, files);
    // Step down context before upload, using the per-turn wire budget rather
    // than the much larger session budget. Reserve room for every branch.
    const budget = Math.floor(MAX_PROMPT_DIFF_LEN / perChain.length);
    const scoped = chainPatch(repoPath, chain, base, budget, only, inheritedFrom);
    // A branch that cannot be diffed would leave its work out, which is the
    // undercount this exists to fix. Keep the ledger instead.
    if (!scoped) {
      declined(deps, pm, 'a branch of the turn could not be diffed');
      deps.log?.('commit patch declined: a branch of the turn could not be diffed', { promptIndex: pm.promptIndex, commit: chain.tip.slice(0, 8) });
      return false;
    }
    if (scoped.diff.trim()) parts.push({ scoped, chain });
  }
  if (parts.length === 0) {
    declined(deps, pm, 'nothing between the turn baseline and its commit');
    deps.log?.('commit patch declined: nothing between the turn baseline and its commit', { promptIndex: pm.promptIndex, commits: tips });
    return false;
  }

  // Each part is already capped; the union is capped again by whole sections.
  let diff = '';
  let cut = false;
  for (const { scoped: part } of parts) {
    for (const section of part.diff.split(/^(?=diff --git )/m)) {
      if (!section.trim()) continue;
      const text = section.endsWith('\n') ? section : `${section}\n`;
      if (diff.length + text.length > MAX_DIFF_SIZE) { cut = true; continue; }
      diff += text;
    }
  }
  const diffTruncated = cut || parts.some((p) => p.scoped.diffTruncated);
  const named = [...new Set(parts.flatMap((p) => (p.scoped.files.length > 0 ? p.scoped.files : pathsInDiff(p.scoped.diff))))];
  const before = { linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
  const linesAdded = parts.reduce((n, p) => n + p.scoped.linesAdded, 0);
  const linesRemoved = parts.reduce((n, p) => n + p.scoped.linesRemoved, 0);
  pm.diff = diff;
  pm.filesChanged = named;
  pm.linesAdded = linesAdded;
  pm.linesRemoved = linesRemoved;
  const inText = new Set(pathsInDiff(diff));
  pm.contentUnavailableFiles = diffTruncated ? named.filter((f) => !inText.has(f)) : [];
  pm.uncommittedDiff = '';
  pm.commitPatch = true;
  delete pm.chatOnly;
  // The same attestation that supplied the patch supplies its primary SHA.
  // A stale HEAD stamp may name an unrelated commit from a branch checkout.
  //
  // Chosen among the chains that CONTRIBUTED text, not among every chain the
  // turn committed on. A commit that touches only Origin's own context files
  // — the `WIP origin context files (temporary)` an agent makes to get a dirty
  // CLAUDE.md/AGENTS.md/GEMINI.md past a rebase — scopes to an empty diff, so it
  // is in `perChain` and absent from `parts`. Listed last, it was the fallback:
  // session c085f0af turn 4 (2026-09-25) wore 2f25335c (+30/-151 of context
  // files, "0 files" once the server stripped them) as its commit while
  // 32bd8196, the fix the turn wrote and the only chain in the patch, went
  // unlinked and the page read "commit total +30/-151 · 0f".
  //
  // …and the NEWEST of those tips, not the one holding the row's local sha.
  // post-commit stamps each commit on the row as the turn makes it, so the
  // server's row names the turn's latest commit; a union sent under any other
  // of the turn's shas is refused there as "a commit patch of another commit"
  // (commit-patch-hold.ts) and the row keeps a stale capture. Session 690e594c
  // turn 6 (2026-09-27) made five commits on two branches: every Stop sent
  // +162/-4 under 1ff2abfc, the row held b2fb7f06, and it stayed at +2/-2.
  const tipTime = (tip: string) => Number(git(repoPath, ['show', '-s', '--format=%ct', tip]).out.trim()) || 0;
  const primary = parts
    .map((p) => ({ chain: p.chain, at: tipTime(p.chain.tip) }))
    .sort((a, b) => a.at - b.at)
    .pop()!.chain;
  pm.commitSha = stampFor(primary.tip);
  applied(deps, pm);
  deps.log?.('ledger diff replaced by the commit patches of several branches', {
    promptIndex: pm.promptIndex, turnId, branches: parts.length, stranded, commits: tips,
    primary: primary.tip.slice(0, 8),
    files: named.length, diffTruncated, ledgerLines: `+${before.linesAdded ?? '?'}/-${before.linesRemoved ?? '?'}`,
    commitLines: `+${linesAdded}/-${linesRemoved}`,
  });
  return true;
}

/**
 * Replace each committed, clean turn's diff with its commit patch. Mutates the
 * mappings in place, like applyLedgerCaptures, and returns how many it changed.
 * Never throws: a git failure leaves the mapping as it was.
 */
export function preferCommitPatchForCommittedTurns(
  state: CommittedTurnState,
  mappings: CommittedTurnMapping[],
  repoPath: string,
  deps: PreferCommitPatchDeps = {},
): number {
  const turns = state.commitTurns || [];
  // Earlier passes may have replaced the content a previous Stop flagged, and
  // the flag now survives the state round-trip — so it is re-earned every pass.
  for (const pm of mappings || []) if (pm) { delete pm.commitPatch; delete pm.patchCommits; }
  if (turns.length === 0 || !repoPath) {
    for (const pm of mappings || []) if (pm) declined(deps, pm, 'the session has no attested commits');
    return 0;
  }
  let replaced = 0;
  const covered = new Map<CommittedTurnMapping, string[]>();
  for (const pm of mappings) {
    // The mapping is a SERVER row; ids and shadows are numbered by this
    // launch (see turn-index.ts). A row from before the launch has neither.
    const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
    if (local === null) { declined(deps, pm, 'row predates this launch'); continue; }
    const turnId = state.promptTurnIds?.[local];
    if (!turnId) { declined(deps, pm, 'turn has no id'); continue; }
    // An empty row still reaches the several-branch check below. A turn whose
    // work sits entirely on branches the tree has left has nothing off HEAD,
    // so every pass before this one leaves its row empty — and Stop then sent
    // that empty row over post-commit's correct ones.
    // A squash that folded SEVERAL turns' commits is attested to the earliest
    // of them and is no one turn's commit. Session c98599c8 turn 12 made
    // a11fa47b (+290/-6), turn 14 added review fixes to the same branch, GitHub
    // squashed them as d1454ba0, and every later Stop measured turn 12 against
    // the squash — +414/-10, fixups it never wrote included — while turn 14
    // owned nothing of that branch. Each turn is measured from the commit it
    // made instead (patchAcrossBranches): the objects exist whether or not a
    // branch still holds them.
    const allRewrites = Array.isArray(state.rewrittenCommits) ? state.rewrittenCommits : [];
    const preSquash = (state.preSquashCommitTurns || []).filter((c) => c && HEX.test(c.sha || '') && HEX.test(c.squash || ''));
    // The shared squash AND whatever it was rewritten to afterwards: a squash
    // rebased onto a moved main (S → S') is attested as S', which is still the
    // place several turns' work merged. Left out, the first turn owned S' AND
    // its own commit, and was billed both.
    const sharedSquashes = [...new Set(preSquash.flatMap((c) => [c.squash, ...rewritesOf(c.squash, allRewrites)]))];
    const isSharedSquash = (sha: string) => sharedSquashes.some((q) => sameSha(q, sha));
    const intoSharedSquash = (sha: string) => preSquash.some((c) => sameSha(c.sha, sha));
    const own = [
      ...turns.filter((c) => c && c.turnId === turnId && typeof c.sha === 'string' && HEX.test(c.sha)
        && !isSharedSquash(c.sha) && !intoSharedSquash(c.sha)),
      ...preSquash.filter((c) => c.turnId === turnId),
    ];
    if (own.length === 0) { declined(deps, pm, 'the turn made no commit'); continue; }
    covered.set(pm, [...new Set(own.flatMap((c) => [c.sha, ...rewritesOf(c.sha, allRewrites)]))]
      .filter((sha) => !isSharedSquash(sha)));
    // Every commit of the turn that still exists as an object names the
    // pathspec, reachable from HEAD or not. The END of the range is the
    // latest commit still on the branch.
    //
    // Session 29b32c38 turn 1 made five commits on two branches, each
    // squash-merged, and twice ran `git checkout -B <new> origin/main`. At
    // the last Stop only its final commit was an ancestor of HEAD, so the
    // pathspec shrank to that commit's one file and a 120-file turn was
    // sent as `Sessions.tsx +85/-82`. The squashed content IS in HEAD —
    // that is what the checkout brought in — so diffing baseline→last over
    // the files of ALL its commits is the turn's work; only the range end
    // needs to be reachable. An amended-away sha whose object is gone
    // cannot name files and drops out here as before.
    const existing = own
      .map((c) => c.sha)
      .filter((sha) => git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]).ok);
    // The range end may be a REWRITE of the turn's commit. After the host
    // squash-merged every branch commit and the tree moved to main, none of
    // the originals is reachable but each survivor is; `rewrittenCommits`
    // is the session's own record of that. Take the newest reachable one.
    // …except INTO a squash shared with other turns — see `preSquash` above.
    const rewrites = sharedSquashes.length > 0
      ? allRewrites.filter((r) => !isSharedSquash(String(r?.to || '')))
      : allRewrites;
    const candidates = [...new Set(existing.flatMap((sha) => [sha, ...rewritesOf(sha, rewrites)]))];
    const shas = candidates.filter((sha) => git(repoPath, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok);
    // …but only when HEAD holds all of the turn's work. A branch whose
    // commits HEAD neither reaches nor carries the content of is work one
    // range off HEAD cannot describe.
    // Only a real prompt shadow: its first parent is the commit the turn
    // started on, which is what patchAcrossBranches compares against.
    const turnShadow = state.promptShadows?.find((s) => s.promptIndex === local)?.shadowSha || null;
    const workTreeShadows = [
      ...(state.promptWorkTreeShadows || []).filter((s) => s.promptIndex === local).map((s) => s.shadowSha),
      // The live slot, for a turn that began before per-prompt starts were kept.
      ...(state.prePromptWorkTree && state.prePromptWorkTree.promptIndex === local ? [state.prePromptWorkTree.sha] : []),
    ];
    if (existing.length > 0) {
      // Pre-squash commits chain apart from the turn's other commits. One that
      // descends from a commit HEAD reaches would otherwise join ITS chain,
      // stand as `reachable`, and be dropped by the single range that follows.
      //
      // A commit HEAD does not reach, that a branch still holds, chains apart
      // from the ones HEAD does reach. Built on top of one of them, it would
      // otherwise join that chain, the chain would stand `reachable` for its
      // reachable member, and the single range off HEAD would leave the branch
      // out. Session df8cc9aa turn 42 (2026-10-04): a sub-agent's two commits
      // were rebased onto main after the turn's own 62a18070 had landed there.
      // They joined 62a18070's chain, nothing stood `stranded`, and every Stop
      // after the rebase sent +88/-30 for a turn of "4 commits total +513/-58".
      // A commit no branch holds stays where ancestry puts it: a commit reset
      // away on top of a reachable one is not a branch of the turn.
      const refCache = new Map<string, boolean>();
      // Every commit this pass may ask about, in one rev-list.
      prefillHeldByABranch(repoPath, existing, refCache);
      const onHead = (sha: string) => shas.includes(sha) || rewritesOf(sha, rewrites).some((r) => shas.includes(r));
      // …and below none of the turn's commits that are on HEAD: an earlier
      // commit of a chain whose tip was squashed (the rewrite names only the
      // tip) is part of what HEAD holds, not a branch beside it.
      const chainsApart = (list: string[]) => {
        const plain = list.filter((sha) => !intoSharedSquash(sha));
        const onHeadHere = plain.filter(onHead);
        const offHead = plain.filter((sha) => !onHead(sha)
          && heldByABranch(repoPath, sha, refCache)
          && !onHeadHere.some((o) => o !== sha && isAncestor(repoPath, sha, o)));
        return [
          ...chainsOf(repoPath, plain.filter((sha) => !offHead.includes(sha))),
          ...chainsOf(repoPath, offHead),
          ...chainsOf(repoPath, list.filter((sha) => intoSharedSquash(sha))),
        ];
      };
      const originalChains = chainsApart(existing);
      const standing = new Map(originalChains.map((c) => [c, chainStanding(repoPath, c, originalChains, shas, rewrites, refCache, c.members.some(intoSharedSquash))] as const));
      const stranded = originalChains.filter((c) => standing.get(c) === 'stranded').length;
      if (stranded > 0) {
        // An amend leaves the old object in Git. It must not become another
        // branch patch alongside its replacement merely because a different
        // sibling branch is stranded. An original no branch holds whose
        // replacement is known (`superseded`) is left out here; one a branch
        // still holds is kept only when none of its recorded replacements
        // with the same parents is locally available. A squash can replace an
        // entire chain; leave that chain intact for the existing squash
        // handling instead of substituting only its tip.
        const superseded = new Set(originalChains.filter((c) => standing.get(c) === 'superseded').flatMap((c) => c.members));
        // A pre-squash commit is already the turn's own; it has no same-parent
        // replacement to look for, and must stay recognisable to chainsApart.
        const surviving = [...new Set(existing.filter((sha) => !superseded.has(sha)).map((sha) =>
          (intoSharedSquash(sha) ? undefined : rewritesOf(sha, rewrites).reverse().find((replacement) =>
            git(repoPath, ['cat-file', '-e', `${replacement}^{commit}`]).ok
            && git(repoPath, ['show', '-s', '--format=%P', replacement]).out.trim()
              === git(repoPath, ['show', '-s', '--format=%P', sha]).out.trim(),
          )) || sha,
        ))];
        // A commit REDONE inside a chain is superseded too, not only a chain's
        // first. Session d027b430 turn 7 merged main as ec4e1329, reset it
        // away and merged again as e9f9d378 — same two parents — then bumped
        // on top. ec4e1329 still chained to the turn's first commit, stood
        // `stranded` beside the live chain, and sent its merge a second time.
        // Same test as chainStanding's: same parents, no branch holds it, and
        // the other is held, reachable or newer.
        const parentsOf = (sha: string) => git(repoPath, ['show', '-s', '--format=%P', sha]).out.trim();
        const committedAt = (sha: string) => Number(git(repoPath, ['show', '-s', '--format=%ct', sha]).out.trim()) || 0;
        const redone = new Set(surviving.filter((sha) => {
          if (intoSharedSquash(sha) || shas.includes(sha) || heldByABranch(repoPath, sha, refCache)) return false;
          const mine = parentsOf(sha);
          if (!mine) return false;
          return surviving.some((other) => other !== sha && parentsOf(other) === mine
            && (shas.includes(other) || heldByABranch(repoPath, other, refCache) || committedAt(other) > committedAt(sha)));
        }));
        // The same change twice: a commit and the squash the forge made of it.
        // GitHub's squash-merge happens off this checkout, so no rewrite is
        // recorded, and both can be the turn's — the branch commit it made and
        // the squash it fetched and built on. Session 9f3d6bd2 turn 3 (#1936):
        // 7ffb9263 stood as its own branch while aa7ad3a35, its squash, sat
        // inside the range of the turn's main-line commits, and every line went
        // out twice. Same patch-id, not on one line of history: one leaves.
        // The one the turn built on stays — the squash with the release on top
        // is what a range covers; the original stranded on its branch is not.
        // Then the newer (a squash follows what it squashed), then sha order.
        const patchIds = new Map<string, string>();
        const patchIdOf = (sha: string): string => {
          if (!patchIds.has(sha)) {
            let id = '';
            if (parentsOf(sha).split(' ').filter(Boolean).length === 1) {
              const patch = git(repoPath, ['show', '--no-color', '--format=', sha]);
              try {
                id = patch.ok && patch.out.trim()
                  ? execFileSync('git', ['patch-id', '--stable'], {
                    cwd: repoPath, input: patch.out, encoding: 'utf-8', windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
                  }).toString().trim().split(/\s+/)[0] || ''
                  : '';
              } catch { id = ''; }
            }
            patchIds.set(sha, id);
          }
          return patchIds.get(sha)!;
        };
        const kept = surviving.filter((sha) => !redone.has(sha));
        const builtOn = (sha: string) => kept.some((o) => o !== sha && isAncestor(repoPath, sha, o));
        const outranks = (a: string, b: string): boolean => {
          const [ba, bb] = [builtOn(a), builtOn(b)];
          if (ba !== bb) return ba;
          const [ta, tb] = [committedAt(a), committedAt(b)];
          return ta !== tb ? ta > tb : a > b;
        };
        const squashedAway = new Set(kept.filter((sha) => {
          if (intoSharedSquash(sha)) return false;
          const id = patchIdOf(sha);
          if (!id) return false;
          return kept.some((other) => other !== sha && patchIdOf(other) === id
            && !isAncestor(repoPath, sha, other) && !isAncestor(repoPath, other, sha)
            && outranks(other, sha));
        }));
        if (squashedAway.size > 0) {
          deps.log?.('a commit and its forge squash are the same change — counted once', {
            promptIndex: pm.promptIndex, dropped: [...squashedAway].map((sha) => sha.slice(0, 8)),
          });
        }
        const chains = chainsApart(kept.filter((sha) => !squashedAway.has(sha)));
        // The row is stamped with the commit the page will show. A pre-squash
        // sha is superseded on the server: stamping it made the row's sha flip
        // between the orphan and nothing on alternate PATCHes.
        const stampFor = (tip: string): string => {
          const pre = preSquash.find((c) => sameSha(c.sha, tip));
          if (!pre) return tip;
          return rewritesOf(pre.squash, allRewrites).pop() || pre.squash;
        };
        if (patchAcrossBranches(repoPath, pm, turnId, chains, stranded, deps, stampFor, turnShadow, workTreeShadows)) replaced++;
        continue;
      }
      // Part of the turn is on HEAD, and another part reached HEAD only as a
      // squash the forge made of it. Session 353eb15f turn 6 (2026-10-08): a
      // sub-agent committed the feature in its own worktree (2f550462 +
      // 5d48361a, +857/-13), the PR was squash-merged on GitHub as 3b224fd2,
      // and the turn then committed the version bump 26ee73ae on main. The
      // branch chain stood `carried`, which only counts when NOTHING of the
      // turn is reachable — here the bump was — so the single range below ran
      // from the turn's shadow to the bump, met 3b224fd2 inside it as somebody
      // else's commit, measured the feature's files from after it, and the
      // turn read "+3 -3" under "3 commits net +860/-16".
      //
      // Each chain is measured on its own instead (patchAcrossBranches), which
      // never counts the squash itself. Only where the squash is PROVEN: a
      // commit on HEAD, not one of the turn's, carrying exactly the chain's
      // patch. A commit reset away and redone also reads `carried`, and its
      // redo is the turn's own commit on HEAD — crediting both would bill the
      // work twice.
      if (shas.length > 0) {
        const reachableChains = originalChains.filter((c) => standing.get(c) === 'reachable');
        // A reachable chain is measured by its own members; one reachable only
        // through a recorded rewrite is left to the single range, as before.
        const direct = reachableChains.every((c) => c.members.every((m) => shas.includes(m)));
        const squashedIn = direct
          ? originalChains
            .filter((c) => standing.get(c) === 'carried' && !c.members.some(intoSharedSquash)
              && filesOfCommits(repoPath, c.members).length > 0)
            .map((c) => ({ chain: c, squash: forgeSquashOnHead(repoPath, c, existing) }))
            .filter((x): x is { chain: CommitChain; squash: string } => x.squash !== null)
          : [];
        if (squashedIn.length > 0) {
          deps.log?.('turn commits on HEAD plus a branch the forge squashed in — sending each chain\'s own patch', {
            promptIndex: pm.promptIndex, turnId,
            squashed: squashedIn.map((x) => `${x.chain.tip.slice(0, 8)}→${x.squash.slice(0, 8)}`),
          });
          // Squashed chains first: on a tie in commit time the row's stamp is the
          // last chain listed, and the commit on HEAD is the one the page shows.
          if (patchAcrossBranches(repoPath, pm, turnId, [...squashedIn.map((x) => x.chain), ...reachableChains], 0, deps, undefined, turnShadow, workTreeShadows)) {
            replaced++;
            continue;
          }
        }
      }
      // The host SQUASH-MERGED the turn's branch and deleted it, and the
      // session never saw a rewrite to record — the squash happened on the
      // forge, not in this checkout. The chain then stands `carried`: HEAD
      // does not reach the commit, but the squash put its bytes there.
      //
      // Nothing is reachable to build a range from and no branch holds it, so
      // this declined and the row kept the watcher's rendering. Meanwhile the
      // session HEADER — written by post-commit while the commit was still
      // live — still counts the commit's files. The two then disagree forever:
      // live session 92f14dfb turn 10 committed seven files (+345/-16), two of
      // them created there, and after #1754 was squashed the row held three
      // unrelated files at +105/-6 and no sha, so those two files appeared in
      // NO turn at all. The release gate reports it as
      // `header_file_unclaimed_by_turns`.
      //
      // `carried` is itself the proof the work survived, and `git show` reads
      // the object whatever the refs say, so the commit's own patch is exact.
      // Only when nothing of the turn is reachable: a reachable chain means
      // the single range below already describes the turn. `superseded` chains
      // stay out — an amended-away original is not carried work, and its
      // replacement is what the turn made.
      // The label alone is NOT the proof. `chainStanding` answers `carried`
      // for an empty file list too, and `filesOfCommits` swallows a failed
      // `git show` as an empty list — a timeout under load, an object briefly
      // unreadable during a concurrent gc — so that branch returns BEFORE the
      // content check ever runs. While `carried` only ever declined, the
      // conflation was harmless; acting on it is not. A reset-away commit
      // reaches `chainStanding` by the same road, and crediting one here would
      // undo exactly what #1761 removes. So prove carriage again, from the
      // commit's own files, and fail closed on anything git cannot answer.
      if (shas.length === 0) {
        const carried = originalChains.filter((c) => {
          if (standing.get(c) !== 'carried') return false;
          const files = filesOfCommits(repoPath, c.members);
          return files.length > 0 && git(repoPath, ['diff', '--quiet', c.tip, 'HEAD', '--', ...files]).ok;
        });
        if (carried.length > 0) {
          deps.log?.('turn commits squash-merged away — sending each chain\'s own patch', {
            promptIndex: pm.promptIndex, turnId, carried: carried.length,
            commits: carried.map((c) => c.tip.slice(0, 8)),
          });
          if (patchAcrossBranches(repoPath, pm, turnId, carried, 0, deps, undefined, turnShadow, workTreeShadows)) replaced++;
          continue;
        }
      }
    }
    // Earlier passes can empty a committed turn after a checkout. Its
    // attested commit and baseline still prove what it authored; recovering
    // that patch must not depend on the reconstruction retaining some bytes.
    // The dirty-file and empty scoped-patch guards below still apply.
    if (shas.length === 0) {
      declined(deps, pm, 'no commit of the turn, nor a rewrite of one, is reachable from HEAD');
      deps.log?.('commit patch declined: no commit of the turn, nor a rewrite of one, is reachable from HEAD', {
        promptIndex: pm.promptIndex, commits: existing.length,
      });
      continue;
    }
    const last = shas
      .map((sha) => ({ sha, t: Number(git(repoPath, ['log', '-1', '--format=%ct', sha]).out.trim()) || 0 }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.sha)
      .pop()!;
    const shadow = state.promptShadows?.find((s) => s.promptIndex === local)?.shadowSha
      || state.prePromptSha || null;
    // A turn containing only a merge has a stronger baseline: the tree its
    // resolution is measured from (git's own merge, conflicts on the first
    // parent's side — see mergeOwnDiff), restricted to the files it resolved.
    // The first parent alone credits the other side's clean hunks in a
    // conflicted file. The prompt shadow may be missing or stale, but the
    // resolution is in Git. Multiple-commit turns keep their range so edits
    // before the merge survive.
    const merge = existing.length === 1 && existing[0] === last
      ? mergeOwnDiff(repoPath, last) : null;
    const mergeParent = merge
      ? merge.baseline || git(repoPath, ['rev-parse', `${last}^1`]).out.trim() : null;
    if (!merge && (!shadow || !HEX.test(shadow))) { declined(deps, pm, 'the turn has no baseline shadow'); continue; }
    // The pathspec above already survives a mid-turn `gh pr checkout` / pull /
    // rebase; the BASELINE did not. The turn's shadow was cut before the
    // checkout, so diffing it against the turn's own commit still reproduces
    // every line that arrived with the branch — for the four files the turn
    // also edited, which is precisely the set the pathspec keeps. Session
    // a073a85b turn 1 reported +286/-5 here for a commit of +20/-10, the
    // difference being PR #1538 as its author left it the day before.
    //
    // Where the window holds inherited commits, the tree the turn started from
    // is the one they left, not the one the shadow holds.
    //
    // Per-file sources answer that for each file the commit names, and are the
    // authoritative answer where they are given. What they do NOT name still
    // needs a base, and it is settled further down — it depends on which of
    // the commit's files came back proven, and that list does not exist yet.
    if (merge && (!mergeParent || !HEX.test(mergeParent))) { declined(deps, pm, 'the turn has no baseline'); continue; }

    // Dirty/untracked is judged on what the ledger named PLUS what the
    // commits carry: an extra file the turn wrote and did not commit is
    // why this pass stands down. The PATHSPEC for the replacement diff is
    // only the commit's files — see the file-level comment. A leaked
    // baseline..HEAD file list must not become the thing we count.
    const ledgerFiles = ledgerFilesOf(pm);
    const commitFiles: string[] = [];
    const seenCommit = new Set<string>();
    for (const sha of existing) {
      const named = merge
        ? { ok: true, out: merge.filesChanged.join('\n') }
        : git(repoPath, ['show', '--no-renames', '--name-only', '--format=', sha]);
      if (!named.ok) continue;
      for (const f of named.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (seenCommit.has(f)) continue;
        seenCommit.add(f);
        commitFiles.push(f);
      }
    }
    // A CLEAN merge — one that resolved nothing — authored nothing. Declining
    // here kept whatever the earlier passes measured, and they read the merge
    // as a rewrite of every file the other side changed. Session a7740ea3 turn
    // 15 merged main into its PR branch, kept its own side of one version line,
    // and stored #1659's +284/-9 under a merge whose resolution was empty.
    // Clear the row — unless the turn also left work uncommitted, which the
    // other passes still own.
    if (merge && merge.filesChanged.length === 0) {
      if (ledgerFiles.length > 0) {
        if (!git(repoPath, ['diff', '--quiet', 'HEAD', '--', ...ledgerFiles]).ok) {
          declined(deps, pm, 'a file of the turn is dirty against its commit');
          continue;
        }
        const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...ledgerFiles]);
        if (!untracked.ok || untracked.out.trim()) {
          declined(deps, pm, 'a file of the turn is untracked');
          continue;
        }
      }
      const before = { files: ledgerFiles.length, linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
      pm.diff = '';
      pm.filesChanged = [];
      pm.linesAdded = 0;
      pm.linesRemoved = 0;
      pm.uncommittedDiff = '';
      pm.contentUnavailableFiles = [];
      // An empty replacement only lands on the server when it claims the row.
      pm.contentAuthoritative = true;
      pm.commitPatch = true;
      replaced++;
      applied(deps, pm);
      deps.log?.('clean merge authored nothing — row cleared', {
        promptIndex: pm.promptIndex, turnId, commit: last.slice(0, 8),
        was: `${before.files} files +${before.linesAdded ?? '?'}/-${before.linesRemoved ?? '?'}`,
      });
      continue;
    }
    if (commitFiles.length === 0) { declined(deps, pm, 'the turn\'s commits name no files'); continue; }
    // Origin refreshes its context files during capture. That bookkeeping
    // must not make an otherwise committed turn look dirty and block repair.
    const watch = [...new Set([...ledgerFiles, ...commitFiles])].filter(f => !isOriginAutoManagedPath(f));

    // Everything the turn touched must be committed — no tracked change
    // against HEAD, nothing untracked among them. Otherwise the ledger holds
    // work no commit does, and it stays.
    //
    // Against HEAD, not against `last`: a later commit (a later turn of this
    // session, or another session's) that touched the same files is not
    // uncommitted work of THIS turn, and the patch baseline→last excludes it
    // anyway. Session 29b32c38 turn 1: its range ended at the squash of its
    // own branch, a later turn's commit had edited three of its files, and
    // the turn stayed at the ledger's 13 files for every Stop after that.
    // An empty pathspec is the whole tree, not "none of the turn's files":
    // a turn whose every file is a context file checks nothing here. Session
    // 97c6ba73 turn 4 committed only CLAUDE.md/AGENTS.md/GEMINI.md and was
    // declined because Origin's own refresh of them sat uncommitted.
    const dirty = watch.length > 0 && !git(repoPath, ['diff', '--quiet', 'HEAD', '--', ...watch]).ok;
    if (dirty) {
      declined(deps, pm, 'a file of the turn is dirty against its commit');
      deps.log?.('commit patch declined: a file of the turn is dirty against its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const untracked = watch.length > 0
      ? git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...watch])
      : { ok: true, out: '' };
    if (!untracked.ok || untracked.out.trim()) {
      declined(deps, pm, 'a file of the turn is untracked');
      deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }

    // Per-file sources, and the base every file they do not name is measured
    // from. Which base depends on WHY a file is not named:
    //
    //   • The resolver ran and left it out on purpose — no inherited commit
    //     touched it, or the turn's own merge resolved it and the side it stood
    //     on is where it began. The turn's shadow is that start. The whole-tree
    //     answer would be wrong here: for a turn that stood on main and merged
    //     a PR in, it names the PR's commit, a tree the turn never stood on.
    //   • The resolver gave up (null) — more files or window commits than the
    //     budget, or a read failed. It knows nothing, and the shadow was cut
    //     before any checkout in the window, so every file measured from it
    //     carries what the checkout brought: the a073a85b +574. The whole-tree
    //     answer is the best information left, and is only walked for then.
    let inheritedFiles: Map<string, string> | null = null;
    let gaveUp = false;
    if (!merge && shadow && deps.inheritedFiles) {
      try { inheritedFiles = deps.inheritedFiles(shadow, local, commitFiles, last); } catch { inheritedFiles = null; }
      gaveUp = inheritedFiles === null;
      if (inheritedFiles) inheritedFiles = withStartDirt(repoPath, shadow, inheritedFiles);
    }
    const wholeTree = !merge && shadow && (!deps.inheritedFiles || gaveUp)
      ? deps.inheritedBaseline?.(shadow, local) || null : null;
    const baseline = merge ? mergeParent! : (wholeTree && HEX.test(wholeTree) ? wholeTree : shadow!);
    // Context steps down to the per-turn wire budget. At the session budget a
    // small change kept whole-file context — 1e2aecba's +21/-1 to hooks.ts was
    // a 249 KB section — and Stop's upload cap then dropped that file and
    // declared it unavailable (prod e33b6ee1 turn 7, "4 of 5 shown"). Files are
    // still only cut at the session budget, as before.
    const scoped = commitDiffScopedToPrompt(repoPath, baseline, last, commitFiles, undefined, inheritedFiles, MAX_PROMPT_DIFF_LEN);
    if (!scoped || !scoped.diff.trim()) {
      declined(deps, pm, 'nothing between the turn baseline and its commit');
      deps.log?.('commit patch declined: nothing between the turn baseline and its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const before = { linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
    // The files are the range's (numstat), not the text's: the text may have
    // been cut at MAX_DIFF_SIZE and a turn is still every file it changed.
    const named = scoped.files.length > 0 ? scoped.files : pathsInDiff(scoped.diff);
    pm.diff = scoped.diff;
    pm.filesChanged = named;
    pm.linesAdded = scoped.linesAdded;
    pm.linesRemoved = scoped.linesRemoved;
    // The patch carries content for every file it names — except those the
    // size cap cut, which are the ONLY ones now without content. The ledger's
    // own list (files it saw written but could not read) is superseded: an
    // explicit empty array, so the server clears it rather than keeps it.
    const inText = new Set(pathsInDiff(scoped.diff));
    pm.contentUnavailableFiles = scoped.diffTruncated ? named.filter((f) => !inText.has(f)) : [];
    // The commit patch already describes everything the turn wrote; an
    // uncommitted diff beside it would count the same lines twice. Empty
    // string, not undefined — see applyLedgerCaptures.
    pm.uncommittedDiff = '';
    pm.commitPatch = true;
    delete pm.chatOnly;
    pm.commitSha = last;
    replaced++;
    applied(deps, pm);
    deps.log?.('ledger diff replaced by the commit patch', {
      promptIndex: pm.promptIndex, turnId, commit: last.slice(0, 8), baseline: baseline.slice(0, 8),
      commits: existing.length, reachable: shas.length, viaRewrite: !existing.includes(last),
      rebaselined: baseline !== shadow ? shadow?.slice(0, 8) : undefined,
      mergeResolution: !!merge,
      files: named.length, diffTruncated: scoped.diffTruncated, ledgerLines: `+${before.linesAdded ?? '?'}/-${before.linesRemoved ?? '?'}`,
      commitLines: `+${scoped.linesAdded}/-${scoped.linesRemoved}`,
    });
  }
  for (const pm of mappings) {
    const shas = pm?.commitPatch ? covered.get(pm) : undefined;
    if (shas && shas.length > 0) pm.patchCommits = shas;
  }
  stampCommittingTurns(state, mappings, deps);
  return replaced;
}

/**
 * The turn that ran `git commit` keeps the commit on its row, and the commit
 * card sits under it, even when the turn wrote nothing itself ("commit it",
 * "open PR").
 *
 * The pass above stamps `commitSha` only together with a commit patch and
 * declines a turn whose patch is empty; the shadow-window pass blanks such a
 * row's stamp outright. Stop then sent `commitSha: null` over the stamp
 * post-commit had sent, and no row held the commit. Session df8cc9aa turn 6
 * committed turn 4's hooks.ts + tests and showed no commit at all.
 *
 * Only a row that wrote nothing — no files, no text, no counts — and carries
 * no stamp is filled, from the commits ATTESTED to its turn (post-commit's
 * `commitTurns`, rewrites it folded, squashes it went into). Content is never
 * touched: the turns whose work is in the commit keep it, and read committed
 * by another turn. The stamp is the commit as it stands now — through every
 * recorded rewrite, and a squash a forge folded it into — the name the
 * server's anchor pass matches.
 */
function stampCommittingTurns(
  state: CommittedTurnState,
  mappings: CommittedTurnMapping[],
  deps: PreferCommitPatchDeps,
): void {
  const rewrites = Array.isArray(state.rewrittenCommits) ? state.rewrittenCommits : [];
  const current = (sha: string) => rewritesOf(sha, rewrites).pop() || sha;
  for (const pm of mappings || []) {
    if (!pm || pm.commitSha) continue;
    if (Array.isArray(pm.filesChanged) && pm.filesChanged.length > 0) continue;
    if ((pm.diff || '').trim() || (pm.uncommittedDiff || '').trim()) continue;
    if ((pm.linesAdded ?? 0) > 0 || (pm.linesRemoved ?? 0) > 0) continue;
    const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
    if (local === null) continue;
    const turnId = state.promptTurnIds?.[local];
    if (!turnId) continue;
    const made: string[] = [];
    for (const c of state.commitTurns || []) if (c?.turnId === turnId && HEX.test(c.sha || '')) made.push(current(c.sha));
    for (const c of state.foldedCommitTurns || []) if (c?.turnId === turnId && HEX.test(c.sha || '')) made.push(current(c.sha));
    for (const c of state.preSquashCommitTurns || []) if (c?.turnId === turnId && HEX.test(c.squash || '')) made.push(current(c.squash));
    const stamp = made.pop();
    if (!stamp) continue;
    pm.commitSha = stamp;
    deps.log?.('committing turn keeps its commit stamp', { promptIndex: pm.promptIndex, turnId, commit: stamp.slice(0, 8) });
  }
}
