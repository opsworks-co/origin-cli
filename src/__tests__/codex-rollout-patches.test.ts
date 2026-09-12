import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  codexApplyPatchToDiff,
  codexApplyPatchesToDiff,
  renderFileDiff,
  parseCodexRolloutLive,
  codexDeletedContentReader,
} from '../agents/codex.js';

describe('codexApplyPatchToDiff', () => {
  it('converts an Add File patch into a git-shaped diff with an accurate add count', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/hello.ts',
      '+export function hello() {',
      "+  return 'hi';",
      '+}',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch);
    expect(r.linesAdded).toBe(3);
    expect(r.linesRemoved).toBe(0);
    expect(r.filesChanged).toEqual(['src/hello.ts']);
    expect(r.diff).toContain('diff --git a/src/hello.ts b/src/hello.ts');
    expect(r.diff).toContain('new file mode 100644');
    expect(r.diff).toContain('@@ -0,0 +1,3 @@');
  });

  it('counts +/- lines in an Update File hunk (ignoring the +++/--- headers)', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@ function main() {',
      '-  const x = 1;',
      '+  const x = 2;',
      '+  const y = 3;',
      '   return x;',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch);
    expect(r.linesAdded).toBe(2);
    expect(r.linesRemoved).toBe(1);
    expect(r.filesChanged).toEqual(['src/app.ts']);
    expect(r.diff).toContain('--- a/src/app.ts');
    expect(r.diff).toContain('+++ b/src/app.ts');
    // Must emit a VALID unified-diff hunk header, never Codex's bare `@@`.
    expect(r.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it('rewrites a BARE `@@` append section into a valid hunk header (real Codex format)', () => {
    // The exact shape Codex emits for "add N more rows": a bare `@@`, one
    // context line, then `+` additions. The old converter passed the bare `@@`
    // through verbatim, so the dashboard rendered "no diff captured".
    const patch = [
      '*** Begin Patch',
      '*** Update File: pipipi',
      '@@',
      ' Row 37',
      '+Row 38',
      '+Row 39',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch);
    expect(r.linesAdded).toBe(2);
    expect(r.linesRemoved).toBe(0);
    // 1 context line + 2 added → old len 1, new len 3.
    expect(r.diff).toContain('@@ -1,1 +1,3 @@');
    expect(r.diff).toContain('+Row 38');
    expect(r.diff).toContain('+Row 39');
    // No leftover bare `@@` marker that a diff parser would choke on.
    expect(r.diff).not.toMatch(/^@@$/m);
  });

  it('handles a Delete File section', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch);
    expect(r.filesChanged).toEqual(['old.txt']);
    expect(r.diff).toContain('deleted file mode 100644');
  });

  it('relativizes an absolute path against repoRoot', () => {
    const root = 'C:\\repo\\proj';
    const patch = [
      '*** Begin Patch',
      '*** Add File: C:\\repo\\proj\\src\\a.ts',
      '+x',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch, root);
    expect(r.filesChanged).toEqual(['src/a.ts']);
  });

  it('returns an empty result for junk input', () => {
    expect(codexApplyPatchToDiff('not a patch').linesAdded).toBe(0);
    expect(codexApplyPatchToDiff('').diff).toBe('');
  });
});

