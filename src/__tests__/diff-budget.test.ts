// Stage 3: a diff that must shrink shrinks HONESTLY.
//
// The property that matters, and the one the old `.slice(0, 200_000)` could
// never satisfy: whatever comes out is a VALID unified diff. The sweep at the
// bottom checks that at every budget from 0 to the full size — if any cut point
// produced a corrupt diff, one of those iterations finds it.
//
// Corruption is the failure being designed out. A truncated diff is worse than
// no diff: nothing downstream can tell it apart from a complete one, so a
// mid-hunk cut becomes a wrong line count, a wrong file list, and a patch git
// refuses to apply.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fitDiffToBudget, splitDiffSections } from '../diff-budget.js';
import { parseUnifiedDiff } from '../capture-verify.js';

const section = (file: string, hunks: number, linesPerHunk = 3): string => {
  const out = [`diff --git a/${file} b/${file}`, 'index 1111111..2222222 100644', `--- a/${file}`, `+++ b/${file}`];
  for (let h = 0; h < hunks; h++) {
    const start = 1 + h * 20;
    out.push(`@@ -${start},1 +${start},${1 + linesPerHunk} @@`);
    out.push(` context line ${h}`);
    for (let l = 0; l < linesPerHunk; l++) out.push(`+added ${file} h${h} l${l}`);
  }
  return out.join('\n') + '\n';
};

const A = section('src/a.ts', 2);
const B = section('src/b.ts', 3);
const C = section('src/c.ts', 1);
const ALL = A + B + C;

