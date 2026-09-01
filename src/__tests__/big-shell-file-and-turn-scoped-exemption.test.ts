/**
 * Two ways a turn's numbers stopped matching the commit it produced, both
 * found on session 3dbff831 by reading its own capture back against git.
 *
 * The commit was 9 files, +139/-33. Its turn read +131/-20 over 7 files, and
 * the release turn above it — which authored nothing — read +31/-2.
 *
 *  1. SIZE DECIDED ATTRIBUTION. The shell window stores whole files, so the
 *     96KB ceiling was measured against the FILE, not its change.
 *     SessionDetail.tsx (112KB) and RepoDetail.tsx (120KB) were edited by
 *     shell scripts, skipped `too-large`, and their +8/-13 landed on no turn
 *     at all — 131 + 8 = 139, 20 + 13 = 33. Dropping is unrecoverable: the
 *     next turn's baseline is anchored at the current tree.
 *
 *  2. THE EXEMPTION OUTLIVED ITS TURN. Files a turn edited itself are exempt
 *     from the concurrent-commit exclusion, but the check ran against the
 *     whole SESSION's transcript, so a path any earlier turn had touched
 *     stayed exempt forever. #1377's +31/-2 on sessions.ts was correctly
 *     dropped and then handed straight back.
 */
import { describe, it, expect } from 'vitest';
import {
  shellWindowEdits,
  trimToChangedRegion,
  SHELL_WINDOW_SOURCE,
  type ShellWindowDeps,
} from '../shell-write-capture.js';
import { filesOwnedByTurn } from '../commands/hooks.js';

const lines = (n: number, tag = 'row') =>
  Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n');

const deps = (files: string[], before: Record<string, string>, after: Record<string, string>): ShellWindowDeps => ({
  listChangedFiles: () => files,
  readAtRev: (_sha, f) => (f in before ? before[f] : null),
  readWorking: (f) => (f in after ? after[f] : null),
});

describe('trimToChangedRegion', () => {
  it('sheds the identical head and tail and reports the real anchor', () => {
    const before = ['a', 'b', 'c', 'd', 'OLD', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'NEW', 'e', 'f', 'g', 'h'].join('\n');

    const t = trimToChangedRegion(before, after, 1)!;

    // One line of context either side of the changed row (index 4 → line 5).
    expect(t.oldContent).toBe(['d', 'OLD', 'e'].join('\n'));
    expect(t.newContent).toBe(['d', 'NEW', 'e'].join('\n'));
    expect(t.startLine).toBe(4);
  });

  it('reports the same change an LCS over the WHOLE pair would', () => {
    const before = [lines(500), 'OLD', lines(500, 'tail')].join('\n');
    const after = [lines(500), 'NEW', lines(500, 'tail')].join('\n');

    const t = trimToChangedRegion(before, after)!;

    const removed = t.oldContent.split('\n').filter((l) => !t.newContent.split('\n').includes(l));
    const added = t.newContent.split('\n').filter((l) => !t.oldContent.split('\n').includes(l));
    expect(removed).toEqual(['OLD']);
    expect(added).toEqual(['NEW']);
    // And it is tiny, which is the whole point.
    expect(t.oldContent.length).toBeLessThan(200);
  });

  it('returns null when there is nothing to shed', () => {
    expect(trimToChangedRegion('same', 'same')).toBeNull();
    expect(trimToChangedRegion('a\nb', 'x\ny')).toBeNull();
  });
});

describe('a big file edited through the shell still reaches the turn', () => {
  // ~120KB either side, like RepoDetail.tsx, changing one line.
  const big = (marker: string) => [lines(6000), marker, lines(6000, 'tail')].join('\n');

  it('captures it instead of skipping it for its size', () => {
    const before = big('OLD LINE');
    const after = big('NEW LINE');
    expect(before.length + after.length).toBeGreaterThan(96 * 1024);

    const { edits, skipped } = shellWindowEdits(
      deps(['apps/web/src/pages/RepoDetail.tsx'], { 'apps/web/src/pages/RepoDetail.tsx': before }, { 'apps/web/src/pages/RepoDetail.tsx': after }),
      { baselineSha: 'sha' },
    );

    expect(skipped).toEqual([]);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe('apps/web/src/pages/RepoDetail.tsx');
    expect(edits[0].op).toBe('edit');
    expect(edits[0].backfillSource).toBe(SHELL_WINDOW_SOURCE);
    // The change survives...
    expect(edits[0].oldContent).toContain('OLD LINE');
    expect(edits[0].newContent).toContain('NEW LINE');
    // ...anchored where it really is, not at line 1: 6000 unchanged rows
    // precede the marker, less the 3 context lines the trim keeps.
    expect(edits[0].newStart).toBe(5998);
    expect(edits[0].oldStart).toBe(5998);
  });

  it('leaves a small file exactly as before — no anchor invented', () => {
    const { edits } = shellWindowEdits(
      deps(['notes.md'], { 'notes.md': 'a\n' }, { 'notes.md': 'b\n' }),
      { baselineSha: 'sha' },
    );

    expect(edits).toHaveLength(1);
    expect(edits[0].oldContent).toBe('a\n');
    expect(edits[0].newContent).toBe('b\n');
    expect(edits[0].newStart).toBeUndefined();
  });

  it('still skips a file whose CHANGE is genuinely too large', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['huge.txt'], { 'huge.txt': lines(6000) }, { 'huge.txt': lines(6000, 'all-different') }),
      { baselineSha: 'sha' },
    );

    expect(edits).toEqual([]);
    expect(skipped).toContainEqual({ file: 'huge.txt', reason: 'too-large' });
  });

  it('still skips an oversized CREATE — a new file is all change', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['new.txt'], {}, { 'new.txt': lines(20000) }),
      { baselineSha: 'sha' },
    );

    expect(edits).toEqual([]);
    expect(skipped).toContainEqual({ file: 'new.txt', reason: 'too-large' });
  });
});

