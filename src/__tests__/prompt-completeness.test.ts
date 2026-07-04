// Root-cause fix for the "commit-and-go" capture gap: a file that falls out of
// every live per-prompt diff (surviving only in the commit) must still be
// attributed to its committing prompt, so pc.diff is authoritative and every
// downstream consumer (turn diff, AI%, By-File blame) reads complete data.

import { describe, it, expect, vi } from 'vitest';
import { attachOrphanCommitFiles, type CompletenessChange } from '../prompt-completeness';

const section = (file: string, lines: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => '+' + l),
  ].join('\n');

const mkChange = (over: Partial<CompletenessChange>): CompletenessChange => ({
  diff: '',
  filesChanged: [],
  commitSha: null,
  linesAdded: 0,
  linesRemoved: 0,
  ...over,
});

describe('attachOrphanCommitFiles', () => {
  it('attaches a commit-only file to the committing prompt and recounts lines', () => {
    // PC2 committed 139f0d2f (touching 3 files) but its live diff only has 2;
    // src/index.test.js fell out of every prompt diff.
    const changes = [
      mkChange({ diff: section('src/greet.js', ['a']), filesChanged: ['src/greet.js'], commitSha: null, linesAdded: 1 }),
      mkChange({
        diff: section('src/index.js', ['b', 'c']),
        filesChanged: ['src/index.js'],
        commitSha: '139f0d2f',
        linesAdded: 2,
      }),
    ];
    const commitDetails = [
      { sha: '139f0d2f', filesChanged: ['src/greet.js', 'src/index.js', 'src/index.test.js'] },
    ];
    const showFile = vi.fn((_sha: string, file: string) =>
      file === 'src/index.test.js' ? section('src/index.test.js', ['t1', 't2', 't3']) : '',
    );

    const mutated = attachOrphanCommitFiles(changes, commitDetails, showFile);

    expect(mutated).toBe(true);
    // Orphan went to the COMMITTING prompt (commitSha match), not the first one.
    expect(changes[1].filesChanged).toContain('src/index.test.js');
    expect(changes[1].diff).toContain('b/src/index.test.js');
    expect(changes[0].filesChanged).not.toContain('src/index.test.js');
    // Line count recomputed: index.js(2) + index.test.js(3) added.
    expect(changes[1].linesAdded).toBe(5);
    // Only the orphan was fetched — already-covered files were skipped.
    expect(showFile).toHaveBeenCalledTimes(1);
    expect(showFile).toHaveBeenCalledWith('139f0d2f', 'src/index.test.js');
  });

  it('does not re-add a file already present in some prompt diff', () => {
    const changes = [
      mkChange({ diff: section('a.js', ['x']), filesChanged: ['a.js'], commitSha: 'abc1234' }),
    ];
    const showFile = vi.fn(() => section('a.js', ['x']));
    const mutated = attachOrphanCommitFiles(
      changes,
      [{ sha: 'abc1234', filesChanged: ['a.js'] }],
      showFile,
    );
    expect(mutated).toBe(false);
    expect(showFile).not.toHaveBeenCalled();
    expect(changes[0].linesAdded).toBe(0); // untouched (no recount when nothing attached)
  });

  it('falls back to the last change when no prompt owns the commit', () => {
    const changes = [
      mkChange({ diff: section('a.js', ['x']), filesChanged: ['a.js'], commitSha: null }),
      mkChange({ diff: section('b.js', ['y']), filesChanged: ['b.js'], commitSha: null }),
    ];
    const showFile = vi.fn((_s: string, f: string) => section(f, ['z']));
    const mutated = attachOrphanCommitFiles(
      changes,
      [{ sha: 'deadbee', filesChanged: ['c.js'] }],
      showFile,
    );
    expect(mutated).toBe(true);
    expect(changes[1].filesChanged).toContain('c.js'); // last change
    expect(changes[0].filesChanged).not.toContain('c.js');
  });

  it('normalizes paths via rel and skips unreachable/empty sections', () => {
    const changes = [mkChange({ diff: '', filesChanged: [], commitSha: 'abc1234' })];
    // rel strips a repo-root prefix; commit lists absolute, diff headers relative.
    const rel = (f: string) => f.replace(/^\/repo\//, '');
    const showFile = vi.fn((_s: string, f: string) =>
      f === '/repo/kept.js' ? section('kept.js', ['k']) : '',
    );
    const mutated = attachOrphanCommitFiles(
      changes,
      [{ sha: 'abc1234', filesChanged: ['/repo/kept.js', '/repo/gone.js'] }],
      showFile,
      rel,
    );
    expect(mutated).toBe(true);
    expect(changes[0].filesChanged).toContain('kept.js');
    expect(changes[0].filesChanged).not.toContain('gone.js'); // empty section skipped
  });

  it('is a no-op with no commits or no changes', () => {
    expect(attachOrphanCommitFiles([], [{ sha: 'a', filesChanged: ['x'] }], () => 'd')).toBe(false);
    expect(attachOrphanCommitFiles([mkChange({})], [], () => 'd')).toBe(false);
  });
});
