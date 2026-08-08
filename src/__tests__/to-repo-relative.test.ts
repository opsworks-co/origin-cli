// Regression: the transcript watcher stored Windows-style absolute paths
// ("C:/repo/src/x.ts") verbatim on Linux/macOS because `path.isAbsolute` only
// recognizes the HOST platform's format — so isSubstantiveMemory dropped the
// entry as foreign work (CI: expected ['src/upload.ts'], got ['C:/repo/...']).
// toRepoRelative strips the workRoot prefix regardless of host OS.
import { describe, it, expect } from 'vitest';
import { toRepoRelative } from '../transcript-watch.js';

describe('toRepoRelative', () => {
  it('strips a Windows workRoot prefix even when running on POSIX', () => {
    expect(toRepoRelative('C:/repo', 'C:/repo/src/upload.ts')).toBe('src/upload.ts');
  });

  it('normalizes backslash Windows paths', () => {
    expect(toRepoRelative('C:\\repo', 'C:\\repo\\src\\upload.ts')).toBe('src/upload.ts');
  });

  it('strips a POSIX workRoot prefix', () => {
    expect(toRepoRelative('/home/me/repo', '/home/me/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('leaves an already-relative path unchanged', () => {
    expect(toRepoRelative('/home/me/repo', 'src/a.ts')).toBe('src/a.ts');
  });

  it('tolerates a trailing slash on workRoot', () => {
    expect(toRepoRelative('C:/repo/', 'C:/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('returns "." when the file IS the workRoot', () => {
    expect(toRepoRelative('C:/repo', 'C:/repo')).toBe('.');
  });

  it('leaves a path outside the workRoot as its normalized self', () => {
    // Not under the repo → not stripped (foreign work; filtered downstream).
    expect(toRepoRelative('C:/repo', 'D:/other/x.ts')).toBe('D:/other/x.ts');
  });
});
