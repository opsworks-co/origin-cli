/**
 * Antigravity re-records a file it has already written, byte-identical.
 * chainAgyWholeFileWrites turned a repeat write into a delta only when the
 * content DIFFERED; an identical repeat fell through to the raw-Write branch
 * and buildDiffFromEdits rendered it as the whole file added a SECOND time.
 *
 * The double-count is the file's entire length, so a turn's numbers came out
 * far above what the agent itself reported. Measured on three live sessions:
 *
 *   294d81ea  styles.css written twice at 549 lines (sha b1acd464 both times)
 *             → turn reported +1893; the agent's own count was +1293
 *   0d10ba06  shitty_code.py written twice at 210 lines (sha 97087f1e both)
 *             → turn reported +450 for ~241 lines of work
 *
 * A write that changed nothing contributes nothing.
 */
import { describe, it, expect } from 'vitest';
import { chainAgyWholeFileWrites } from '../transcript-adapters.js';

const W = (file: string, content: string) => ({ file, toolName: 'Write', input: { content } } as never);
const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const FILE = 'C:/repo/styles.css';

// What the turn is worth: every whole-file Write counts its full content, every
// Edit counts only its new side. Mirrors how buildDiffFromEdits renders them.
const weight = (recs: any[][]) =>
  recs.flat().reduce((n, r) => n + String(
    r.toolName === 'Write' ? (r.input.content ?? '') : (r.input.new_string ?? ''),
  ).split('\n').length, 0);

describe('chainAgyWholeFileWrites — identical repeat writes', () => {
  it('drops a repeat write of identical content', () => {
    const c = body(549);
    const out = chainAgyWholeFileWrites([[W(FILE, c), W(FILE, c)]]);
    expect(out[0]).toHaveLength(1);
    expect(weight(out)).toBe(weight(chainAgyWholeFileWrites([[W(FILE, c)]])));
  });

  it('drops every extra identical write, not just the second', () => {
    const c = body(30);
    const out = chainAgyWholeFileWrites([[W(FILE, c), W(FILE, c), W(FILE, c)]]);
    expect(out[0]).toHaveLength(1);
  });

  it('still chains a repeat write that really changed the file', () => {
    const first = body(50);
    const second = first + '\nextra';
    const out = chainAgyWholeFileWrites([[W(FILE, first), W(FILE, second)]]);
    expect(out[0]).toHaveLength(2);
    // Second becomes a delta, not a whole-file add.
    expect((out[0][1] as any).toolName).toBe('Edit');
    expect((out[0][1] as any).input.old_string).toBe(first);
    expect((out[0][1] as any).input.new_string).toBe(second);
  });

  it('tracks each file separately', () => {
    const a = body(20);
    const b = body(40);
    const out = chainAgyWholeFileWrites([[W('C:/repo/a.css', a), W('C:/repo/b.css', b), W('C:/repo/a.css', a)]]);
    // The repeat of a.css is dropped; b.css is untouched.
    expect(out[0]).toHaveLength(2);
    expect(new Set(out[0].map((r: any) => r.file)).size).toBe(2);
  });

  it('drops an identical repeat that lands in a LATER turn', () => {
    // agy re-records across turns too, and the content carries over.
    const c = body(100);
    const out = chainAgyWholeFileWrites([[W(FILE, c)], [W(FILE, c)]]);
    expect(out[0]).toHaveLength(1);
    expect(out[1]).toHaveLength(0);
  });

  it('leaves an Edit record alone', () => {
    const rec = { file: FILE, toolName: 'Edit', input: { old_string: 'a', new_string: 'b' } } as never;
    const out = chainAgyWholeFileWrites([[rec]]);
    expect(out[0]).toHaveLength(1);
    expect((out[0][0] as any).input.new_string).toBe('b');
  });
});
