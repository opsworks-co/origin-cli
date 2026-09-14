/**
 * A blended re-capture declares the files its kept diff cannot show.
 *
 * keepRicherTurnCapture unions the prior and current file lists but keeps ONE
 * diff — whichever text is longer. A file only the losing capture carried is
 * then named with no content. Prod session 9f8501f7 turn 1 ("update origin
 * memory from github and decide on task") stored 20 claimed files over a
 * 4-file diff, and the release gate flagged `claimed_file_absent_from_diff`.
 *
 * The blend is deliberate until the ledger covers every path (see
 * ledger-answer-is-never-blended.test.ts, stop-recapture-shrinkage.test.ts), so
 * the file list and the diff choice are unchanged here. What changes: the files
 * the kept diff does not carry are named in `contentUnavailableFiles`, which
 * verify-capture already treats as an honest shortfall.
 */
import { describe, it, expect } from 'vitest';
import { keepRicherTurnCapture } from '../commands/hooks.js';
import { verifyTurn } from '../capture-verify.js';

function section(file: string, lines: number): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, i) => `+line ${i} of ${file}`),
    '',
  ].join('\n');
}

const counts = (diff: string) => ({
  linesAdded: diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
  linesRemoved: diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
});

type Row = { promptIndex: number; filesChanged: string[]; diff: string; contentUnavailableFiles?: string[] };

describe('keepRicherTurnCapture declares what the kept diff cannot show', () => {
  it('a longer current diff: the prior-only files are declared unavailable', () => {
    const previous = [{ promptIndex: 1, filesChanged: ['a.ts', 'b.ts'], diff: section('a.ts', 1) + section('b.ts', 1) }];
    const current: Row[] = [{ promptIndex: 1, filesChanged: ['c.ts'], diff: section('c.ts', 40) }];
    const [turn] = keepRicherTurnCapture(current, previous) as Row[];
    expect([...turn.filesChanged].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(turn.diff).toBe(current[0].diff);
    expect([...(turn.contentUnavailableFiles || [])].sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('a longer prior diff: the current-only files are declared instead', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['a.ts', 'b.ts'], diff: section('a.ts', 30) + section('b.ts', 30) }];
    const current: Row[] = [{ promptIndex: 0, filesChanged: ['b.ts', 'c.ts'], diff: section('c.ts', 1) }];
    const [turn] = keepRicherTurnCapture(current, previous) as Row[];
    expect(turn.diff).toBe(previous[0].diff);
    expect(turn.contentUnavailableFiles).toEqual(['c.ts']);
  });

  it('declares nothing when the kept diff carries every named file', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['a.ts'], diff: section('a.ts', 1) }];
    const current: Row[] = [{ promptIndex: 0, filesChanged: ['a.ts', 'b.ts'], diff: section('a.ts', 1) + section('b.ts', 5) }];
    const [turn] = keepRicherTurnCapture(current, previous) as Row[];
    expect(turn.contentUnavailableFiles).toBeUndefined();
  });

  it('keeps a declaration the current row already made, once', () => {
    const previous = [{ promptIndex: 0, filesChanged: ['a.ts'], diff: section('a.ts', 1) }];
    const current: Row[] = [{ promptIndex: 0, filesChanged: ['big.ts', 'c.ts'], diff: section('c.ts', 20), contentUnavailableFiles: ['big.ts', 'a.ts'] }];
    const [turn] = keepRicherTurnCapture(current, previous) as Row[];
    expect([...(turn.contentUnavailableFiles || [])].sort()).toEqual(['a.ts', 'big.ts']);
  });

  it('the 9f8501f7 shape now verifies clean: many claimed files over a short diff', () => {
    const pulled = Array.from({ length: 16 }, (_, i) => `apps/api/src/pulled-${i}.ts`);
    const own = ['apps/api/src/utils/commit-attribution.ts', 'apps/api/src/routes/sessions.ts'];
    const previous = [{ promptIndex: 1, filesChanged: [...pulled, ...own], diff: pulled.map((f) => section(f, 1)).join('') }];
    const current: Row[] = [{ promptIndex: 1, filesChanged: own, diff: own.map((f) => section(f, 120)).join('') }];
    const [turn] = keepRicherTurnCapture(current, previous) as Row[];
    expect(turn.filesChanged).toHaveLength(18);
    const findings = verifyTurn({
      promptIndex: 1, filesChanged: turn.filesChanged, diff: turn.diff,
      contentUnavailableFiles: turn.contentUnavailableFiles, ...counts(turn.diff),
    } as any);
    expect(findings.map((f: { code: string }) => f.code)).not.toContain('claimed_file_absent_from_diff');
  });

  it('without the declaration the same row is a contradiction (why this exists)', () => {
    const own = ['a.ts'];
    const findings = verifyTurn({
      promptIndex: 1, filesChanged: [...own, 'pulled.ts'], diff: section('a.ts', 3), ...counts(section('a.ts', 3)),
    } as any);
    expect(findings.map((f: { code: string }) => f.code)).toContain('claimed_file_absent_from_diff');
  });
});