// Codex Update-File sections are context-anchored (bare `@@`, no line ranges),
// so without the turn's baseline file every hunk was numbered from line 1 and
// the dashboard's "by prompt" view showed every Codex turn starting at line 1
// while "by file" (real git diffs) showed the truth. These lock the anchoring.
// Session be030630, styles.css: hunks anchored on a bare `}` — 33 of them in a
// 226-line stylesheet — so requiring each anchor to be unique in the whole file
// rejected the section outright. Both turns reconciled 0 of 2 sections, the
// file kept its duplicate per-patch blocks, and 4-file turns reported 5 and 6.
describe('codexApplyPatchToDiff — anchors that repeat in the file', () => {
  const sheet = [
    '#a {',
    '    color: red;',
    '}',
    '',
    '#b {',
    '    color: blue;',
    '}',
  ].join('\n') + '\n';

  // A context-ONLY hunk (no + or - lines) is a pure position marker; Codex
  // emits them so the following ambiguous anchor is well defined.
  const patch = [
    '*** Begin Patch',
    '*** Update File: styles.css',
    '@@',
    ' #b {',
    '@@',
    ' }',
    '+',
    '+#c {',
    '+    width: 1px;',
    '+}',
    '*** End Patch',
  ].join('\n');

  it('resolves a repeated anchor to the first match after the previous hunk', () => {
    const r = codexApplyPatchToDiff(patch, undefined, () => sheet);
    expect(r.sections[0].anchored).toBe(true);
    expect(r.diff).toContain('@@ -5,3 +5,7 @@');
    expect(r.linesAdded).toBe(4);
    // The `}` that closes #b, not the one closing #a: the new rule lands
    // immediately after `#b`'s block and before end of file.
    expect(r.diff).toContain('     color: blue;\n }\n+\n+#c {');
  });

  it('still refuses a patch whose context is absent entirely', () => {
    const absent = [
      '*** Begin Patch',
      '*** Update File: styles.css',
      '@@',
      ' #nope {',
      '+    color: green;',
      '*** End Patch',
    ].join('\n');
    expect(codexApplyPatchToDiff(absent, undefined, () => sheet).sections[0].anchored).toBe(false);
  });

  it('collapses a file patched twice on repeated anchors into ONE block', () => {
    const second = [
      '*** Begin Patch',
      '*** Update File: styles.css',
      '@@',
      ' #c {',
      '+    height: 2px;',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchesToDiff([patch, second], undefined, () => sheet);
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(r.filesChanged).toEqual(['styles.css']);
    expect(r.linesAdded).toBe(5);
    expect(r.linesRemoved).toBe(0);
  });
});

describe('codexApplyPatchToDiff — baseline anchoring', () => {
  // Verbatim from rollout 019fce00 on file `fikus`: "add 5 rows to it and
  // commit" applied to a file holding the rows 1..11.
  const fikusPatch = [
    '*** Begin Patch',
    '*** Update File: C:\\soft\\origin-demo-1\\fikus',
    '@@',
    ' 11',
    '+12',
    '+13',
    '+14',
    '+15',
    '+16',
    '*** End Patch',
  ].join('\n');
  const fikusBaseline = Array.from({ length: 11 }, (_, n) => String(n + 1)).join('\n') + '\n';

  it('anchors a real rollout hunk to its true line number', () => {
    const r = codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', () => fikusBaseline);
    expect(r.linesAdded).toBe(5);
    expect(r.linesRemoved).toBe(0);
    expect(r.filesChanged).toEqual(['fikus']);
    // The bug: this used to render `@@ -1,1 +1,6 @@`. An anchored section is
    // now rendered from the file on both sides of the patch, so the header is
    // the one `git diff -U3` prints for the same edit — verified against it.
    expect(r.diff).toContain('@@ -9,3 +9,8 @@');
  });

  it('anchors the follow-up turn against ITS own baseline', () => {
    // "add 10 more rows" — same session, one turn later, file now 1..16.
    const patch = [
      '*** Begin Patch',
      '*** Update File: fikus',
      '@@',
      ' 16',
      ...Array.from({ length: 10 }, (_, n) => `+${n + 17}`),
      '*** End Patch',
    ].join('\n');
    const baseline = Array.from({ length: 16 }, (_, n) => String(n + 1)).join('\n') + '\n';
    const r = codexApplyPatchToDiff(patch, undefined, () => baseline);
    expect(r.diff).toContain('@@ -14,3 +14,13 @@');
  });

  it('offsets the new-side start by earlier hunks in the same file', () => {
    // The two edit sites have to sit far enough apart that they do not share a
    // hunk, or there is no second header to check the offset on.
    const baseline = Array.from({ length: 20 }, (_, n) => String(n + 1)).join('\n') + '\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' 1',
      '+one-b',
      '@@',
      ' 15',
      '+fifteen-b',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch, undefined, () => baseline);
    expect(r.diff).toContain('@@ -1,4 +1,5 @@');
    // Old line 13, shifted one line down on the new side by the first hunk.
    expect(r.diff).toContain('@@ -13,6 +14,7 @@');
  });

  it('anchors a hunk that removes lines, and tracks the negative shift', () => {
    const baseline = ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' b',
      '-c',
      ' d',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch, undefined, () => baseline);
    expect(r.linesRemoved).toBe(1);
    expect(r.diff).toContain('@@ -1,5 +1,4 @@');
  });

  it('resolves a repeated context to the first match, as apply_patch does', () => {
    // `}` occurs twice. This used to refuse rather than pick, on the reasoning
    // that a non-unique match is a guess — but it is not: Codex applies hunks
    // in file order against a moving cursor, so a bare `@@` means the FIRST
    // match from here. Refusing cost far more than it saved, because refusal
    // was not neutral — it fell back to numbering from line 1, which for this
    // baseline claimed the `}` was on line 1 when it is on line 2.
    const baseline = ['if (a) {', '}', 'if (b) {', '}'].join('\n') + '\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.ts',
      '@@',
      ' }',
      '+// done',
      '*** End Patch',
    ].join('\n');
    const r = codexApplyPatchToDiff(patch, undefined, () => baseline);
    expect(r.linesAdded).toBe(1);
    expect(r.sections[0].anchored).toBe(true);
    expect(r.diff).toContain('@@ -1,4 +1,5 @@');
    // The FIRST `}` — the comment lands before `if (b) {`, not at end of file.
    expect(r.diff).toContain(' }\n+// done\n if (b) {');
  });

  it('falls back when the context is MISSING from the baseline', () => {
    const r = codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', () => 'something else\n');
    expect(r.linesAdded).toBe(5);
    expect(r.diff).toContain('@@ -1,1 +1,6 @@');
  });

  it('falls back when the baseline file cannot be read', () => {
    const r = codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', () => null);
    expect(r.diff).toContain('@@ -1,1 +1,6 @@');
  });

  it('falls back when the resolver throws', () => {
    const r = codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', () => {
      throw new Error('git show exploded');
    });
    expect(r.diff).toContain('@@ -1,1 +1,6 @@');
  });

  it('resolves the file by its REPO-RELATIVE path', () => {
    const seen: string[] = [];
    codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', (p) => { seen.push(p); return fikusBaseline; });
    expect(seen).toEqual(['fikus']);
  });

  it('tolerates a CRLF baseline', () => {
    const r = codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', () => fikusBaseline.replace(/\n/g, '\r\n'));
    expect(r.diff).toContain('@@ -9,3 +9,8 @@');
  });

  it('leaves the caller-s file view alone when it could NOT anchor', () => {
    const applied: Array<[string, string]> = [];
    codexApplyPatchToDiff(fikusPatch, 'C:\\soft\\origin-demo-1', {
      read: () => 'unrelated\n',
      onApplied: (p, c) => applied.push([p, c]),
    });
    expect(applied).toEqual([]);
  });

  it('never consults the baseline for an Add File section', () => {
    const resolver = vi.fn(() => 'irrelevant\n');
    const r = codexApplyPatchToDiff(
      '*** Begin Patch\n*** Add File: n.txt\n+one\n+two\n*** End Patch',
      undefined,
      resolver,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(r.diff).toContain('@@ -0,0 +1,2 @@');
  });
});

