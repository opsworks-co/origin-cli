import { describe, it, expect } from 'vitest';
import { foldStopRows } from './helpers/fold-stop-rows.js';

describe('foldStopRows', () => {
  it('folds the #1561 sequence: a trailing single-turn send is not the whole session', () => {
    // Exact order observed on a failing capture-e2e-real-binary run, as
    // [promptIndex, linesAdded]. Last payload is turn 5 alone.
    const payloads = [
      [{ promptIndex: 0, linesAdded: 2 }],
      [{ promptIndex: 0, linesAdded: 2 }],
      [{ promptIndex: 1, linesAdded: 2 }],
      [{ promptIndex: 0, linesAdded: 2 }, { promptIndex: 1, linesAdded: 2 }],
      [
        { promptIndex: 0, linesAdded: 2 },
        { promptIndex: 1, linesAdded: 2 },
        { promptIndex: 2, linesAdded: 0 },
        { promptIndex: 3, linesAdded: 1 },
      ],
      [{ promptIndex: 4, linesAdded: 1 }],
    ];
    const rows = foldStopRows(payloads);
    expect(rows.map((r) => [r.promptIndex, r.linesAdded])).toEqual([
      [0, 2],
      [1, 2],
      [2, 0],
      [3, 1],
      [4, 1],
    ]);
    expect(rows.reduce((n, r) => n + (Number(r.linesAdded) || 0), 0)).toBe(6);
  });

  it('last write per index wins, including when bodies wrap promptChanges', () => {
    const rows = foldStopRows([
      { promptChanges: [{ promptIndex: 0, linesAdded: 1, tag: 'old' }] },
      { promptChanges: [{ promptIndex: 0, linesAdded: 9, tag: 'new' }, { promptIndex: 1, linesAdded: 3 }] },
      null,
      undefined,
      { promptChanges: [{ promptIndex: 1, linesAdded: 4, tag: 'later' }] },
    ]);
    expect(rows.map((r) => [r.promptIndex, r.linesAdded, r.tag])).toEqual([
      [0, 9, 'new'],
      [1, 4, 'later'],
    ]);
  });

  it('a row captured before the one already held does not replace it (server isStaleCapture)', () => {
    // The heartbeat stamps its in-flight resend, then spends seconds on git on a
    // loaded runner; Stop's payload for the same turn can reach the API first.
    const stop = { promptIndex: 3, capturedAt: 2_000, filesChanged: ['notes.md'], editsJson: '{"edits":[{"file":"notes.md"}]}' };
    const heartbeat = { promptIndex: 3, capturedAt: 1_000, filesChanged: ['notes.md'] };
    const [row] = foldStopRows([[stop], [heartbeat]]);
    expect(row).toBe(stop);
  });

  it('a newer row that omits editsJson keeps the stored evidence, and replaces everything else', () => {
    const first = { promptIndex: 3, capturedAt: 1_000, linesAdded: 1, editsJson: '{"edits":[{"file":"notes.md"}]}' };
    const later = { promptIndex: 3, capturedAt: 2_000, linesAdded: 2 };
    const [row] = foldStopRows([[first], [later]]);
    expect(row).toMatchObject({ capturedAt: 2_000, linesAdded: 2, editsJson: first.editsJson });
  });

  it('a newer row with its own editsJson replaces the stored one, and rows without stamps still fold in order', () => {
    const [stamped] = foldStopRows([
      [{ promptIndex: 0, capturedAt: 1, editsJson: 'old' }],
      [{ promptIndex: 0, capturedAt: 2, editsJson: 'new' }],
    ]);
    expect(stamped.editsJson).toBe('new');
    const [unstamped] = foldStopRows([[{ promptIndex: 0, tag: 'a' }], [{ promptIndex: 0, tag: 'b' }]]);
    expect(unstamped.tag).toBe('b');
  });

  it('returns [] for empty or shapeless input', () => {
    expect(foldStopRows([])).toEqual([]);
    expect(foldStopRows([null, undefined, { promptChanges: undefined }])).toEqual([]);
  });
});
