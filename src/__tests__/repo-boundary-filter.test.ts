// Origin's own memory notes were being billed as the agent's repo work.
//
// `toRepoRelative` RETURNS THE INPUT UNCHANGED when a path lies outside the
// root, so an out-of-repo absolute path did not fail loudly — it travelled on
// as if it were repo-relative and rendered as a changed file of the repo.
// Session 81d65cb5's first turn showed exactly ONE "changed file": Origin's
// own memory .md under ~/.claude, while the six source files of the commit
// that turn made were nowhere to be seen.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isInsideRepo } from '../commands/hooks.js';

describe('isInsideRepo', () => {
  let repo: string;
  beforeEach(() => { repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-bound-'))); });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('keeps files in the repo', () => {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
    expect(isInsideRepo(repo, path.join(repo, 'src', 'a.ts'))).toBe(true);
    // A file that does not exist yet is still inside — the write may be the
    // very thing being recorded.
    expect(isInsideRepo(repo, path.join(repo, 'src', 'new.ts'))).toBe(true);
  });

  it('treats a relative path as already repo-relative', () => {
    expect(isInsideRepo(repo, 'src/a.ts')).toBe(true);
  });

  it('REJECTS Origin\'s own memory notes and other out-of-repo files', () => {
    const home = os.homedir();
    expect(isInsideRepo(repo, path.join(home, '.claude', 'projects', 'x', 'memory', 'note.md'))).toBe(false);
    expect(isInsideRepo(repo, path.join(home, '.origin', 'sessions', 's.json'))).toBe(false);
    expect(isInsideRepo(repo, '/etc/passwd')).toBe(false);
  });

  it('rejects a sibling directory whose name merely starts the same', () => {
    // Prefix comparison without a separator would call `<repo>-other` inside.
    expect(isInsideRepo(repo, repo + '-other/file.ts')).toBe(false);
  });

  it('is symlink-tolerant', () => {
    // macOS temp dirs are symlinked (/var -> /private/var); an unresolved
    // comparison would call a file in the session's own tree "outside".
    const viaTmp = path.join(os.tmpdir(), path.basename(repo), 'src', 'a.ts');
    expect(isInsideRepo(repo, viaTmp)).toBe(true);
  });

  it('says no when it has nothing to compare', () => {
    expect(isInsideRepo('', '/a/b')).toBe(false);
    expect(isInsideRepo(repo, '')).toBe(false);
  });
});