// A turn routinely applies SEVERAL patches to the SAME file — Codex creates it,
// appends, appends again. Each is applied to the result of the last, so
// anchoring them all against the start-of-turn file would leave everything after
// the first unmatched. The converter reports each reconstructed file back so the
// caller's per-turn view advances; this mirrors the watcher's cache.
function turnStore(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    files,
    reads,
    access: {
      read: (p: string) => { reads.push(p); return files.has(p) ? files.get(p)! : null; },
      onApplied: (p: string, c: string) => { files.set(p, c); },
    },
  };
}

describe('codexApplyPatchToDiff — several patches to one file in a turn', () => {
  const append = (file: string, ctx: string, rows: number[]) =>
    ['*** Begin Patch', `*** Update File: ${file}`, '@@', ` ${ctx}`, ...rows.map((r) => `+${r}`), '*** End Patch'].join('\n');

  it('anchors the SECOND patch against the result of the first', () => {
    const store = turnStore({ fikus: Array.from({ length: 11 }, (_, n) => String(n + 1)).join('\n') + '\n' });
    const first = codexApplyPatchToDiff(append('fikus', '11', [12, 13, 14, 15, 16]), undefined, store.access);
    const second = codexApplyPatchToDiff(append('fikus', '16', [17, 18, 19, 20]), undefined, store.access);
    expect(first.diff).toContain('@@ -9,3 +9,8 @@');
    // The bug: without the write-back this fell back to `@@ -1,1 +1,5 @@`,
    // because line 16 does not exist in the start-of-turn file.
    expect(second.diff).toContain('@@ -14,3 +14,7 @@');
    expect(store.files.get('fikus')).toBe(Array.from({ length: 20 }, (_, n) => String(n + 1)).join('\n') + '\n');
  });

  it('anchors an Update against a file the SAME turn created', () => {
    const store = turnStore(); // file does not exist at the turn-s baseline
    const create = ['*** Begin Patch', '*** Add File: rows.txt', '+a', '+b', '+c', '*** End Patch'].join('\n');
    codexApplyPatchToDiff(create, undefined, store.access);
    const r = codexApplyPatchToDiff(append('rows.txt', 'c', [1]), undefined, store.access);
    expect(r.diff).toContain('@@ -1,3 +1,4 @@');
    expect(store.files.get('rows.txt')).toBe('a\nb\nc\n1\n');
  });

  it('replays deletions so later hunks shift correctly', () => {
    const store = turnStore({ 'f.txt': 'a\nb\nc\nd\ne\n' });
    const drop = ['*** Begin Patch', '*** Update File: f.txt', '@@', ' b', '-c', ' d', '*** End Patch'].join('\n');
    codexApplyPatchToDiff(drop, undefined, store.access);
    expect(store.files.get('f.txt')).toBe('a\nb\nd\ne\n');
    // `e` was line 5, is now line 4.
    const after = codexApplyPatchToDiff(append('f.txt', 'e', [9]), undefined, store.access);
    expect(after.diff).toContain('@@ -2,3 +2,4 @@');
  });

  // Session fb457e3f: the agent wrote `_verify_api.py`, ran it, and deleted it
  // again inside one turn. The Add section's 28 lines were still counted and
  // the file still rendered as created, so the turn claimed +65 where Codex
  // itself reported +39 — for a file that does not exist.
  it('drops a file the turn created and deleted again', () => {
    const create = ['*** Begin Patch', '*** Add File: tmp.py', '+one', '+two', '+three', '*** End Patch'].join('\n');
    const remove = ['*** Begin Patch', '*** Delete File: tmp.py', '*** End Patch'].join('\n');
    const real = ['*** Begin Patch', '*** Update File: keep.txt', '@@', ' a', '+b', '*** End Patch'].join('\n');
    const r = codexApplyPatchesToDiff([create, real, remove], undefined, () => 'a\n');
    // Only the file that survived the turn.
    expect(r.filesChanged).toEqual(['keep.txt']);
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(r.diff).not.toContain('tmp.py');
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(0);
  });

  it('counts the lines a Delete File section actually removes', () => {
    // Codex names the file and stops — the content is not in the patch, so a
    // body-based count reported every deletion as -0 and the lines vanished.
    const remove = ['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch'].join('\n');
    const r = codexApplyPatchToDiff(remove, undefined, () => 'a\nb\nc\n');
    expect(r.linesRemoved).toBe(3);
    expect(r.diff).toContain('@@ -1,3 +0,0 @@');
    expect(r.diff).toContain('-a');
    expect(r.diff).toContain('deleted file mode 100644');
  });

  it('reports -0 for a deletion whose content it cannot see', () => {
    // No reader, or a file already gone: an honest zero beats a guess.
    const remove = ['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch'].join('\n');
    expect(codexApplyPatchToDiff(remove).linesRemoved).toBe(0);
    expect(codexApplyPatchToDiff(remove, undefined, () => null).linesRemoved).toBe(0);
  });

  it('does not anchor an Update against a file the SAME turn deleted', () => {
    const store = turnStore({ gone: 'x\ny\n' });
    codexApplyPatchToDiff('*** Begin Patch\n*** Delete File: gone\n*** End Patch', undefined, store.access);
    expect(store.files.get('gone')).toBe('');
    const r = codexApplyPatchToDiff(append('gone', 'y', [1]), undefined, store.access);
    expect(r.diff).toContain('@@ -1,1 +1,2 @@'); // honest fallback, not a stale anchor
  });

  it('reads each file at most once — later patches reuse the replayed content', () => {
    const store = turnStore({ fikus: Array.from({ length: 11 }, (_, n) => String(n + 1)).join('\n') + '\n' });
    codexApplyPatchToDiff(append('fikus', '11', [12]), undefined, store.access);
    codexApplyPatchToDiff(append('fikus', '12', [13]), undefined, store.access);
    codexApplyPatchToDiff(append('fikus', '13', [14]), undefined, store.access);
    expect(store.reads).toEqual(['fikus', 'fikus', 'fikus']); // read() called per patch...
    expect(new Set(store.reads).size).toBe(1);
    expect(store.files.get('fikus')).toBe(Array.from({ length: 14 }, (_, n) => String(n + 1)).join('\n') + '\n');
  });

  it('preserves a file with no trailing newline', () => {
    const store = turnStore({ 'f.txt': 'a\nb' });
    codexApplyPatchToDiff(append('f.txt', 'b', [1]), undefined, store.access);
    expect(store.files.get('f.txt')).toBe('a\nb\n1');
  });
});

