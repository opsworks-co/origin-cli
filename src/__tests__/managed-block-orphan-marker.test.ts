/**
 * A context file whose origin-managed block lost one of its two marker lines
 * used to freeze: `existing.includes(MARKER)` sent it down the replace branch,
 * the pair regex matched nothing, the output was byte-identical to the input,
 * and writeManagedBlock returned false. Nothing surfaced it — the
 * sibling-refresh loop only logs when a write actually happened — so that
 * file's Origin context stayed stale forever while every session reported
 * success.
 *
 * Half a block is easy to produce: a user tidying CLAUDE.md and deleting one
 * line, or a torn write (the file is written whole, not atomically).
 *
 * Repair has a hard constraint: never delete text the user may have written.
 * The tail after an orphan marker is reclaimed ONLY when it carries Origin's
 * own preamble; otherwise the orphan line alone is dropped and a fresh block is
 * appended. Losing a user's notes to fix our own bookkeeping would be a worse
 * failure than the staleness being repaired.
 */

import { describe, it, expect } from 'vitest';
import { renderManagedFile, ORIGIN_MANAGED_MARKER as M } from '../commands/hooks.js';

const MSG = 'Origin: Session tracking active — fresh context.';
const BLOCK = `${M}\n${MSG}\n${M}`;

/** Number of marker lines in a rendered file — must always end up 0 or 2. */
const markers = (s: string) => s.split(M).length - 1;

describe('renderManagedFile — well-formed files (unchanged behaviour)', () => {
  it('becomes the whole file when there is nothing there', () => {
    expect(renderManagedFile('', MSG)).toBe(BLOCK);
    expect(renderManagedFile('   \n\n', MSG)).toBe(BLOCK);
  });

  it('appends to a file that has no marker, keeping the user content', () => {
    const out = renderManagedFile('# My notes\n\nSome prose.\n', MSG);
    expect(out).toContain('# My notes');
    expect(out).toContain('Some prose.');
    expect(out.endsWith(BLOCK)).toBe(true);
  });

  it('replaces a paired block in place, preserving text on both sides', () => {
    const out = renderManagedFile(`# Above\n\n${M}\nSTALE\n${M}\n\n# Below\n`, MSG);
    expect(out).toContain('# Above');
    expect(out).toContain('# Below');
    expect(out).toContain(MSG);
    expect(out).not.toContain('STALE');
    expect(markers(out)).toBe(2);
  });
});

describe('renderManagedFile — orphan marker repair', () => {
  it('refreshes a file whose closing marker was deleted (was: frozen forever)', () => {
    const damaged = `# Notes\n\n${M}\nOrigin: Session tracking active — STALE context.\n`;
    const out = renderManagedFile(damaged, MSG);
    expect(out).not.toBe(damaged);           // the freeze
    expect(out).toContain(MSG);
    expect(out).not.toContain('STALE');
    expect(out).toContain('# Notes');
    expect(markers(out)).toBe(2);
  });

  it('refreshes a file whose opening marker was deleted', () => {
    const damaged = `Origin: Session tracking active — STALE context.\n${M}\n`;
    const out = renderManagedFile(damaged, MSG);
    expect(out).not.toBe(damaged);
    expect(out).toContain(MSG);
    expect(markers(out)).toBe(2);
  });

  it('NEVER deletes prose after an orphan when it is not demonstrably ours', () => {
    // No Origin preamble in the tail, so it could be anything the user wrote.
    const damaged = `${M}\n\n# My hand-written project notes\n\nDo not lose this paragraph.\n`;
    const out = renderManagedFile(damaged, MSG);
    expect(out).toContain('# My hand-written project notes');
    expect(out).toContain('Do not lose this paragraph.');
    expect(out).toContain(MSG);
    expect(markers(out)).toBe(2);
  });

  it('leaves no stray marker behind after repairing', () => {
    for (const damaged of [
      `${M}\nOrigin: Session tracking active — stale.\n`,
      `# Notes\n${M}\nuser prose\n`,
      `${M}\n`,
    ]) {
      expect(markers(renderManagedFile(damaged, MSG))).toBe(2);
    }
  });

  it('is idempotent — repairing twice is the same as repairing once', () => {
    const damaged = `# Notes\n\n${M}\nOrigin: Session tracking active — stale.\n`;
    const once = renderManagedFile(damaged, MSG);
    expect(renderManagedFile(once, MSG)).toBe(once);
  });
});

describe('renderManagedFile — over-marked files converge', () => {
  it('collapses three markers into exactly one well-formed block', () => {
    // A third marker used to survive every refresh, leaving the file one edit
    // away from the frozen state above.
    const out = renderManagedFile(`${M}\nSTALE\n${M}\n\ntrailing\n${M}\n`, MSG);
    expect(markers(out)).toBe(2);
    expect(out).toContain(MSG);
    expect(out).not.toContain('STALE');
  });

  it('reaches a fixed point after one pass', () => {
    const once = renderManagedFile(`${M}\nSTALE\n${M}\nx\n${M}\n`, MSG);
    expect(renderManagedFile(once, MSG)).toBe(once);
  });
});
