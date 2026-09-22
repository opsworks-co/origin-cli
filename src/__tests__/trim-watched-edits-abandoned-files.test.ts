/**
 * A file that existed only inside a commit the session reset away is nobody's
 * work, and its watched edits must leave editsJson with it.
 *
 * RCCE-423, live session ccd07b34: the session committed `only_wip.txt` and
 * then `git reset --hard`ed the commit away. Every row came out empty and the
 * session header was empty, but turn 1's ledger still held a `write_journal`
 * delete of that file — the reset removing it from disk — and the read path
 * synthesized a card from it: `only_wip.txt`, -1. A row that names no files
 * drops no watched edits (that rule keeps a hookless, shell-only turn's work),
 * so nothing took them off.
 *
 * `abandonedOnlyFiles` is what proves the file is gone: git says the abandoned
 * commit touched it, no live commit of the session does, and it is in neither
 * the tree nor the index. An empty list — which is also every git failure —
 * drops nothing.
 */
import { describe, it, expect } from 'vitest';
import { trimWatchedEdits, trimWatchedEditsForTurns } from '../trim-watched-edits.js';

const edit = (file: string, evidence: string, op = 'write') =>
  ({ file, op, newContent: 'x\n', source: 'uncommitted', evidence });
const files = (raw: string) => (JSON.parse(raw).edits as Array<{ file: string }>).map((e) => e.file).sort();

const raw = JSON.stringify({
  edits: [edit('only_wip.txt', 'write_journal', 'delete'), edit('only_wip.txt', 'turn_window', 'create'), edit('kept.ts', 'write_journal')],
  finalHunks: [{ file: 'only_wip.txt', start: 1, lines: ['gone'] }, { file: 'kept.ts', start: 1, lines: ['k'] }],
});

describe('trimWatchedEdits with abandoned-only files', () => {
  it('drops the watched edits on an abandoned-only file even when the row names none', () => {
    const out = trimWatchedEdits(raw, { promptIndex: 1, filesChanged: [] }, ['only_wip.txt']);
    expect(out.dropped).toEqual(['only_wip.txt']);
    // kept.ts is not abandoned and the row names nothing to scope it against,
    // so the shell-only turn keeps it — the rule this pass already had.
    expect(files(out.raw)).toEqual(['kept.ts']);
    expect(JSON.parse(out.raw).finalHunks).toEqual([{ file: 'kept.ts', start: 1, lines: ['k'] }]);
  });

  // Authorship outranks abandonment. The agent DID write this file, and the
  // session resetting the commit away afterwards does not unmake that. The
  // lines and the file leave the turn (dropVanishedWatchedAdds), but the tool
  // call stays: erasing it would make the page match the repository by
  // deleting the evidence that anything happened.
  it('keeps an authored edit: the agent wrote it, however the work ended', () => {
    const withTool = JSON.stringify({ edits: [edit('only_wip.txt', 'tool_call'), edit('only_wip.txt', 'command_named'), edit('kept.ts', 'tool_call')] });
    const out = trimWatchedEdits(withTool, { promptIndex: 1, filesChanged: [] }, ['only_wip.txt']);
    expect(out.dropped).toEqual([]);
    expect(out.raw).toBe(withTool);
    expect(files(out.raw)).toEqual(['kept.ts', 'only_wip.txt', 'only_wip.txt']);
  });

  // Both witnesses on one abandoned file: the watcher's goes, the tool call
  // stays. Proves the split is per-EDIT, not per-file.
  it('splits a mixed-evidence abandoned file, keeping only the authored edit', () => {
    const mixed = JSON.stringify({
      edits: [edit('only_wip.txt', 'write_journal', 'delete'), edit('only_wip.txt', 'tool_call')],
    });
    const out = trimWatchedEdits(mixed, { promptIndex: 1, filesChanged: [] }, ['only_wip.txt']);
    expect(out.dropped).toEqual(['only_wip.txt']);
    const kept = JSON.parse(out.raw).edits as Array<{ evidence: string }>;
    expect(kept.map((e) => e.evidence)).toEqual(['tool_call']);
  });

  it('drops nothing without a proven list — absence of proof is not proof', () => {
    expect(trimWatchedEdits(raw, { promptIndex: 1, filesChanged: [] }, [])).toEqual({ raw, dropped: [] });
    expect(trimWatchedEdits(raw, { promptIndex: 1, filesChanged: [] })).toEqual({ raw, dropped: [] });
  });

  it('leaves a file the row still names alone unless it is proven abandoned', () => {
    const out = trimWatchedEdits(raw, { promptIndex: 1, filesChanged: ['kept.ts'] }, ['only_wip.txt']);
    expect(files(out.raw)).toEqual(['kept.ts']);
  });

  it('trims every turn of the session through the batch entry point', () => {
    const byIndex = new Map<number, string>([[0, raw], [1, raw]]);
    const n = trimWatchedEditsForTurns(
      byIndex,
      [{ promptIndex: 0, filesChanged: [] }, { promptIndex: 1, filesChanged: [] }],
      undefined,
      ['only_wip.txt'],
    );
    expect(n).toBe(2);
    expect(files(byIndex.get(0)!)).toEqual(['kept.ts']);
    expect(files(byIndex.get(1)!)).toEqual(['kept.ts']);
  });
});