describe('renderFileDiff', () => {
  const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(i + from)).join('\n') + '\n';

  it('matches what git reports for an append', () => {
    const r = renderFileDiff('fikus', rows(37), rows(43))!;
    // `git diff` on the same edit prints exactly this header.
    expect(r.diff).toContain('@@ -35,3 +35,9 @@');
    expect(r.linesAdded).toBe(6);
    expect(r.linesRemoved).toBe(0);
    expect(r.diff).toContain(' 35\n 36\n 37\n+38');
  });

  it('renders a replacement in the middle with context on both sides', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    const r = renderFileDiff('f.txt', before, after)!;
    expect(r.diff).toContain('@@ -1,7 +1,7 @@');
    expect(r.diff).toContain('-d');
    expect(r.diff).toContain('+D');
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(1);
  });

  // The old prefix/suffix-trim renderer emitted ONE hunk spanning every edit,
  // so a file touched in three places reported the whole span as removed and
  // re-added. Session be030630 stored server.py at +154/-133 for a +26/-5 edit,
  // and that inflation is what the session header showed the reviewer.
  it('emits one hunk per edit site, not one spanning them all', () => {
    const before = rows(60);
    const lines = before.split('\n');
    lines[4] = 'edited-near-top';
    lines[29] = 'edited-in-the-middle';
    lines[54] = 'edited-near-bottom';
    const r = renderFileDiff('scattered.txt', before, lines.join('\n'))!;
    expect(r.linesAdded).toBe(3);
    expect(r.linesRemoved).toBe(3);
    const hunks = r.diff.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunks).toEqual(['@@ -2,7 +2,7 @@', '@@ -27,7 +27,7 @@', '@@ -52,7 +52,7 @@']);
  });

  it('merges edit sites that are closer together than their shared context', () => {
    const before = rows(20);
    const lines = before.split('\n');
    lines[4] = 'x';
    lines[8] = 'y'; // 3 unchanged lines apart — git prints these as one hunk
    const r = renderFileDiff('near.txt', before, lines.join('\n'))!;
    expect(r.diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -2,11 +2,11 @@']);
    expect(r.linesAdded).toBe(2);
    expect(r.linesRemoved).toBe(2);
  });

  it('reports an insertion the way git does, without touching neighbouring lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'NEW', 'd', 'e', 'f'].join('\n') + '\n';
    const r = renderFileDiff('ins.txt', before, after)!;
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(0);
    expect(r.diff).toContain('@@ -1,6 +1,7 @@');
  });

  it('renders a creation and a deletion', () => {
    expect(renderFileDiff('n.txt', null, 'x\ny\n')!.diff).toContain('@@ -0,0 +1,2 @@');
    expect(renderFileDiff('n.txt', null, 'x\ny\n')!.diff).toContain('new file mode 100644');
    expect(renderFileDiff('g.txt', 'x\ny\n', '')!.diff).toContain('deleted file mode 100644');
  });

  it('returns null when nothing changed', () => {
    expect(renderFileDiff('f.txt', rows(5), rows(5))).toBeNull();
  });
});

