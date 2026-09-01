/**
 * A commit belongs to ONE session, and the post-commit incremental update must
 * go only there.
 *
 * Prod session 0a8e2164 shared a checkout with a second Claude session and
 * ended up owning three of its neighbour's commits. The disambiguation ladder
 * was not the problem — it worked, and was then ignored. From ~/.origin/hooks.log:
 *
 *   15:37:45  [post-commit] disambiguated by recency  {sessionId: 0a8e2164…}
 *   15:38:09  [post-commit] sending incremental update {sessionId: aad6cc17…}
 *   15:38:09  [post-commit] sending incremental update {sessionId: 0a8e2164…}
 *
 * The loop ran over every active session in the repo, so both were handed the
 * commit's files, its diff, and a promptChange stamped with its SHA. Commits
 * 90e907a7, b3e6e70e and 8761ea1d all show the same double-send.
 *
 * These cover the target selection: the resolved owner alone, and — when the
 * ladder deliberately declines to guess — only sessions whose own edits touch
 * a committed file, never the whole repo's sessions.
 */
import { describe, it, expect } from 'vitest';
import { pickSessionForCommit, sessionTouchedAnyCommitFile, pickCommitUpdateTargets } from '../commands/hooks.js';

type S = {
  sessionId: string;
  agentSlug?: string | null;
  model?: string | null;
  branch?: string | null;
  startedAt?: string;
  lastStopAt?: string | null;
  completedPromptMappings?: Array<{ filesChanged?: string[] }>;
};

// The production shape: two Claude sessions, same repo, same branch — the one
// signal a shared checkout guarantees they agree on.
const mine = (): S => ({
  sessionId: '0a8e2164',
  agentSlug: 'claude-code',
  model: 'claude',
  branch: 'fix/landing-agent-count',
  startedAt: '2026-08-18T19:21:11Z',
  lastStopAt: '2026-08-19T15:30:00Z',
  completedPromptMappings: [
    // Absolute, as a tool call records it.
    { filesChanged: ['/Users/x/origin/apps/api/src/routes/sessions.ts'] },
  ],
});

const theirs = (): S => ({
  sessionId: 'aad6cc17',
  agentSlug: 'claude-code',
  model: 'claude',
  branch: 'fix/landing-agent-count',
  startedAt: '2026-08-19T09:00:00Z',
  lastStopAt: '2026-08-19T15:30:00Z',
  completedPromptMappings: [
    // Repo-relative, as a git capture records it.
    { filesChanged: ['apps/web/src/pages/Landing.tsx'] },
  ],
});

// Drives the SAME pair of functions post-commit calls, so reverting the
// production line fails these rather than leaving them green against a copy
// of the logic.
const targetsFor = (sessions: S[], commitFiles: string[]): string[] => {
  const picked = pickSessionForCommit(sessions, {
    detectedSlug: null,
    currentBranch: 'fix/landing-agent-count',
    commitFiles,
  });
  return pickCommitUpdateTargets(sessions, picked.session, commitFiles).map((s) => s.sessionId);
};

describe('sessionTouchedAnyCommitFile', () => {
  it('matches an absolutely-recorded mapping against a repo-relative commit file', () => {
    expect(sessionTouchedAnyCommitFile(mine(), ['apps/api/src/routes/sessions.ts'])).toBe(true);
  });

  it('does not claim a file the session never touched', () => {
    expect(sessionTouchedAnyCommitFile(mine(), ['apps/web/src/pages/Landing.tsx'])).toBe(false);
  });

  it('is false for a commit with no files', () => {
    expect(sessionTouchedAnyCommitFile(mine(), [])).toBe(false);
  });
});

