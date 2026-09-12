// The verifier checks the session HEADER against the turns.
//
// Every per-turn rule compares a row with itself, so a header that disagreed
// with the rows beneath it was invisible: session 51995e1c stored +1218 across
// 27 files above turns carrying +895 across 16, and `origin verify-capture`
// read it as clean. The header is a different producer (the session
// accumulator, the session-level snapshot) with its own arithmetic, and that
// is exactly where the merge and foreign-commit leaks land.
//
// Two rules. A file the header lists must appear in some turn's capture. And
// the header's totals must not EXCEED the turns' — one-sided, because turns
// legitimately sum to more (an add later removed is two actions, zero net).
import { describe, it, expect } from 'vitest';
import {
  verifyHeader,
  verifySession,
  summarize,
  isMidTurnHeader,
  SESSION_LEVEL_INDEX,
  type VerifiableTurn,
} from '../capture-verify.js';

const patch = (file: string, adds: string[], removes: string[] = []) => [
  `diff --git a/${file} b/${file}`,
  'index 1111111..2222222 100644',
  `--- a/${file}`,
  `+++ b/${file}`,
  `@@ -1,${1 + removes.length} +1,${1 + adds.length} @@`,
  ' context',
  ...removes.map((l) => `-${l}`),
  ...adds.map((l) => `+${l}`),
].join('\n');

const turns: VerifiableTurn[] = [
  { promptIndex: 0, filesChanged: ['src/a.ts'], diff: patch('src/a.ts', ['one', 'two']) },
  { promptIndex: 1, filesChanged: ['src/b.ts'], diff: patch('src/b.ts', ['three'], ['old']) },
];

describe('verifyHeader', () => {
  it('a header that summarises its turns is clean', () => {
    expect(verifyHeader({ filesChanged: ['src/a.ts', 'src/b.ts'], linesAdded: 3, linesRemoved: 1 }, turns)).toEqual([]);
  });

  it('a header may claim LESS than the turns sum to — net versus actions', () => {
    // Turn 0 added a line turn 1 removed: two actions, one net line.
    expect(verifyHeader({ filesChanged: ['src/a.ts', 'src/b.ts'], linesAdded: 2, linesRemoved: 0 }, turns)).toEqual([]);
  });

  it('a file in the header that no turn touched is a contradiction', () => {
    const v = verifyHeader({ filesChanged: ['src/a.ts', 'src/b.ts', 'their-feature.ts'], linesAdded: 3, linesRemoved: 1 }, turns);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      code: 'header_file_unclaimed_by_turns',
      severity: 'contradiction',
      promptIndex: SESSION_LEVEL_INDEX,
      files: ['their-feature.ts'],
    });
  });

  it('a header claiming more lines than every turn together is a contradiction', () => {
    // The merge leak, in miniature: +1218 stored above turns carrying +895.
    const v = verifyHeader({ filesChanged: ['src/a.ts', 'src/b.ts'], linesAdded: 40, linesRemoved: 1 }, turns);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('header_exceeds_turns');
    expect(v[0].detail).toMatch(/\+40\/-1/);
    expect(v[0].detail).toMatch(/\+3\/-1/);
  });

  it('a file the turn names without content, or wrote outside the repo, still claims it', () => {
    const t: VerifiableTurn[] = [
      { promptIndex: 0, filesChanged: ['bin/blob.png'], contentUnavailableFiles: ['bin/blob.png'] },
      { promptIndex: 1, filesChanged: [], outOfRepoFiles: ['~/scratch/x.md'] },
    ];
    expect(verifyHeader({ filesChanged: ['bin/blob.png', '~/scratch/x.md'], linesAdded: 0, linesRemoved: 0 }, t)).toEqual([]);
  });

  it('an absolute header path matches the turn\'s repo-relative one', () => {
    expect(verifyHeader({ filesChanged: ['/Users/dev/repo/src/a.ts'], linesAdded: 2, linesRemoved: 0 }, turns)).toEqual([]);
  });

  it('turns with counters but no diff text are summed by their counters', () => {
    const t: VerifiableTurn[] = [{ promptIndex: 0, filesChanged: ['x.ts'], linesAdded: 5, linesRemoved: 2 }];
    expect(verifyHeader({ filesChanged: ['x.ts'], linesAdded: 5, linesRemoved: 2 }, t)).toEqual([]);
    expect(verifyHeader({ filesChanged: ['x.ts'], linesAdded: 6, linesRemoved: 2 }, t).map((v) => v.code)).toEqual(['header_exceeds_turns']);
  });

  it('with no turns, or no header, there is nothing to contradict', () => {
    expect(verifyHeader({ filesChanged: ['a.ts'], linesAdded: 9, linesRemoved: 0 }, [])).toEqual([]);
    expect(verifyHeader(null, turns)).toEqual([]);
    // File-set records are not turns.
    expect(verifyHeader({ filesChanged: ['a.ts'], linesAdded: 9, linesRemoved: 0 }, [{ promptIndex: 0, fileSetOnly: true, filesChanged: ['a.ts'] }])).toEqual([]);
  });
});

