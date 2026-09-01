/**
 * A file the turn CREATED and then kept editing is one result, not a transcript
 * of the typing.
 *
 * buildDiffFromEdits concatenated the create with every later touch-up, so the
 * rewritten lines counted twice — once as created, once as replaced. Session
 * 61abc51d, `rectify.py`: a new 709-line file rendered
 *
 *     @@ -1,0 +1,708 @@     the create
 *     @@ -4,3 +4,3 @@       and eleven more edits to the file it just made
 *     ...
 *
 * and reported +779/-70. Cursor itself, and git, say +709/-0. The NET was
 * always right (779 - 70 = 709); the two halves were inflated by the churn.
 *
 * Only applies when the turn created the file: then "before" is nothing and
 * "after" is the final content, both known. A file that already existed has a
 * base we cannot reconstruct from the records, so it keeps the old rendering.
 */
import { describe, it, expect } from 'vitest';
import { buildDiffFromEdits } from '../transcript.js';

const count = (diff: string) => {
  let added = 0, removed = 0, inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line[0] === '+') added++;
    else if (line[0] === '-') removed++;
  }
  return { added, removed };
};

const F = 'C:/repo/rectify.py';
const write = (content: string) => ({ file: F, toolName: 'Write', input: { content } });
const edit = (oldS: string, newS: string) => ({ file: F, toolName: 'Edit', input: { old_string: oldS, new_string: newS } });
const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('a file created and then edited in the same turn', () => {
  it('counts only the result, not the intermediate rewrites', () => {
    const diff = buildDiffFromEdits([
      write(body(709)),
      edit('line 4', 'line 4 fixed'),
      edit('line 34', 'line 34 fixed'),
    ]);
    // 709 lines added, nothing removed — the file did not exist before.
    expect(count(diff)).toEqual({ added: 709, removed: 0 });
  });

  it('carries the edits into the content it reports', () => {
    const diff = buildDiffFromEdits([write('a\nb\nc'), edit('b', 'B')]);
    expect(diff).toContain('+B');
    expect(diff).not.toContain('+b');
    expect(count(diff)).toEqual({ added: 3, removed: 0 });
  });

  it('uses the LAST whole-file write when the turn rewrites wholesale', () => {
    const diff = buildDiffFromEdits([write(body(50)), write(body(20))]);
    expect(count(diff)).toEqual({ added: 20, removed: 0 });
  });

  it('leaves a single create exactly as it was', () => {
    const one = buildDiffFromEdits([write(body(30))]);
    expect(count(one)).toEqual({ added: 30, removed: 0 });
  });

  it('does NOT collapse a file that already existed', () => {
    // First record is a region edit, so the turn did not create it and the base
    // is unknown — the old per-edit rendering has to stand.
    const diff = buildDiffFromEdits([
      { file: F, toolName: 'Edit', input: { old_string: 'x', new_string: 'y' } },
      { file: F, toolName: 'Edit', input: { old_string: 'p', new_string: 'q' } },
    ]);
    const c = count(diff);
    expect(c.added).toBeGreaterThan(0);
    expect(c.removed).toBeGreaterThan(0);
  });

  it('declines when an edit anchor is not in the content it built', () => {
    // Our copy has diverged from the agent's; reconstructing would be a guess.
    // Falls back to the old rendering, which still shows both records.
    const diff = buildDiffFromEdits([write('a\nb'), edit('NOT PRESENT', 'z')]);
    expect(count(diff).removed).toBeGreaterThan(0);
  });

  it('keeps separate files separate', () => {
    const diff = buildDiffFromEdits([
      { file: 'C:/repo/a.py', toolName: 'Write', input: { content: body(10) } },
      { file: 'C:/repo/b.py', toolName: 'Write', input: { content: body(20) } },
      { file: 'C:/repo/a.py', toolName: 'Edit', input: { old_string: 'line 1', new_string: 'line 1!' } },
    ]);
    expect(diff).toContain('diff --git a/repo/a.py');
    expect(diff).toContain('diff --git a/repo/b.py');
    expect(count(diff)).toEqual({ added: 30, removed: 0 });
  });
});
