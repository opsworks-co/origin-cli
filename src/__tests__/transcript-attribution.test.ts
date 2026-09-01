// A turn-window sweep is an INFERENCE with a known soft edge: the watcher polls,
// so turn N's window runs to a baseline for turn N+1 that was taken late, and
// turn N+1's first writes land on turn N. Prod session 376cc22f: turn 2 wrote
// README.md (write_to_file, in the transcript) and turn 1's shell window claimed
// it — the session rendered turn 2 as two files and turn 1 as five.
//
// The transcript is the authority on WHICH TURN wrote a file. These tests pin
// both halves: the prevention (a window never claims another turn's file) and
// the repair (an already-assembled payload is corrected), plus the guards that
// keep a correct row from being degraded by running the check.

import { describe, it, expect } from 'vitest';
import {
  transcriptWriterTurns,
  filesRecordedForOtherTurns,
  reconcileWindowAttribution,
  type AttributedTurn,
} from '../transcript-attribution';

const windowEdit = (file: string, over: Record<string, unknown> = {}) => ({
  file,
  op: 'edit',
  oldContent: 'a\n',
  newContent: 'a\nb\n',
  source: 'uncommitted',
  evidence: 'turn_window',
  ...over,
});

const toolEdit = (file: string) => ({
  file,
  op: 'write',
  newContent: 'x\n',
  source: 'tool_call',
});

const writers = (pairs: Array<[string, number[]]>): Map<string, Set<number>> =>
  new Map(pairs.map(([f, turns]) => [f, new Set(turns)]));

describe('transcriptWriterTurns', () => {
  it('maps each repo-relative file to the turns that wrote it', () => {
    const byFile = transcriptWriterTurns(
      [
        { promptIndex: 0, edits: [{ file: '/repo/app.js' }] },
        { promptIndex: 1, edits: [{ file: '/repo/README.md' }, { file: '/repo/app.js' }] },
      ],
      (f) => (f.startsWith('/repo/') ? f.slice('/repo/'.length) : null),
    );
    expect([...(byFile.get('app.js') || [])].sort()).toEqual([0, 1]);
    expect([...(byFile.get('README.md') || [])]).toEqual([1]);
  });

  it('drops paths the caller maps outside the repo', () => {
    const byFile = transcriptWriterTurns(
      [{ promptIndex: 0, edits: [{ file: '/tmp/scratch.md' }, { file: '/repo/a.ts' }] }],
      (f) => (f.startsWith('/repo/') ? f.slice('/repo/'.length) : null),
    );
    expect([...byFile.keys()]).toEqual(['a.ts']);
  });

  it('survives a mapper that throws on a malformed path', () => {
    const byFile = transcriptWriterTurns(
      [{ promptIndex: 0, edits: [{ file: 'boom' }, { file: '/repo/a.ts' }] }],
      (f) => { if (f === 'boom') throw new Error('bad path'); return f.slice('/repo/'.length); },
    );
    expect([...byFile.keys()]).toEqual(['a.ts']);
  });
});

describe('filesRecordedForOtherTurns', () => {
  it('names files the transcript attributes to a different turn', () => {
    const byFile = writers([['README.md', [2]], ['app.js', [1]]]);
    expect(filesRecordedForOtherTurns(byFile, 1)).toEqual(['README.md']);
  });

  it('never shields a file this turn also wrote — a two-turn file stays claimable', () => {
    const byFile = writers([['shared.ts', [1, 2]]]);
    expect(filesRecordedForOtherTurns(byFile, 1)).toEqual([]);
    expect(filesRecordedForOtherTurns(byFile, 2)).toEqual([]);
  });
});

