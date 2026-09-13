import { describe, expect, it } from 'vitest';
import { verifySession, type VerifiableTurn } from '../capture-verify.js';

const file = 'src/example.ts';
const headers = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
const grouped = headers + '@@ -1,2 +1,2 @@\n-old one\n-old two\n+new one\n+new two\n';
const interleaved = headers + '@@ -1 +1 @@\n-old one\n+new one\n@@ -2 +2 @@\n-old two\n+new two\n';
const row = (promptIndex: number, over: Partial<VerifiableTurn> = {}): VerifiableTurn => ({
  promptIndex, filesChanged: [file], diff: grouped, ...over,
});
const repeats = (turns: VerifiableTurn[]) => verifySession(turns).filter((v) => v.code === 'identical_change_in_two_turns');
const indexed = (text: string, old: string, next: string) => text.replace('--- a/', `index ${old}..${next} 100644\n--- a/`);

describe('equivalent changes across capture producers', () => {
  it('finds equivalent replacements regrouped into separate hunks', () => {
    const result = repeats([row(0), row(1, { diff: interleaved })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ severity: 'suspect', promptIndex: 1, files: [file] });
  });
  it('compares diff with uncommittedDiff from a different producer', () => {
    expect(repeats([row(0), row(1, { diff: '', uncommittedDiff: interleaved })])).toHaveLength(1);
  });
  it('compares two uncommitted captures and deduplicates mirrored fields within a turn', () => {
    expect(repeats([row(0, { uncommittedDiff: grouped }), row(1, { diff: '', uncommittedDiff: interleaved })])).toHaveLength(1);
    expect(repeats([row(0, { uncommittedDiff: interleaved })])).toEqual([]);
  });
  it('preserves line order, whitespace, Unicode, and occurrence counts', () => {
    for (const changed of [
      grouped.replace('+new one\n+new two', '+new two\n+new one'),
      grouped.replace('+new one', '+ new one'),
      grouped + '\\ No newline at end of file\n',
      grouped.replace('+new one', '+nťw one'), // U+0165 shares ASCII e's low byte
      grouped.replace('@@ -1,2 +1,2 @@', '@@ -1,2 +1,3 @@').replace('+new two\n', '+new two\n+new two\n'),
    ]) expect(repeats([row(0), row(1, { diff: changed })])).toEqual([]);
  });
  it('keeps identical text written in a proven subsequent git window', () => {
    expect(repeats([
      row(1, { diff: indexed(interleaved, 'bbbbbbb', 'ccccccc') }),
      row(0, { diff: indexed(grouped, 'aaaaaaa', 'bbbbbbb') }),
    ])).toEqual([]);
  });
  it('allows revert and reapply instead of calling the reapplication a duplicate', () => {
    const reverse = headers + '@@ -1,2 +1,2 @@\n-new one\n-new two\n+old one\n+old two\n';
    expect(repeats([
      row(0, { diff: indexed(grouped, 'aaaaaaa', 'bbbbbbb') }),
      row(1, { diff: indexed(reverse, 'bbbbbbb', 'aaaaaaa') }),
      row(2, { diff: indexed(interleaved, 'aaaaaaa', 'bbbbbbb') }),
    ])).toEqual([]);
  });
  it('does not let a later valid window erase an earlier duplicate finding', () => {
    expect(repeats([
      row(0, { diff: indexed(grouped, 'aaaaaaa', 'bbbbbbb') }),
      row(1, { diff: indexed(interleaved, 'aaaaaaa', 'bbbbbbb') }),
      row(2, { diff: indexed(grouped, 'bbbbbbb', 'ccccccc') }),
    ])).toEqual([expect.objectContaining({ promptIndex: 1 })]);
  });
  it('still checks complete files when another file in the same patch is truncated', () => {
    const incomplete = 'diff --git a/broken.ts b/broken.ts\n--- a/broken.ts\n+++ b/broken.ts\n@@ -1,2 +1,2 @@\n-missing rest\n';
    expect(repeats([row(0), row(1, { diff: interleaved + incomplete })])).toHaveLength(1);
  });
  it('does not match malformed prefixes or different files', () => {
    expect(repeats([row(0), row(1, { diff: interleaved + '@@ -5,2 +5,2 @@\n-incomplete\n' })])).toEqual([]);
    expect(repeats([row(0), row(1, { filesChanged: ['lib/example.ts'], diff: interleaved.replaceAll(file, 'lib/example.ts') })])).toEqual([]);
  });
});
