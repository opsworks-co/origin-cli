// Regression: ONE state file per server session.
//
// Real failure (Codex on Windows, from ~/.origin/hooks.log):
//   findStateForHook  match  sessionId:40618c4a  tag:"smry224c2"   ← state exists
//   session-start     session tag {"sessionTag":"smry262lp"}       ← mints a new tag
//   session-start     api returned {"sessionId":"40618c4a-..."}    ← server: SAME session
//   session-start     state saved {tag:"smry262lp"}                ← writes a 2nd file
//   findStateForHook  tags:["smry224c2","smry262lp"] candidateCount:2
//
// Two files for one session → the new one's prompts[] restarts at 0, so its
// turn indices collide with ones already recorded. Server promptText is
// append-only (first write wins), so the re-sent indices keep the OLD text and
// the new turns vanish — "it stopped capturing".

import { describe, it, expect } from 'vitest';
import { findDuplicateStateForSession, carryForwardTurnState } from '../session-dedup.js';

const SESSION = '40618c4a-c9ed-46db-88dc-a80f2553feb6';

const existing = {
  sessionId: SESSION,
  sessionTag: 'smry224c2',
  prompts: ['first prompt', 'second prompt', 'third prompt'],
  promptShadows: [
    { promptIndex: 0, shadowSha: 'aaa', capturedAt: '2026-07-23T22:00:00Z' },
    { promptIndex: 1, shadowSha: 'bbb', capturedAt: '2026-07-23T22:01:00Z' },
  ],
  promptStartedAt: [1000, 2000, 3000],
};

describe('findDuplicateStateForSession', () => {
  it('finds the same-session state written under a different tag', () => {
    expect(findDuplicateStateForSession([existing], SESSION, 'smry262lp')).toBe(existing);
  });

  it('ignores the state file for THIS tag (not a duplicate)', () => {
    expect(findDuplicateStateForSession([existing], SESSION, 'smry224c2')).toBeNull();
  });

  it('ignores states belonging to a different session', () => {
    expect(findDuplicateStateForSession([existing], 'some-other-session', 'smry262lp')).toBeNull();
  });

  it('returns null on empty input / missing ids', () => {
    expect(findDuplicateStateForSession([], SESSION, 'smry262lp')).toBeNull();
    expect(findDuplicateStateForSession([existing], '', 'smry262lp')).toBeNull();
    expect(findDuplicateStateForSession([existing], SESSION, '')).toBeNull();
  });
});

describe('carryForwardTurnState', () => {
  it('THE FIX: a fresh state continues turn numbering instead of restarting at 0', () => {
    const fresh = { sessionId: SESSION, sessionTag: 'smry262lp', prompts: [] as string[] };
    carryForwardTurnState(fresh, existing);
    // Without this the next turn would be promptIndex 0 and collide with the
    // already-recorded turn 0, whose text the server refuses to overwrite.
    expect(fresh.prompts).toHaveLength(3);
    expect((fresh as any).promptShadows).toHaveLength(2);
    expect((fresh as any).promptStartedAt).toEqual([1000, 2000, 3000]);
  });

  it('never lets a thinner duplicate clobber richer incoming state', () => {
    const richer = {
      sessionId: SESSION,
      sessionTag: 'smry262lp',
      prompts: ['a', 'b', 'c', 'd', 'e'],
      promptShadows: [
        { promptIndex: 0, shadowSha: 'x', capturedAt: 'x' },
        { promptIndex: 1, shadowSha: 'y', capturedAt: 'y' },
        { promptIndex: 2, shadowSha: 'z', capturedAt: 'z' },
      ],
    };
    carryForwardTurnState(richer, existing);
    expect(richer.prompts).toHaveLength(5);
    expect(richer.promptShadows).toHaveLength(3);
  });

  it('is a no-op against an empty duplicate', () => {
    const fresh = { sessionId: SESSION, sessionTag: 'smry262lp', prompts: ['only'] };
    carryForwardTurnState(fresh, { sessionId: SESSION, sessionTag: 'old', prompts: [] });
    expect(fresh.prompts).toEqual(['only']);
  });
});
