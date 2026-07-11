// Cursor per-turn capture regression.
//
// Cursor's transcript carries full edit content — `Write` in a `contents`
// field, edits via `StrReplace` (old_string/new_string) — but the extractor
// read `content`/`file_text`, so every write was content-less and got
// backfilled from the LATER live file. Each turn's diff then showed the whole
// current file as additions (session 7009de23 "bubba": "remove 1 and add 4"
// read +8 for an 8-line file instead of +4/-1). Now: read `contents`, and
// chain consecutive whole-file writes into real per-turn deltas.

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { capturePromptEdits, extractEditsFromToolCall, chainWholeFileWrites } from '../prompt-capture/index.js';
import type { PromptCapture } from '../prompt-capture/types.js';

let tmp: string | null = null;
afterEach(() => { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } tmp = null; } });

function writeJsonl(lines: object[]): string {
  tmp = path.join(os.tmpdir(), `origin-cursor-${process.pid}-${Date.now() % 1e6}.jsonl`);
  fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n'));
  return tmp;
}

const C1 = 'line one\nline two\nline three\nline four\nline five';
// removed "line one", appended 4 → 8 lines (the "remove 1 and add 4" turn)
const C2 = 'line two\nline three\nline four\nline five\nnew a\nnew b\nnew c\nnew d';

describe('extractEditsFromToolCall — Cursor tool shapes', () => {
  it("reads Cursor's Write `contents` field", () => {
    const edits = extractEditsFromToolCall('Write', { path: '/repo/bubba', contents: 'hello\nworld' }, '/repo', 'cursor');
    expect(edits).toHaveLength(1);
    expect(edits[0].op).toBe('write');
    expect(edits[0].newContent).toBe('hello\nworld');
    expect(edits[0].file).toBe('bubba');
  });

  it('reads Cursor StrReplace as an edit', () => {
    const edits = extractEditsFromToolCall('StrReplace', { path: '/repo/bubba', old_string: 'a', new_string: 'b' }, '/repo', 'cursor');
    expect(edits[0]).toMatchObject({ op: 'edit', oldContent: 'a', newContent: 'b', file: 'bubba' });
  });
});

describe('chainWholeFileWrites', () => {
  it('gives a rewrite the prior turn content as oldContent (write→write)', () => {
    const turns: PromptCapture[] = [
      { promptIndex: 0, promptText: 'create', agent: 'cursor', edits: [{ file: 'bubba', op: 'write', newContent: C1, source: 'tool_call' }], commits: [] },
      { promptIndex: 1, promptText: 'edit', agent: 'cursor', edits: [{ file: 'bubba', op: 'write', newContent: C2, source: 'tool_call' }], commits: [] },
    ];
    chainWholeFileWrites(turns);
    // First write is a genuine create — no baseline.
    expect(turns[0].edits[0].oldContent).toBeFalsy();
    // Second write chains from the first's content → real delta, not all-new.
    expect(turns[1].edits[0].oldContent).toBe(C1);
    expect(turns[1].edits[0].newContent).toBe(C2);
  });
});

describe('capturePromptEdits — full Cursor session', () => {
  it('produces correct per-turn deltas for create → rewrite → str-replace', () => {
    const repo = os.tmpdir(); // no git repo needed; writes carry their own content
    const file = writeJsonl([
      { role: 'user', content: 'create bubba with 5 rows' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: `${repo}/bubba`, contents: C1 } }] } },
      { role: 'user', content: 'remove 1 and add 4 rows' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: `${repo}/bubba`, contents: C2 } }] } },
      { role: 'user', content: 'add 2 more and commit' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StrReplace', input: { path: `${repo}/bubba`, old_string: 'new d', new_string: 'new d\nnew e\nnew f' } }] } },
    ]);
    const caps = capturePromptEdits({ agent: 'cursor', repoPath: repo, transcriptPath: file });

    expect(caps).toHaveLength(3);

    // Turn 1 — create: all 5 lines added, no prior baseline.
    const t1 = caps[0].edits.find((e) => e.file === 'bubba')!;
    expect(t1.op).toBe('write');
    expect(t1.oldContent ?? '').toBe('');
    expect(t1.newContent).toBe(C1);

    // Turn 2 — rewrite chained to turn 1: delta is remove "line one" + add 4,
    // NOT a fresh 8-line file. Verified via the old→new pair the server diffs.
    const t2 = caps[1].edits.find((e) => e.file === 'bubba')!;
    expect(t2.oldContent).toBe(C1);
    expect(t2.newContent).toBe(C2);
    // Sanity: LCS of that pair is +4 / -1, not +8.
    const added = C2.split('\n').filter((l) => !C1.split('\n').includes(l)).length;
    const removed = C1.split('\n').filter((l) => !C2.split('\n').includes(l)).length;
    expect([added, removed]).toEqual([4, 1]);

    // Turn 3 — StrReplace edit: +2.
    const t3 = caps[2].edits.find((e) => e.file === 'bubba')!;
    expect(t3).toMatchObject({ op: 'edit', oldContent: 'new d', newContent: 'new d\nnew e\nnew f' });
  });
});
