// Which turn made a commit is OBSERVED, once, at post-commit — and until now it
// was discarded. `sessionCommitShas` recorded which commits are ours; nothing
// recorded whose turn. So ownership was reconstructed afterwards, twice,
// independently and differently:
//
//   CLI     "the highest-promptIndex turn that claims it" — the most defensible
//           owner, which is a guess dressed as a rule.
//   server  9 time windows and 10 promptIntent() checks over the prompt wording.
//
// Both guess at something that was in hand. That is why the server ranks its own
// guess above the capture's carrier ("a capture's commits[] is a claim, not
// attestation"), and why the same fix kept being made — 31 of them in 90 days.
//
// The heuristic is right whenever the committing turn is also the last to claim
// the sha, and wrong exactly when a commit surfaces late — Cursor's normal case,
// since its commits don't reliably fire the global post-commit hook. These tests
// pin the difference.
import { describe, it, expect } from 'vitest';

// Mirrors the owner-resolution rule in supplementUncoveredCommittedFiles: the
// attested turn owns the sha; without an attestation, the highest claimer does.
function resolveOwner(
  turns: Array<{ promptIndex: number; commits: string[] }>,
  promptTurnIds: string[],
  commitTurns: Array<{ sha: string; turnId: string }>,
): Map<string, number> {
  const attested = new Map(commitTurns.map((c) => [c.sha, c.turnId]));
  const owner = new Map<string, number>();
  for (const turn of turns) {
    for (const sha of turn.commits) {
      const want = attested.get(sha);
      if (want) {
        if (promptTurnIds[turn.promptIndex] === want) owner.set(sha, turn.promptIndex);
        continue;
      }
      const cur = owner.get(sha);
      if (cur === undefined || turn.promptIndex > cur) owner.set(sha, turn.promptIndex);
    }
  }
  return owner;
}

const IDS = ['t_a', 't_b', 't_c'];

describe('commit ownership', () => {
  it('gives the commit to the turn post-commit saw it land under', () => {
    // Turn 1 committed. Turn 2 later touched the same sha (a trailing capture,
    // an amend, a status re-scan) and under the old rule would have taken it.
    const turns = [
      { promptIndex: 1, commits: ['sha1'] },
      { promptIndex: 2, commits: ['sha1'] },
    ];
    const owner = resolveOwner(turns, IDS, [{ sha: 'sha1', turnId: 't_b' }]);
    expect(owner.get('sha1')).toBe(1);
  });

  it('does not let a later claimer overrule what was observed', () => {
    // The Cursor shape: the sha surfaces late, so a LATER turn claims it and the
    // carrier names the wrong committer. Attestation refuses that.
    const turns = [
      { promptIndex: 0, commits: ['sha1'] },
      { promptIndex: 1, commits: ['sha1'] },
      { promptIndex: 2, commits: ['sha1'] },
    ];
    const owner = resolveOwner(turns, IDS, [{ sha: 'sha1', turnId: 't_a' }]);
    expect(owner.get('sha1')).toBe(0);
  });

  it('falls back to the old rule when nothing was attested', () => {
    // A commit made outside any open turn — a manual `git commit` between
    // prompts, a rebase, an amend — legitimately has no active turn. Inventing
    // one would be worse than the heuristic: it would give the reader false
    // attestation. So the existing inference still applies there.
    const turns = [
      { promptIndex: 0, commits: ['sha9'] },
      { promptIndex: 2, commits: ['sha9'] },
    ];
    const owner = resolveOwner(turns, IDS, []);
    expect(owner.get('sha9')).toBe(2);
  });

  it('leaves a sha unowned when the attested turn is not among the claimers', () => {
    // Better to attribute nothing than to attribute confidently to the wrong
    // turn: a missing badge is a visible gap, a wrong one is a false accusation.
    const turns = [{ promptIndex: 2, commits: ['sha1'] }];
    const owner = resolveOwner(turns, IDS, [{ sha: 'sha1', turnId: 't_a' }]);
    expect(owner.has('sha1')).toBe(false);
  });

  it('matches on turnId, so a renumbered turn keeps its commit', () => {
    // The reason this is keyed by identity and not position. A resume or a
    // rolled transcript shifts indices; the commit must follow the TURN, not
    // whatever now occupies the slot.
    const shifted = ['t_b', 't_c'];            // turn t_a dropped out; everything moved down
    const turns = [
      { promptIndex: 0, commits: ['sha1'] },   // this is t_b now, at index 0
      { promptIndex: 1, commits: ['sha1'] },
    ];
    const owner = resolveOwner(turns, shifted, [{ sha: 'sha1', turnId: 't_b' }]);
    expect(owner.get('sha1')).toBe(0);
  });
});

// ─── Grading ───────────────────────────────────────────────────────────────
//
// Two sources, unequal strength, and collapsing them would hide which one an
// attribution actually rests on:
//
//   post-commit  the hook fired as the commit landed and read activeTurn.
//   transcript   the agent printed the sha in its own output and the watcher
//                paired it to the turn it appeared under.
//
// Cursor only ever gets the second. Across this machine's whole log history its
// worktree fired after-file-edit 30x, user-prompt-submit 29x, post-tool-use 9x
// and post-commit ZERO times — with core.hooksPath set correctly and the hook
// executable — so its commits do not invoke git hooks at all.
function resolveGraded(
  commitTurns: Array<{ sha: string; turnId: string; via?: 'post-commit' | 'transcript' }>,
): Map<string, string> {
  const RANK: Record<string, number> = { 'post-commit': 2, transcript: 1 };
  const best = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const c of commitTurns) {
    const r = RANK[c.via || 'post-commit'] ?? 0;
    if (r >= (rank.get(c.sha) ?? -1)) { best.set(c.sha, c.turnId); rank.set(c.sha, r); }
  }
  return best;
}

describe('attestation grading', () => {
  it('prefers a commit-time observation over a transcript pairing', () => {
    const out = resolveGraded([
      { sha: 'sha1', turnId: 't_transcript', via: 'transcript' },
      { sha: 'sha1', turnId: 't_hook', via: 'post-commit' },
    ]);
    expect(out.get('sha1')).toBe('t_hook');
  });

  it('keeps the stronger verdict regardless of arrival order', () => {
    const out = resolveGraded([
      { sha: 'sha1', turnId: 't_hook', via: 'post-commit' },
      { sha: 'sha1', turnId: 't_transcript', via: 'transcript' },
    ]);
    expect(out.get('sha1')).toBe('t_hook');
  });

  it('still uses a transcript pairing when it is all there is', () => {
    // The Cursor case. Weaker evidence beats no evidence — the alternative is
    // the positional guess that names a later turn for a late-surfacing commit.
    const out = resolveGraded([{ sha: 'sha1', turnId: 't_cursor', via: 'transcript' }]);
    expect(out.get('sha1')).toBe('t_cursor');
  });

  it('treats an ungraded entry as commit-time, for rows written before grading', () => {
    const out = resolveGraded([{ sha: 'sha1', turnId: 't_old' }]);
    expect(out.get('sha1')).toBe('t_old');
  });
});
