// Unit tests for post-commit concurrent-session disambiguation.
// When two same-agent sessions run in one repo, process detection can't
// tell them apart; we attribute the commit to the session whose recent
// edits overlap the committed files. Regression for the GitLab MR case
// where a Gemini commit was credited to a sibling Gemini session, making
// the real committing turn render a false "uncommitted" badge.

import { describe, expect, it } from 'vitest';
import { pickSessionByFileOverlap, sessionTouchedAnyCommitFile } from '../commands/hooks.js';

type S = { sessionId: string; completedPromptMappings?: Array<{ filesChanged?: string[] }> };

describe('pickSessionByFileOverlap', () => {
  it('picks the session whose recent prompt edited the committed files', () => {
    // a2c6ef61: its LAST prompt edited the committed files.
    const a2c6ef61: S = {
      sessionId: 'a2c6ef61',
      completedPromptMappings: [
        { filesChanged: ['first-file.txt'] },
        { filesChanged: ['scripts/repo-health.sh', 'scripts/status-summary.sh'] },
        { filesChanged: ['README.md', 'docs/gitlab-integration.md'] }, // latest
      ],
    };
    // 54f5b4cf: touched the same files but only in an OLDER prompt.
    const f54: S = {
      sessionId: '54f5b4cf',
      completedPromptMappings: [
        { filesChanged: ['README.md', 'docs/gitlab-integration.md'] }, // old
        { filesChanged: ['docs/workflow.md'] },
        { filesChanged: ['scripts/git-info.sh'] }, // latest — unrelated
      ],
    };
    const commitFiles = ['README.md', 'docs/gitlab-integration.md'];
    const winner = pickSessionByFileOverlap([f54, a2c6ef61], commitFiles);
    expect(winner?.sessionId).toBe('a2c6ef61');
  });

  it('picks by overlap when sessions worked on disjoint files', () => {
    const docs: S = { sessionId: 'docs', completedPromptMappings: [{ filesChanged: ['README.md', 'docs/tips.md'] }] };
    const code: S = { sessionId: 'code', completedPromptMappings: [{ filesChanged: ['src/app.ts', 'src/util.ts'] }] };
    expect(pickSessionByFileOverlap([docs, code], ['src/app.ts'])?.sessionId).toBe('code');
    expect(pickSessionByFileOverlap([docs, code], ['docs/tips.md'])?.sessionId).toBe('docs');
  });

  it('matches on basename so repo-relative vs absolute paths still align', () => {
    const s: S = { sessionId: 's', completedPromptMappings: [{ filesChanged: ['/Users/x/repo/src/app.ts'] }] };
    expect(pickSessionByFileOverlap([s], ['src/app.ts'])?.sessionId).toBe('s');
  });

  it('returns null when no session edited any committed file', () => {
    const s: S = { sessionId: 's', completedPromptMappings: [{ filesChanged: ['other.txt'] }] };
    expect(pickSessionByFileOverlap([s], ['unrelated.md'])).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(pickSessionByFileOverlap([] as S[], ['a.txt'])).toBeNull();
    expect(pickSessionByFileOverlap([{ sessionId: 's' }] as S[], [])).toBeNull();
  });
});

// pickSessionForCommit — the full disambiguation ladder (process → branch →
// file overlap). Branch is the fix for a STALE session left RUNNING on another
// branch (e.g. an old mislabeled Devin run) orphaning a real commit.
import { pickSessionForCommit } from '../commands/hooks.js';

type CS = {
  sessionId: string;
  agentSlug?: string | null;
  model?: string | null;
  branch?: string | null;
  completedPromptMappings?: Array<{ filesChanged?: string[] }>;
};

describe('pickSessionForCommit', () => {
  const devin: CS = { sessionId: 'devin-1', agentSlug: 'devin', branch: 'feature/x' };
  const staleClaude: CS = { sessionId: 'claude-stale', agentSlug: 'claude-code', branch: 'main' };

  it('returns the only session when just one is active', () => {
    const r = pickSessionForCommit([devin], {});
    expect(r.reason).toBe('only');
    expect(r.session).toBe(devin);
  });

  it('process detection narrows to the running agent', () => {
    const r = pickSessionForCommit([devin, staleClaude], { detectedSlug: 'devin' });
    expect(r.reason).toBe('process');
    expect(r.session?.sessionId).toBe('devin-1');
  });

  it('BRANCH narrows out a stale session on another branch when process detection is ambiguous', () => {
    // No detectedSlug (or a process that matches neither): the commit is on
    // feature/x, so the session on feature/x owns it — the stale main session drops.
    const r = pickSessionForCommit([devin, staleClaude], { currentBranch: 'feature/x' });
    expect(r.reason).toBe('branch');
    expect(r.session?.sessionId).toBe('devin-1');
  });

  it('does NOT narrow by branch when every candidate shares the commit branch', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['a.txt'] }] };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['b.txt'] }] };
    // Both on main → branch can't split them → falls through to file overlap.
    const r = pickSessionForCommit([a, b], { currentBranch: 'main', commitFiles: ['b.txt'] });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('b');
  });

  it('falls back to file overlap after process + branch cannot decide', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['x.txt'] }] };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['y.txt'] }] };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: ['y.txt'] });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('b');
  });

  it('returns null (ambiguous) when nothing can decide — never guesses', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main' };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main' };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('ambiguous');
    expect(r.session).toBeNull();
  });

  it('branch narrowing keeps the real session even if the stale one started more recently', () => {
    // Order independence: stale session first in the list.
    const r = pickSessionForCommit([staleClaude, devin], { currentBranch: 'feature/x' });
    expect(r.session?.sessionId).toBe('devin-1');
  });
});

