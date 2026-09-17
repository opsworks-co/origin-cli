// END-TO-END: a git command that names its paths is the turn's own work, even
// when the result is an older version of the file.
//
// Re-review of #1684 at d40c389c0:
//
//   3. turn 0 committed config.py, the user then added two lines by hand, and
//      turn 1 ran `git checkout -- config.py`. filesPutBackAcrossTheGap saw a
//      file rewritten between the turns and put back, and dropped it: turn 1
//      read [] against main's [config.py] -2.
//   4. an interrupted turn (no Stop) that ran `git checkout HEAD~1 --
//      package.json`, `git checkout HEAD~1 -- lib` or `git revert --no-commit
//      HEAD` went out empty from the next prompt's replacement, because
//      fileNamedInCommand only matched paths containing '/' and the history
//      test drops an older version nothing authored.
//
// Built binary, real hook sequence, real repo, fake API.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep, waitFor, type Harness } from './helpers/stop-next-prompt-harness.js';

const T = 120_000 * WINDOWS_SLOWDOWN;

/** An interrupted turn: the command runs, no Stop, and the next prompt arrives. */
async function interruptedTurnRow(h: Harness, command: string, effect: () => void): Promise<any> {
  await h.startSession('roll it back');
  await h.agentRuns('tu-1', command, effect);
  await sleep(500);
  await h.submit('now continue');
  await waitFor(() => !!h.rows().find((r: any) => r.promptIndex === 0), 15_000, 'the next prompt to send turn 0');
  return h.rows().find((r: any) => r.promptIndex === 0);
}

describe.skipIf(!haveDist || isWindows)('git pathspec reverts stay the turn\'s work, through the built binary', () => {
  it('turn 1\'s `git checkout -- config.py` of the user\'s between-turn edit is turn 1\'s -2', async () => {
    const h = await createHarness('e2e-gitpath-gap-0001', 'e2e-gitpath-gap-srv-1');
    try {
      commitFiles(h, { 'config.py': numbered('cfg', 3) }, 'base');

      await h.startSession('tune the config');
      await h.agentWrites('tu-1', 'config.py', numbered('cfg', 3) + 'cfg_new = 1\n');
      await h.agentRuns('tu-2', 'git add config.py && git commit -m "tune config"', async () => {
        h.git(['add', 'config.py']);
        h.git(['commit', '-q', '-m', 'tune config']);
        const pc = await h.gitHook('git-post-commit');
        expect(pc.code, pc.stderr).toBe(0);
      });
      h.reply('Committed.');
      await h.stop();

      // The user edits the file by hand between the turns.
      fs.appendFileSync(path.join(h.repo, 'config.py'), 'user_a = 1\nuser_b = 2\n');
      await sleep(500);

      await h.submit('drop my local edits to config.py');
      await h.agentRuns('tu-3', 'git checkout -- config.py', () => { h.git(['checkout', '--', 'config.py']); });
      await sleep(500);
      h.reply('Dropped.');
      await h.stop();

      const one = h.rows().find((r: any) => r.promptIndex === 1);
      expect(one?.filesChanged).toEqual(['config.py']);
      expect([one?.linesAdded, one?.linesRemoved]).toEqual([0, 2]);
    } finally {
      await h.close();
    }
  }, T);

  it('an interrupted turn\'s `git checkout HEAD~1 -- package.json` (root file) is its row at the next prompt', async () => {
    const h = await createHarness('e2e-gitpath-root-0002', 'e2e-gitpath-root-srv-2');
    try {
      commitFiles(h, { 'package.json': '{ "version": "1.0.0" }\n', 'src/app.py': numbered('app', 3) }, 'base');
      commitFiles(h, { 'package.json': '{ "version": "2.0.0" }\n' }, 'bump');
      const row = await interruptedTurnRow(h, 'git checkout HEAD~1 -- package.json', () => {
        h.git(['checkout', 'HEAD~1', '--', 'package.json']);
      });
      expect(row?.filesChanged).toEqual(['package.json']);
      expect(String(row?.diff || '')).toContain('+{ "version": "1.0.0" }');
    } finally {
      await h.close();
    }
  }, T);

  it('an interrupted turn\'s `git checkout HEAD~1 -- lib` (directory) is its row at the next prompt', async () => {
    const h = await createHarness('e2e-gitpath-dir-0003', 'e2e-gitpath-dir-srv-3');
    try {
      commitFiles(h, { 'lib/a.py': numbered('a', 3), 'lib/b.py': numbered('b', 3), 'other.py': numbered('o', 2) }, 'base');
      commitFiles(h, { 'lib/a.py': numbered('a', 6), 'lib/b.py': numbered('b', 6) }, 'grow lib');
      const row = await interruptedTurnRow(h, 'git checkout HEAD~1 -- lib', () => {
        h.git(['checkout', 'HEAD~1', '--', 'lib']);
      });
      expect([...(row?.filesChanged || [])].sort()).toEqual(['lib/a.py', 'lib/b.py']);
    } finally {
      await h.close();
    }
  }, T);

  it('an interrupted turn\'s `git revert --no-commit HEAD` is its row at the next prompt', async () => {
    const h = await createHarness('e2e-gitpath-revert-0004', 'e2e-gitpath-revert-srv-4');
    try {
      commitFiles(h, { 'svc.py': numbered('svc', 3) }, 'base');
      commitFiles(h, { 'svc.py': numbered('svc', 5) }, 'grow svc');
      const row = await interruptedTurnRow(h, 'git revert --no-commit HEAD', () => {
        h.git(['revert', '--no-commit', 'HEAD']);
      });
      expect(row?.filesChanged).toEqual(['svc.py']);
      expect(String(row?.diff || '')).toContain('-svc_4 = 4');
    } finally {
      await h.close();
    }
  }, T);
});
