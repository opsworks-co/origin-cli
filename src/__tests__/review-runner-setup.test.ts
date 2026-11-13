// `origin review runner setup` (commands/review-runner-setup.ts): a fresh box
// clones the repos with its own git access, then installs the runner service.
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { cloneTarget, runnerSetupCommand, type RunnerSetupDeps } from '../commands/review-runner-setup.js';
import type { ServiceSpec } from '../commands/review-runner-service.js';

describe('cloneTarget', () => {
  it('puts https and scp-style URLs at <dir>/<path on the host>', () => {
    expect(cloneTarget('https://github.com/acme/api.git', '/r')).toBe(path.join('/r', 'acme', 'api'));
    expect(cloneTarget('git@github.com:acme/api.git', '/r')).toBe(path.join('/r', 'acme', 'api'));
    expect(cloneTarget('https://code.acme.io/code/team/repo', '/r')).toBe(path.join('/r', 'code', 'team', 'repo'));
    expect(cloneTarget('ssh://git@host:2222/a/b.git', '/r')).toBe(path.join('/r', 'a', 'b'));
  });
  it('refuses a URL with no path or one that climbs out', () => {
    expect(cloneTarget('https://github.com/', '/r')).toBeNull();
    // The URL parser folds an encoded `..` away, so it stays inside the folder.
    expect(cloneTarget('https://github.com/a/%2e%2e/b', '/r')).toBe(path.join('/r', 'b'));
    expect(cloneTarget('git@host:../../etc', '/r')).toBeNull();
    expect(cloneTarget('not a url', '/r')).toBeNull();
  });
});

function fakeDeps(over: Partial<RunnerSetupDeps> = {}) {
  const lines: string[] = [];
  const codes: number[] = [];
  const installed: ServiceSpec[] = [];
  const deps: RunnerSetupDeps = {
    platform: 'linux',
    home: '/home/me',
    log: (l) => lines.push(l),
    isCheckout: () => false,
    mkdirp: () => {},
    git: () => ({ status: 0, stderr: '' }),
    onPath: () => true,
    linger: () => ({ ok: true, out: '' }),
    spec: (opts, cwd) => ({ node: 'node', entry: 'origin', args: ['review', 'runner', '--repo', ...opts.repo, ...(opts.scope ? ['--scope', opts.scope] : [])], cwd, logFile: 'l', pathEnv: null }),
    install: (spec) => { installed.push(spec); return '/svc'; },
    exit: (c) => codes.push(c),
    ...over,
  };
  return { deps, lines, codes, installed };
}

describe('runnerSetupCommand', () => {
  it('clones each repo, then installs the service watching the clones with the scope asked for', async () => {
    const git = vi.fn(() => ({ status: 0, stderr: '' }));
    const linger = vi.fn(() => ({ ok: true, out: '' }));
    const { deps, codes, installed } = fakeDeps({ git, linger });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git', 'https://github.com/acme/web.git'], scope: 'workspace', parallel: '2' }, deps);
    expect(git).toHaveBeenCalledWith(['clone', '--quiet', 'https://github.com/acme/api.git', path.join('/home/me/origin-runner', 'acme', 'api')]);
    expect(linger).toHaveBeenCalled();
    expect(installed).toHaveLength(1);
    expect(installed[0].args).toEqual(['review', 'runner', '--repo', path.join('/home/me/origin-runner', 'acme', 'api'), path.join('/home/me/origin-runner', 'acme', 'web'), '--scope', 'workspace']);
    expect(codes).toEqual([]);
  });

  it('fetches a checkout already there instead of cloning it again', async () => {
    const git = vi.fn(() => ({ status: 0, stderr: '' }));
    const { deps, installed } = fakeDeps({ git, isCheckout: () => true });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git'], dir: '/srv/r' }, deps);
    expect(git).toHaveBeenCalledWith(['fetch', '--quiet', 'origin'], path.join('/srv/r', 'acme', 'api'));
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['clone']));
    expect(installed).toHaveLength(1);
  });

  it('with no access to any repo: says how to give it, installs nothing, exits 1', async () => {
    const { deps, lines, codes, installed } = fakeDeps({ git: () => ({ status: 128, stderr: "fatal: could not read Username for 'https://github.com'" }) });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git'] }, deps);
    const out = lines.join('\n');
    expect(out).toContain('could not read Username');
    expect(out).toContain('gh auth login');
    expect(installed).toHaveLength(0);
    expect(codes).toEqual([1]);
  });

  it('installs for the repos it could clone, but still exits 1 for the ones it could not', async () => {
    const git = vi.fn((args: string[]) => ({ status: args[2].includes('secret') ? 128 : 0, stderr: 'fatal: denied' }));
    const { deps, codes, installed } = fakeDeps({ git });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git', 'https://github.com/acme/secret.git'] }, deps);
    expect(installed[0].args).toContain(path.join('/home/me/origin-runner', 'acme', 'api'));
    expect(installed[0].args).not.toContain(path.join('/home/me/origin-runner', 'acme', 'secret'));
    expect(codes).toEqual([1]);
  });

  it('warns when no reviewer agent is on PATH or lingering is refused, and still installs', async () => {
    const { deps, lines, installed } = fakeDeps({ onPath: () => false, linger: () => ({ ok: false, out: 'Access denied' }) });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git'] }, deps);
    const out = lines.join('\n');
    expect(out).toContain('No reviewer agent on PATH');
    expect(out).toContain('sudo loginctl enable-linger');
    expect(installed).toHaveLength(1);
  });

  it('no lingering on macOS; refuses no --clone and a bad --scope', async () => {
    const linger = vi.fn(() => ({ ok: true, out: '' }));
    const mac = fakeDeps({ platform: 'darwin', linger });
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git'] }, mac.deps);
    expect(linger).not.toHaveBeenCalled();
    const none = fakeDeps();
    await runnerSetupCommand({}, none.deps);
    expect(none.codes).toEqual([2]);
    const bad = fakeDeps();
    await runnerSetupCommand({ clone: ['https://github.com/acme/api.git'], scope: 'all' }, bad.deps);
    expect(bad.codes).toEqual([2]);
    expect(bad.installed).toHaveLength(0);
  });
});