describe('pickSessionForCommit — recency tiebreak (stale vs active)', () => {
  it('picks the actively-working session over a STALE one on the same branch when nothing else decides', () => {
    // The real bug: both on the same branch, process detection inconclusive, no
    // file-overlap yet (current turn not stopped). The stale session last
    // stopped 45m ago; the active one seconds ago.
    const stale: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'stale', agentSlug: 'claude-code', branch: 'feature/x',
      startedAt: '2026-07-23T18:14:00Z', lastStopAt: '2026-07-23T18:14:30Z',
    };
    const active: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'active', agentSlug: 'devin', branch: 'feature/x',
      startedAt: '2026-07-23T19:00:00Z', lastStopAt: '2026-07-23T19:01:00Z',
    };
    const r = pickSessionForCommit([stale, active], { currentBranch: 'feature/x', commitFiles: [] });
    expect(r.reason).toBe('recency');
    expect(r.session?.sessionId).toBe('active');
  });

  it('stays ambiguous when two sessions are concurrently active (within the margin)', () => {
    const a: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'a', agentSlug: 'devin', branch: 'main',
      startedAt: '2026-07-23T19:00:00Z', lastStopAt: '2026-07-23T19:04:00Z',
    };
    const b: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'b', agentSlug: 'devin', branch: 'main',
      startedAt: '2026-07-23T19:00:30Z', lastStopAt: '2026-07-23T19:04:30Z', // 30s gap < 2m margin
    };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('ambiguous');
    expect(r.session).toBeNull();
  });

  it('falls back to startedAt when a session has no lastStopAt yet', () => {
    const older: CS & { startedAt: string } = { sessionId: 'old', agentSlug: 'devin', branch: 'main', startedAt: '2026-07-23T18:00:00Z' };
    const newer: CS & { startedAt: string } = { sessionId: 'new', agentSlug: 'devin', branch: 'main', startedAt: '2026-07-23T19:00:00Z' };
    const r = pickSessionForCommit([older, newer], { currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('recency');
    expect(r.session?.sessionId).toBe('new');
  });
});

