/**
 * The written ranking of a turn's content sources.
 *
 * Three passes decide a turn today and the order between them lives in the
 * order they are called. resolveTurn writes it down; these tests pin each
 * rung, including the one exception that crosses sources: an empty shadow
 * window yields to journal writes when its start is not a complete baseline.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveTurn, compareWithRow, compareResolverWithPasses, createTurnObserver, observeReconstruction,
  type TurnContent, type TurnObservation,
} from '../resolve-turn.js';

const content = (file: string, added: number, removed = 0): TurnContent => ({
  files: [file],
  diff: `diff --git a/${file} b/${file}\n+x\n`,
  added,
  removed,
  contentUnavailable: [],
});
const recon = (c: TurnContent): TurnObservation => ({ source: 'reconstruction', ...c });
const ledger = (c: TurnContent): TurnObservation => ({ source: 'ledger', outcome: 'applied', ...c });
const window = (c: TurnContent): TurnObservation => ({ source: 'turn-window', outcome: 'applied', ...c });
const commit = (c: TurnContent): TurnObservation => ({ source: 'commit-patch', outcome: 'applied', ...c });
const declined = (source: 'ledger' | 'turn-window' | 'commit-patch', reason: string): TurnObservation =>
  ({ source, outcome: 'declined', reason });
const empty = (completeBaseline: boolean): TurnObservation => ({ source: 'turn-window', outcome: 'empty', completeBaseline });

describe('resolveTurn ranks the sources', () => {
  it('the commit patch outranks every other source', () => {
    const r = resolveTurn([recon(content('r.ts', 9)), ledger(content('l.ts', 3)), window(content('w.ts', 2)), commit(content('c.ts', 1))]);
    expect(r).toMatchObject({ kind: 'diff', source: 'commit-patch', files: ['c.ts'], added: 1 });
  });

  it('the turn window outranks the ledger — it runs later and replaces the row', () => {
    const r = resolveTurn([recon(content('r.ts', 9)), ledger(content('l.ts', 3)), window(content('w.ts', 2)), declined('commit-patch', 'the turn made no commit')]);
    expect(r).toMatchObject({ kind: 'diff', source: 'turn-window', files: ['w.ts'] });
    expect(r.why).toContain('commit-patch declined: the turn made no commit');
  });

  it('an empty window keeps the ledger\'s writes when its start is not a complete baseline', () => {
    const r = resolveTurn([ledger(content('l.ts', 3)), empty(false)]);
    expect(r).toMatchObject({ kind: 'diff', source: 'ledger', files: ['l.ts'] });
  });

  it('an empty window between complete shadows is chat-only, whatever the ledger saw', () => {
    expect(resolveTurn([ledger(content('l.ts', 3)), empty(true)]).kind).toBe('chat-only');
  });

  it('an empty window with no journal writes is chat-only, and drops the reconstruction', () => {
    expect(resolveTurn([recon(content('leftover.ts', 154)), declined('ledger', 'turn is not marked in the journal'), empty(false)]).kind)
      .toBe('chat-only');
  });

  it('the ledger answers when the window declines', () => {
    const r = resolveTurn([recon(content('r.ts', 9)), ledger(content('l.ts', 3)), declined('turn-window', 'the window spans commits the turn did not make')]);
    expect(r).toMatchObject({ kind: 'diff', source: 'ledger', files: ['l.ts'] });
  });

  it('the reconstruction answers when no pass qualifies', () => {
    const r = resolveTurn([recon(content('r.ts', 9)), declined('ledger', 'row predates this launch'), declined('turn-window', 'no shadow window')]);
    expect(r).toMatchObject({ kind: 'diff', source: 'reconstruction', files: ['r.ts'] });
    expect(r.why).toEqual([
      'turn-window declined: no shadow window',
      'ledger declined: row predates this launch',
      'reconstruction: no higher source qualified',
    ]);
  });

  it('nothing with content is unavailable, never a guess', () => {
    const blank: TurnContent = { files: [], diff: '', added: 0, removed: 0, contentUnavailable: [] };
    expect(resolveTurn([recon(blank), declined('ledger', 'turn is not marked in the journal')]))
      .toMatchObject({ kind: 'unavailable', reason: 'no source has content for this turn' });
    expect(resolveTurn([])).toMatchObject({ kind: 'unavailable', reason: 'no capture was observed' });
  });

  it('a later report from the same source replaces an earlier one', () => {
    const r = resolveTurn([ledger(content('first.ts', 1)), ledger(content('second.ts', 2))]);
    expect(r).toMatchObject({ source: 'ledger', files: ['second.ts'] });
  });
});

describe('side by side with the passes', () => {
  const row = (c: TurnContent, extra: Record<string, unknown> = {}) => ({
    promptIndex: 0, filesChanged: c.files, diff: c.diff, linesAdded: c.added, linesRemoved: c.removed, ...extra,
  });

  it('a row carrying the resolver\'s content agrees, whatever its diffSource label', () => {
    const c = content('c.ts', 4);
    expect(compareWithRow(row(c, { diffSource: 'ledger' }), resolveTurn([commit(c)]))).toEqual({ verdict: 'agree', fields: [] });
  });

  it('names the fields that differ', () => {
    expect(compareWithRow(row(content('a.ts', 4)), resolveTurn([window(content('a.ts', 5, 1))])))
      .toEqual({ verdict: 'differ', fields: ['linesAdded', 'linesRemoved'] });
  });

  it('an empty row against unavailable is its own verdict', () => {
    const blank: TurnContent = { files: [], diff: '', added: 0, removed: 0, contentUnavailable: [] };
    expect(compareWithRow(row(blank), resolveTurn([recon(blank)])).verdict).toBe('unavailable');
  });

  it('logs each difference with the resolver\'s reasoning, then one summary', () => {
    const observer = createTurnObserver();
    const rows = [row(content('a.ts', 4)), { ...row(content('b.ts', 2)), promptIndex: 1 }, { ...row(content('c.ts', 1)), promptIndex: 2 }];
    observeReconstruction(rows, observer);
    // Turn 0: a pass the row does not reflect. Turn 1: agrees. Turn 2: never observed.
    observer.observe(0, window(content('a.ts', 7)));
    const unobserved = rows.pop()!;
    const log: Array<[string, Record<string, unknown>]> = [];
    const tally = compareResolverWithPasses([...rows, { ...unobserved, promptIndex: 9 }], observer, (e, d) => log.push([e, d]));
    expect(tally).toEqual({ agree: 1, differ: 1, unavailable: 0 });
    expect(log[0]).toEqual(['resolver differs from the passes', expect.objectContaining({
      promptIndex: 0, fields: ['linesAdded'], resolver: { source: 'turn-window', files: 1, lines: '+7/-0' },
    })]);
    expect(log[1]).toEqual(['resolver side by side', { agree: 1, differ: 1, unavailable: 0, sources: { 'turn-window': 1, reconstruction: 1 } }]);
  });

  it('snapshots the reconstruction before the passes mutate the row', () => {
    const observer = createTurnObserver();
    const r = row(content('a.ts', 4));
    observeReconstruction([r], observer);
    (r.filesChanged as string[]).push('mutated.ts');
    r.linesAdded = 99;
    expect(observer.observations(0)[0]).toMatchObject({ source: 'reconstruction', files: ['a.ts'], added: 4 });
  });
});
