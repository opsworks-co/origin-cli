// The reviewer agent never outlives the `origin review run` / runner process
// that started it. A runner restarted mid-run (`launchctl kickstart -k`) used
// to leave `claude -p` — which ignored the SIGTERM — reviewing for a dead
// parent. Real processes: an "agent" that ignores SIGTERM and starts a
// grandchild that ignores it too.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { killTree } from '../background-supervisor.js';
import { runAgentProcess, type AgentProcessDeps } from '../commands/review-run.js';

const posix = process.platform !== 'win32';
const started: number[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** An agent that ignores SIGTERM, starts a grandchild that does too, writes both pids, then lives `lifeMs`. */
function stubbornAgent(dir: string, lifeMs: number): { script: string; pids: string } {
  const pids = path.join(dir, 'pids.json');
  const script = path.join(dir, 'agent.js');
  fs.writeFileSync(script, `
const { spawn } = require('child_process');
process.on('SIGTERM', () => {});
const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ agent: process.pid, grandchild: g.pid }));
setTimeout(() => process.exit(0), ${lifeMs});
`);
  return { script, pids };
}

function fakeDeps(over: Partial<AgentProcessDeps> = {}) {
  let stop: ((s: NodeJS.Signals) => void) | null = null;
  let unsubscribed = 0;
  const exits: number[] = [];
  const deps: AgentProcessDeps = {
    platform: process.platform,
    onStopSignal: (onStop) => { stop = onStop; return () => { unsubscribed++; stop = null; }; },
    killTree,
    killGroup: (pgid) => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } },
    exit: (code) => { exits.push(code); },
    graceMs: 400,
    ...over,
  };
  return { deps, exits, signal: (s: NodeJS.Signals) => stop?.(s), get unsubscribed() { return unsubscribed; }, get listening() { return stop !== null; } };
}

afterEach(() => {
  for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

describe.skipIf(!posix)('runAgentProcess', () => {
  it('a stop signal to the runner stops the agent and what it started, SIGKILL after the grace, then exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agent-proc-'));
    const { script, pids } = stubbornAgent(dir, 60_000);
    const f = fakeDeps();
    const run = runAgentProcess(process.execPath, [script], dir, process.env, false, f.deps);
    expect(await until(() => fs.existsSync(pids))).toBe(true);
    const { agent, grandchild } = JSON.parse(fs.readFileSync(pids, 'utf-8')) as { agent: number; grandchild: number };
    started.push(agent, grandchild);
    expect(alive(agent) && alive(grandchild)).toBe(true);

    f.signal('SIGTERM');
    // SIGTERM is ignored by both; the grace runs out and the group is SIGKILLed.
    expect(await until(() => !alive(agent) && !alive(grandchild))).toBe(true);
    await run;
    expect(await until(() => f.exits.length > 0)).toBe(true);
    expect(f.exits).toEqual([143]);
  });

  it('an agent that finishes on its own takes its leftover children with it, and stops listening', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agent-proc-'));
    const { script, pids } = stubbornAgent(dir, 300);
    const f = fakeDeps();
    expect(f.listening).toBe(false);
    const run = runAgentProcess(process.execPath, [script], dir, process.env, false, f.deps);
    expect(f.listening).toBe(true);
    const res = await run;
    expect(res.code).toBe(0);
    const { grandchild } = JSON.parse(fs.readFileSync(pids, 'utf-8')) as { grandchild: number };
    started.push(grandchild);
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(f.unsubscribed).toBe(1);
    expect(f.exits).toEqual([]);
  });

  it('captures stdout and passes on the exit code', async () => {
    const f = fakeDeps();
    const res = await runAgentProcess(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'], os.tmpdir(), process.env, true, f.deps);
    expect(res).toEqual({ code: 3, stdout: 'hi' });
  });
});
