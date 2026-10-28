// `origin issue run-epic <KEY>`: the epic's stories claimed one at a time from
// the task queue and each started as `origin issue start` would; the claim
// finished when the agent exits cleanly, released and the loop stopped when it
// does not; --max; and the run-epic link the web opens.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { issueRunEpicCommand, prUrlOfPublish, RUN_EPIC_LEASE_S, type IssueRunEpicDeps } from '../commands/issue-run-epic.js';
import { issueRunEpicCommandLine, issueRunEpicUrl, parseIssueLaunchUrl, parseIssueRunEpicUrl } from '../issue-prompt.js';
import { runEpicCommandLine, runEpicLaunchScript } from '../url-handler.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); process.exitCode = undefined; });

/** A git repo to run in: the command only needs a toplevel. */
function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-run-epic-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q', d]);
  return d;
}

interface Story { shortId: string; title: string; status: string; claimToken?: string | null }

/**
 * A stand-in for the API's queue: open stories under EP-1, handed out by
 * priority (array order); a claim-next marks one in-progress, finish closes
 * it, release opens it again. A blocked story is never handed out.
 */
function fakeApi(stories: Story[]) {
  const calls: string[] = [];
  let tokens = 0;
  const api: NonNullable<IssueRunEpicDeps['api']> = {
    previewRoute: async () => ({ repo: { id: 'r1' } }),
    getIssue: async (_r, id) => (id === 'EP-1' ? { id: 'epic-id-1', shortId: 'EP-1', title: 'Checkout v2', type: 'epic' } : (() => { throw Object.assign(new Error('not found'), { status: 404 }); })()),
    claimNextIssue: async (_r, data) => {
      calls.push(`claim-next parent=${data.parentId} agent=${data.agent} lease=${data.leaseSeconds}`);
      const s = stories.find((x) => x.status === 'open');
      if (!s) return { task: null };
      s.status = 'in-progress';
      s.claimToken = `tok-${++tokens}`;
      return { task: { shortId: s.shortId, title: s.title }, claimToken: s.claimToken, leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
    renewIssueClaim: async (_r, id, token) => { calls.push(`renew ${id} ${token}`); return { leaseExpiresAt: 'later' }; },
    releaseIssueClaim: async (_r, id, token) => {
      calls.push(`release ${id} ${token}`);
      const s = stories.find((x) => x.shortId === id);
      if (!s || s.claimToken !== token) throw Object.assign(new Error('lost'), { status: 409 });
      s.status = 'open'; s.claimToken = null;
      return { ok: true };
    },
    finishIssueClaim: async (_r, id, data) => {
      calls.push(`finish ${id} ${data.claimToken} pr=${data.prUrl ?? '-'}`);
      const s = stories.find((x) => x.shortId === id);
      if (!s || s.claimToken !== data.claimToken) throw Object.assign(new Error('lost'), { status: 409 });
      s.status = 'closed'; s.claimToken = null;
      return { outcome: 'closed' };
    },
  };
  return { api, calls };
}

/** `origin issue start` as the loop sees it: records the call, answers per story. */
const fakeStart = (starts: any[], outcome: (id: string) => { exitCode: number; published?: string | null } | null) => async (id: string, opts: any) => {
  starts.push({ id, ...opts });
  const o = outcome(id);
  if (!o) { process.exitCode = 1; return null; }
  if (o.exitCode !== 0) process.exitCode = o.exitCode;
  return { issue: { shortId: id }, branch: `issue/${id.toLowerCase()}-x`, prompt: 'p', agent: opts.agent, launched: ['claude'], promptFile: null, linkFile: null, worktree: null, published: o.published ?? null, exitCode: o.exitCode } as any;
};

let logs: string[];
let errs: string[];
beforeEach(() => { logs = []; errs = []; });
const deps = (over: Partial<IssueRunEpicDeps>): Partial<IssueRunEpicDeps> => ({
  cwd: repo(), log: (l) => logs.push(l), error: (l) => errs.push(l), connected: () => true, hostname: () => 'mac', renewEveryMs: 60_000, ...over,
});

describe('origin issue run-epic', () => {
  it('claims each open story under the epic in turn, starts the agent on it as Start does, finishes it from a clean exit, and stops when the blocked one is all that is left', async () => {
    const stories: Story[] = [
      { shortId: 'ST-1', title: 'Cart page', status: 'open' },
      { shortId: 'ST-2', title: 'Empty state', status: 'blocked' },
      { shortId: 'ST-3', title: 'Checkout button', status: 'open' },
    ];
    const { api, calls } = fakeApi(stories);
    const starts: any[] = [];
    const r = await issueRunEpicCommand('EP-1', { worktree: true }, deps({ api, start: fakeStart(starts, (id) => ({ exitCode: 0, published: id === 'ST-1' ? 'Opened pull request https://github.com/acme/app/pull/12' : 'Did not push: nothing to commit' })) }));

    expect(starts.map((s) => [s.id, s.agent, s.worktree, s.force])).toEqual([['ST-1', 'claude', true, undefined], ['ST-3', 'claude', true, undefined]]);
    expect(calls).toEqual([
      `claim-next parent=epic-id-1 agent=claude lease=${RUN_EPIC_LEASE_S}`,
      'finish ST-1 tok-1 pr=https://github.com/acme/app/pull/12',
      `claim-next parent=epic-id-1 agent=claude lease=${RUN_EPIC_LEASE_S}`,
      'finish ST-3 tok-2 pr=-',
      `claim-next parent=epic-id-1 agent=claude lease=${RUN_EPIC_LEASE_S}`,
    ]);
    expect(stories.map((s) => s.status)).toEqual(['closed', 'blocked', 'closed']);
    expect(r).toMatchObject({ epic: { shortId: 'EP-1', title: 'Checkout v2' }, stopped: 'none-left' });
    expect(r!.stories.map((s) => [s.shortId, s.outcome, s.prUrl])).toEqual([['ST-1', 'finished', 'https://github.com/acme/app/pull/12'], ['ST-3', 'finished', null]]);
    expect(logs.join('\n')).toContain('Worked through 2 stories of EP-1: ST-1, ST-3');
    expect(process.exitCode).toBe(0);
  });

  it('releases the story and stops when the agent fails, so a rerun takes it again; what was done before stays done', async () => {
    const stories: Story[] = [
      { shortId: 'ST-1', title: 'a', status: 'open' },
      { shortId: 'ST-2', title: 'b', status: 'open' },
      { shortId: 'ST-3', title: 'c', status: 'open' },
    ];
    const { api, calls } = fakeApi(stories);
    const starts: any[] = [];
    const r = await issueRunEpicCommand('EP-1', {}, deps({ api, start: fakeStart(starts, (id) => (id === 'ST-2' ? { exitCode: 1 } : { exitCode: 0 })) }));
    expect(starts.map((s) => s.id)).toEqual(['ST-1', 'ST-2']);
    expect(calls.filter((c) => !c.startsWith('claim-next'))).toEqual(['finish ST-1 tok-1 pr=-', 'release ST-2 tok-2']);
    expect(stories.map((s) => s.status)).toEqual(['closed', 'open', 'open']);
    expect(r!.stopped).toBe('failed');
    expect(r!.stories.map((s) => [s.shortId, s.outcome, s.exitCode])).toEqual([['ST-1', 'finished', 0], ['ST-2', 'released', 1]]);
    expect(errs.join('\n')).toContain('Stopped at ST-2: claude exited with code 1');
    expect(errs.join('\n')).toContain('back in the queue');
    expect(process.exitCode).toBe(1);
  });

  it('a start that is refused (someone is on the story, or no agent installed) releases it too', async () => {
    const stories: Story[] = [{ shortId: 'ST-1', title: 'a', status: 'open' }];
    const { api, calls } = fakeApi(stories);
    await issueRunEpicCommand('EP-1', {}, deps({ api, start: fakeStart([], () => null) }));
    expect(calls.at(-1)).toBe('release ST-1 tok-1');
    expect(stories[0].status).toBe('open');
    expect(process.exitCode).toBe(1);
  });

  it('--max stops after that many stories and says the rest wait', async () => {
    const stories: Story[] = ['ST-1', 'ST-2', 'ST-3'].map((shortId) => ({ shortId, title: shortId, status: 'open' }));
    const { api } = fakeApi(stories);
    const starts: any[] = [];
    const r = await issueRunEpicCommand('EP-1', { max: '2', agent: 'codex' }, deps({ api, start: fakeStart(starts, () => ({ exitCode: 0 })) }));
    expect(starts.map((s) => [s.id, s.agent])).toEqual([['ST-1', 'codex'], ['ST-2', 'codex']]);
    expect(stories.map((s) => s.status)).toEqual(['closed', 'closed', 'open']);
    expect(r!.stopped).toBe('max');
    expect(logs.join('\n')).toContain('Did 2 stories of EP-1 (--max 2): ST-1, ST-2. Run again for the rest.');
  });

  it('keeps the lease alive while the agent runs', async () => {
    const stories: Story[] = [{ shortId: 'ST-1', title: 'a', status: 'open' }];
    const { api, calls } = fakeApi(stories);
    const slow = async (id: string, opts: any) => {
      await new Promise((r) => setTimeout(r, 70));
      return (await fakeStart([], () => ({ exitCode: 0 }))(id, opts));
    };
    await issueRunEpicCommand('EP-1', {}, deps({ api, start: slow, renewEveryMs: 20 }));
    expect(calls.filter((c) => c.startsWith('renew ST-1 tok-1')).length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-2)).toBe('finish ST-1 tok-1 pr=-');
  });

  it('refuses a bad agent, a bad --max, an unknown epic, and a repo that is not on Origin', async () => {
    const { api } = fakeApi([]);
    expect(await issueRunEpicCommand('EP-1', { agent: 'print' }, deps({ api, start: fakeStart([], () => null) }))).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(await issueRunEpicCommand('EP-1', { max: '0' }, deps({ api, start: fakeStart([], () => null) }))).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(await issueRunEpicCommand('EP-9', {}, deps({ api, start: fakeStart([], () => null) }))).toBeNull();
    expect(errs.at(-1)).toContain('No issue on Origin matches "EP-9"');
    expect(await issueRunEpicCommand('EP-1', {}, deps({ api: { ...api, previewRoute: async () => ({ repo: null }) }, start: fakeStart([], () => null) }))).toBeNull();
    expect(errs.at(-1)).toContain('not on Origin yet');
    expect(await issueRunEpicCommand('EP-1', {}, deps({ api, connected: () => false, start: fakeStart([], () => null) }))).toBeNull();
    expect(errs.at(-1)).toContain('origin login');
  });

  it('reads the PR out of the publish line', () => {
    expect(prUrlOfPublish('Opened pull request https://github.com/acme/app/pull/12')).toBe('https://github.com/acme/app/pull/12');
    expect(prUrlOfPublish('Pushed to pull request https://gitlab.com/acme/app/-/merge_requests/3')).toBe('https://gitlab.com/acme/app/-/merge_requests/3');
    expect(prUrlOfPublish('Pushed issue/x to origin')).toBeNull();
    expect(prUrlOfPublish('Did not push: see https://example.com')).toBeNull();
    expect(prUrlOfPublish(null)).toBeNull();
  });
});

describe('the run-epic link', () => {
  it('round-trips, defaults the agent to claude, and is not a start link (an older CLI refuses it instead of starting the whole epic)', () => {
    const url = issueRunEpicUrl('repo_1', 'EP-1', 'acme/app');
    expect(url).toBe('getorigin://issue/run-epic?repo=repo_1&issue=EP-1&name=acme%2Fapp');
    expect(parseIssueRunEpicUrl(url)).toEqual({ repoId: 'repo_1', shortId: 'EP-1', agent: 'claude', repoName: 'acme/app', max: null });
    expect(parseIssueRunEpicUrl(issueRunEpicUrl('r', 'EP-1', null, { agent: 'codex', max: 3 }))).toEqual({ repoId: 'r', shortId: 'EP-1', agent: 'codex', repoName: null, max: 3 });
    expect(parseIssueLaunchUrl(url)).toBeNull();
    expect(parseIssueRunEpicUrl('getorigin://issue/run-epic?repo=r&issue=EP-1&agent=print')).toBeNull();
    expect(parseIssueRunEpicUrl('getorigin://issue/run-epic?repo=r&issue=EP-1&max=lots')).toBeNull();
    expect(parseIssueRunEpicUrl('getorigin://issue/run-epic?repo=r;x&issue=EP-1')).toBeNull();
    expect(parseIssueRunEpicUrl('getorigin://issue/start?repo=r&issue=EP-1&agent=claude')).toBeNull();
    expect(issueRunEpicCommandLine('EP-1')).toBe('origin issue run-epic EP-1');
    expect(issueRunEpicCommandLine('EP-1', { agent: 'codex', max: 2 })).toBe('origin issue run-epic EP-1 --agent codex --max 2');
  });

  it('opens a terminal in the checkout running origin issue run-epic, every value quoted', () => {
    const req = { repoId: 'r', shortId: 'EP-1', agent: 'codex' as const, repoName: 'acme/app', max: 2 };
    expect(runEpicCommandLine(req, ['/usr/bin/node', "/opt/it's/index.js"])).toBe("'/usr/bin/node' '/opt/it'\\''s/index.js' issue run-epic 'EP-1' --agent 'codex' --max 2");
    const s = runEpicLaunchScript('/w/app', req, ['/usr/bin/node', '/opt/origin/index.js']);
    expect(s).toContain("cd '/w/app' || exit 1");
    const run = s.split('\n').find((l) => l.includes('issue run-epic'))!;
    expect(run.startsWith('exec "${SHELL:-/bin/sh}" -ilc ')).toBe(true);
    // What that shell runs, once sh has unquoted it.
    const inner = execFileSync('sh', ['-c', `printf %s ${run.slice('exec "${SHELL:-/bin/sh}" -ilc '.length)}`], { encoding: 'utf-8' });
    expect(inner).toBe(`'/usr/bin/node' '/opt/origin/index.js' issue run-epic 'EP-1' --agent 'codex' --max 2; exec "\${SHELL:-/bin/sh}" -il`);
    const none = runEpicLaunchScript(null, req, ['n', 'o']);
    expect(none).toContain('could not find a checkout of acme/app (r)');
    expect(none).toContain('origin issue run-epic EP-1 --agent codex --max 2');
  });
});
