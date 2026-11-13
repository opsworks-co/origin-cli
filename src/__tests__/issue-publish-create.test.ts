// `origin issue create` puts the issue on Origin too (publishIssue), so the
// Issues page, Start and the orchestrator see it; the local file stands
// whatever Origin says.
import { describe, it, expect, vi } from 'vitest';
import { publishIssue, type Issue, type PublishIssueDeps } from '../commands/issue.js';

const issue: Issue = {
  id: 'ori-ab12', title: 'Fix it', description: 'Details', type: 'bug', priority: 2, status: 'open',
  labels: ['cli'], deps: [], sessions: [], createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z',
};

function deps(over: Partial<PublishIssueDeps> = {}): PublishIssueDeps {
  return {
    connected: () => true,
    remoteUrl: () => 'git@github.com:acme/app.git',
    previewRoute: vi.fn(async () => ({ repo: { id: 'repo-1' } })),
    createIssue: vi.fn(async () => ({})),
    ...over,
  };
}

describe('publishIssue', () => {
  it('creates the issue on Origin under the same id, in the repo the checkout routes to', async () => {
    const d = deps();
    expect(await publishIssue('/w', issue, d)).toEqual({ ok: true, repoId: 'repo-1' });
    expect(d.previewRoute).toHaveBeenCalledWith({ repoPath: '/w', repoUrl: 'git@github.com:acme/app.git' });
    expect(d.createIssue).toHaveBeenCalledWith('repo-1', { shortId: 'ori-ab12', title: 'Fix it', description: 'Details', type: 'bug', priority: 2, labels: ['cli'], deps: [] });
  });

  it('stays local when not signed in, the repo is not on Origin, or Origin fails', async () => {
    const off = deps({ connected: () => false });
    expect(await publishIssue('/w', issue, off)).toMatchObject({ ok: false, reason: expect.stringContaining('not signed in') });
    expect(off.previewRoute).not.toHaveBeenCalled();

    expect(await publishIssue('/w', issue, deps({ previewRoute: async () => ({ repo: null }) }))).toMatchObject({ ok: false, reason: 'this repo is not on Origin yet' });
    expect(await publishIssue('/w', issue, deps({ createIssue: async () => { throw new Error('HTTP 500'); } }))).toMatchObject({ ok: false, reason: expect.stringContaining('HTTP 500') });
  });
});