describe('codexApplyPatchesToDiff — a whole turn at once', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1)).join('\n') + '\n';
  const append = (ctx: number, add: number[]) =>
    ['*** Begin Patch', '*** Update File: fikus', '@@', ` ${ctx}`, ...add.map((r) => `+${r}`), '*** End Patch'].join('\n');

  it('renders three patches to one file as ONE diff against the turn baseline', () => {
    const r = codexApplyPatchesToDiff(
      [append(37, [38, 39]), append(39, [40, 41]), append(41, [42, 43])],
      undefined,
      () => rows(37),
    );
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(r.diff).toContain('@@ -35,3 +35,9 @@');
    expect(r.linesAdded).toBe(6);
    expect(r.filesChanged).toEqual(['fikus']);
  });

  // Session 019fce3b: the watcher's shadow was taken 8.2s into the turn, by
  // which point Codex had already applied the first patch. Replaying it again
  // duplicated lines and left every later patch ambiguous.
  it('recognises patches the baseline ALREADY reflects', () => {
    const r = codexApplyPatchesToDiff(
      [append(37, [38, 39]), append(39, [40, 41]), append(41, [42, 43])],
      undefined,
      () => rows(39), // shadow caught the file mid-turn
    );
    expect(r.diff).toContain('@@ -35,3 +35,9 @@');
    expect(r.linesAdded).toBe(6);
    expect(r.diff).not.toContain('+37'); // no duplicated context
  });

  it('handles a baseline taken AFTER the whole turn finished', () => {
    const r = codexApplyPatchesToDiff(
      [append(37, [38, 39]), append(39, [40, 41]), append(41, [42, 43])],
      undefined,
      () => rows(43),
    );
    expect(r.diff).toContain('@@ -35,3 +35,9 @@');
    expect(r.linesAdded).toBe(6);
  });

  it('merges a create-then-append turn into one new-file diff', () => {
    const create = ['*** Begin Patch', '*** Add File: fikus', '+1', '+2', '*** End Patch'].join('\n');
    const r = codexApplyPatchesToDiff([create, append(2, [3])], undefined, () => null);
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(r.diff).toContain('new file mode 100644');
    expect(r.diff).toContain('@@ -0,0 +1,3 @@');
    expect(r.linesAdded).toBe(3);
  });

  it('leaves single-patch files exactly as the per-patch converter renders them', () => {
    const one = append(37, [38, 39]);
    const turn = codexApplyPatchesToDiff([one], undefined, () => rows(37));
    const solo = codexApplyPatchToDiff(one, undefined, () => rows(37));
    expect(turn.diff).toBe(solo.diff);
    expect(turn.linesAdded).toBe(solo.linesAdded);
  });

  it('marks a repeated file unavailable when a patch could NOT be reconciled', () => {
    // Second patch's context is nowhere to be found. It is safer to report a
    // partial capture than to store two sections for one file, which cannot be
    // applied or rendered as a single turn diff.
    const r = codexApplyPatchesToDiff(
      [append(37, [38, 39]), append(999, [1000])],
      undefined,
      () => rows(37),
    );
    expect(r.diff).toBe('');
    expect(r.linesAdded).toBe(0);
    expect(r.filesChanged).toEqual(['fikus']);
    expect(r.contentUnavailableFiles).toEqual(['fikus']);
  });

  it('does not emit duplicate file sections with no baseline reader', () => {
    const patches = [append(37, [38, 39]), append(39, [40, 41])];
    const r = codexApplyPatchesToDiff(patches, undefined, undefined);
    expect(r.diff).toBe('');
    expect(r.linesAdded).toBe(0);
    expect(r.filesChanged).toEqual(['fikus']);
    expect(r.contentUnavailableFiles).toEqual(['fikus']);
  });

  it('keeps a valid file while naming an unreconcilable repeated file', () => {
    const other = ['*** Begin Patch', '*** Add File: other.txt', '+safe', '*** End Patch'].join('\n');
    const r = codexApplyPatchesToDiff(
      [append(37, [38]), append(999, [1000]), other],
      undefined,
      () => rows(37),
    );
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(r.diff).toContain('other.txt');
    expect(r.filesChanged.sort()).toEqual(['fikus', 'other.txt']);
    expect(r.contentUnavailableFiles).toEqual(['fikus']);
    expect(r.linesAdded).toBe(1);
  });

  it('still separates DIFFERENT files touched in the same turn', () => {
    const a = ['*** Begin Patch', '*** Add File: a.txt', '+one', '*** End Patch'].join('\n');
    const b = ['*** Begin Patch', '*** Add File: b.txt', '+two', '*** End Patch'].join('\n');
    const r = codexApplyPatchesToDiff([a, b], undefined, () => null);
    expect(r.diff.match(/^diff --git /gm)).toHaveLength(2);
    expect(r.filesChanged.sort()).toEqual(['a.txt', 'b.txt']);
  });
});

