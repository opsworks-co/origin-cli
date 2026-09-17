// END-TO-END: what a turn's background job writes after the turn's Stop still
// belongs to that turn.
//
// #1684 made Stop's row final for a turn it closed ('closed by stop'), so a
// background job's pathspec checkout of an older main between Stop and the
// next prompt no longer REPLACES the row (session 874ff028 turn 6). Review
// found the other half: a background job the agent started (`sleep 2 &&
// ./gen.sh > src/gen_client.py`) fires no tool hook, post-commit only re-opens
// a RUNNING turn, the closed turn's window ends at Stop's tree, and the next
// turn's start shadow is cut after the write. The generated file belonged to
// no turn.
//
// Closed-by-stop now protects Stop's row from being replaced or shrunk, not
// from being EXTENDED: the next prompt adds the files that moved between Stop's
// tree and its own, unless they were only put back to a version history had.
//
// Built binary, real hook sequence, real repo, fake API.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { WINDOWS_SLOWDOWN, isWindows } from './helpers/windows-e2e.js';
import { commitFiles, createHarness, haveDist, numbered, sleep, waitFor } from './helpers/stop-next-prompt-harness.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const MINE = 'src/mine.py';
const GEN = 'src/gen_client.py';

describe.skipIf(!haveDist || isWindows)('a background job that outlives its turn\'s Stop, through the built binary', () => {
  it('a file the job writes after Stop lands in the turn that started the job', async () => {
    const h = await createHarness('e2e-bg-output-0001', 'e2e-bg-output-srv-1');
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5), 'gen.sh': 'echo generated\n' }, 'base');

      await h.startSession('regenerate the client');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      const command = 'sleep 2 && ./gen.sh > src/gen_client.py';
      await h.agentRuns('tu-2', command, () => { /* runs in the background */ }, { run_in_background: true });
      h.reply('Started the generator.');
      await h.stop();
      expect(h.rows().find((r: any) => r.promptIndex === 0)?.filesChanged).toEqual([MINE]);

      // The job finishes after Stop: no hook fires.
      fs.writeFileSync(path.join(h.repo, GEN), numbered('client', 20));
      await waitFor(() => h.journalText().includes('gen_client.py'), 10_000, 'the journal to record the generated file');
      await sleep(300);

      await h.submit('looks good, thanks');
      h.reply('You are welcome.');
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0);
      const one = rows.find((r: any) => r.promptIndex === 1);
      expect([...(zero?.filesChanged || [])].sort()).toEqual([GEN, MINE]);
      expect(String(zero?.diff || '')).toContain('+client_19 = 19');
      expect(String(zero?.diff || '')).toContain('+mine_new = 1');
      expect([zero?.linesAdded, zero?.linesRemoved]).toEqual([21, 0]);
      expect((one?.filesChanged || []) as string[]).not.toContain(GEN);
      expect(String(one?.diff || '')).not.toContain('gen_client.py');
    } finally {
      await h.close();
    }
  }, T);

  it('a commit the job makes after Stop stays the turn\'s, and so does its file', async () => {
    const h = await createHarness('e2e-bg-commit-0002', 'e2e-bg-commit-srv-2');
    try {
      commitFiles(h, { [MINE]: numbered('mine', 5), 'gen.sh': 'echo generated\n' }, 'base');

      await h.startSession('regenerate and commit the client');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = 1\n');
      const command = 'sleep 2 && ./gen.sh > src/gen_client.py && git add src/gen_client.py && git commit -m "regenerate client"';
      await h.agentRuns('tu-2', command, () => { /* runs in the background */ }, { run_in_background: true });
      h.reply('Started the generator.');
      await h.stop();

      // The job writes and commits after Stop; git fires post-commit.
      fs.writeFileSync(path.join(h.repo, GEN), numbered('client', 20));
      h.git(['add', GEN]);
      h.git(['commit', '-q', '-m', 'regenerate client']);
      const sha = h.git(['rev-parse', 'HEAD']);
      const pc = await h.gitHook('git-post-commit');
      expect(pc.code, pc.stderr).toBe(0);
      await sleep(500);

      await h.submit('looks good, thanks');
      h.reply('You are welcome.');
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0);
      const one = rows.find((r: any) => r.promptIndex === 1);
      expect([...(zero?.filesChanged || [])].sort()).toEqual([GEN, MINE]);
      expect(String(zero?.diff || '')).toContain('+client_19 = 19');
      expect(String(zero?.diff || '')).toContain('+mine_new = 1');
      expect((one?.filesChanged || []) as string[]).not.toContain(GEN);
      // As on main: the session reports the commit, and no later turn claims it.
      expect(one?.commitSha ?? null).not.toBe(sha);
      expect((one?.commitShas || []) as string[]).not.toContain(sha);
      expect(h.hits.some((x) => (x.body?.gitCapture?.commitShas || []).includes(sha))).toBe(true);
    } finally {
      await h.close();
    }
  }, T);

  it('the job\'s pathspec checkout of an older main before the next prompt is still not the turn\'s', async () => {
    const h = await createHarness('e2e-bg-restore-0003', 'e2e-bg-restore-srv-3');
    const PR_FILES = ['src/pr_one.py', 'src/pr_two.py'];
    try {
      const older = commitFiles(h, {
        [MINE]: numbered('mine', 5),
        ...Object.fromEntries(PR_FILES.map((f) => [f, numbered(path.basename(f, '.py'), 5)])),
      }, 'base');
      commitFiles(h, Object.fromEntries(PR_FILES.map((f) => [f, numbered(path.basename(f, '.py'), 40)])),
        'fix(capture): another session\'s PR (#1676)', {
          GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
          GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@else.dev',
        });

      await h.startSession('make the change');
      await h.agentWrites('tu-1', MINE, numbered('mine', 5) + 'mine_new = "turn one"\n');
      // The agent itself started the job, and its command NAMES the directory.
      const command = `git add -A && git commit -m wip && git checkout ${older} -- src && sleep 5 && git checkout HEAD -- src && git reset --soft HEAD~1 && git reset`;
      await h.agentRuns('tu-2', command, () => { /* runs in the background */ }, { run_in_background: true });
      h.reply('Done.');
      await h.stop();
      expect(h.rows().find((r: any) => r.promptIndex === 0)?.filesChanged).toEqual([MINE]);

      h.git(['add', '-A']);
      h.git(['commit', '-q', '-m', 'wip']);
      h.git(['checkout', older, '--', 'src']);
      await waitFor(() => PR_FILES.every((f) => h.journalText().includes(f)), 10_000, 'the journal to record the checkout');

      await h.submit('now explain it');

      h.git(['checkout', 'HEAD', '--', 'src']);
      h.git(['reset', '-q', '--soft', 'HEAD~1']);
      h.git(['reset', '-q']);
      await sleep(600);
      h.reply('It adds one line.');
      await h.stop();

      const rows = h.rows();
      const zero = rows.find((r: any) => r.promptIndex === 0);
      const one = rows.find((r: any) => r.promptIndex === 1);
      expect(zero?.filesChanged).toEqual([MINE]);
      expect([zero?.linesAdded, zero?.linesRemoved]).toEqual([1, 0]);
      for (const f of PR_FILES) expect(String(zero?.diff || '')).not.toContain(f);
      for (const f of [...PR_FILES, MINE]) {
        expect((one?.filesChanged || []) as string[]).not.toContain(f);
        expect(String(one?.diff || '')).not.toContain(f);
      }
    } finally {
      await h.close();
    }
  }, T);
});
