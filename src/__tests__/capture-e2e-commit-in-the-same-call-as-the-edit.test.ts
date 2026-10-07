// End to end, through the built binary: a shell call that EDITS a file and
// COMMITS it reaches prepare-commit-msg before the session's ledger has the
// edit. With another conversation live in the same checkout whose finished
// turn holds that file, the commit used to get THAT session's trailer
// (6b770703 / ff9131bd, 2026-09-20 — see commit-command-in-flight.ts).
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BIN, commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';
import { sessionIsRunningCommitHere } from '../commit-command-in-flight.js';

const T = 120_000 * WINDOWS_SLOWDOWN;
const FILE = 'src/shared.py';

function gitHook(cwd: string, name: string, args: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', name, ...args], {
    cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

describe.skipIf(!haveDist)('a commit made in the same shell call as its edit', () => {
  it('wears the trailer of the session running the command, not of the one that touched the file yesterday', async () => {
    const h = await createHarness('e2e-commit-call-0001', 'e2e-commit-call-srv-1');
    try {
      commitFiles(h, { [FILE]: numbered('base', 4), 'src/mine.py': numbered('mine', 3) }, 'base');

      // The earlier conversation in this checkout: one finished turn that
      // edited FILE. Never ended, no turn open.
      const earlier = await h.sibling('e2e-earlier-0002');
      await earlier.submit('rework the shared module');
      await earlier.agentWrites('s-1', FILE, numbered('base', 4) + 'earlier = 1\n');
      earlier.reply('Done.');
      await earlier.stop();
      h.git(['add', '-A']); h.git(['commit', '-q', '-m', 'earlier work', '--no-verify']);
      await sleep(300);

      // Today's conversation: its open turn has an edit in the ledger already
      // (another file), then ONE shell call edits FILE and commits it.
      await h.startSession('fix the shared module and commit');
      await h.agentWrites('tu-1', 'src/mine.py', numbered('mine', 3) + 'mine_new = 1\n');

      const msgFile = path.join(h.repo, '.git', 'COMMIT_EDITMSG');
      let trailerAtCommit = '';
      let postCommit: Promise<{ code: number | null; stderr: string }> | null = null;
      await h.agentRuns('tu-2', `python3 - <<'EOF'\nopen('${FILE}','a').write('fixed = 1\\n')\nEOF\ngit add ${FILE}; git commit -qm 'fix the shared module'`, async () => {
        fs.appendFileSync(path.join(h.repo, FILE), 'fixed = 1\n');
        h.git(['add', FILE]);
        fs.writeFileSync(msgFile, 'fix the shared module\n');
        const r = await gitHook(h.repo, 'git-prepare-commit-msg', [msgFile]);
        expect(r.code, r.stderr).toBe(0);
        trailerAtCommit = fs.readFileSync(msgFile, 'utf-8');
        h.git(['commit', '-q', '--no-verify', '-F', msgFile]);
        // git starts post-commit in the background: it reads every session's
        // state NOW, claim set, and saves after this call has returned.
        postCommit = gitHook(h.repo, 'git-post-commit');
      });
      const pc = await postCommit!;
      expect(pc.code, pc.stderr).toBe(0);

      expect(trailerAtCommit).toContain('Origin-Session: e2e-commit-c');
      expect(trailerAtCommit).not.toContain('sibling-e2e-');
      expect(h.hooksLog()).toContain('attributed by the commit command in flight');

      // The call has returned and post-commit has saved: the claim is ENDED and
      // stays ended, so a commit somebody makes by hand a minute later is not
      // this session's on that account — prepare-commit-msg treats an ended
      // claim as over, and post-commit only honours it at the commit's time.
      const state = JSON.parse(fs.readFileSync(path.join(h.repo, '.git', 'origin-session-e2e-commit-c.json'), 'utf-8'));
      expect(state.commitCommandInFlight?.endedAt).toBeTruthy();
      expect(sessionIsRunningCommitHere(state, h.repo)).toBe(false);
      expect(sessionIsRunningCommitHere(state, h.repo, undefined, Date.now(), Date.parse(state.commitCommandInFlight.endedAt) + 60_000)).toBe(false);
    } finally {
      await h.close();
    }
  }, T);
});