// Build a minimal Codex rollout JSONL exercising two user turns, each with its
// own apply_patch, so we can assert the parser attributes each patch to its turn.
function writeRollout(lines: any[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-roll-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const applyPatchInput = (body: string) =>
  `const patch = "${body.replace(/\n/g, '\\n')}";\ntext(await tools.apply_patch(patch));`;

describe('parseCodexRolloutLive — promptPatches', () => {
  it('attributes each apply_patch to the user turn that produced it', () => {
    const p1 = '*** Begin Patch\n*** Add File: a.ts\n+one\n+two\n*** End Patch';
    const p2 = '*** Begin Patch\n*** Add File: b.ts\n+three\n*** End Patch';
    const file = writeRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first prompt' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: applyPatchInput(p1) } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second prompt' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: applyPatchInput(p2) } },
    ]);
    const parsed = parseCodexRolloutLive(file);
    expect(parsed).toBeTruthy();
    expect(parsed!.userPrompts.length).toBe(2);
    expect(parsed!.promptPatches.length).toBe(2);
    expect(parsed!.promptPatches[0].length).toBe(1);
    expect(parsed!.promptPatches[0][0]).toContain('Add File: a.ts');
    expect(parsed!.promptPatches[1].length).toBe(1);
    expect(parsed!.promptPatches[1][0]).toContain('Add File: b.ts');

    // The per-turn diffs are distinct — a git snapshot could not separate these
    // if the two turns landed inside one poll interval.
    const d0 = codexApplyPatchToDiff(parsed!.promptPatches[0][0]);
    const d1 = codexApplyPatchToDiff(parsed!.promptPatches[1][0]);
    expect(d0.linesAdded).toBe(2);
    expect(d1.linesAdded).toBe(1);
  });

  it('gives a turn with no edits an empty patch list', () => {
    const file = writeRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'just a question' }] } },
    ]);
    const parsed = parseCodexRolloutLive(file);
    expect(parsed!.promptPatches).toEqual([[]]);
  });

  // Session 5dfd1596 turn 3: Codex started a server with its store pointed at
  // `.tags-smoke.json`, so the file was created by the RUNNING PROCESS — no Add
  // section, and nothing at the turn's baseline either. Deleting it counted -0
  // and the file rendered as an empty section, so the turn read +144/-14 where
  // Codex itself reported +144/-49 over the same nine files.
  it('keeps the content of a file the turn deleted, so its lines can be counted', () => {
    const remove = '*** Begin Patch\n*** Delete File: C:\\\\repo\\\\.smoke.json\n*** End Patch';
    const file = writeRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'clean up after yourself' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: applyPatchInput(remove) } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'FileChange',
            changes: {
              'C:\\repo\\.smoke.json': { type: 'delete', content: 'one\ntwo\nthree\n' },
              // An add/update is already recoverable from the patch itself.
              'C:\\repo\\kept.ts': { type: 'update', content: '' },
            },
          },
        },
      },
    ]);
    const parsed = parseCodexRolloutLive(file);
    expect(parsed!.promptDeletedFiles).toEqual([{ 'C:\\repo\\.smoke.json': 'one\ntwo\nthree\n' }]);

    // End to end: the turn now counts the deletion it could not see before.
    const read = codexDeletedContentReader(parsed!.promptDeletedFiles![0]);
    const r = codexApplyPatchesToDiff(parsed!.promptPatches[0], 'C:\\repo', undefined, read);
    expect(r.linesRemoved).toBe(3);
    expect(r.filesChanged).toEqual(['.smoke.json']);
    expect(r.diff).toContain('deleted file mode 100644');
    expect(r.diff).toContain('@@ -1,3 +0,0 @@');
  });
});

