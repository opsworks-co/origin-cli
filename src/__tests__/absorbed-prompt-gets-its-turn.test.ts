/**
 * A message absorbed mid-turn whose submit hook never ran gets its own turn at
 * Stop (TODO e840ccd5): an id, a journal mark where it was absorbed, and the
 * commits the running turn attested after that moment.
 */
import { describe, it, expect } from 'vitest';
import { insertTurnMarkAt, parseJournalEntries, writesForTurn } from '../write-journal.js';
import { giveAbsorbedPromptsTheirTurns } from '../absorbed-prompt-turn.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const journal = (...o: Array<Record<string, unknown>>) => o.map(line).join('\n') + '\n';

describe('insertTurnMarkAt', () => {
  const log = journal(
    { k: 't', t: 100, id: 't_A' },
    { f: 'a.py', t: 110, h: 'h1', n: 3, r: 1 },
    { f: 'b.py', t: 210, h: 'h2', n: 3, r: 1 },
    { f: 'b.py', t: 220, h: 'h3', n: 3 },
  );

  it('puts the mark before the first write at or after the moment', () => {
    const out = insertTurnMarkAt(log, { at: 200, turnId: 't_B' }, 't_A')!;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((o) => o.id || o.f)).toEqual(['t_A', 'a.py', 't_B', 'b.py', 'b.py']);
    // Other fields on the records survive untouched.
    expect(lines[1]).toEqual({ f: 'a.py', t: 110, h: 'h1', n: 3, r: 1 });
    // And the ledger's span reader now splits there.
    const entries = parseJournalEntries(out);
    expect(writesForTurn(entries, 't_A').map((w) => w.file)).toEqual(['a.py']);
    expect(writesForTurn(entries, 't_B').map((w) => w.file)).toEqual(['b.py', 'b.py']);
  });

  it('appends when nothing came after the moment', () => {
    const out = insertTurnMarkAt(log, { at: 999, turnId: 't_B' }, 't_A')!;
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ k: 't', t: 999, id: 't_B' });
  });

  it('never crosses the next turn\'s mark', () => {
    const cut = insertTurnMarkAt(journal({ k: 't', t: 100, id: 't_A' }, { f: 'a.py', t: 110 }, { k: 't', t: 150, id: 't_C' }, { f: 'c.py', t: 400 }), { at: 300, turnId: 't_B' }, 't_A')!;
    expect(cut.trim().split('\n').map((l) => JSON.parse(l).id || JSON.parse(l).f)).toEqual(['t_A', 'a.py', 't_B', 't_C', 'c.py']);
  });

  it('changes nothing when the turn is already marked, or the split turn has no mark', () => {
    expect(insertTurnMarkAt(log + line({ k: 't', t: 200, id: 't_B' }) + '\n', { at: 200, turnId: 't_B' }, 't_A')).toBeNull();
    expect(insertTurnMarkAt(log, { at: 200, turnId: 't_B' }, 't_missing')).toBeNull();
  });
});

