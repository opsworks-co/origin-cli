// END-TO-END, through the built binary: an agent whose session is homed in
// worktree A commits in worktree B of the same repository, and both commit
// hooks give it the commit (process-owner.ts, siblingTreeOwner).
//
// The tree narrowing drops a session homed in another worktree before
// prepare-commit-msg's process-ancestry check ran, so `cd ../b && git commit`
// went out with no trailer even though the agent's own process made it. Now
// the check falls back to every live session of the git common dir.
// post-commit runs in the background and keeps the session through the trailer
// prepare-commit-msg just wrote (keepSessionTheTrailerNames). A commit made in
// B from outside the agent matches no owner and stays unattributed.
//
// The "agent" is a real long-lived process that runs its hooks and shell
// commands through `sh -c`, the way Claude Code does — see
// capture-e2e-commit-owner-by-process-tree.test.ts.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BIN, createHarness, haveDist, numbered } from './helpers/stop-next-prompt-harness.js';
import { platformStat } from '../process-owner.js';

const T = 120_000;
const CONV = 'e2e-own-sibling-wt-conv-0001';
const SRV = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';

// One JSON command per line, run with `sh -c` as the agent's own child.
const AGENT_SRC = `
const { spawn } = require('child_process');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const c = spawn('/bin/sh', ['-c', m.cmd], { cwd: m.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.stdin.end(m.input || '');
  c.on('close', (code) => process.stdout.write(JSON.stringify({ id: m.id, code, out, err }) + '\\n'));
});`;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const noteOf = (cwd: string, sha: string): string => {
  try { return git(cwd, ['notes', '--ref=origin', 'show', sha]); } catch { return ''; }
};

function startAgent(home: string, transcript: string) {
  const child: ChildProcess = spawn(process.execPath, ['-e', AGENT_SRC], {
    cwd: home, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map<number, (r: any) => void>();
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const r = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(r.id)?.(r);
      waiting.delete(r.id);
    }
  });
  let next = 0;
  const sh = (cmd: string, input = ''): Promise<{ code: number; out: string; err: string }> => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin!.write(JSON.stringify({ id, cmd, cwd: home, input }) + '\n');
  });
  const hook = (event: string, payload: Record<string, unknown> = {}) => sh(
    `${q(process.execPath)} ${q(BIN)} hooks claude-code ${event}`,
    JSON.stringify({ session_id: CONV, transcript_path: transcript, cwd: home, hook_event_name: event, ...payload }),
  );
  return { pid: child.pid!, sh, hook, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

/** post-commit, the way git's background hook runs it: outside the agent's tree. */
function postCommit(cwd: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, 'hooks', 'git-post-commit'], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => { /* ignore */ });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

describe.skipIf(!haveDist || !platformStat())('an agent homed in worktree A commits in sibling worktree B', () => {
  it('the trailer and post-commit both name A\'s session; a commit from outside the agent in B stays unattributed', async () => {
    const h = await createHarness(CONV, SRV);
    let agent: ReturnType<typeof startAgent> | null = null;
    try {
      const hooksDir = path.join(h.repo, '..', 'git-hooks');
      fs.mkdirSync(hooksDir);
      fs.writeFileSync(path.join(hooksDir, 'prepare-commit-msg'),
        `#!/bin/sh\n${q(process.execPath)} ${q(BIN)} hooks git-prepare-commit-msg "$1" "$2" "$3" || true\n`, { mode: 0o755 });
      h.git(['config', 'core.hooksPath', hooksDir]);
      fs.writeFileSync(path.join(h.repo, 'README.md'), '# repo\n');
      h.git(['add', '-A']);
      h.git(['commit', '-q', '-m', 'base', '--no-verify']);
      const wtA = path.join(h.repo, '..', 'wt-a');
      const wtB = path.join(h.repo, '..', 'wt-b');
      h.git(['worktree', 'add', '-q', '-b', 'feature-a', wtA]);
      h.git(['worktree', 'add', '-q', '-b', 'release-b', wtB]);
      const A = fs.realpathSync(wtA);
      const B = fs.realpathSync(wtB);

      const transcript = path.join(h.repo, '..', `${CONV}.jsonl`);
      fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'cut the release from the release worktree' }] } }) + '\n');
      agent = startAgent(A, transcript);
      let r = await agent.hook('session-start', { source: 'startup' });
      expect(r.code, r.err).toBe(0);
      r = await agent.hook('user-prompt-submit', { prompt: 'cut the release from the release worktree' });
      expect(r.code, r.err).toBe(0);

      const state = JSON.parse(fs.readFileSync(path.join(h.repo, '.git', `origin-session-${CONV.slice(0, 12)}.json`), 'utf-8'));
      expect(state.ownerProcess?.pid).toBe(agent.pid);
      expect(fs.realpathSync(state.repoPath)).toBe(A);

      // The agent commits in B from a script: no hook sees the command, no claim.
      const c = await agent.sh(`cd ${q(B)} && printf '${numbered('release', 2).replace(/\n/g, '\\n')}' > release.txt && git add -A && git commit -q -m 'release from the sibling worktree'`);
      expect(c.code, c.err).toBe(0);
      const sha = git(B, ['rev-parse', 'HEAD']);
      const msg = git(B, ['log', '-1', '--format=%B', sha]);
      expect(msg).toContain(`Origin-Session: ${SRV.slice(0, 12)}`);
      expect(h.hooksLog()).toMatch(/\[prepare-commit-msg\][^\n]*attributed by process ancestry[^\n]*from a sibling worktree/);

      const pc = await postCommit(B);
      expect(pc.code, pc.stderr).toBe(0);
      expect(h.hooksLog()).toMatch(/kept the session the commit trailer names — its home is another worktree of this repo/);
      const carriers = h.hits.filter((x) => x.method === 'PATCH' && x.url.startsWith(`/api/mcp/session/${SRV}`)
        && (x.body?.gitCapture?.commitShas || []).includes(sha));
      expect(carriers.length, 'no session update named the commit').toBeGreaterThan(0);
      expect(noteOf(B, sha)).toContain(SRV);

      // A commit in B from outside the agent: its owner is not an ancestor.
      const before = (h.hooksLog().match(/from a sibling worktree/g) || []).length;
      fs.writeFileSync(path.join(B, 'release.txt'), 'by hand\n');
      git(B, ['add', '-A']);
      git(B, ['commit', '-q', '-m', 'by hand']);
      const hand = git(B, ['rev-parse', 'HEAD']);
      expect(git(B, ['log', '-1', '--format=%B', hand])).not.toContain('Origin-Session:');
      expect((h.hooksLog().match(/from a sibling worktree/g) || []).length).toBe(before);
      const pc2 = await postCommit(B);
      expect(pc2.code, pc2.stderr).toBe(0);
      const handCarriers = h.hits.filter((x) => x.method === 'PATCH' && x.url.startsWith(`/api/mcp/session/${SRV}`)
        && JSON.stringify(x.body?.gitCapture || {}).includes(hand));
      expect(handCarriers).toEqual([]);
      expect(noteOf(B, hand)).not.toContain(SRV);
    } finally {
      agent?.kill();
      await h.close();
    }
  }, T);
});
