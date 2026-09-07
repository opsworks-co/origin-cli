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
 * Provenance stays `ledger`: the content is still the turn's observed writes,
 * now in git's rendering, and every reader of that marker (the server's
 * editsJson stripping, keepRicherTurnCapture, the heartbeat) treats it as an
 * observation rather than a reconstruction — which it is.
 */
import { execFileSync } from 'child_process';
import { commitDiffScopedToPrompt } from './git-capture.js';

const HEX = /^[a-fA-F0-9]{7,40}$/;

export interface CommittedTurnState {
  promptTurnIds?: string[];
  commitTurns?: Array<{ sha: string; turnId: string; at?: string }>;
  promptShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  prePromptSha?: string | null;
}

export interface CommittedTurnMapping {
  promptIndex: number;
  filesChanged?: unknown;
  diff?: string;
  uncommittedDiff?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface PreferCommitPatchDeps {
  log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * Bound the git work to the turns that can have changed: the turn this
   * Stop closes, and any turn with a commit recorded after the previous
   * Stop. Every earlier turn is re-sent on every Stop, and five git calls per
   * committed turn per Stop is the hook-path cost the O(commits) note in
   * captureGitState warns about. Omit both to consider every turn.
   */
  currentPromptIndex?: number;
  /** ISO time of the previous Stop; a commit newer than this is unprocessed. */
  since?: string | null;
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
  const sinceMs = deps.since ? Date.parse(deps.since) : NaN;
  const bounded = deps.currentPromptIndex != null || Number.isFinite(sinceMs);
  for (const pm of mappings) {
    const turnId = state.promptTurnIds?.[pm.promptIndex];
    if (!turnId || !(pm.diff || '').trim()) continue;
    const own = turns.filter((c) => c && c.turnId === turnId && typeof c.sha === 'string' && HEX.test(c.sha));
    if (own.length === 0) continue;
    if (bounded) {
      const isCurrent = deps.currentPromptIndex != null && pm.promptIndex === deps.currentPromptIndex;
      const newCommit = Number.isFinite(sinceMs)
        && own.some((c) => c.at && Date.parse(c.at) > sinceMs);
      if (!isCurrent && !newCommit) continue;
    }
    const shas = own
      .map((c) => c.sha)
      // Still on the branch. An amended-away sha has a rewrite the rescue
      // will map; until then it is nothing to point a turn at.
      .filter((sha) => git(repoPath, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok);
    if (shas.length === 0) continue;
    const last = shas[shas.length - 1];
    const baseline = state.promptShadows?.find((s) => s.promptIndex === pm.promptIndex)?.shadowSha
      || state.prePromptSha || null;
    if (!baseline || !HEX.test(baseline)) continue;

    // The turn's files: what the ledger saw it write, plus what its commits
    // carry (a file created by a shell command the journal missed still
    // belongs to the turn once the turn committed it).
    const ledgerFiles = Array.isArray(pm.filesChanged)
      ? (pm.filesChanged as unknown[]).filter((f): f is string => typeof f === 'string' && !!f)
      : [];
    const files = new Set<string>(ledgerFiles);
    for (const sha of shas) {
      const named = git(repoPath, ['show', '--no-renames', '--name-only', '--format=', sha]);
      if (!named.ok) continue;
      for (const f of named.out.split('\n').map((l) => l.trim()).filter(Boolean)) files.add(f);
    }
    if (files.size === 0) continue;
    const fileList = [...files];

    // Everything the turn touched must be exactly as the commit left it —
    // no tracked change against the commit, nothing untracked among them.
    // Otherwise the ledger holds work the commit does not, and it stays.
    const dirty = !git(repoPath, ['diff', '--quiet', last, '--', ...fileList]).ok;
    if (dirty) {
      deps.log?.('commit patch declined: a file of the turn is dirty against its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard', '--', ...fileList]);
    if (!untracked.ok || untracked.out.trim()) {
      deps.log?.('commit patch declined: a file of the turn is untracked', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }

    const scoped = commitDiffScopedToPrompt(repoPath, baseline, last, fileList);
    if (!scoped || !scoped.diff.trim()) {
      deps.log?.('commit patch declined: nothing between the turn baseline and its commit', { promptIndex: pm.promptIndex, commit: last.slice(0, 8) });
      continue;
    }
    const before = { linesAdded: pm.linesAdded, linesRemoved: pm.linesRemoved };
    const named = pathsInDiff(scoped.diff);
    pm.diff = scoped.diff;
    pm.filesChanged = named;
    pm.linesAdded = scoped.linesAdded;
    pm.linesRemoved = scoped.linesRemoved;
    // The commit patch already describes everything the turn wrote; an
    // uncommitted diff beside it would count the same lines twice. Empty
    // string, not undefined — see applyLedgerCaptures.
    pm.uncommittedDiff = '';
    replaced++;
    deps.log?.('ledger diff replaced by the commit patch', {
      promptIndex: pm.promptIndex, turnId, commit: last.slice(0, 8), baseline: baseline.slice(0, 8),
      files: named.length, ledgerLines: `+${before.linesAdded ?? '?'}/-${before.linesRemoved ?? '?'}`,
      commitLines: `+${scoped.linesAdded}/-${scoped.linesRemoved}`,
    });
  }
  return replaced;
}
