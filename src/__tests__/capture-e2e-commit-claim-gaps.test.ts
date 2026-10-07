// End to end, through the built binary: the commit claim (see
// commit-command-in-flight.ts) in the three places it used to be missing.
//
//   1. A merge the agent concludes carries no trailer — prepare-commit-msg
//      returns before its picker for source=merge — and post-commit did not
//      read the claim, so a lone session whose ledger lacked the merged file
//      was refused the commit for "no evidence".
//   2. `git ci` (an alias), `/usr/bin/git commit`: the claim was never set.
//   3. A `git commit` that FAILED: Claude Code fires PostToolUseFailure, not
//      PostToolUse, and Origin did not listen — the claim stayed up for the
//      rest of the turn.
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BIN, commitFiles, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';
import { WINDOWS_SLOWDOWN } from './helpers/windows-e2e.js';

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

const stateOf = (repo: string, sessionId: string) =>
  JSON.parse(fs.readFileSync(path.join(repo, '.git', `origin-session-${sessionId.slice(0, 12)}.json`), 'utf-8'));

describe.skipIf(!haveDist)('the commit claim where it used to be missing', () => {
  it('a merge the agent concludes in one shell call is its commit, though no trailer names it', async () => {
    const SID = 'e2e-claim-merge-0001';
    const h = await createHarness(SID, 'e2e-claim-merge-srv-1');
    try {
      commitFiles(h, { [FILE]: numbered('base', 4) }, 'base');
      // Another conversation in this checkout, idle, whose finished turn
      // touched FILE — the one the file rules pick without the claim.
      const earlier = await h.sibling('e2e-earlier-merge-0002');
      await earlier.submit('rework the shared module');
      await earlier.agentWrites('s-1', FILE, numbered('base', 4) + 'earlier = 1\n');
      earlier.reply('Done.');
      await earlier.stop();
      h.git(['add', '-A']); h.git(['commit', '-q', '-m', 'earlier work', '--no-verify']);
      await sleep(300);
      h.git(['checkout', '-q', '-b', 'topic']);
      commitFiles(h, { [FILE]: numbered('topic', 4) }, 'topic side');
      h.git(['checkout', '-q', 'main']);
      commitFiles(h, { [FILE]: numbered('main', 4) }, 'main side');
      try { h.git(['merge', '-q', 'topic']); } catch { /* conflict — expected */ }
      expect(fs.existsSync(path.join(h.repo, '.git', 'MERGE_HEAD'))).toBe(true);

      await h.startSession('finish the merge');
      const msgFile = path.join(h.repo, '.git', 'COMMIT_EDITMSG');
      let postCommit: Promise<{ code: number | null; stderr: string }> | null = null;
      // Resolves AND commits in one call: nothing reaches the ledger first.
      await h.agentRuns('tu-1', `git checkout --theirs ${FILE} && git add ${FILE} && /usr/bin/git commit --no-edit`, async () => {
        h.git(['checkout', '--theirs', FILE]);
        h.git(['add', FILE]);
        fs.writeFileSync(msgFile, "Merge branch 'topic'\n");
        const r = await gitHook(h.repo, 'git-prepare-commit-msg', [msgFile, 'merge']);
        expect(r.code, r.stderr).toBe(0);
        expect(fs.readFileSync(msgFile, 'utf-8')).not.toContain('Origin-Session:');
        h.git(['commit', '-q', '--no-verify', '-F', msgFile]);
        postCommit = gitHook(h.repo, 'git-post-commit');
      });
      const pc = await postCommit!;
      expect(pc.code, pc.stderr).toBe(0);

      const sha = h.git(['rev-parse', 'HEAD']);
      expect(h.git(['rev-list', '--parents', '-n1', 'HEAD']).split(' ')).toHaveLength(3);
      expect(h.hooksLog()).toMatch(/\[post-commit\][^\n]*attributed by the commit command in flight/);
      expect(stateOf(h.repo, SID).sessionCommitShas || []).toContain(sha);
      expect(stateOf(h.repo, 'e2e-earlier-merge-0002').sessionCommitShas || []).not.toContain(sha);
    } finally {
      await h.close();
    }
  }, T);

  it('a git alias for commit sets the claim; a failed commit call ends it', async () => {
    const SID = 'e2e-claim-alias-0001';
    const h = await createHarness(SID, 'e2e-claim-alias-srv-1');
    try {
      commitFiles(h, { [FILE]: numbered('base', 4) }, 'base');
      h.git(['config', 'alias.ci', 'commit -v']);
      await h.startSession('commit it');

      const input = { command: 'git ci -m "wip"' };
      let r = await h.run('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-alias' });
      expect(r.code, r.stderr).toBe(0);
      expect(stateOf(h.repo, SID).commitCommandInFlight?.toolCallId).toBe('tu-alias');

      // The call failed (say, nothing staged). Claude reports it on its own event.
      r = await h.run('post-tool-use-failure', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-alias', error: 'Exit code 1' });
      expect(r.code, r.stderr).toBe(0);
      await sleep(100);
      expect(stateOf(h.repo, SID).commitCommandInFlight?.endedAt).toBeTruthy();

      // Not somebody else's call: a failure of a DIFFERENT tool call leaves it.
      await h.run('pre-tool-use', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tu-alias-2' });
      await h.run('post-tool-use-failure', { tool_name: 'Read', tool_input: {}, tool_use_id: 'tu-other', error: 'no such file' });
      expect(stateOf(h.repo, SID).commitCommandInFlight?.toolCallId).toBe('tu-alias-2');
      expect(stateOf(h.repo, SID).commitCommandInFlight?.endedAt).toBeUndefined();
    } finally {
      await h.close();
    }
  }, T);
});
