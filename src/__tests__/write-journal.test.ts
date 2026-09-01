// The window claims a file because it is DIRTY. The journal claims it because
// it was WRITTEN during the turn. The difference is what lets an agent with no
// hooks at all — Codex, Devin, Copilot — stop absorbing a sibling's work.
import { describe, it, expect } from 'vitest';
import {
  serializeRecord, parseJournal, filesWrittenDuring, trimJournal, type WriteRecord,
} from '../write-journal.js';

const rec = (file: string, at: number): WriteRecord => ({ file, at });

describe('journal serialisation', () => {
  it('round-trips a record', () => {
    const line = serializeRecord(rec('src/a.ts', 1000));
    expect(line.endsWith('\n')).toBe(true);
    expect(parseJournal(line)).toEqual([rec('src/a.ts', 1000)]);
  });

  it('skips a torn final line rather than losing the whole journal', () => {
    // Appends are not atomic; a reader can catch a half-written last line.
    const text = serializeRecord(rec('a.ts', 1)) + serializeRecord(rec('b.ts', 2)) + '{"f":"c.ts","t":';
    expect(parseJournal(text).map((r) => r.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('ignores structurally wrong entries', () => {
    const text = ['{"f":"","t":1}', '{"f":"a.ts"}', '{"t":5}', '{"f":"ok.ts","t":9}', 'nonsense'].join('\n');
    expect(parseJournal(text)).toEqual([rec('ok.ts', 9)]);
  });

  it('returns nothing for an empty journal', () => {
    expect(parseJournal('')).toEqual([]);
    expect(parseJournal('\n\n')).toEqual([]);
  });
});

describe('filesWrittenDuring', () => {
  const records = [rec('before.ts', 50), rec('a.ts', 100), rec('b.ts', 150), rec('after.ts', 300)];

  it('claims only writes inside the turn', () => {
    expect(filesWrittenDuring(records, { startedAt: 100, endedAt: 300 })).toEqual(['a.ts', 'b.ts']);
  });

  it('is inclusive of start and EXCLUSIVE of end, so no write lands in two turns', () => {
    const t1 = filesWrittenDuring(records, { startedAt: 100, endedAt: 300 });
    const t2 = filesWrittenDuring(records, { startedAt: 300, endedAt: 400 });
    expect(t1).toContain('a.ts');
    expect(t2).toEqual(['after.ts']);
    // Nothing is claimed twice.
    expect(t1.filter((f) => t2.includes(f))).toEqual([]);
  });

  it('takes everything from start onward for a turn still running', () => {
    expect(filesWrittenDuring(records, { startedAt: 100 })).toEqual(['a.ts', 'b.ts', 'after.ts']);
  });

  it('reports each file once, at its first write', () => {
    const r = [rec('a.ts', 100), rec('a.ts', 120), rec('b.ts', 110)];
    expect(filesWrittenDuring(r, { startedAt: 0 })).toEqual(['a.ts', 'b.ts']);
  });

  it('claims nothing for a turn that wrote nothing', () => {
    // The read-only turn that used to be credited with a sibling's 14.5 KB.
    expect(filesWrittenDuring(records, { startedAt: 200, endedAt: 250 })).toEqual([]);
  });
});

describe('trimJournal', () => {
  it('drops records older than the retention window', () => {
    const now = 10_000;
    const r = [rec('old.ts', 1_000), rec('new.ts', 9_500)];
    expect(trimJournal(r, now, 5_000, 100).map((x) => x.file)).toEqual(['new.ts']);
  });

  it('caps the total, keeping the NEWEST', () => {
    const now = 1_000;
    const r = Array.from({ length: 10 }, (_, i) => rec(`f${i}.ts`, 900 + i));
    const kept = trimJournal(r, now, 60_000, 3).map((x) => x.file);
    expect(kept).toEqual(['f7.ts', 'f8.ts', 'f9.ts']);
  });

  it('leaves a small fresh journal alone', () => {
    const r = [rec('a.ts', 100), rec('b.ts', 200)];
    expect(trimJournal(r, 300, 60_000, 100)).toEqual(r);
  });
});