describe('deleted-file content recorded by Codex', () => {
  const remove = ['*** Begin Patch', '*** Delete File: .smoke.json', '*** End Patch'].join('\n');

  it('counts a deletion the baseline cannot see', () => {
    // The file was created inside the turn by a shell command, so it is in
    // neither the turn's baseline nor any Add section.
    const r = codexApplyPatchesToDiff([remove], undefined, () => null, () => 'a\nb\nc\nd\n');
    expect(r.linesRemoved).toBe(4);
    expect(r.filesChanged).toEqual(['.smoke.json']);
    expect(r.diff).toContain('@@ -1,4 +0,0 @@');
    expect(r.diff).toContain('-a');
  });

  it('works with no baseline reader at all', () => {
    const r = codexApplyPatchesToDiff([remove], undefined, undefined, () => 'a\nb\n');
    expect(r.linesRemoved).toBe(2);
  });

  it('is a FALLBACK — the turn-s own view of the file still wins', () => {
    const r = codexApplyPatchToDiff(remove, undefined, {
      read: () => 'a\nb\n',
      deleted: () => 'x\ny\nz\n',
    });
    expect(r.linesRemoved).toBe(2);
  });

  it('leaves an Update section unanchored — it is consulted for deletions only', () => {
    // The recorded content describes the file at the moment it was REMOVED,
    // which is not a baseline an Update hunk may be positioned against.
    const update = ['*** Begin Patch', '*** Update File: .smoke.json', '@@', ' b', '+new', '*** End Patch'].join('\n');
    const r = codexApplyPatchToDiff(update, undefined, {
      read: () => null,
      deleted: () => 'a\nb\nc\n',
    });
    expect(r.diff).toContain('@@ -1,1 +1,2 @@'); // sequential fallback, not line 2
  });

  // #1376 stays fixed: a throwaway file the turn created AND removed changed
  // nothing by the end of the turn, whatever we can now see of its content.
  it('still drops a file the turn created and deleted again', () => {
    const create = ['*** Begin Patch', '*** Add File: tmp.py', '+one', '+two', '*** End Patch'].join('\n');
    const drop = ['*** Begin Patch', '*** Delete File: tmp.py', '*** End Patch'].join('\n');
    const r = codexApplyPatchesToDiff([create, drop], undefined, () => null, () => 'one\ntwo\n');
    expect(r.filesChanged).toEqual([]);
    expect(r.linesAdded).toBe(0);
    expect(r.linesRemoved).toBe(0);
  });
});

describe('codexDeletedContentReader', () => {
  it('answers an absolute-path record for the repo-relative path a patch resolves to', () => {
    const read = codexDeletedContentReader({ 'C:\\soft\\kotleta\\.tags-smoke.json': 'x\ny\n' })!;
    expect(read('.tags-smoke.json')).toBe('x\ny\n');
    expect(read('src/.tags-smoke.json')).toBeNull();
  });

  it('matches whole path segments only, so a same-named sibling never answers', () => {
    const read = codexDeletedContentReader({ '/repo/src/app.ts': 'gone\n' })!;
    expect(read('src/app.ts')).toBe('gone\n');
    expect(read('app.ts')).toBe('gone\n');   // the record IS this file, seen through a root
    expect(read('other/app.ts')).toBeNull();
    expect(read('nap.ts')).toBeNull();       // suffix of the string, not of the path
  });

  it('is undefined when nothing was recorded, so the converter keeps its old behaviour', () => {
    expect(codexDeletedContentReader(undefined)).toBeUndefined();
    expect(codexDeletedContentReader({})).toBeUndefined();
    expect(codexDeletedContentReader({ 'a.txt': '' })).toBeUndefined();
  });
});
