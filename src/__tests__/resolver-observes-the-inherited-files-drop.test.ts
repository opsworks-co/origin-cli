/**
 * The resolver's answer must be the row AFTER the inherited-files drop.
 *
 * Every pass reports what it found through `observe` and then
 * `dropInheritedFilesFromTurns` takes out of the row what a commit the turn
 * did not make left in its window. The resolver only saw the pre-drop
 * reports, so it kept resurrecting the inherited file: all 33 differences in
 * ten days of side-by-side logs were this one case (resolver audit 3,
 * 2026-09-27 — 92f14dfb turn 10 ×5, f5556085 turn 13 ×18, and six id-less
 * turns whose reconstruction named the inherited list). Slice 3 of the
 * consolidation (416e0aae) cannot switch the sent row to the resolver's
 * while the resolver disagrees with a correct row.
 *
 * The drop pass now reports the row it changed under the source that filled
 * it, so the resolver's latest observation for that source is the dropped row.
 */
import { describe, it, expect } from 'vitest';
import { dropInheritedFilesFromTurns, type InheritedFilesRow } from '../drop-inherited-files.js';
import { compareResolverWithPasses, createTurnObserver, observeReconstruction, resolveTurn } from '../resolve-turn.js';

const section = (file: string, line: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;

const state = () => ({
  prompts: ['fix it', 'and then'],
  promptShadows: [{ promptIndex: 0, shadowSha: 'a'.repeat(40), completeBaseline: true }, { promptIndex: 1, shadowSha: 'c'.repeat(40), completeBaseline: true }],
  turnEndShadows: [{ promptIndex: 0, shadowSha: 'b'.repeat(40), capturedAt: new Date().toISOString(), completeBaseline: true }],
});

/** The ledger filled turn 0 with its own a.ts and the inherited b.ts. */
const ledgerRow = (): InheritedFilesRow & { diffSource: string } => ({
  promptIndex: 0, diffSource: 'ledger',
  filesChanged: ['a.ts', 'b.ts'], diff: section('a.ts', 'mine') + section('b.ts', 'theirs'),
  linesAdded: 2, linesRemoved: 0, uncommittedDiff: '',
});

function runDrop(row: InheritedFilesRow, observe?: (i: number, o: any) => void) {
  return dropInheritedFilesFromTurns(state(), [row], {
    inheritedFiles: () => new Set(['b.ts']),
    authoredFiles: () => new Set(['a.ts']),
    observe,
  });
}

describe('the resolver after the inherited-files drop', () => {
  it('agrees with the dropped row when the drop reports it', () => {
    const row = ledgerRow();
    const observer = createTurnObserver();
    observeReconstruction([row], observer);
    observer.observe(0, { source: 'ledger', outcome: 'applied', files: ['a.ts', 'b.ts'], diff: row.diff!, added: 2, removed: 0, contentUnavailable: [] });
    expect(runDrop(row, observer.observe)).toBe(1);
    expect(row.filesChanged).toEqual(['a.ts']);

    const resolved = resolveTurn(observer.observations(0));
    expect(resolved.kind).toBe('diff');
    expect((resolved as { files: string[] }).files).toEqual(['a.ts']);
    const events: Array<[string, Record<string, unknown>]> = [];
    const tally = compareResolverWithPasses([row], observer, (e, d) => events.push([e, d]));
    expect(tally).toEqual({ agree: 1, differ: 0, unavailable: 0 });
    expect(events.map(([e]) => e)).toEqual(['resolver side by side']);
  });

  it('control: without the report the resolver resurrects the inherited file', () => {
    const row = ledgerRow();
    const observer = createTurnObserver();
    observeReconstruction([row], observer);
    observer.observe(0, { source: 'ledger', outcome: 'applied', files: ['a.ts', 'b.ts'], diff: row.diff!, added: 2, removed: 0, contentUnavailable: [] });
    runDrop(row);
    const tally = compareResolverWithPasses([row], observer, () => {});
    expect(tally.differ).toBe(1);
  });

  it('reports a row the drop emptied as empty, under its own source', () => {
    const row: InheritedFilesRow & { diffSource: string } = {
      promptIndex: 0, diffSource: 'turn-window', filesChanged: ['b.ts'], diff: section('b.ts', 'theirs'), linesAdded: 1, linesRemoved: 0, uncommittedDiff: '',
    };
    const observer = createTurnObserver();
    observeReconstruction([row], observer);
    observer.observe(0, { source: 'turn-window', outcome: 'applied', files: ['b.ts'], diff: row.diff!, added: 1, removed: 0, contentUnavailable: [] });
    expect(runDrop(row, observer.observe)).toBe(1);
    expect(row.filesChanged).toEqual([]);
    expect(compareResolverWithPasses([row], observer, () => {}).agree).toBe(1);
  });

  it('a row no pass filled reports as the reconstruction', () => {
    const row: InheritedFilesRow = { promptIndex: 0, filesChanged: ['a.ts', 'b.ts'], diff: section('a.ts', 'mine') + section('b.ts', 'theirs'), linesAdded: 2, linesRemoved: 0 };
    const observer = createTurnObserver();
    observeReconstruction([row], observer);
    expect(runDrop(row, observer.observe)).toBe(1);
    const resolved = resolveTurn(observer.observations(0));
    expect(resolved.kind === 'diff' && resolved.source).toBe('reconstruction');
    expect(compareResolverWithPasses([row], observer, () => {}).agree).toBe(1);
  });
});
