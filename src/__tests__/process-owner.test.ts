// Commit → session by the process tree (process-owner.ts).
//
// Two agents in one checkout both look like the committer to every file and
// timing rule. The agent whose process is an ancestor of prepare-commit-msg is
// the one that ran `git commit`. These pin the matcher: a recycled pid, a
// reboot or another host never matches; the nearest owner wins; nothing
// matching means nothing is decided here.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import {
  ownerDepth, parseProcStat, parsePsLine, pickSessionsByAncestry, pickSessionsByCommitAncestry,
  platformStat, resolveOwnerFrom, walkAncestry, bootId,
  type Ancestry, type ProcStat, type ProcessIdentity, type WalkEnv,
} from '../process-owner.js';

// A fake process table: pid → stat.
function table(rows: Record<number, ProcStat>): WalkEnv['stat'] {
  return (pid) => rows[pid] ?? null;
}

const HOST = 'devbox';
const BOOT = 'boot-1';

// launchd(1) → Terminal(100) → zsh(110) → claude A(120) → zsh(130) → git(140) → sh(150) → [hook]
//                            → zsh(210) → claude B(220)
//                            → zsh(310) → git(340) → sh(350) → [hook, a person's commit]
const TREE: Record<number, ProcStat> = {
  100: { ppid: 1, name: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', start: 't100' },
  110: { ppid: 100, name: '-zsh', start: 't110' },
  120: { ppid: 110, name: 'claude', start: 't120' },
  130: { ppid: 120, name: '/bin/zsh', start: 't130' },
  140: { ppid: 130, name: 'git', start: 't140' },
  150: { ppid: 140, name: '/bin/sh', start: 't150' },
  210: { ppid: 100, name: '-zsh', start: 't210' },
  220: { ppid: 210, name: 'claude', start: 't220' },
  230: { ppid: 220, name: 'sh', start: 't230' },
  310: { ppid: 100, name: '-zsh', start: 't310' },
  340: { ppid: 310, name: 'git', start: 't340' },
  350: { ppid: 340, name: 'sh', start: 't350' },
};
const env: WalkEnv = { stat: table(TREE), host: HOST, boot: BOOT };

const owner = (pid: number, start: string, extra: Partial<ProcessIdentity> = {}): ProcessIdentity =>
  ({ pid, start, host: HOST, boot: BOOT, ...extra });

const A = { sessionId: 'session-a', ownerProcess: owner(120, 't120') };
const B = { sessionId: 'session-b', ownerProcess: owner(220, 't220') };

describe('resolveOwnerFrom — the agent an agent hook runs under', () => {
  it('skips the hook shell and stops at the agent', () => {
    // claude B → sh(230) → [hook]
    expect(resolveOwnerFrom(230, env)).toMatchObject({ pid: 220, start: 't220', host: HOST, boot: BOOT, name: 'claude' });
  });

  it('never records a terminal as the owner — it is the parent of every tab', () => {
    // A hook run straight from a shell in Terminal: the walk passes the shell and lands on Terminal.
    expect(resolveOwnerFrom(110, env)).toBeNull();
  });

  it('gives up on an unreadable tree instead of guessing higher', () => {
    expect(resolveOwnerFrom(999, env)).toBeNull();
  });
});

describe('ownerDepth — guards', () => {
  const ancestry = walkAncestry(150, env);

  it('finds the owner among the commit hook\'s ancestors', () => {
    expect(ancestry.chain.map((c) => c.pid)).toEqual([150, 140, 130, 120, 110, 100]);
    expect(ownerDepth(ancestry, A.ownerProcess)).toBe(3);
  });

  it('a recycled pid (same number, different start) is not the owner', () => {
    expect(ownerDepth(ancestry, owner(120, 't-old-process'))).toBe(-1);
  });

  it('an owner recorded before a reboot never matches', () => {
    expect(ownerDepth(ancestry, owner(120, 't120', { boot: 'boot-0' }))).toBe(-1);
    // One side without a boot id while the other has one is not a match either.
    expect(ownerDepth(ancestry, owner(120, 't120', { boot: undefined }))).toBe(-1);
  });

  it('an owner recorded on another host never matches', () => {
    expect(ownerDepth(ancestry, owner(120, 't120', { host: 'other-box' }))).toBe(-1);
  });

  it('no owner, pid 1 or no start time is never a match', () => {
    expect(ownerDepth(ancestry, undefined)).toBe(-1);
    expect(ownerDepth(ancestry, owner(1, 't1'))).toBe(-1);
    expect(ownerDepth(ancestry, owner(120, ''))).toBe(-1);
  });
});

describe('pickSessionsByAncestry — two agents in one checkout', () => {
  it('the agent that ran `git commit` owns it, the other agent does not', () => {
    const pick = pickSessionsByAncestry([B, A], walkAncestry(150, env));
    expect(pick).toMatchObject({ outcome: 'owner', depth: 3 });
    expect(pick.outcome === 'owner' && pick.session.sessionId).toBe('session-a');
  });

  it('a person committing in another tab matches neither — today\'s rules decide', () => {
    expect(pickSessionsByAncestry([A, B], walkAncestry(350, env))).toEqual({ outcome: 'none' });
  });

  it('sessions without a recorded owner (Windows, IDE agents, old state) match nothing', () => {
    expect(pickSessionsByAncestry([{ sessionId: 'x' }, { sessionId: 'y', ownerProcess: null }], walkAncestry(150, env)))
      .toEqual({ outcome: 'none' });
  });

  it('one agent process hosting two sessions narrows to both, it does not pick', () => {
    const A2 = { sessionId: 'session-a2', ownerProcess: owner(120, 't120') };
    const pick = pickSessionsByAncestry([A, B, A2], walkAncestry(150, env));
    expect(pick.outcome).toBe('shared');
    expect(pick.outcome === 'shared' && pick.sessions.map((s) => s.sessionId)).toEqual(['session-a', 'session-a2']);
  });

  it('a nested agent beats the agent that launched it — the nearest owner made the commit', () => {
    // claude A(120) → zsh(130) → codex(135) → zsh(136) → git(137) → sh(138)
    const nested: WalkEnv = {
      ...env,
      stat: table({
        ...TREE,
        135: { ppid: 130, name: 'codex', start: 't135' },
        136: { ppid: 135, name: 'zsh', start: 't136' },
        137: { ppid: 136, name: 'git', start: 't137' },
        138: { ppid: 137, name: 'sh', start: 't138' },
      }),
    };
    const C = { sessionId: 'session-codex', ownerProcess: owner(135, 't135') };
    const pick = pickSessionsByAncestry([A, C], walkAncestry(138, nested));
    expect(pick.outcome === 'owner' && pick.session.sessionId).toBe('session-codex');
  });
});

describe('pickSessionsByCommitAncestry — bounded and fail-quiet', () => {
  it('stops walking at the nearest owner', () => {
    const seen: number[] = [];
    const counting: WalkEnv = { ...env, stat: (pid) => { seen.push(pid); return TREE[pid] ?? null; } };
    const pick = pickSessionsByCommitAncestry([A, B], counting, 150);
    expect(pick.outcome).toBe('owner');
    expect(seen).toEqual([150, 140, 130, 120]);
  });

  it('does not walk at all when no session recorded an owner', () => {
    let calls = 0;
    const counting: WalkEnv = { ...env, stat: (pid) => { calls++; return TREE[pid] ?? null; } };
    const unowned: { sessionId: string; ownerProcess?: ProcessIdentity } = { sessionId: 'x' };
    expect(pickSessionsByCommitAncestry([unowned], counting, 150)).toEqual({ outcome: 'none' });
    expect(calls).toBe(0);
  });

  it('no platform reader (Windows) and a throwing reader both answer none', () => {
    expect(pickSessionsByCommitAncestry([A], null, 150)).toEqual({ outcome: 'none' });
    const throwing: WalkEnv = { ...env, stat: () => { throw new Error('ps blocked'); } };
    expect(pickSessionsByCommitAncestry([A], throwing, 150)).toEqual({ outcome: 'none' });
  });

  it('a parent loop or a slow table cannot hang the hook', () => {
    const loop: WalkEnv = { ...env, stat: (pid) => ({ ppid: pid === 10 ? 11 : 10, name: 'x', start: 's' }) };
    expect(walkAncestry(10, loop).chain.map((c) => c.pid)).toEqual([10, 11]);
    let t = 0;
    const slow: WalkEnv = { ...env, now: () => (t += 1_000), stat: (pid) => ({ ppid: pid + 1, name: 'x', start: 's' }) };
    expect(walkAncestry(2, slow).chain.length).toBeLessThanOrEqual(1);
  });
});

describe('platform readers', () => {
  it('parses /proc/<pid>/stat with a name holding spaces and parens', () => {
    const line = '4242 (my (weird) proc) S 4100 4242 4100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200';
    expect(parseProcStat(line)).toEqual({ ppid: 4100, name: 'my (weird) proc', start: '987654' });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('parses a `ps -o ppid=,lstart=,comm=` line, comm with spaces', () => {
    expect(parsePsLine('  1626 Mon Oct  6 10:09:07 2026     /Applications/Claude.app/Contents/MacOS/Claude Helper'))
      .toEqual({ ppid: 1626, start: 'Mon Oct 6 10:09:07 2026', name: '/Applications/Claude.app/Contents/MacOS/Claude Helper' });
    expect(parsePsLine('')).toBeNull();
  });
});

// The real process table, where there is one to read.
const stat = platformStat();
describe.skipIf(!stat)('on this machine', () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } } });

  it('a child finds this test process among its ancestors, and a sibling does not', async () => {
    const live: WalkEnv = { stat: stat!, host: 'h', boot: bootId() };
    const self = stat!(process.pid)!;
    const me: ProcessIdentity = { pid: process.pid, start: self.start, host: 'h', boot: bootId() };
    // A child of this process, and its own child: walk up from the grandchild.
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    kids.push(child);
    await new Promise((r) => setTimeout(r, 300));
    const ancestry: Ancestry = walkAncestry(child.pid!, live);
    expect(ancestry.chain[0].pid).toBe(child.pid);
    expect(ownerDepth(ancestry, me)).toBe(1);
    // Same pid, another start: a recycled pid.
    expect(ownerDepth(ancestry, { ...me, start: 'not-' + me.start })).toBe(-1);
  });
});