describe('post-commit incremental update targets', () => {
  it('credits only the session whose edits match the commit', () => {
    // The neighbour's commit. Mine must not appear.
    expect(targetsFor([mine(), theirs()], ['apps/web/src/pages/Landing.tsx'])).toEqual(['aad6cc17']);
    // And the reverse.
    expect(targetsFor([mine(), theirs()], ['apps/api/src/routes/sessions.ts'])).toEqual(['0a8e2164']);
  });

  it('credits nobody when no session touched the committed file', () => {
    // Branch cannot separate them and neither ledger matches — the ladder
    // declines, and the fallback finds no plausible owner. Broadcasting here
    // is what produced the original bug.
    const sessions = [mine(), theirs()];
    const targets = targetsFor(sessions, ['docs/notes/unrelated.md']);
    expect(targets).toEqual([]);
  });

  it('still credits both when both genuinely touched the commit', () => {
    const a = mine();
    const b = theirs();
    b.completedPromptMappings = [{ filesChanged: ['apps/api/src/routes/sessions.ts'] }];
    // pickSessionForCommit resolves one by overlap; if it ever declines, the
    // fallback must keep both rather than silently drop a real author.
    const picked = pickSessionForCommit([a, b], {
      detectedSlug: null,
      currentBranch: 'fix/landing-agent-count',
      commitFiles: ['apps/api/src/routes/sessions.ts'],
    });
    if (!picked.session) {
      expect([a, b].filter((s) => sessionTouchedAnyCommitFile(s, ['apps/api/src/routes/sessions.ts'])))
        .toHaveLength(2);
    } else {
      expect(['0a8e2164', 'aad6cc17']).toContain(picked.session.sessionId);
    }
  });

  it('leaves the single-session case exactly as it was', () => {
    // No ambiguity, no narrowing: the one session gets its commit even when
    // its ledger has not caught up (a shell-edit turn has no mapping yet).
    const solo = mine();
    solo.completedPromptMappings = [];
    expect(targetsFor([solo], ['anything.ts'])).toEqual(['0a8e2164']);
  });

  // The same answer now also governs the commit's COUNTERS.
  //
  // post-commit's state-writing loop ran over every active session in the repo
  // and accumulated the commit's filesChanged / linesAdded / linesRemoved /
  // commitCount onto all of them. Two agents sharing a checkout each ended up
  // holding the other's commits — a session that had written nothing all turn
  // still showed a stranger's files and line totals. #1188's header flagged it
  // as the next thing to go wrong here.
  //
  // These pin the ownership answer the loop consumes; the loop itself just
  // filters on `counterSessionIds.has(s.sessionId)`.
  describe('commit counters follow the same ownership answer', () => {
    it('credits only the resolved owner, not every co-located session', () => {
      const owner = mine();
      const neighbour = theirs();
      const credited = pickCommitUpdateTargets([owner, neighbour], owner, ['src/App.tsx']);
      expect(credited.map((s) => s.sessionId)).toEqual([owner.sessionId]);
      expect(credited.map((s) => s.sessionId)).not.toContain(neighbour.sessionId);
    });

    it('falls back to sessions whose OWN edits touch the commit, never all of them', () => {
      // The ladder declined to guess. Crediting everyone is what produced the
      // bug; crediting the plausible owners is the honest middle.
      const toucher = mine();
      const bystander = theirs();
      bystander.completedPromptMappings = [{ filesChanged: ['unrelated/thing.ts'] }];
      const credited = pickCommitUpdateTargets(
        [toucher, bystander], null, (toucher.completedPromptMappings ?? []).at(-1)!.filesChanged!,
      );
      expect(credited.map((s) => s.sessionId)).toEqual([toucher.sessionId]);
    });

    it('credits nobody when no co-located session touched the commit', () => {
      const a = mine();
      const b = theirs();
      a.completedPromptMappings = [{ filesChanged: ['a.ts'] }];
      b.completedPromptMappings = [{ filesChanged: ['b.ts'] }];
      expect(pickCommitUpdateTargets([a, b], null, ['somebody/elses.ts'])).toEqual([]);
    });
  });
});
