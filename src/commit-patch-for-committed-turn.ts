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
 * reachable commit, over the files the turn touched. That is the diff the
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
import { execFileSync } from 'child_process';
import { commitDiffScopedToPrompt } from './git-capture.js';
import { localTurnForServerRow } from './turn-index.js';

const HEX = /^[a-fA-F0-9]{7,40}$/;

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
  if (turns.length === 0 || !repoPath) return 0;
  let replaced = 0;
  for (const pm of mappings) {
    // The mapping is a SERVER row; ids and shadows are numbered by this
    // launch (see turn-index.ts). A row from before the launch has neither.
    const local = localTurnForServerRow(pm.promptIndex, state.promptIndexBase);
    if (local === null) continue;
    const turnId = state.promptTurnIds?.[local];
    if (!turnId || !(pm.diff || '').trim()) continue;
    const own = turns.filter((c) => c && c.turnId === turnId && typeof c.sha === 'string' && HEX.test(c.sha));
    if (own.length === 0) continue;
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
    if (shas.length === 0) {
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
    if (!shadow || !HEX.test(shadow)) continue;
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
    const inherited = deps.inheritedBaseline?.(shadow, local) || null;
    const baseline = inherited && HEX.test(inherited) ? inherited : shadow;

    // Dirty/untracked is judged on what the ledger named PLUS what the
    // commits carry: an extra file the turn wrote and did not commit is
    // why this pass stands down. The PATHSPEC for the replacement diff is
    // only the commit's files — see the file-level comment. A leaked
    // baseline..HEAD file list must not become the thing we count.
    const ledgerFiles = Array.isArray(pm.filesChanged)
      ? (pm.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string' && !!f)
      : [];
    const commitFiles: string[] = [];
    const seenCommit = new Set<string>();
    for (const sha of existing) {
      const named = git(repoPath, ['show', '--no-renames', '--name-only', '--format=', sha]);
      if (!named.ok) continue;
      for (const f of named.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (seenCommit.has(f)) continue;
        seenCommit.add(f);
        commitFiles.push(f);
      }
    }
    if (commitFiles.length === 0) continue;
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
      deps.log?.('commit patch declined: a file of the turn is dirty against its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...watch]);
    if (!untracked.ok || untracked.out.trim()) {
      deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }

    const scoped = commitDiffScopedToPrompt(repoPath, baseline, last, commitFiles);
    if (!scoped || !scoped.diff.trim()) {
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
    deps.log?.('ledger diff replaced by the commit patch', {
      promptIndex: pm.promptIndex, turnId, commit: last.slice(0, 8), baseline: baseline.slice(0, 8),
      commits: existing.length, reachable: shas.length, viaRewrite: !existing.includes(last),
      rebaselined: baseline !== shadow ? shadow.slice(0, 8) : undefined,
      files: named.length, diffTruncated: scoped.diffTruncated, ledgerLines: `+${before.linesAdded ?? '?'}/-${before.linesRemoved ?? '?'}`,
      commitLines: `+${scoped.linesAdded}/-${scoped.linesRemoved}`,
    });
  }
  return replaced;
}
