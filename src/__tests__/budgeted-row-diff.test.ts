/**
 * A saved row's diff is fitted at file/hunk boundaries, never cut at a byte.
 *
 * Session ac7e1559 turn 4 (Cursor, 2026-09-23): after-file-edit built a
 * 309 KB diff over four files and stored `fullDiff.slice(0, 200_000)` —
 * exactly 200000 bytes, stop.ts cut mid-hunk, transcript-adapters.ts gone —
 * and `origin verify-capture` reported diff_unparseable +
 * claimed_file_absent_from_diff. Stop already had the rule (d5cc625b,
 * budgetedTurnCapture); five other producers did not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { budgetRowDiffs, withCutFiles } from '../budgeted-row-diff.js';
import { verifyTurn } from '../capture-verify.js';

/** A modified-file section with `hunks` hunks of `lines` added lines each. */
function section(file: string, hunks: number, lines: number): string {
  let out = `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n`;
  for (let h = 0; h < hunks; h++) {
    const start = h * 1000 + 1;
    out += `@@ -${start},1 +${start},${lines + 1} @@\n ctx ${h}\n`;
    for (let i = 0; i < lines; i++) out += `+${file} hunk ${h} line ${i} ${'x'.repeat(40)}\n`;
  }
  return out;
}

// Four files like ac7e1559 turn 4; the third is big enough to straddle the
// 200 KB line and the fourth lands past it.
const FILES = [
  'packages/cli/src/__tests__/cursor-token-estimate.test.ts',
  'packages/cli/src/agents/cursor.ts',
  'packages/cli/src/commands/hooks/stop.ts',
  'packages/cli/src/transcript-adapters.ts',
];
const BIG = section(FILES[0], 2, 40) + section(FILES[1], 3, 60) + section(FILES[2], 40, 70) + section(FILES[3], 2, 30);

describe('budgetRowDiffs', () => {
  it('the fixture reproduces the stored row: a raw 200000-byte cut is corrupt', () => {
    expect(BIG.length).toBeGreaterThan(300_000);
    const kinds = verifyTurn({ promptIndex: 4, filesChanged: FILES, diff: BIG.slice(0, 200_000), uncommittedDiff: BIG.slice(0, 200_000) })
      .map((v) => v.code);
    expect(kinds).toContain('diff_unparseable');
    expect(kinds).toContain('claimed_file_absent_from_diff');
  });

  it.each([
    ['the diff half', BIG, ''],
    ['the uncommitted half', '', BIG],
  ])('fits %s at boundaries and names what it cut, so the row verifies clean', (_half, diff, uncommitted) => {
    const b = budgetRowDiffs(diff, uncommitted);
    expect(Buffer.byteLength(b.diff)).toBeLessThanOrEqual(200_000);
    expect(Buffer.byteLength(b.uncommittedDiff)).toBeLessThanOrEqual(200_000);
    expect(b.cutFiles).toContain(FILES[3]);
    const row = {
      promptIndex: 4,
      filesChanged: [...new Set([...FILES, ...b.cutFiles])],
      diff: b.diff,
      uncommittedDiff: b.uncommittedDiff,
      ...withCutFiles([], b.cutFiles),
    };
    expect(verifyTurn(row)).toEqual([]);
  });

  it('leaves a diff that fits untouched and names nothing', () => {
    const small = section(FILES[0], 1, 5);
    const b = budgetRowDiffs(small, '');
    expect(b.diff).toBe(small);
    expect(b.uncommittedDiff).toBe('');
    expect(b.cutFiles).toEqual([]);
    expect(withCutFiles([], [])).toEqual({});
  });

  it('keeps contentUnavailableFiles the caller already had', () => {
    expect(withCutFiles(['bin.png'], ['a.ts', 'bin.png'])).toEqual({ contentUnavailableFiles: ['bin.png', 'a.ts'] });
  });
});

// No call-site harness drives these five hooks with a large diff, so the
// wiring is pinned at the source: a producer that goes back to cutting a diff
// at a byte offset fails here.
describe('no producer cuts a diff at a byte offset', () => {
  const src = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(src);

  it('finds the sources', () => {
    expect(files.some((f) => f.endsWith(path.join('hooks', 'after-file-edit.ts')))).toBe(true);
  });

  it('has no `.slice(0, 200_000)` or `.slice(0, MAX_PROMPT_DIFF_LEN)` outside comments', () => {
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').trim();
        if (code.startsWith('*') || code.startsWith('/*')) return;
        if (/\.slice\(0,\s*(200_000|200000|MAX_PROMPT_DIFF_LEN)\)/.test(code)) offenders.push(`${path.relative(src, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
