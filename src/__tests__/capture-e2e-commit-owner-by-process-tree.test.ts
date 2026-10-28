// END-TO-END, through the built binary: two agents in ONE checkout, and the
// one whose process ran `git commit` gets the commit (process-owner.ts).
//
// Both sessions have a turn open and both have written the committed file, so
// every rule prepare-commit-msg had — in-flight edits, staged-file overlap,
// open turn, lastCwd, recency — ties, and the commit went out with no
// trailer. Neither sent a commit claim either: the commit comes from a script
// (`make release`-style), not a command the pre-tool-use hook recognises.
//
// Each "agent" here is a real long-lived process that runs its hooks and its
// shell commands through `sh -c`, the way Claude Code does. git runs
// prepare-commit-msg as its child, so the committing agent is an ancestor of
// the hook. A commit made from outside both agents (a person's terminal)
// matches neither and is decided exactly as before.
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BIN, createHarness, haveDist, numbered, sleep } from './helpers/stop-next-prompt-harness.js';
import { platformStat } from '../process-owner.js';

const T = 120_000;
const FILE = 'src/shared.py';
const CONV_A = 'e2e-own-a-tree-conv-0001';
const CONV_B = 'e2e-own-b-tree-conv-0002';
const SRV_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SRV_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// A stand-in agent: reads one JSON command per line, runs it with `sh -c` as
// its own child, answers with the exit code. CommonJS on purpose (`node -e`).
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

interface Agent {
  pid: number;
  sh: (cmd: string, input?: string) => Promise<{ code: number; out: string; err: string }>;
  hook: (event: string, payload?: Record<string, unknown>) => Promise<{ code: number; out: string; err: string }>;
  kill: () => void;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function startAgent(repo: string, conv: string, transcript: string): Agent {
  const child: ChildProcess = spawn(process.execPath, ['-e', AGENT_SRC], {
    cwd: repo, env: { ...process.env, ORIGIN_LIVE_CAPTURE: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
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
  const sh = (cmd: string, input = '') => new Promise<any>((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin!.write(JSON.stringify({ id, cmd, cwd: repo, input }) + '\n');
  });
  const hook = (event: string, payload: Record<string, unknown> = {}) => sh(
    `${q(process.execPath)} ${q(BIN)} hooks claude-code ${event}`,
    JSON.stringify({ session_id: conv, transcript_path: transcript, cwd: repo, hook_event_name: event, ...payload }),
  );
  return { pid: child.pid!, sh, hook, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

describe.skipIf(!haveDist || !platformStat())('two agents in one checkout: the commit goes to the one whose process made it', () => {
  it('agent B\'s commit is stamped B; a commit from outside both is not decided by the tree', async () => {
    const h = await createHarness(CONV_A, SRV_A, {
      respond: (method, url, body) => (method === 'POST' && url.startsWith('/api/mcp/session/start')
        ? { sessionId: JSON.stringify(body).includes(CONV_B) ? SRV_B : SRV_A, verboseCapture: false }
        : undefined),
    });
    const agents: Agent[] = [];
    try {
      // Origin's prepare-commit-msg, the way `origin enable` installs it: a
      // shell script git runs, which runs the CLI.
      const hooksDir = path.join(h.repo, '..', 'git-hooks');
      fs.mkdirSync(hooksDir);
      fs.writeFileSync(path.join(hooksDir, 'prepare-commit-msg'),
        `#!/bin/sh\n${q(process.execPath)} ${q(BIN)} hooks git-prepare-commit-msg "$1" "$2" "$3" || true\n`, { mode: 0o755 });
      h.git(['config', 'core.hooksPath', hooksDir]);
      fs.mkdirSync(path.join(h.repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(h.repo, FILE), numbered('base', 4));
      h.git(['add', '-A']);
      h.git(['commit', '-q', '-m', 'base', '--no-verify']);

      const transcripts: Record<string, string> = {};
      for (const conv of [CONV_A, CONV_B]) {
        transcripts[conv] = path.join(h.repo, '..', `${conv}.jsonl`);
        fs.writeFileSync(transcripts[conv], JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'rework the shared module' }] } }) + '\n');
      }
      const a = startAgent(h.repo, CONV_A, transcripts[CONV_A]);
      const b = startAgent(h.repo, CONV_B, transcripts[CONV_B]);
      agents.push(a, b);

      // Both sessions start, both open a turn, both write the same file.
      for (const [agent, tag] of [[a, 'a'], [b, 'b']] as const) {
        let r = await agent.hook('session-start', { source: 'startup' });
        expect(r.code, r.err).toBe(0);
        r = await agent.hook('user-prompt-submit', { prompt: 'rework the shared module' });
        expect(r.code, r.err).toBe(0);
        const abs = path.join(h.repo, FILE);
        const input = { file_path: abs, content: numbered(tag, 4) };
        await agent.hook('pre-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: `w-${tag}` });
        fs.writeFileSync(abs, numbered(tag, 4));
        await agent.hook('post-tool-use', { tool_name: 'Write', tool_input: input, tool_use_id: `w-${tag}`, tool_response: { filePath: abs, success: true } });
      }

      const state = (conv: string) => JSON.parse(fs.readFileSync(path.join(h.repo, '.git', `origin-session-${conv.slice(0, 12)}.json`), 'utf-8'));
      // Each session recorded its own agent, not the hook's shell.
      expect(state(CONV_A).ownerProcess?.pid).toBe(a.pid);
      expect(state(CONV_B).ownerProcess?.pid).toBe(b.pid);
      expect(state(CONV_A).ownerProcess?.start).toBeTruthy();

      // B commits from a script — no `git commit` in the tool command, so no claim.
      const c = await b.sh(`git add -A && git commit -q -m 'release from a script'`);
      expect(c.code, c.err).toBe(0);
      const msg = h.git(['log', '-1', '--format=%B']);
      expect(msg).toContain(`Origin-Session: ${SRV_B.slice(0, 12)}`);
      expect(msg).not.toContain(SRV_A.slice(0, 12));
      expect(h.hooksLog()).toMatch(/\[prepare-commit-msg\][^\n]*attributed by process ancestry/);

      // A commit made outside both agents: neither owner is its ancestor, so
      // the process tree says nothing and today's rules run unchanged.
      const before = (h.hooksLog().match(/attributed by process ancestry/g) || []).length;
      fs.writeFileSync(path.join(h.repo, FILE), numbered('person', 4));
      h.git(['add', '-A']);
      h.git(['commit', '-q', '-m', 'by hand']);
      await sleep(100);
      expect((h.hooksLog().match(/attributed by process ancestry/g) || []).length).toBe(before);
    } finally {
      for (const ag of agents) ag.kill();
      await h.close();
    }
  }, T);
});
