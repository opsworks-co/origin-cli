/**
 * The retroactive capture in user-prompt-submit undid the exclusion Stop had
 * just computed.
 *
 * Stop drops a concurrent session's commits out of the turn window before
 * anything reads the capture. The user-prompt-submit path re-derives the
 * PREVIOUS turn from git on the next prompt and then REPLACES the stored
 * mapping — and it never applied that drop, so a foreign commit walked back in
 * one prompt later.
 *
 * Session b0c86852, from hooks.log:
 *
 *   23:24:44.297  [stop] dropped concurrent session commits
 *                 {"dropped":["aab018ef"],"files":7}
 *   23:24:44.779  [stop] calling api.updateSession … {"i":2,"f":2}
 *   23:25:53.353  [user-prompt-submit] captured per-prompt diff for previous
 *                 prompt {"promptIndex":2,"filesChanged":9,"linesAdded":307}
 *
 * 2 files became 9. The five added were #1380's, which Stop had correctly
 * dropped 69 seconds earlier.
 *
 * The tell is that the stored DIFF stayed clean the whole time — it is built
 * from `sessionScopedCommittedDiff`, which is scoped to our own commits. Only
 * the FILE LIST took the raw `baseline..HEAD` range. So the row ended up
 * claiming five files whose changes its own diff did not contain, which is the
 * "counts on a diff that doesn't hold them" shape.
 */
import { describe, it, expect } from 'vitest';
import { retroactiveTurnFiles } from '../commands/hooks.js';

const hunk = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y\n`;

// The real b0c86852 turn 3 window: our own rebased commit, plus #1380.
const OURS = [
  'packages/cli/package-lock.json',
  'packages/cli/package.json',
  'packages/cli/src/__tests__/big-shell-file-and-turn-scoped-exemption.test.ts',
  'packages/cli/src/commands/hooks.ts',
];
const THEIRS = [
  'apps/api/src/__tests__/routes/session-detail-window-repeated-row.test.ts',
  'apps/api/src/__tests__/services/prompt-line-counts-heal.test.ts',
  'apps/api/src/routes/sessions.ts',
  'packages/cli/src/__tests__/codex-window-chains-by-blob.test.ts',
  'packages/cli/src/agents/codex.ts',
];

const sessionCommitted = OURS.map(hunk).join('');
const rawRange = [...OURS, ...THEIRS].map(hunk).join('');

describe('the retroactive per-prompt file list', () => {
  it('does not re-admit a concurrent session\'s files', () => {
    // The exact input that produced 9. Stop had already named THEIRS foreign.
    expect(retroactiveTurnFiles(sessionCommitted, rawRange, THEIRS).sort())
      .toEqual([...OURS].sort());
  });

  it('reproduces the 9-file bug when the drop is not applied', () => {
    // Pinning the defect itself: with no foreign list the old behaviour is
    // exactly what shipped — 4 ours + 5 theirs.
    expect(retroactiveTurnFiles(sessionCommitted, rawRange, []).length).toBe(9);
  });

  it('keeps files the raw range knows about and the scoped diff missed', () => {
    // The raw range is a genuine safety net — it is only the FOREIGN part of it
    // that had to go. A file of ours that sessionScopedCommittedDiff did not
    // carry must still be reported.
    const missed = 'packages/cli/src/late.ts';
    expect(retroactiveTurnFiles('', hunk(missed), THEIRS)).toEqual([missed]);
  });

  it('never drops a file the scoped diff itself carries', () => {
    // A path both a concurrent commit and our own turn touched stays ours: the
    // scoped diff is proof we changed it, and the filter is not applied there.
    const shared = 'apps/api/src/routes/sessions.ts';
    expect(THEIRS).toContain(shared); // the concurrent commit touched it too
    expect(retroactiveTurnFiles(hunk(shared), hunk(shared), THEIRS)).toEqual([shared]);
  });

  it('matches foreign paths across a repo-relative / absolute mismatch', () => {
    // The same suffix rule Stop's own exemption filter uses — the two sides do
    // not always agree on the prefix.
    expect(retroactiveTurnFiles('', hunk('apps/api/src/routes/sessions.ts'),
      ['src/routes/sessions.ts'])).toEqual([]);
  });
});
