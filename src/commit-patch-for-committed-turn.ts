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
 *   • no commit of the turn is still reachable (an amend that the rescue has
 *     not yet mapped) — there is nothing exact to point at;
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
import { execFileSync } from 'child_process';
import { commitDiffScopedToPrompt, MAX_DIFF_SIZE, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
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
  prePromptSha?: string | null;
  /** Server row of this launch's turn 0 — see turn-index.ts. */
  promptIndexBase?: number | null;
  /** Squash / amend rewrites the session has seen: original → survivor. */
  rewrittenCommits?: Array<{ from: string; to: string }>;
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
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
  /** Files of the turn whose content the diff does not carry. */
  contentUnavailableFiles?: string[];
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
 * Whether a chain is work that sits on ANOTHER branch: HEAD does not hold it,
 * and a local branch still does.
 *
 * HEAD holds it when a member, or a recorded rewrite of one, is reachable — or
 * the chain's files read the same in HEAD as at its tip (a squash the session
 * never saw as a rewrite). An amended-away original fails all three, yet it is
 * no branch's work: it sits on no branch, and the amend in HEAD is the turn's
 * commit. That is the same line the rescue draws (`onLiveBranch` in hooks.ts),
 * and Origin's shadow refs do not count for the same reason — a snapshot can
 * still hold the original.
 */
