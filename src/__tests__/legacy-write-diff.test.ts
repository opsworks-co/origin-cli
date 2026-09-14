import { describe, it, expect } from 'vitest';
import { reRenderCreatedWrites } from '../legacy-write-diff.js';
import { verifyTurn } from '../capture-verify.js';

const BASE = Array.from({ length: 10 }, (_, i) => `base_${i} = ${i}`).join('\n') + '\n';
const AFTER = BASE + 'mine = "the turn wrote this"\n';

/** What buildDiffFromEdits emits for a first-edit whole-file Write: a creation. */
function asCreate(file: string, content: string): string {
  const lines = content.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const editsJson = (edits: unknown[]) => JSON.stringify({ edits });
const count = (diff: string) => ({
  added: diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
  removed: diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
});

describe('reRenderCreatedWrites', () => {
  it('a Write over an existing file becomes a modification with only its own lines', () => {
    const diff = asCreate('shared.py', AFTER);
    const out = reRenderCreatedWrites(diff, editsJson([{ file: 'shared.py', op: 'write', oldContent: BASE, newContent: AFTER }]));
    expect(out.changed).toEqual(['shared.py']);
    expect(out.diff).not.toContain('new file mode');
    expect(out.diff).toContain('+mine = "the turn wrote this"');
    expect(out.diff).not.toContain('+base_0 = 0');
    expect(count(out.diff)).toEqual({ added: 1, removed: 0 });
    expect(verifyTurn({ promptIndex: 0, filesChanged: ['shared.py'], diff: out.diff, linesAdded: 1, linesRemoved: 0 } as any)).toEqual([]);
  });

  it('a genuine create (no before-state) is left as the creation it is', () => {
    const diff = asCreate('new.py', 'x = 1\n');
    const out = reRenderCreatedWrites(diff, editsJson([{ file: 'new.py', op: 'write', oldContent: '', newContent: 'x = 1\n' }]));
    expect(out.changed).toEqual([]);
    expect(out.diff).toBe(diff);
  });

  it('a file with a non-Write edit in the turn is left alone', () => {
    const diff = asCreate('shared.py', AFTER);
    const out = reRenderCreatedWrites(diff, editsJson([
      { file: 'shared.py', op: 'write', oldContent: BASE, newContent: BASE },
      { file: 'shared.py', op: 'edit', oldString: 'base_0', newString: 'b0' },
    ]));
    expect(out.changed).toEqual([]);
    expect(out.diff).toBe(diff);
  });

  it('uses the first Write\'s before-state and the last Write\'s after-state', () => {
    const middle = BASE + 'draft = 1\n';
    const diff = asCreate('shared.py', AFTER);
    const out = reRenderCreatedWrites(diff, editsJson([
      { file: 'shared.py', op: 'write', oldContent: BASE, newContent: middle },
      { file: 'shared.py', op: 'write', oldContent: middle, newContent: AFTER },
    ]));
    expect(out.diff).toContain('+mine = "the turn wrote this"');
    expect(out.diff).not.toContain('draft = 1');
    expect(count(out.diff)).toEqual({ added: 1, removed: 0 });
  });

  it('only the creation sections change; other sections stay byte-identical', () => {
    const other = 'diff --git a/other.py b/other.py\n--- a/other.py\n+++ b/other.py\n@@ -1 +1 @@\n-a\n+b\n';
    const diff = other + asCreate('shared.py', AFTER);
    const out = reRenderCreatedWrites(diff, editsJson([{ file: 'shared.py', op: 'write', oldContent: BASE, newContent: AFTER }]));
    expect(out.diff.startsWith(other)).toBe(true);
    expect(out.changed).toEqual(['shared.py']);
  });

  it('a Write that restored the file exactly drops its section (net zero)', () => {
    const diff = asCreate('shared.py', BASE);
    const out = reRenderCreatedWrites(diff, editsJson([{ file: 'shared.py', op: 'write', oldContent: BASE, newContent: BASE }]));
    expect(out.changed).toEqual(['shared.py']);
    expect(out.diff).toBe('');
  });

  it('matches an absolute edit path to the repo-relative section by suffix', () => {
    const diff = asCreate('src/shared.py', AFTER);
    const out = reRenderCreatedWrites(diff, editsJson([{ file: '/repo/src/shared.py', op: 'write', oldContent: BASE, newContent: AFTER }]));
    expect(out.changed).toEqual(['src/shared.py']);
  });

  it('is a no-op without evidence: no editsJson, unparseable editsJson, or no creation sections', () => {
    const diff = asCreate('shared.py', AFTER);
    expect(reRenderCreatedWrites(diff, undefined)).toEqual({ diff, changed: [] });
    expect(reRenderCreatedWrites(diff, '{not json')).toEqual({ diff, changed: [] });
    const modify = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-a\n+b\n';
    expect(reRenderCreatedWrites(modify, editsJson([{ file: 'a.py', op: 'write', oldContent: 'a\n', newContent: 'b\n' }]))).toEqual({ diff: modify, changed: [] });
  });
});