// The turn IN FLIGHT is the one that commits.
//
// completedPromptMappings are written at a session's own Stop, so for the whole
// duration of a turn they say nothing — and `git commit` runs at the END of a
// turn, before that Stop. So the overlap rung scored ZERO for the session that
// was at that instant writing the committed file, abstained, and handed the
// commit to the recency tiebreak.
//
// Prod, 2026-08-25 18:56:22, three live sessions in one checkout:
//
//   [post-commit] disambiguated by recency
//     {detectedSlug: null, branch: "fix/sqlite-tuning-actually-applies",
//      sessionId: "2e58a848-85b…"}
//
// 00541dfc was 59a0fa03's — it had been editing apps/api/src/db.ts for minutes,
// mid-turn, and its Stop did not run until 19:01:48. 2e58a848 had started 92
// seconds earlier and written nothing at all; it won purely on startedAt. The
// commit's files, its diff and a SHA stamp all landed on a stranger's turn, and
// db.ts was written into that session's own mappings — where it then makes the
// same mis-pick MORE likely next time.
describe('pickSessionByFileOverlap — the turn in flight (session 2e58a848)', () => {
  type Live = S & {
    activeTurn?: { index: number } | null;
    liveEdits?: Array<{ promptIndex?: number; edits?: Array<{ file?: string }> }>;
    pendingWrites?: Array<{ file?: string }>;
  };

  // Mid-turn: files are in the live ledger, mappings know nothing of them.
  const committer: Live = {
    sessionId: '59a0fa03',
    completedPromptMappings: [{ filesChanged: ['apps/api/src/routes/sessions.ts'] }],
    activeTurn: { index: 18 },
    liveEdits: [{ promptIndex: 18, edits: [{ file: 'apps/api/src/db.ts' }] }],
  };
  // Started 92s ago, has written nothing: no mappings, no ledger, no claims.
  const bystander: Live = { sessionId: '2e58a848', activeTurn: { index: 1 } };

  it('credits the session mid-write over one that has written nothing', () => {
    const r = pickSessionByFileOverlap([bystander, committer], ['apps/api/src/db.ts']);
    expect(r?.sessionId).toBe('59a0fa03');
  });

  it('a pre-tool-use claim counts before the write has even landed', () => {
    const claiming: Live = {
      sessionId: 'claiming', activeTurn: { index: 0 },
      pendingWrites: [{ file: 'apps/api/src/db.ts' }],
    };
    const r = pickSessionByFileOverlap([bystander, claiming], ['apps/api/src/db.ts']);
    expect(r?.sessionId).toBe('claiming');
  });

  it('in-flight outranks another session\'s last COMPLETED turn on the same file', () => {
    // Same file in both, but only one session is writing it right now.
    const earlier: Live = {
      sessionId: 'earlier',
      completedPromptMappings: [{ filesChanged: ['apps/api/src/db.ts'] }], // ×3
    };
    const now: Live = {
      sessionId: 'now', activeTurn: { index: 0 },
      liveEdits: [{ promptIndex: 0, edits: [{ file: 'apps/api/src/db.ts' }] }], // ×4
    };
    expect(pickSessionByFileOverlap([earlier, now], ['apps/api/src/db.ts'])?.sessionId).toBe('now');
  });

  it('the full ladder now reaches file-overlap instead of falling to recency', () => {
    // Exactly the prod shape: same agent, neither state's branch matches the
    // commit's, and the bystander started much later so recency would take it.
    const c: CS & Live & { startedAt: string; lastStopAt: string } = {
      ...committer, agentSlug: 'claude-code', branch: 'main',
      startedAt: '2026-08-25T13:32:39Z', lastStopAt: '2026-08-25T18:47:00Z',
    };
    const b: CS & Live & { startedAt: string } = {
      ...bystander, agentSlug: 'claude-code', branch: 'main',
      startedAt: '2026-08-25T18:54:50Z',
    };
    const r = pickSessionForCommit([c, b], {
      currentBranch: 'fix/sqlite-tuning-actually-applies',
      commitFiles: ['apps/api/src/db.ts'],
    });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('59a0fa03');
  });

  it('sessionTouchedAnyCommitFile sees the in-flight turn too', () => {
    expect(sessionTouchedAnyCommitFile(committer, ['apps/api/src/db.ts'])).toBe(true);
    expect(sessionTouchedAnyCommitFile(bystander, ['apps/api/src/db.ts'])).toBe(false);
  });

  // liveEdits is the WHOLE session's ledger, not the current turn's: it is kept
  // across turns and pruned only by its size cap. 59a0fa03 carries entries for
  // prompts 17, 18 and 19 at once; 2e58a848 still holds prompts 1 and 2 with no
  // turn open at all. Reading it wholesale would give the ×4 in-flight weight
  // to a file somebody edited turns ago and stopped — the exact inversion this
  // rung's recency weighting exists to prevent, made worse by ×4 outranking the
  // ×3 that the session actually writing it would score.
  describe('the ledger is not the same thing as the open turn', () => {
    it('ignores ledger entries from a turn that is no longer the open one', () => {
      const stale: Live = {
        sessionId: 'stale',
        activeTurn: { index: 9 },                                  // open turn edits something else
        liveEdits: [
          { promptIndex: 3, edits: [{ file: 'apps/api/src/db.ts' }] },   // turns ago
          { promptIndex: 9, edits: [{ file: 'README.md' }] },
        ],
      };
      expect(pickSessionByFileOverlap([stale], ['apps/api/src/db.ts'])).toBeNull();
      expect(sessionTouchedAnyCommitFile(stale, ['apps/api/src/db.ts'])).toBe(false);
    });

    it('contributes nothing between turns, when closeTurn has nulled activeTurn', () => {
      // 2e58a848's shape after its Stop: ledger still full, no turn open.
      const between: Live = {
        sessionId: 'between', activeTurn: null,
        liveEdits: [{ promptIndex: 2, edits: [{ file: 'apps/api/src/db.ts' }] }],
        pendingWrites: [{ file: 'apps/api/src/db.ts' }],
      };
      expect(pickSessionByFileOverlap([between], ['apps/api/src/db.ts'])).toBeNull();
    });

    it('a session mid-write beats one whose ledger only remembers an old turn', () => {
      // The regression the guard prevents: `stale` would otherwise score
      // 4 (stale ledger) + 3 (latest mapping) = 7 against `now`'s 4.
      const stale: Live = {
        sessionId: 'stale',
        activeTurn: { index: 9 },
        completedPromptMappings: [{ filesChanged: ['apps/api/src/db.ts'] }],
        liveEdits: [{ promptIndex: 3, edits: [{ file: 'apps/api/src/db.ts' }] }],
      };
      const now: Live = {
        sessionId: 'now', activeTurn: { index: 0 },
        liveEdits: [{ promptIndex: 0, edits: [{ file: 'apps/api/src/db.ts' }] }],
      };
      expect(pickSessionByFileOverlap([stale, now], ['apps/api/src/db.ts'])?.sessionId).toBe('now');
    });
  });
});
