// Cursor's afterFileEdit names the exact file it just wrote. That is proof —
// the agent telling us, not us deducing it from what happens to be dirty.
//
// The path was previously used only as an extra NAME appended to filesChanged,
// while the attribution still came from a whole-tree diff against the prompt
// shadow. So a Cursor turn in a shared checkout absorbed a sibling agent's
// work exactly like every other window-based turn, despite holding the one
// signal that could have prevented it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeTree, touchedSince } from '../shell-command-probe.js';
import { getDirtyFiles } from '../git-capture.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('cursor edit-hook evidence vs the window', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cur-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@origin.dev'); git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'a\n');
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 's\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('the window sees a sibling\'s dirt; the edit hook names only our file', () => {
    // A concurrent agent leaves work in the shared checkout.
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'their WIP\n');
    // Cursor writes ours, and its hook reports THAT path.
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'our edit\n');

    // What a whole-tree window would attribute to this turn:
    expect(getDirtyFiles(repo).sort()).toEqual(['mine.ts', 'sibling.ts']);

    // What the edit hook asserts — one file, named by the agent itself.
    const reported = 'mine.ts';
    expect(getDirtyFiles(repo)).toContain(reported);
    expect(reported).not.toBe('sibling.ts');
  });

  it('an absolute path from the hook resolves to a repo-relative one', () => {
    // Cursor reports absolute paths; the ledger keys on repo-relative.
    const abs = path.join(repo, 'src', 'deep', 'a.ts');
    const rel = path.relative(repo, abs).split(path.sep).join('/');
    expect(rel).toBe('src/deep/a.ts');
    expect(path.isAbsolute(rel)).toBe(false);
  });

  it('a path OUTSIDE the repo must not become a repo file', () => {
    // Cursor can edit files outside the workspace; those are not repo work.
    const outside = path.join(os.tmpdir(), 'not-in-repo.ts');
    const rel = path.relative(repo, outside);
    expect(rel.startsWith('..')).toBe(true);
  });

  it('still proves the probe ignores an unchanged sibling file', () => {
    // Cross-check the two evidence paths agree on the sibling case.
    const deps = {
      listDirty: (t: string) => getDirtyFiles(t),
      stat: (t: string, f: string) => {
        try { const st = fs.statSync(path.join(t, f)); return { mtimeMs: st.mtimeMs, size: st.size }; }
        catch { return null; }
      },
    };
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'their WIP\n');
    const before = probeTree(repo, deps);
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'our edit\n');
    expect(touchedSince(before, probeTree(repo, deps))).toEqual(['mine.ts']);
  });
});
