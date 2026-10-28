// A background run must not hang forever: a `cursor-agent -p` whose backend
// answered nothing sat Running at 0% CPU until it was killed by hand
// (2026-10-12). The supervisor gives each run a wall-clock limit and stops
// the agent's whole process group — the agent and every tool it started.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describeLimit, superviseRun } from '../background-supervisor.js';

// The fake agent is a node script run by this node — native Windows has no
// /bin/sh. `dir` reaches it as process.argv[2].
function setup(script: string, timeoutMin = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-supervise-'));
  const agent = path.join(dir, 'agent.cjs');
  fs.writeFileSync(agent, script);
  const record = path.join(dir, 'run.json');
  const log = path.join(dir, 'run.log');
  fs.writeFileSync(record, JSON.stringify({ argv: [process.execPath, agent, dir], worktree: dir, log, timeoutMin }));
  return { dir, record, log };
}

/** A tool the agent leaves running: its child (in its process group on POSIX, its process tree on Windows). */
const TOOL = "const tool = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });\n";
const HANG = 'setTimeout(() => {}, 300000);\n';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('superviseRun', () => {
  it('logs the agent\'s output and how it exited, then ends the session', async () => {
    const t = setup("console.log('working');\nconsole.error('oops');\nprocess.exit(3);\n", 120);
    const ended: string[] = [];
    const code = await superviseRun(t.record, { onEnded: async (r) => { ended.push(r); } });
    expect(code).toBe(3);
    expect(fs.readFileSync(t.log, 'utf-8')).toBe('working\noops\n[origin] agent exited with code 3\n');
    expect(ended).toEqual([t.record]);
    expect(JSON.parse(fs.readFileSync(t.record, 'utf-8')).agentPid).toBeGreaterThan(0);
  });

  it('stops a hung agent at its limit — tools it started included — and says so', async () => {
    const t = setup(`${TOOL}require('fs').writeFileSync(require('path').join(process.argv[2], 'tool.pid'), String(tool.pid));\nconsole.log('working');\n${HANG}`);
    const ended: string[] = [];
    const started = Date.now();
    // 1 s: room for node to start the agent and its tool (slower on Windows runners) inside the limit.
    const code = await superviseRun(t.record, { timeoutMs: 1000, graceMs: 2000, onEnded: async (r) => { ended.push(r); } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(code).toBe(124);
    const log = fs.readFileSync(t.log, 'utf-8');
    expect(log).toContain('working\n');
    expect(log).toMatch(/\[origin\] agent timed out after 1s\n\[origin\] agent exited with code 124\n$/);
    const tool = Number(fs.readFileSync(path.join(t.dir, 'tool.pid'), 'utf-8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(tool)).toBe(false);
    expect(ended).toEqual([t.record]); // the session still ends
  });

  it('KILLs an agent that ignores TERM after the grace period', async () => {
    const t = setup(`process.on('SIGTERM', () => {});\n${TOOL}${HANG}`);
    const code = await superviseRun(t.record, { timeoutMs: 300, graceMs: 300 });
    expect(code).toBe(124);
    expect(fs.readFileSync(t.log, 'utf-8')).toContain('[origin] agent timed out');
  });

  it('a missing binary is a failed run, not a hang', async () => {
    const t = setup('');
    const rec = JSON.parse(fs.readFileSync(t.record, 'utf-8'));
    fs.writeFileSync(t.record, JSON.stringify({ ...rec, argv: [path.join(t.dir, 'nope')] }));
    const ended: string[] = [];
    expect(await superviseRun(t.record, { onEnded: async (r) => { ended.push(r); } })).toBe(127);
    expect(fs.readFileSync(t.log, 'utf-8')).toMatch(/could not start .*\n\[origin\] agent exited with code 127\n$/);
    expect(ended).toHaveLength(1);
  });

  it('no limit when the record says 0', async () => {
    const t = setup("setTimeout(() => console.log('done'), 1000);\n", 0);
    expect(await superviseRun(t.record)).toBe(0);
    expect(fs.readFileSync(t.log, 'utf-8')).not.toContain('timed out');
  });

  it('describes limits in minutes', () => {
    expect(describeLimit(120 * 60_000)).toBe('120 min');
    expect(describeLimit(1500)).toBe('2s');
  });
});