describe('reconcileWindowAttribution', () => {
  it('moves an inferred edit to the turn the transcript records writing it', () => {
    // The 376cc22f case: turn 1's window swallowed turn 2's README.md.
    const turns: AttributedTurn[] = [
      { promptIndex: 1, edits: [toolEdit('app.js'), windowEdit('README.md')] },
      { promptIndex: 2, edits: [toolEdit('.gitignore')] },
    ];
    const findings = reconcileWindowAttribution(turns, writers([['README.md', [2]]]));

    expect(findings).toEqual([
      { file: 'README.md', heldBy: 1, recordedBy: 2, action: 'moved' },
    ]);
    expect(turns[0].edits.map((e) => e.file)).toEqual(['app.js']);
    expect(turns[1].edits.map((e) => e.file)).toEqual(['.gitignore', 'README.md']);
  });

  it('carries the moved edit\'s content across and stamps its provenance', () => {
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [] },
    ];
    reconcileWindowAttribution(turns, writers([['README.md', [1]]]));

    const moved = turns[1].edits[0];
    expect(moved.newContent).toBe('a\nb\n');
    expect(moved.oldContent).toBe('a\n');
    // Attribution is now backed by the transcript's own record of the call.
    expect(moved.evidence).toBe('tool_call');
    expect(moved.backfillSource).toBe('transcript-reattributed-from-0');
  });

  it('appends to an existing backfillSource rather than overwriting it', () => {
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md', { backfillSource: 'shell-window' })] },
      { promptIndex: 1, edits: [] },
    ];
    reconcileWindowAttribution(turns, writers([['README.md', [1]]]));
    expect(turns[1].edits[0].backfillSource).toBe('shell-window+transcript-reattributed-from-0');
  });

  it('drops the window copy when the recorded turn already carries the file', () => {
    // Both halves fired: the window guessed turn 0 while turn 1 has the real
    // record. Moving would duplicate the file; the wrong turn just loses it.
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [toolEdit('README.md')] },
    ];
    const findings = reconcileWindowAttribution(turns, writers([['README.md', [1]]]));

    expect(findings).toEqual([
      { file: 'README.md', heldBy: 0, recordedBy: 1, action: 'dropped' },
    ]);
    expect(turns[0].edits).toEqual([]);
    expect(turns[1].edits.map((e) => e.file)).toEqual(['README.md']);
  });

  it('replaces a NO-OP edit on the recorded turn instead of dropping the real delta', () => {
    // The late baseline that misfiles the window edit also poisons the target
    // turn's own record: backfillWriteBaselines recovers a before-state taken
    // AFTER the write, so the turn's tool_call edit is old === new and renders
    // nothing. Dropping the window copy beside it would erase the file from
    // both turns — which is worse than the bug being fixed.
    const noop = { file: 'README.md', op: 'write', oldContent: 'done\n', newContent: 'done\n', source: 'tool_call' };
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [toolEdit('app.js'), noop] },
    ];
    const findings = reconcileWindowAttribution(turns, writers([['README.md', [1]]]));

    expect(findings).toEqual([
      { file: 'README.md', heldBy: 0, recordedBy: 1, action: 'moved' },
    ]);
    expect(turns[0].edits).toEqual([]);
    expect(turns[1].edits.map((e) => e.file)).toEqual(['app.js', 'README.md']);
    // The surviving README edit is the one that actually renders a diff.
    const readme = turns[1].edits.find((e) => e.file === 'README.md')!;
    expect(readme.oldContent).toBe('a\n');
    expect(readme.newContent).toBe('a\nb\n');
  });

  it('drops the window copy when the recorded turn\'s own edit carries a real change', () => {
    // A create counts: '' → content is a change, so the target renders it.
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [{ file: 'README.md', op: 'create', newContent: 'hi\n', source: 'tool_call' }] },
    ];
    const findings = reconcileWindowAttribution(turns, writers([['README.md', [1]]]));
    expect(findings[0].action).toBe('dropped');
    expect(turns[1].edits).toHaveLength(1);
    expect(turns[1].edits[0].newContent).toBe('hi\n');
  });

  it('never touches proof-grade evidence, even when the transcript disagrees', () => {
    // A file the agent's own hook / probe named is not a guess. If the two
    // records disagree, the proof wins and this check stays out of it.
    for (const evidence of ['tool_call', 'command_named', 'command_probe', 'edit_hook', 'write_journal']) {
      const turns: AttributedTurn[] = [
        { promptIndex: 0, edits: [windowEdit('README.md', { evidence })] },
        { promptIndex: 1, edits: [] },
      ];
      const findings = reconcileWindowAttribution(turns, writers([['README.md', [1]]]));
      expect(findings).toEqual([]);
      expect(turns[0].edits).toHaveLength(1);
    }
  });

  it('leaves an edit alone when the transcript never recorded that file', () => {
    // A shell heredoc / `sed -i` write leaves no tool call. Absence of a record
    // is "unknown", not "did not happen" — the window is the only evidence.
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('generated.lock')] },
      { promptIndex: 1, edits: [] },
    ];
    expect(reconcileWindowAttribution(turns, writers([['README.md', [1]]]))).toEqual([]);
    expect(turns[0].edits).toHaveLength(1);
  });

  it('leaves an edit alone when the transcript agrees with the holding turn', () => {
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [] },
    ];
    expect(reconcileWindowAttribution(turns, writers([['README.md', [0, 1]]]))).toEqual([]);
    expect(turns[0].edits).toHaveLength(1);
  });

  it('leaves an ambiguous file alone when several other turns wrote it', () => {
    // No single right answer, and guessing again is what put the edit here.
    const turns: AttributedTurn[] = [
      { promptIndex: 0, edits: [windowEdit('README.md')] },
      { promptIndex: 1, edits: [] },
      { promptIndex: 2, edits: [] },
    ];
    expect(reconcileWindowAttribution(turns, writers([['README.md', [1, 2]]]))).toEqual([]);
    expect(turns[0].edits).toHaveLength(1);
  });

  it('leaves an edit alone when the recorded turn is not in this payload', () => {
    // A partial capture / windowed re-send. Moving it nowhere would delete work.
    const turns: AttributedTurn[] = [{ promptIndex: 0, edits: [windowEdit('README.md')] }];
    expect(reconcileWindowAttribution(turns, writers([['README.md', [4]]]))).toEqual([]);
    expect(turns[0].edits).toHaveLength(1);
  });

  it('does nothing when the transcript recorded no writes at all', () => {
    // A parser miss must never be allowed to move real captured data.
    const turns: AttributedTurn[] = [{ promptIndex: 0, edits: [windowEdit('README.md')] }];
    expect(reconcileWindowAttribution(turns, new Map())).toEqual([]);
    expect(turns[0].edits).toHaveLength(1);
  });

  it('is idempotent — a second pass over corrected turns finds nothing', () => {
    const turns: AttributedTurn[] = [
      { promptIndex: 1, edits: [toolEdit('app.js'), windowEdit('README.md')] },
      { promptIndex: 2, edits: [toolEdit('.gitignore')] },
    ];
    const byFile = writers([['README.md', [2]]]);
    expect(reconcileWindowAttribution(turns, byFile)).toHaveLength(1);
    expect(reconcileWindowAttribution(turns, byFile)).toEqual([]);
    expect(turns[1].edits.map((e) => e.file)).toEqual(['.gitignore', 'README.md']);
  });

  it('handles empty and malformed input without throwing', () => {
    expect(reconcileWindowAttribution([], writers([['a', [0]]]))).toEqual([]);
    const turns = [
      { promptIndex: 0, edits: [null as unknown as AttributedTurn['edits'][0], windowEdit('a.ts')] },
      { promptIndex: 1, edits: [] },
    ];
    expect(reconcileWindowAttribution(turns, writers([['a.ts', [1]]]))).toHaveLength(1);
    // The malformed entry is preserved, not silently swallowed.
    expect(turns[0].edits).toEqual([null]);
  });
});
