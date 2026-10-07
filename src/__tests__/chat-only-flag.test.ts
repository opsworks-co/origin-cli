// `chatOnly` may only ever be saved beside a row that shows nothing.
//
// Session c085f0af row 16 (2026-09-26 20:16Z): the shadow pass blanked the
// row at one Stop, the ledger refilled it at the next (3 files, +48/-4) and
// the state file carried `chatOnly: true` beside 5 KB of diff for a day. Every
// fill now drops the mark, and the state pick asks the row instead of the flag.
import { describe, it, expect } from 'vitest';
import { chatOnlyStateFlag, rowShowsWork } from '../chat-only-flag.js';
import { hooksSource } from './helpers/hooks-source.js';

describe('rowShowsWork', () => {
  it('is false for a row with nothing in it', () => {
    expect(rowShowsWork({ filesChanged: [], diff: '', uncommittedDiff: '' })).toBe(false);
    expect(rowShowsWork({})).toBe(false);
    expect(rowShowsWork({ diff: '  \n' })).toBe(false);
  });
  it('is true for a file, a diff, a working-tree diff or a declared cut', () => {
    expect(rowShowsWork({ filesChanged: ['a.ts'] })).toBe(true);
    expect(rowShowsWork({ diff: 'diff --git a/a b/a\n' })).toBe(true);
    expect(rowShowsWork({ uncommittedDiff: 'diff --git a/a b/a\n' })).toBe(true);
    expect(rowShowsWork({ contentUnavailableFiles: ['big.json'] })).toBe(true);
  });
});

describe('chatOnlyStateFlag', () => {
  it('carries the mark for an empty row and drops it beside content', () => {
    expect(chatOnlyStateFlag({ chatOnly: true, filesChanged: [], diff: '' })).toEqual({ chatOnly: true });
    // The c085f0af row 16 shape.
    expect(chatOnlyStateFlag({ chatOnly: true, filesChanged: ['a.ts', 'b.ts', 'c.ts'], diff: 'diff --git a/a.ts b/a.ts\n' })).toEqual({});
    expect(chatOnlyStateFlag({ filesChanged: [], diff: '' })).toEqual({});
  });
});

describe('the state pick', () => {
  it('asks the row, not the flag', () => {
    const src = hooksSource();
    const start = src.indexOf('state.completedPromptMappings = promptMappings.map');
    expect(start).toBeGreaterThan(-1);
    const pick = src.slice(start, start + 4000);
    expect(pick).toContain('...chatOnlyStateFlag(pm)');
    expect(pick).not.toContain('pm.chatOnly ? { chatOnly: true }');
  });
});