describe('verifySession with a header', () => {
  it('reports the header finding beside the per-turn ones, without dirtying a turn', () => {
    const violations = verifySession(turns, { filesChanged: ['src/a.ts', 'src/b.ts', 'leak.ts'], linesAdded: 99, linesRemoved: 1 });
    expect(violations.map((v) => v.code).sort()).toEqual(['header_exceeds_turns', 'header_file_unclaimed_by_turns']);
    const s = summarize(turns, violations);
    expect(s.contradictions).toBe(2);
    // Both turns are internally consistent; the defect is the header's.
    expect(s.cleanTurns).toBe(2);
  });

  it('is unchanged without a header', () => {
    expect(verifySession(turns)).toEqual([]);
  });
});

// A header is only comparable with its turns once they are ALL there.
//
// post-commit SETS the session totals when `git commit` runs; Stop appends the
// row for the turn that ran it at the END of the turn. In between, the header
// carries work no turn carries — and both header rules called that a
// contradiction. `scripts/release-cli.sh` runs the gate from inside an agent's
// own turn, so the releasing session was always in that window: the gate failed
// on itself, and `--allow-contradictions` was the only way past, which silences
// the check for every other session in the range too.
describe('a session with a turn still open', () => {
  // Header carries a commit's +40 that turn 2's row will account for once Stop
  // writes it — exactly what post-commit leaves behind mid-turn.
  const midTurn = {
    filesChanged: ['src/a.ts', 'src/b.ts', 'src/uncaptured.ts'],
    linesAdded: 40,
    linesRemoved: 1,
    openTurnIndex: 2,
  };

  it('is not graded on either header rule', () => {
    expect(verifyHeader(midTurn, turns)).toEqual([]);
    expect(verifySession(turns, midTurn)).toEqual([]);
  });

  it('is graded again the moment the turn closes', () => {
    // closeTurn nulls activeTurn at Stop; the same header is then a finding.
    const closed = { ...midTurn, openTurnIndex: null };
    expect(verifyHeader(closed, turns).map((v) => v.code).sort())
      .toEqual(['header_exceeds_turns', 'header_file_unclaimed_by_turns']);
  });

  it('a session with nothing more coming is graded whatever its open turn says', () => {
    // A turn killed by an API error, an interrupt or a killed agent never
    // Stops, so activeTurn stays set for good — an ENDED session and a zombie
    // RUNNING one alike. That must not buy a permanent exemption.
    expect(verifyHeader({ ...midTurn, noMoreTurns: true }, turns).map((v) => v.code).sort())
      .toEqual(['header_exceeds_turns', 'header_file_unclaimed_by_turns']);
  });

  it('absence never confers the privilege', () => {
    // A producer that stops recording activeTurn is graded, not excused —
    // the rule isFileSetRecord follows for the same reason.
    expect(verifyHeader({ ...midTurn, openTurnIndex: undefined }, turns)).toHaveLength(2);
    expect(isMidTurnHeader({ filesChanged: ['a.ts'] })).toBe(false);
    expect(isMidTurnHeader(null)).toBe(false);
    // A malformed index is not an assertion that a turn is open.
    expect(isMidTurnHeader({ openTurnIndex: NaN })).toBe(false);
    expect(isMidTurnHeader({ openTurnIndex: 1.5 })).toBe(false);
    // Turn 0 is a real turn index — falsy, and it must still count.
    expect(isMidTurnHeader({ openTurnIndex: 0 })).toBe(true);
  });

  it('leaves the per-turn rules alone — only the header comparison is unknown', () => {
    const broken: VerifiableTurn[] = [
      ...turns,
      { promptIndex: 2, filesChanged: ['src/c.ts'], diff: patch('src/other.ts', ['x']) },
    ];
    const codes = verifySession(broken, midTurn).map((v) => v.code).sort();
    expect(codes).toEqual(['claimed_file_absent_from_diff', 'diff_file_unclaimed']);
  });
});
