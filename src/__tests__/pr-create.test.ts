// `origin pr create` gives agents in an Origin-hosted repo a way to open a PR
// that ends in an Origin link. Without it Codex opened the Git server's own
// web form and handed out a code.rhodecode.com link (test2, PR !3082).
import { describe, expect, it } from 'vitest';
import { prCreate, type PrCreateDeps } from '../commands/pr.js';

function deps(over: Partial<PrCreateDeps> = {}) {
  const calls: { route: any[]; open: any[] } = { route: [], open: [] };
  const d: PrCreateDeps = {
    connected: () => true,
    repoRoot: () => '/work/test2',
    currentBranch: () => 'codex/line-count',
    remoteUrl: () => 'https://code.rhodecode.com/origin/origin-hq/test2',
    branchOnRemote: () => true,
    readFile: (f) => `body from ${f}`,
    previewRoute: async (data) => { calls.route.push(data); return { repo: { id: 'repo-1' } }; },
    openPullRequest: async (repoId, data) => { calls.open.push({ repoId, ...data }); return { id: 'pr-row-9', number: 3082, url: 'https://code.rhodecode.com/origin/origin-hq/test2/pull-request/3082' }; },
    appUrl: () => 'https://getorigin.io/',
    out: () => {},
    ...over,
  };
  return { d, calls };
}

describe('origin pr create', () => {
  it('opens the PR for the current branch and returns the Origin link, not the host link', async () => {
    const { d, calls } = deps();
    const r = await prCreate({ title: ' Add line count ', body: 'why' }, '/work/test2/sub', d);
    expect(r).toEqual({ ok: true, id: 'pr-row-9', number: 3082, url: 'https://getorigin.io/pull-requests/pr-row-9', hostUrl: 'https://code.rhodecode.com/origin/origin-hq/test2/pull-request/3082' });
    expect(calls.route).toEqual([{ repoPath: '/work/test2', repoUrl: 'https://code.rhodecode.com/origin/origin-hq/test2' }]);
    expect(calls.open).toEqual([{ repoId: 'repo-1', head: 'codex/line-count', title: 'Add line count', body: 'why', draft: false }]);
  });

  it('passes --base, --head, --draft and reads --body-file', async () => {
    const { d, calls } = deps();
    await prCreate({ title: 't', bodyFile: 'pr.md', base: 'develop', head: 'feat', draft: true }, '/w', d);
    expect(calls.open[0]).toEqual({ repoId: 'repo-1', head: 'feat', base: 'develop', title: 't', body: 'body from pr.md', draft: true });
  });

  it('refuses an unpushed branch with the push command, before calling Origin', async () => {
    const { d, calls } = deps({ branchOnRemote: () => false });
    const r = await prCreate({ title: 't' }, '/w', d);
    expect(r).toEqual({ ok: false, message: 'codex/line-count is not on the remote yet. Push it first: git push -u origin codex/line-count' });
    expect(calls.route).toEqual([]);
  });

  it('goes ahead when the remote cannot be asked; the server says what is wrong', async () => {
    const { d, calls } = deps({ branchOnRemote: () => null });
    expect((await prCreate({ title: 't' }, '/w', d)).ok).toBe(true);
    expect(calls.open).toHaveLength(1);
  });

  it.each([
    [{ title: '  ' }, {}, 'A title is required'],
    [{ title: 't', body: 'a', bodyFile: 'b' }, {}, 'Pass --body or --body-file'],
    [{ title: 't' }, { connected: () => false }, 'Not signed in'],
    [{ title: 't' }, { repoRoot: () => null }, 'Not inside a git repository'],
    [{ title: 't' }, { currentBranch: () => null }, 'Not on a branch'],
    [{ title: 't', base: 'codex/line-count' }, {}, '--base and the branch are both'],
    [{ title: 't' }, { previewRoute: async () => ({ repo: null }) }, 'not on Origin yet'],
  ] as const)('refuses %j', async (opts, over, msg) => {
    const { d, calls } = deps(over as Partial<PrCreateDeps>);
    const r = await prCreate(opts as any, '/w', d);
    expect(r.ok).toBe(false);
    expect((r as any).message).toContain(msg);
    expect(calls.open).toEqual([]);
  });

  it("says the server's reason when the host refuses", async () => {
    const err: any = new Error('Conflict');
    err.serverMessage = 'A pull request from codex/line-count is already open.';
    const { d } = deps({ openPullRequest: async () => { throw err; } });
    expect(await prCreate({ title: 't' }, '/w', d)).toEqual({ ok: false, message: 'Origin could not open the pull request: A pull request from codex/line-count is already open.' });
  });
});