describe('giveAbsorbedPromptsTheirTurns', () => {
  const T = Date.parse('2026-09-26T10:05:00Z');
  const state = () => ({
    prompts: ['rename alpha', 'and rename beta too'],
    promptTurnIds: ['t_A'],
    promptSubmittedAt: ['2026-09-26T10:00:00.000Z'],
    activeTurn: { index: 0 },
    lastClosedTurnIndex: -1,
    commitTurns: [
      { sha: 'c1', turnId: 't_A', at: '2026-09-26T10:02:00.000Z' },
      { sha: 'c2', turnId: 't_A', at: '2026-09-26T10:07:00.000Z' },
    ],
  });
  const parsed = { prompts: ['rename alpha', 'and rename beta too'], midTurnPrompts: [1], midTurnPromptAt: [T] };

  it('mints the id, marks the journal at the absorption and moves the later commit', () => {
    const s = state();
    const marks: unknown[] = [];
    const out = giveAbsorbedPromptsTheirTurns(s, parsed, { markAt: (...a) => { marks.push(a); return true; }, newId: () => 't_B' });
    expect(out).toEqual([{ promptIndex: 1, turnId: 't_B', at: T, splitFrom: 't_A', midTurn: true, marked: true, commits: ['c2'] }]);
    expect(s.promptTurnIds).toEqual(['t_A', 't_B']);
    expect(s.promptSubmittedAt[1]).toBe(new Date(T).toISOString());
    expect(marks).toEqual([['t_B', T, 't_A']]);
    expect(s.commitTurns.map((c) => [c.sha, c.turnId])).toEqual([['c1', 't_A'], ['c2', 't_B']]);
  });

  it('leaves a prompt whose hook ran alone', () => {
    const s = { ...state(), promptTurnIds: ['t_A', 't_hook'] };
    const out = giveAbsorbedPromptsTheirTurns(s, parsed, { markAt: () => { throw new Error('no'); } });
    expect(out).toEqual([]);
    expect(s.commitTurns[1].turnId).toBe('t_A');
  });

  it('ignores an absorption from an earlier turn that repeats the text', () => {
    // "next task from the list", absorbed long ago; the same words typed again
    // as an ordinary prompt whose hook died must not be split at the old time.
    const s = { ...state(), prompts: ['next task', 'fix it', 'next task'], promptTurnIds: ['t_0', 't_1'],
      promptSubmittedAt: ['2026-09-26T09:00:00.000Z', '2026-09-26T10:00:00.000Z'], activeTurn: { index: 1 } };
    const out = giveAbsorbedPromptsTheirTurns(s, {
      prompts: ['next task', 'fix it', 'next task'], midTurnPrompts: [0], midTurnPromptAt: [Date.parse('2026-09-26T09:30:00Z')],
    }, { markAt: () => true, newId: () => 't_x' });
    expect(out).toEqual([]);
  });

  it('does nothing with no time for the absorption', () => {
    const s = state();
    expect(giveAbsorbedPromptsTheirTurns(s, { ...parsed, midTurnPromptAt: [null] }, { markAt: () => true })).toEqual([]);
    expect(s.promptTurnIds).toEqual(['t_A']);
  });

  describe('a prompt sent between turns whose hook never ran (session 1476cd52 row 1)', () => {
    const SENT = Date.parse('2026-09-27T23:05:12Z');
    const between = () => ({
      prompts: ['what does shared with turn 3 mean', 'fix both'],
      promptTurnIds: ['t_A'],
      promptSubmittedAt: ['2026-09-27T22:59:37.000Z'],
      // Its first tool call re-opened the previous turn.
      activeTurn: { index: 0 } as { index: number } | null,
      lastClosedTurnIndex: 0,
      commitTurns: [{ sha: '61bbe8cb', turnId: 't_A', at: '2026-09-27T23:34:37.000Z' }],
    });
    const seen = { prompts: ['what does shared with turn 3 mean', 'fix both'], promptAt: [Date.parse('2026-09-27T22:59:37Z'), SENT] };

    it('splits at the time the transcript says it was sent, and moves the commit made after it', () => {
      const s = between();
      const marks: unknown[] = [];
      const out = giveAbsorbedPromptsTheirTurns(s, seen, { markAt: (...a) => { marks.push(a); return true; }, newId: () => 't_B' });
      expect(out).toEqual([{ promptIndex: 1, turnId: 't_B', at: SENT, splitFrom: 't_A', midTurn: false, marked: true, commits: ['61bbe8cb'] }]);
      expect(s.promptTurnIds).toEqual(['t_A', 't_B']);
      expect(s.promptSubmittedAt[1]).toBe(new Date(SENT).toISOString());
      expect(marks).toEqual([['t_B', SENT, 't_A']]);
      expect(s.commitTurns[0].turnId).toBe('t_B');
    });

    it('splits the last closed turn when nothing re-opened it', () => {
      const s = { ...between(), activeTurn: null };
      const out = giveAbsorbedPromptsTheirTurns(s, seen, { markAt: () => true, newId: () => 't_B' });
      expect(out.map((a) => [a.promptIndex, a.splitFrom, a.commits])).toEqual([[1, 't_A', ['61bbe8cb']]]);
    });

    it('takes the time of the copy at the tail when the text repeats an older prompt', () => {
      // "next task" was typed before, at 09:00. The copy whose hook died was
      // sent at 11:00; splitting at 09:00 would move every commit of turn 1.
      const s = {
        prompts: ['next task', 'fix it', 'next task'], promptTurnIds: ['t_0', 't_1'],
        promptSubmittedAt: ['2026-09-26T09:00:00.000Z', '2026-09-26T10:00:00.000Z'],
        activeTurn: { index: 1 }, lastClosedTurnIndex: 0,
        commitTurns: [
          { sha: 'early', turnId: 't_1', at: '2026-09-26T10:30:00.000Z' },
          { sha: 'late', turnId: 't_1', at: '2026-09-26T11:10:00.000Z' },
        ],
      };
      const at = Date.parse('2026-09-26T11:00:00Z');
      const out = giveAbsorbedPromptsTheirTurns(s, {
        prompts: ['next task', 'fix it', 'next task'],
        promptAt: [Date.parse('2026-09-26T09:00:00Z'), Date.parse('2026-09-26T10:00:00Z'), at],
      }, { markAt: () => true, newId: () => 't_2' });
      expect(out.map((a) => [a.promptIndex, a.at, a.commits])).toEqual([[2, at, ['late']]]);
      expect(s.commitTurns.map((c) => c.turnId)).toEqual(['t_1', 't_2']);
    });

    it('does nothing when the tails do not line up, or the prompt predates the turn it would split', () => {
      const s = between();
      expect(giveAbsorbedPromptsTheirTurns(s, { prompts: ['what does shared with turn 3 mean', 'something else'], promptAt: seen.promptAt }, { markAt: () => true })).toEqual([]);
      expect(giveAbsorbedPromptsTheirTurns(s, { ...seen, promptAt: [seen.promptAt[0], Date.parse('2026-09-27T22:00:00Z')] }, { markAt: () => true })).toEqual([]);
      expect(giveAbsorbedPromptsTheirTurns(s, { prompts: seen.prompts }, { markAt: () => true })).toEqual([]);
      expect(s.promptTurnIds).toEqual(['t_A']);
      expect(s.commitTurns[0].turnId).toBe('t_A');
    });
  });
});
