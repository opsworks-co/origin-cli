// END-TO-END: what a turn's own shell command deleted, moved or checked out
// stays in the turn's row.
//
// The restored-from-history drop (restored-from-history.ts) exists for a
// background job's pathspec checkout of an OLDER commit that nobody in the
// turn asked for. Review of #1684 found it also ate the turn's own shell work:
//
//   - `versionsInHistory` counted "absent" as a past version of every path
//     (the creating commit has an all-zero source), so DELETING a committed
//     file read as "put back to a version history already had";
//   - Stop runs the check on the in-flight turn, where a shell deletion carries
//     only watched evidence (command_probe / write_journal);
//   - `fileNamedInCommand` only matched paths containing `/`, and never a
//     directory the command named, so neither `NOTES.md` nor `src/legacy`
//     counted as named.
//
// Built binary, real hook sequence, real repo, fake API.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';

const T = 120_000 * WINDOWS_SLOWDOWN;

describe.skipIf(!haveDist || isWindows)('a turn\'s own shell deletions and checkouts, through the built binary', () => {
  it('git rm of a committed directory and rm of a root file stay in the row', async () => {
    const h = await createHarness('e2e-shell-del-rm-0001', 'e2e-shell-del-srv-rm');
    try {
      commitFiles(h, {
        'src/mine.py': numbered('mine', 5),
        'src/legacy/old_a.py': numbered('old_a', 6),
        'src/legacy/old_b.py': numbered('old_b', 4),
        'NOTES.md': '# notes\nkeep this\n',
      }, 'base');
      // A second version of each, so history holds more than the creation.
      commitFiles(h, {
        'src/legacy/old_a.py': numbered('old_a', 8),
        'NOTES.md': '# notes\nkeep this\nand this\n',
      }, 'second');

      await h.startSession('remove the legacy code');
      await h.agentWrites('tu-1', 'src/mine.py', numbered('mine', 5) + 'mine_new = 1\n');
      await h.agentRuns('tu-2', 'git rm -r -q src/legacy && rm NOTES.md', () => {
        h.git(['rm', '-r', '-q', 'src/legacy']);
        fs.rmSync(path.join(h.repo, 'NOTES.md'));
      });
      await sleep(500);
      h.reply('Removed.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row, 'no row for turn 0').toBeTruthy();
      expect([...(row.filesChanged || [])].sort()).toEqual(['NOTES.md', 'src/legacy/old_a.py', 'src/legacy/old_b.py', 'src/mine.py']);
      expect(String(row.diff || '')).toContain('-old_b_0 = 0');
      expect(String(row.diff || '')).toContain('-and this');
      expect(h.hooksLog()).not.toMatch(/inherited files dropped from an earlier turn[^\n]*NOTES\.md/);
    } finally {
      await h.close();
    }
  }, T);

  it('git mv of a directory, then a rewrite, keeps the removed old path', async () => {
    const h = await createHarness('e2e-shell-del-mv-0002', 'e2e-shell-del-srv-mv');
    try {
      commitFiles(h, { 'src/olddir/a.py': numbered('a', 5), 'src/olddir/b.py': numbered('b', 3) }, 'base');
      commitFiles(h, { 'src/olddir/a.py': numbered('a', 7) }, 'second');

      await h.startSession('rename the package');
      // The rewrite breaks rename pairing for a.py, so git shows its old path
      // as a deletion and its new path as an addition; b.py stays a rename.
      await h.agentRuns('tu-1', 'git mv src/olddir src/newdir && ./regen.sh > src/newdir/a.py', () => {
        h.git(['mv', 'src/olddir', 'src/newdir']);
        fs.writeFileSync(path.join(h.repo, 'src/newdir/a.py'), numbered('regenerated', 9));
      });
      await sleep(500);
      h.reply('Renamed.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row, 'no row for turn 0').toBeTruthy();
      expect([...(row.filesChanged || [])].sort()).toEqual(['src/newdir/a.py', 'src/newdir/b.py', 'src/olddir/a.py']);
      expect(String(row.diff || '')).toContain('-a_6 = 6');
    } finally {
      await h.close();
    }
  }, T);

  it('a deliberate `git checkout HEAD~1 -- package.json` at the root stays', async () => {
    const h = await createHarness('e2e-shell-del-co-0003', 'e2e-shell-del-srv-co');
    try {
      commitFiles(h, { 'package.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n', 'src/app.py': numbered('app', 3) }, 'base');
      commitFiles(h, { 'package.json': '{\n  "name": "x",\n  "version": "2.0.0"\n}\n' }, 'bump');

      await h.startSession('roll back the version bump');
      await h.agentRuns('tu-1', 'git checkout HEAD~1 -- package.json', () => {
        h.git(['checkout', 'HEAD~1', '--', 'package.json']);
      });
      await sleep(500);
      h.reply('Rolled back.');
      await h.stop();

      const row = h.rows().find((r: any) => r.promptIndex === 0);
      expect(row, 'no row for turn 0').toBeTruthy();
      expect(row.filesChanged).toEqual(['package.json']);
      expect(String(row.diff || '')).toContain('+  "version": "1.0.0"');
      expect(String(row.diff || '')).toContain('-  "version": "2.0.0"');
    } finally {
      await h.close();
    }
  }, T);
});
