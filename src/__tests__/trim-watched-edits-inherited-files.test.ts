/**
 * A row emptied by dropInheritedFilesFromTurns names no files, and a row that
 * names no files drops no watched edits — so the checkout's journal edits
 * stayed in editsJson and the server synthesized the files back onto the card.
 * The files that pass removed are dropped from editsJson by name.
 */
import { describe, it, expect } from 'vitest';
import { trimWatchedEdits } from '../trim-watched-edits.js';

const edit = (file: string, evidence?: string) =>
  ({ file, op: 'write', newContent: 'x\n', source: 'uncommitted', ...(evidence ? { evidence } : {}) });
const files = (raw: string) => (JSON.parse(raw).edits as Array<{ file: string }>).map((e) => e.file).sort();

describe('trimWatchedEdits with inherited files', () => {
  const raw = JSON.stringify({
    edits: [edit('b.ts', 'write_journal'), edit('c.ts', 'command_probe'), edit('b.ts', 'tool_call'), edit('d.ts', 'write_journal')],
    finalHunks: [{ file: 'c.ts', start: 1, lines: ['c2'] }, { file: 'd.ts', start: 1, lines: ['d'] }],
  });

  it('drops the watched edits on inherited files even when the row names none', () => {
    const out = trimWatchedEdits(raw, { promptIndex: 0, filesChanged: [], inheritedFiles: ['b.ts', 'c.ts'] });
    expect(out.dropped).toEqual(['b.ts', 'c.ts']);
    // The tool call on b.ts is authorship and stays; d.ts is not inherited and
    // the row names nothing to scope it against.
    expect(files(out.raw)).toEqual(['b.ts', 'd.ts']);
    expect(JSON.parse(out.raw).finalHunks).toEqual([{ file: 'd.ts', start: 1, lines: ['d'] }]);
  });

  it('still drops nothing for a row with neither files nor inherited files', () => {
    expect(trimWatchedEdits(raw, { promptIndex: 0, filesChanged: [] })).toEqual({ raw, dropped: [] });
  });
});