describe('the concurrent-commit exemption is scoped to one turn', () => {
  const mappings = [
    { promptIndex: 0, filesChanged: ['apps/api/src/routes/sessions.ts'] },
    { promptIndex: 1, filesChanged: ['README.md'] },
  ];

  it('does not exempt a file only an EARLIER turn touched', () => {
    // The release turn (2) authored nothing. sessions.ts belongs to turn 0.
    expect(filesOwnedByTurn({}, mappings, 2, 2)).toEqual([]);
  });

  it('exempts a file the turn itself touched', () => {
    expect(filesOwnedByTurn({}, mappings, 0, 0)).toEqual(['apps/api/src/routes/sessions.ts']);
  });

  it('counts the turn\'s live ledger too, for tool calls the transcript has not flushed', () => {
    const state = {
      liveEdits: [
        { promptIndex: 2, edits: [{ file: 'src/live.ts' }] },
        { promptIndex: 0, edits: [{ file: 'src/other.ts' }] },
      ],
    };

    expect(filesOwnedByTurn(state, mappings, 2, 2)).toEqual(['src/live.ts']);
  });

  it('de-duplicates a file both sources report', () => {
    const state = { liveEdits: [{ promptIndex: 0, edits: [{ file: 'apps/api/src/routes/sessions.ts' }] }] };

    expect(filesOwnedByTurn(state, mappings, 0, 0)).toEqual(['apps/api/src/routes/sessions.ts']);
  });
});

/**
 * The follow-on defect: #1379 scoped the exemption to one turn, but resolved
 * that turn with the raw LOCAL counter against a list numbered in SERVER space.
 *
 * `extractPromptFileMappings` keeps each surviving turn's NATIVE transcript
 * position; `state.liveEdits` is keyed by `currentTurnIndex`, which indexes
 * `state.prompts` — only the turns this launch saw. The two agree while
 * `promptIndexBase` is 0, so an ordinary session never showed it. Resume,
 * compact or adopt a conversation and base B makes local L select native row L,
 * which is our own turn L − B.
 */
describe('the exemption resolves the turn in the right index space', () => {
  // A conversation adopted after 6 turns: base 6, so our local turn 0 is
  // native row 6 and our local turn 1 is native row 7.
  const resumed = [
    { promptIndex: 6, filesChanged: ['apps/api/src/routes/sessions.ts'] },
    { promptIndex: 7, filesChanged: ['README.md'] },
  ];

  it('finds the turn\'s own transcript files at its NATIVE row', () => {
    // Local turn 0 → server row 6. The pre-#1379 signature was handed 0, which
    // matches no row on this session, and the exemption went silent.
    expect(filesOwnedByTurn({}, resumed, 6, 0))
      .toEqual(['apps/api/src/routes/sessions.ts']);
  });

  it('does not hand an earlier turn\'s files to the turn B rows above it', () => {
    // Local turn 6 is the seventh turn of OUR launch — native row 12, which
    // this transcript has no mapping for. Reading it as row 6 would exempt
    // sessions.ts, a file local turn 0 wrote: the very miscredit #1379 fixed,
    // re-entered through the index space.
    expect(filesOwnedByTurn({}, resumed, 12, 6)).toEqual([]);
  });

  it('reads the LEDGER in local space while the mappings stay native', () => {
    // One turn, both sources, two different numbers for it.
    const state = { liveEdits: [{ promptIndex: 1, edits: [{ file: 'src/live.ts' }] }] };

    expect(filesOwnedByTurn(state, resumed, 7, 1))
      .toEqual(['README.md', 'src/live.ts']);
    // The ledger is local, so the native row must not reach it.
    expect(filesOwnedByTurn(state, resumed, 7, 7)).toEqual(['README.md']);
  });
});
