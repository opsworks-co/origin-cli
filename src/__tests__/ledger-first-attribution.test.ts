// Ledger-first attribution, against a real git tree.
//
// The turn window claims a file because it is DIRTY. In a checkout shared with
// other agents that is wrong constantly: session 81d65cb5 was credited with a
// sibling's `hooks.ts` on a turn that edited nothing, and with another
// session's `SpendQuality.tsx` and `post-commit-pipe-stall.test.ts`.
//
// The probe claims a file because it was SEEN CHANGING across one command.
// This asserts the difference on the exact shape that leaked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeTree, touchedSince, type ProbeDeps } from '../shell-command-probe.js';
import { getDirtyFiles } from '../git-capture.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('probe vs window on a real tree', () => {
  let repo: string;
  let deps: ProbeDeps;

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-ledger-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@origin.dev'); git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'export const s = 1;\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
    deps = {
      listDirty: (t) => getDirtyFiles(t),
      stat: (t, f) => {
        try { const st = fs.statSync(path.join(t, f)); return { mtimeMs: st.mtimeMs, size: st.size }; }
        catch { return null; }
      },
    };
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('does NOT claim a sibling agent\'s file that was already dirty', async () => {
    // A concurrent session left work in the shared checkout BEFORE our command.
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'export const s = 999; // their WIP\n');

    // The window's view — everything dirty counts as the turn's work, so the
    // sibling's file is in it before our command has even run. This is the
    // input the probe has to improve on, asserted so the contrast is real.
    expect(getDirtyFiles(repo)).toEqual(['sibling.ts']);

    // Our command runs, touching only our file.
    const before = probeTree(repo, deps);
    await new Promise((r) => setTimeout(r, 12)); // distinct mtime
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const a = 2;\n');
    const touched = touchedSince(before, probeTree(repo, deps));

    // The probe claims ours and only ours — the sibling's file never moved.
    expect(touched).toEqual(['mine.ts']);
    expect(touched).not.toContain('sibling.ts');
  });

  it('claims a file created by the command, including in a subdirectory', async () => {
    const before = probeTree(repo, deps);
    await new Promise((r) => setTimeout(r, 12));
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'new.ts'), 'export const n = 1;\n');
    expect(touchedSince(before, probeTree(repo, deps))).toEqual(['src/new.ts']);
  });

  it('claims a file the command edited AGAIN after a sibling had dirtied it', async () => {
    // Contested file: dirty before us, and we write it too. Ours.
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'their edit\n');
    const before = probeTree(repo, deps);
    await new Promise((r) => setTimeout(r, 12));
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'their edit\nour edit\n');
    expect(touchedSince(before, probeTree(repo, deps))).toEqual(['sibling.ts']);
  });

  it('claims nothing for a read-only command', async () => {
    // The turn that asked "how many edits did you do" — it wrote nothing, and
    // was credited with 14.5 KB of a sibling's hooks.ts.
    fs.writeFileSync(path.join(repo, 'sibling.ts'), 'their WIP\n');
    const before = probeTree(repo, deps);
    await new Promise((r) => setTimeout(r, 12));
    execFileSync('git', ['status', '--short'], { cwd: repo });  // pure read
    expect(touchedSince(before, probeTree(repo, deps))).toEqual([]);
  });

  it('does not claim files a commit merely cleaned', async () => {
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'export const a = 3;\n');
    const before = probeTree(repo, deps);
    await new Promise((r) => setTimeout(r, 12));
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'commit earlier work');
    // The write happened in an EARLIER command; the committing one gets nothing.
    expect(touchedSince(before, probeTree(repo, deps))).toEqual([]);
  });
});
