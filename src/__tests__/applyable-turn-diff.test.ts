import { describe, it, expect } from 'vitest';
import {
  combineApplyableTurnDiff,
  hasDuplicateFileSections,
} from '../applyable-turn-diff.js';
import { parseUnifiedDiff, verifyTurn } from '../capture-verify.js';

function section(file: string, extra: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,2 @@',
    ' keep',
    extra,
  ].join('\n') + '\n';
}

const COMMITTED = section('pkg.json', '+committed');
const LEFTOVER = section('pkg.json', '+leftover');
const NET = [
  'diff --git a/pkg.json b/pkg.json',
  '--- a/pkg.json',
  '+++ b/pkg.json',
  '@@ -1,1 +1,3 @@',
  ' keep',
  '+committed',
  '+leftover',
].join('\n') + '\n';
const OTHER = section('src/a.ts', '+other');

describe('combineApplyableTurnDiff', () => {
  it('returns a single half unchanged when the other is empty', () => {
    expect(combineApplyableTurnDiff({ committedDiff: COMMITTED, uncommittedDiff: '' })).toBe(COMMITTED.trim());
    expect(combineApplyableTurnDiff({ committedDiff: '', uncommittedDiff: LEFTOVER })).toBe(LEFTOVER.trim());
  });

  it('concatenates disjoint files — there is nothing to merge', () => {
    const out = combineApplyableTurnDiff({ committedDiff: OTHER, uncommittedDiff: LEFTOVER });
    expect(hasDuplicateFileSections(out)).toBe(false);
    expect(parseUnifiedDiff(out).files.map((f) => f.file).sort()).toEqual(['pkg.json', 'src/a.ts']);
  });

  it('a file committed then edited further becomes one applyable section, not two', () => {
    // Last-wins on the uncommitted leftover would keep only +leftover and
    // drop the commit. The working-tree view is the net vs the turn baseline.
    const out = combineApplyableTurnDiff({
      committedDiff: COMMITTED,
      uncommittedDiff: LEFTOVER,
      workingTreeDiff: NET,
    });
    expect(hasDuplicateFileSections(out)).toBe(false);
    expect(out).toContain('+committed');
    expect(out).toContain('+leftover');
    expect(parseUnifiedDiff(out).files).toHaveLength(1);
    expect(verifyTurn({
      promptIndex: 0,
      filesChanged: ['pkg.json'],
      diff: out,
      linesAdded: 2,
      linesRemoved: 0,
    }).map((v) => v.code)).not.toContain('duplicate_file_section');
  });

  it('two git-show patches for the same file (Codex/Gemini heartbeat) collapse via the working tree', () => {
    const first = section('pkg.json', '+bump-1');
    const second = section('pkg.json', '+bump-2');
    const net = [
      'diff --git a/pkg.json b/pkg.json',
      '--- a/pkg.json',
      '+++ b/pkg.json',
      '@@ -1,1 +1,3 @@',
      ' keep',
      '+bump-1',
      '+bump-2',
    ].join('\n') + '\n';
    const out = combineApplyableTurnDiff({
      committedDiff: first + second,
      uncommittedDiff: '',
      workingTreeDiff: net,
    });
    expect(hasDuplicateFileSections(out)).toBe(false);
    expect(out).toContain('+bump-1');
    expect(out).toContain('+bump-2');
    expect((out.match(/^diff --git /gm) || []).length).toBe(1);
  });

  it('keeps a committed-only file and an uncommitted-only file beside a merged overlap', () => {
    const out = combineApplyableTurnDiff({
      committedDiff: OTHER + COMMITTED,
      uncommittedDiff: LEFTOVER,
      workingTreeDiff: OTHER + NET,
    });
    expect(hasDuplicateFileSections(out)).toBe(false);
    expect(parseUnifiedDiff(out).files.map((f) => f.file).sort()).toEqual(['pkg.json', 'src/a.ts']);
    expect(out).toContain('+other');
    expect(out).toContain('+committed');
    expect(out).toContain('+leftover');
  });

  it('does not resurrect a file the caller already dropped from both halves', () => {
    // Pre-existing dirt lives in the working tree but was filtered out of
    // uncommittedDiff. Combining must not pull it back in.
    const dirt = section('dirt.ts', '+prior');
    const out = combineApplyableTurnDiff({
      committedDiff: COMMITTED,
      uncommittedDiff: '',
      workingTreeDiff: dirt + COMMITTED,
    });
    expect(out).not.toContain('dirt.ts');
    expect(out).toContain('pkg.json');
  });
});
