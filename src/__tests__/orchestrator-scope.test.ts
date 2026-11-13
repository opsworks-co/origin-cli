// The runner's part in a scope: a split run launches `orchestrator split
// <scopeId> --background` instead of `issue start`, and the split runs a
// read-only agent here and posts what it printed (or why it couldn't).
import { describe, it, expect } from 'vitest';
import os from 'os';
import { launchArgv } from '../commands/orchestrator-launch.js';
import { parseAgentJson, runSplit, type SplitDeps, type SplitPacket } from '../commands/orchestrator-scope.js';

const packet: SplitPacket = { scopeId: 's1', runId: 'r1', repoId: 'repo', agent: 'claude', prompt: 'split it', schema: { type: 'object' } };

function deps(over: Partial<SplitDeps> = {}) {
  const posted: Array<{ ok: boolean; result?: unknown; error?: string }> = [];
  const ran: Array<{ exe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const d: SplitDeps = {
    getPacket: async () => packet,
    postResult: async (_id, data) => { posted.push(data); return {}; },
    run: async (exe, args, cwd, env) => { ran.push({ exe, args, cwd, env }); return { code: 0, stdout: JSON.stringify({ structured_output: { tasks: [{ title: 'a' }] } }) }; },
    findExe: (n) => `/bin/${n}`,
    env: { PATH: '/bin' },
    tmpDir: () => os.tmpdir(),
    log: () => {},
    ...over,
  };
  return { d, posted, ran };
}

describe('orchestrator split', () => {
  it('a split run launches `orchestrator split <id> --background`, not issue start', () => {
    expect(launchArgv({ id: 'r1', repoFullName: 'acme/app', shortId: 'ori-e', agent: 'claude', scopeId: 's1' }, ['/node', '/origin'])).toEqual(
      ['/node', ['/origin', 'orchestrator', 'split', 's1', '--background']],
    );
  });

  it('runs claude read-only (plan mode, structured output) in the checkout and posts its answer', async () => {
    const { d, posted, ran } = deps();
    expect(await runSplit('s1', '/repo', d)).toEqual({ ok: true });
    expect(ran[0].exe).toBe('/bin/claude');
    expect(ran[0].cwd).toBe('/repo');
    expect(ran[0].args).toEqual(expect.arrayContaining(['-p', 'split it', '--permission-mode', 'plan', '--json-schema']));
    expect(ran[0].env.ORIGIN_HEADLESS_RUN).toBe('1');
    expect(posted).toEqual([{ ok: true, result: { structured_output: { tasks: [{ title: 'a' }] } } }]);
  });

  it('posts the error when the agent is missing, prints no JSON, or cannot split', async () => {
    const missing = deps({ findExe: () => null });
    expect((await runSplit('s1', '/repo', missing.d)).ok).toBe(false);
    expect(missing.posted[0].error).toContain('not installed');

    const prose = deps({ run: async () => ({ code: 0, stdout: 'I could not decide.' }) });
    await runSplit('s1', '/repo', prose.d);
    expect(prose.posted[0]).toMatchObject({ ok: false, error: expect.stringContaining('no JSON') });

    const agy = deps({ getPacket: async () => ({ ...packet, agent: 'antigravity' }) });
    await runSplit('s1', '/repo', agy.d);
    expect(agy.posted[0].error).toContain('cannot split');
  });

  it('a packet it cannot read posts nothing', async () => {
    const { d, posted } = deps({ getPacket: async () => { throw new Error('403'); } });
    expect(await runSplit('s1', '/repo', d)).toMatchObject({ ok: false });
    expect(posted).toEqual([]);
  });

  it('parseAgentJson reads JSON whole, fenced, or in prose', () => {
    expect(parseAgentJson('{"tasks":[]}')).toEqual({ tasks: [] });
    expect(parseAgentJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseAgentJson('so {"a":2} ok')).toEqual({ a: 2 });
    expect(parseAgentJson('none')).toBeNull();
  });
});