function strandedOnBranch(
  repoPath: string,
  chain: CommitChain,
  reachable: string[],
  rewrites: Array<{ from: string; to: string }>,
): boolean {
  if (chain.members.some((m) => reachable.includes(m) || rewritesOf(m, rewrites).some((r) => reachable.includes(r)))) return false;
  const files = filesOfCommits(repoPath, chain.members);
  if (files.length === 0) return false;
  if (git(repoPath, ['diff', '--quiet', chain.tip, 'HEAD', '--', ...files]).ok) return false;
  const refs = git(repoPath, ['for-each-ref', '--contains', chain.tip, '--format=%(refname)', 'refs/heads']);
  return refs.out.split('\n').map((r) => r.trim()).some((r) => !!r && !/(^|\/)shadow(\/|$)/.test(r));
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
function patchAcrossBranches(
  repoPath: string,
  pm: CommittedTurnMapping,
  turnId: string,
  chains: CommitChain[],
  stranded: number,
  deps: PreferCommitPatchDeps,
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
  const watch = [...new Set([...ledgerFilesOf(pm), ...commitFiles])];
  if (!git(repoPath, ['diff', '--quiet', 'HEAD', '--', ...watch]).ok) {
    declined(deps, pm, 'a file of the turn is dirty against its commit');
    deps.log?.('commit patch declined: a file of the turn is dirty against its commit', { promptIndex: pm.promptIndex, commits: tips });
    return false;
  }
  const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...watch]);
  if (!untracked.ok || untracked.out.trim()) {
    declined(deps, pm, 'a file of the turn is untracked');
    deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commits: tips });
    return false;
  }

  const parts: Array<NonNullable<ReturnType<typeof commitDiffScopedToPrompt>>> = [];
  for (const { chain, files } of perChain) {
    const parent = git(repoPath, ['rev-parse', '--verify', '-q', `${chain.first}^1`]).out.trim();
    // Step down context before upload, using the per-turn wire budget rather
    // than the much larger session budget. Reserve room for every branch.
    const scoped = commitDiffScopedToPrompt(repoPath, HEX.test(parent) ? parent : EMPTY_TREE, chain.tip, files,
      Math.floor(MAX_PROMPT_DIFF_LEN / perChain.length));
    // A branch that cannot be diffed would leave its work out, which is the
    // undercount this exists to fix. Keep the ledger instead.
    if (!scoped) {
      declined(deps, pm, 'a branch of the turn could not be diffed');
      deps.log?.('commit patch declined: a branch of the turn could not be diffed', { promptIndex: pm.promptIndex, commit: chain.tip.slice(0, 8) });
      return false;
    }
    if (scoped.diff.trim()) parts.push(scoped);
  }
  if (parts.length === 0) {
    declined(deps, pm, 'nothing between the turn baseline and its commit');
    deps.log?.('commit patch declined: nothing between the turn baseline and its commit', { promptIndex: pm.promptIndex, commits: tips });
    return false;
  }

  // Each part is already capped; the union is capped again by whole sections.
  let diff = '';
  let cut = false;
  for (const part of parts) {
    for (const section of part.diff.split(/^(?=diff --git )/m)) {
      if (!section.trim()) continue;
      const text = section.endsWith('\n') ? section : `${section}\n`;
      if (diff.length + text.length > MAX_DIFF_SIZE) { cut = true; continue; }
      diff += text;
    }
  }
  const diffTruncated = cut || parts.some((p) => p.diffTruncated);
  const named = [...new Set(parts.flatMap((p) => (p.files.length > 0 ? p.files : pathsInDiff(p.diff))))];
  const before = { linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
  const linesAdded = parts.reduce((n, p) => n + p.linesAdded, 0);
  const linesRemoved = parts.reduce((n, p) => n + p.linesRemoved, 0);
  pm.diff = diff;
  pm.filesChanged = named;
  pm.linesAdded = linesAdded;
  pm.linesRemoved = linesRemoved;
  const inText = new Set(pathsInDiff(diff));
  pm.contentUnavailableFiles = diffTruncated ? named.filter((f) => !inText.has(f)) : [];
  pm.uncommittedDiff = '';
  applied(deps, pm);
  deps.log?.('ledger diff replaced by the commit patches of several branches', {
    promptIndex: pm.promptIndex, turnId, branches: parts.length, stranded, commits: tips,
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
  if (turns.length === 0 || !repoPath) {
    for (const pm of mappings || []) if (pm) declined(deps, pm, 'the session has no attested commits');
    return 0;
  }
  let replaced = 0;
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
    const hasDiff = !!(pm.diff || '').trim();
    const own = turns.filter((c) => c && c.turnId === turnId && typeof c.sha === 'string' && HEX.test(c.sha));
    if (own.length === 0) { declined(deps, pm, 'the turn made no commit'); continue; }
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
    const rewrites = Array.isArray(state.rewrittenCommits) ? state.rewrittenCommits : [];
    const candidates = [...new Set(existing.flatMap((sha) => [sha, ...rewritesOf(sha, rewrites)]))];
    const shas = candidates.filter((sha) => git(repoPath, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok);
    // …but only when HEAD holds all of the turn's work. A branch whose
    // commits HEAD neither reaches nor carries the content of is work one
    // range off HEAD cannot describe.
    if (existing.length > 0) {
      const originalChains = chainsOf(repoPath, existing);
      const stranded = originalChains.filter((c) => strandedOnBranch(repoPath, c, shas, rewrites)).length;
      if (stranded > 0) {
        // An amend leaves the old object in Git. It must not become another
        // branch patch alongside its replacement merely because a different
        // sibling branch is stranded. Keep the original only when none of its
        // recorded replacements with the same parents is locally available.
        // A squash can replace an entire chain; leave that chain intact for
        // the existing squash handling instead of substituting only its tip.
        const surviving = [...new Set(existing.map((sha) =>
          rewritesOf(sha, rewrites).reverse().find((replacement) =>
            git(repoPath, ['cat-file', '-e', `${replacement}^{commit}`]).ok
            && git(repoPath, ['show', '-s', '--format=%P', replacement]).out.trim()
              === git(repoPath, ['show', '-s', '--format=%P', sha]).out.trim(),
          ) || sha,
        ))];
        const chains = chainsOf(repoPath, surviving);
        if (patchAcrossBranches(repoPath, pm, turnId, chains, stranded, deps)) replaced++;
        continue;
      }
    }
    // The single range only re-renders a row that has content; it was never
    // asked to fill an empty one, and still is not.
    if (!hasDiff) { declined(deps, pm, 'the row is empty and HEAD holds the turn\'s commits'); continue; }
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
    // A turn containing only a merge has a stronger baseline: the merge's
    // first parent, restricted to files changed against EVERY parent. The
    // prompt shadow may be missing or stale, but the resolution is in Git.
    // Multiple-commit turns keep their range so edits before the merge survive.
    const merge = existing.length === 1 && existing[0] === last
      ? mergeOwnDiff(repoPath, last) : null;
    const mergeParent = merge ? git(repoPath, ['rev-parse', `${last}^1`]).out.trim() : null;
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
    const inherited = !merge && shadow ? deps.inheritedBaseline?.(shadow, local) || null : null;
    const baseline = merge ? mergeParent : (inherited && HEX.test(inherited) ? inherited : shadow);
    if (!baseline || !HEX.test(baseline)) { declined(deps, pm, 'the turn has no baseline'); continue; }

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
    if (commitFiles.length === 0) { declined(deps, pm, 'the turn\'s commits name no files'); continue; }
    const watch = [...new Set([...ledgerFiles, ...commitFiles])];

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
    const dirty = !git(repoPath, ['diff', '--quiet', 'HEAD', '--', ...watch]).ok;
    if (dirty) {
      declined(deps, pm, 'a file of the turn is dirty against its commit');
      deps.log?.('commit patch declined: a file of the turn is dirty against its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...watch]);
    if (!untracked.ok || untracked.out.trim()) {
      declined(deps, pm, 'a file of the turn is untracked');
      deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }

    const scoped = commitDiffScopedToPrompt(repoPath, baseline, last, commitFiles);
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
  return replaced;
}
