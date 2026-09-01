/**
 * A tool-call file must not exclude a DIFFERENT file that shares its basename.
 *
 * `coveredFiles` / `foreignFiles` mix repo-relative and absolute paths (tool
 * call vs git capture), so the window's repo-relative names had to match
 * `/abs/checkout/src/app.ts` against `src/app.ts`. That was done by indexing
 * every entry's BASENAME — which also excludes every other file with the same
 * name anywhere in the tree.
 *
 * agy session 65953fe2: the turn's tool calls created `frontend/index.html`,
 * and the same turn deleted the repo-root `index.html` from the shell. The
 * basename `index.html` was already in `covered`, so the deletion was skipped
 * as "already accounted for" — 7 of the turn's 8 deletions were recorded and
 * the 8th (51 removed lines) landed nowhere.
 */
import { describe, it, expect } from 'vitest';
import { shellWindowEdits, type ShellWindowDeps } from '../shell-write-capture.js';

function deps(files: string[], atRev: Record<string, string>, working: Record<string, string>): ShellWindowDeps {
  return {
    listChangedFiles: () => files,
    readAtRev: (_sha, file) => (file in atRev ? atRev[file] : null),
    readWorking: (file) => (file in working ? working[file] : null),
  };
}

describe('shell window exclusion is path-precise', () => {
  it('claims a root file whose basename a tool-call file in a subdir shares', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(
        ['index.html', 'frontend/index.html'],
        { 'index.html': '<old>\n' },
        { 'frontend/index.html': '<new>\n' },
      ),
      { baselineSha: 'sha', coveredFiles: ['frontend/index.html'] },
    );
    // The deletion of the ROOT index.html is this turn's work and must land.
    expect(edits.map((e) => e.file)).toEqual(['index.html']);
    expect(skipped).toContainEqual({ file: 'frontend/index.html', reason: 'covered' });
  });

  it('still reconciles an ABSOLUTE covered path against the relative window name', () => {
    const { edits, skipped } = shellWindowEdits(
      deps(['src/app.ts', 'gen.txt'], { 'src/app.ts': 'x\n' }, { 'src/app.ts': 'y\n', 'gen.txt': 'g\n' }),
      { baselineSha: 'sha', coveredFiles: ['/Users/someone/checkout/src/app.ts'] },
    );
    expect(edits.map((e) => e.file)).toEqual(['gen.txt']);
    expect(skipped).toContainEqual({ file: 'src/app.ts', reason: 'covered' });
  });

  it('reconciles a Windows absolute covered path too', () => {
    const { skipped } = shellWindowEdits(
      deps(['src/app.ts'], { 'src/app.ts': 'x\n' }, { 'src/app.ts': 'y\n' }),
      { baselineSha: 'sha', coveredFiles: ['C:\\repo\\src\\app.ts'] },
    );
    expect(skipped).toContainEqual({ file: 'src/app.ts', reason: 'covered' });
  });

  it("does not let a sibling's basename mark a file as another session's", () => {
    const { edits } = shellWindowEdits(
      deps(['docs/README.md'], { 'docs/README.md': 'a\n' }, { 'docs/README.md': 'b\n' }),
      { baselineSha: 'sha', foreignFiles: ['README.md'] },
    );
    expect(edits.map((e) => e.file)).toEqual(['docs/README.md']);
  });
});
