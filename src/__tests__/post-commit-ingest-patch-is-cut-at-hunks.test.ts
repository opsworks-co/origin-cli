// The commit ingest's patch used to be `diff.slice(0, 500_000)`: a byte cut,
// mid-hunk, and nothing told the server it was short. The session header
// counts the stored patch's lines, so prod c085f0af read +678/-175 for a
// +729/-175 commit — the cut landed 600 lines into its 631-line file and lost
// the file after it. Now the patch is cut at hunk boundaries and flagged.
import { describe, it, expect } from 'vitest';
import { COMMIT_INGEST_PATCH_LIMIT, ingestPatchForCommit } from '../commands/hooks/post-commit.js';

function section(file: string, lines: number, width = 1): string {
  const body = Array.from({ length: lines }, (_, i) => `+${'x'.repeat(width)} ${i}`).join('\n');
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines} @@`,
    body,
  ].join('\n');
}

describe('ingestPatchForCommit', () => {
  it('sends a small patch whole and does not flag it', () => {
    const diff = section('a.ts', 3);
    expect(ingestPatchForCommit(diff)).toEqual({ diff });
  });

  it('sends nothing for an empty diff, as before', () => {
    expect(ingestPatchForCommit('')).toEqual({});
    expect(ingestPatchForCommit(undefined)).toEqual({});
  });

  it('cuts an oversize patch at hunk boundaries and says so', () => {
    // A small first section, then one hunk far over the limit, then a small
    // last file — the shape of the prod commit.
    const small = section('small.json', 17);
    const big = section('big.json', 4000, 200); // ~800KB in one hunk
    const last = section('last.json', 17);
    const out = ingestPatchForCommit([small, big, last].join('\n'));
    expect(out.diffTruncated).toBe(true);
    expect(out.diff!.length).toBeLessThanOrEqual(COMMIT_INGEST_PATCH_LIMIT);
    // Whole sections only: the text starts a file header and every kept
    // section is intact — no half hunk for a reader to mis-parse.
    expect(out.diff!.startsWith('diff --git a/small.json')).toBe(true);
    expect(out.diff).toContain('diff --git a/last.json');
    expect(out.diff).not.toContain('diff --git a/big.json');
  });
});