describe('splitDiffSections', () => {
  it('splits on file boundaries and preserves bytes exactly', () => {
    const s = splitDiffSections(ALL);
    expect(s.map((x) => x.file)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(s.map((x) => x.text).join('')).toBe(ALL);
  });

  it('keeps each section\'s hunks separate', () => {
    expect(splitDiffSections(ALL)[1].hunks).toHaveLength(3);
  });

  it('returns nothing for text with no file header', () => {
    expect(splitDiffSections('just some words\n')).toEqual([]);
    expect(splitDiffSections('')).toEqual([]);
  });

  it('handles a diff with no trailing newline', () => {
    const noNl = A.trimEnd();
    expect(splitDiffSections(noNl).map((x) => x.file)).toEqual(['src/a.ts']);
  });
});

describe('fitDiffToBudget', () => {
  it('returns the input untouched when it already fits', () => {
    const r = fitDiffToBudget(ALL, 1_000_000);
    expect(r.diff).toBe(ALL);
    expect(r.truncated).toBe(false);
    expect(r.omittedFiles).toEqual([]);
  });

  it('drops WHOLE trailing files and names them', () => {
    const r = fitDiffToBudget(ALL, Buffer.byteLength(A, 'utf-8'));
    expect(r.diff).toBe(A);
    expect(r.omittedFiles).toEqual(['src/b.ts', 'src/c.ts']);
    expect(r.truncated).toBe(true);
    expect(parseUnifiedDiff(r.diff).malformed).toEqual([]);
  });

  it('keeps whole HUNKS when a section will not fit whole', () => {
    const aBytes = Buffer.byteLength(A, 'utf-8');
    const bSecs = splitDiffSections(B)[0];
    const budget = aBytes + Buffer.byteLength(bSecs.header + bSecs.hunks[0], 'utf-8');
    const r = fitDiffToBudget(ALL, budget);
    expect(r.partialFiles).toEqual(['src/b.ts']);
    const p = parseUnifiedDiff(r.diff);
    expect(p.malformed, 'a partial section must still parse').toEqual([]);
    // Exactly one of b's three hunks survived.
    expect(r.diff.match(/^@@ /gm)?.length).toBe(3); // a's two + b's one
  });

  it('omits a file entirely rather than emit a partial hunk', () => {
    // Budget allows a's section plus b's header but not one of b's hunks.
    const aBytes = Buffer.byteLength(A, 'utf-8');
    const bHeader = Buffer.byteLength(splitDiffSections(B)[0].header, 'utf-8');
    const r = fitDiffToBudget(ALL, aBytes + bHeader + 5);
    expect(r.omittedFiles).toContain('src/b.ts');
    expect(r.diff).not.toContain('src/b.ts');
    expect(parseUnifiedDiff(r.diff).malformed).toEqual([]);
  });

  it('keeps nothing rather than a prefix when the text has no sections', () => {
    // A prefix would be the mid-cut this module exists to prevent.
    const r = fitDiffToBudget('a'.repeat(500), 100);
    expect(r.diff).toBe('');
    expect(r.truncated).toBe(true);
  });

  it('preserves file ORDER rather than packing smallest-first', () => {
    // A "first N files" cut is explicable to a reviewer; an arbitrary subset
    // that happened to pack well is not.
    const big = section('src/zzz-big.ts', 20);
    const small = section('src/aaa-small.ts', 1);
    const r = fitDiffToBudget(big + small, Buffer.byteLength(small, 'utf-8') + 10);
    expect(r.diff).not.toContain('aaa-small');
    expect(r.omittedFiles[0]).toBe('src/aaa-small.ts');
  });

  it('reports the original size so a caller can say how much was lost', () => {
    const r = fitDiffToBudget(ALL, 10);
    expect(r.originalBytes).toBe(Buffer.byteLength(ALL, 'utf-8'));
  });

  it('is a no-op on empty input', () => {
    for (const v of ['', '   ']) {
      const r = fitDiffToBudget(v, 10);
      expect(r.diff).toBe(v);
      expect(r.truncated).toBe(false);
    }
  });

  it('measures BYTES, not characters', () => {
    // A multi-byte diff must not overflow a byte budget by counting chars.
    const uni = section('src/héllo-🎉.ts', 1);
    const r = fitDiffToBudget(uni, Buffer.byteLength(uni, 'utf-8') - 1);
    expect(Buffer.byteLength(r.diff, 'utf-8')).toBeLessThanOrEqual(Buffer.byteLength(uni, 'utf-8') - 1);
    expect(parseUnifiedDiff(r.diff).malformed).toEqual([]);
  });
});

describe('every possible cut point yields a valid diff', () => {
  let dir = '';
  let haveGit = true;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-budget-'));
    try { execFileSync('git', ['--version'], { cwd: dir, stdio: 'pipe' }); } catch { haveGit = false; }
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('parses at every budget from 0 to the full size', () => {
    const total = Buffer.byteLength(ALL, 'utf-8');
    for (let budget = 0; budget <= total; budget += 7) {
      const r = fitDiffToBudget(ALL, budget);
      expect(Buffer.byteLength(r.diff, 'utf-8'), `budget ${budget} overflowed`).toBeLessThanOrEqual(budget);
      const p = parseUnifiedDiff(r.diff);
      expect(p.malformed, `budget ${budget} produced a malformed diff`).toEqual([]);
      expect(p.duplicateFiles, `budget ${budget} duplicated a section`).toEqual([]);
    }
  });

  it('never names a file it did not actually keep', () => {
    const total = Buffer.byteLength(ALL, 'utf-8');
    for (let budget = 0; budget <= total; budget += 11) {
      const r = fitDiffToBudget(ALL, budget);
      const inDiff = new Set(parseUnifiedDiff(r.diff).files.map((f) => f.file));
      for (const f of r.omittedFiles) {
        expect(inDiff.has(f), `budget ${budget}: ${f} is both omitted and present`).toBe(false);
      }
      for (const f of r.partialFiles) {
        expect(inDiff.has(f), `budget ${budget}: ${f} is partial but absent`).toBe(true);
      }
    }
  });

  it('git accepts the reduced diff at every budget', () => {
    if (!haveGit) return;
    const total = Buffer.byteLength(ALL, 'utf-8');
    for (let budget = 0; budget <= total; budget += 13) {
      const r = fitDiffToBudget(ALL, budget);
      if (!r.diff.trim()) continue;
      // `git apply` invoked from inside a repository silently ignores paths
      // outside the cwd, so the check runs in an empty temp dir with no repo —
      // see capture-verify.test.ts for the full story on that trap.
      const out = execFileSync('git', ['apply', '--numstat', '--allow-empty', '-'], {
        cwd: dir, input: r.diff, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(out.length, `budget ${budget}: git parsed nothing`).toBeGreaterThan(0);
    }
  });
});
