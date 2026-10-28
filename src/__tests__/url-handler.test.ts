// The web's "Start" opens getorigin://issue/start?…; the CLI's handler finds
// the repo's checkout and opens a terminal running `origin issue start`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { issueLaunchUrl, parseIssueLaunchUrl } from '../issue-prompt.js';
import { candidateCheckouts, findCheckout, isRepeatLaunch, launchScript, raceCommandLine, cloudCommandLine, remoteNames, selfCommand, type FindCheckoutDeps } from '../url-handler.js';

function gitDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-launch-'));
  fs.mkdirSync(path.join(d, '.git'));
  return d;
}

describe('launch links', () => {
  it('round-trips, and carries no prompt', () => {
    const url = issueLaunchUrl('cmrepo123', 'e2069d70', 'codex', 'acme/app');
    expect(url).toBe('getorigin://issue/start?repo=cmrepo123&issue=e2069d70&agent=codex&name=acme%2Fapp');
    expect(parseIssueLaunchUrl(url)).toEqual({ repoId: 'cmrepo123', shortId: 'e2069d70', agent: 'codex', repoName: 'acme/app', worktree: false, background: false });
    const wt = issueLaunchUrl('cmrepo123', 'e2069d70', 'codex', null, { worktree: true, background: false });
    expect(wt).toBe('getorigin://issue/start?repo=cmrepo123&issue=e2069d70&agent=codex&worktree=1');
    expect(parseIssueLaunchUrl(wt)?.worktree).toBe(true);
    // Background implies a worktree.
    const bg = issueLaunchUrl('cmrepo123', 'e2069d70', 'codex', null, { background: true });
    expect(bg).toBe('getorigin://issue/start?repo=cmrepo123&issue=e2069d70&agent=codex&background=1');
    expect(parseIssueLaunchUrl(bg)).toMatchObject({ background: true, worktree: true });
  });

  it('refuses anything that is not a plain id', () => {
    expect(parseIssueLaunchUrl('getorigin://issue/start?repo=r&issue=a;rm -rf ~&agent=claude')).toBeNull();
    expect(parseIssueLaunchUrl("getorigin://issue/start?repo=r'&issue=a&agent=claude")).toBeNull();
    expect(parseIssueLaunchUrl('getorigin://issue/start?repo=r&issue=a&agent=vim')).toBeNull();
    expect(parseIssueLaunchUrl('getorigin://issue/start?repo=r&issue=-x&agent=claude')).toBeNull();
    expect(parseIssueLaunchUrl('getorigin://other?repo=r&issue=a&agent=claude')).toBeNull();
    expect(parseIssueLaunchUrl('origin://issue/start?repo=r&issue=a&agent=claude')).toBeNull();
    // A bad name is dropped, not fatal.
    expect(parseIssueLaunchUrl('getorigin://issue/start?repo=r&issue=a&agent=claude&name=%24(x)')?.repoName).toBeNull();
  });
});

describe('finding the checkout', () => {
  const deps = (over: Partial<FindCheckoutDeps>): FindCheckoutDeps => ({
    known: () => ({}), candidates: () => [], remote: () => '', repoIdOf: async () => null, ...over,
  });

  it('matches remotes by owner/name, ssh or https', () => {
    expect(remoteNames('git@github.com:Acme/App.git', 'acme/app')).toBe(true);
    expect(remoteNames('https://github.com/acme/app', 'acme/app')).toBe(true);
    expect(remoteNames('https://github.com/acme/app-two.git', 'acme/app')).toBe(false);
  });

  it('takes the remembered checkout first', async () => {
    const a = gitDir();
    expect(await findCheckout({ repoId: 'r1', repoName: null }, deps({ known: () => ({ r1: a }) }))).toBe(a);
  });

  it('asks the API about the checkouts whose remote names the repo first', async () => {
    const a = gitDir(); const b = gitDir();
    const asked: string[] = [];
    const found = await findCheckout({ repoId: 'r2', repoName: 'acme/app' }, deps({
      candidates: () => [a, b],
      remote: (d) => (d === b ? 'git@github.com:acme/app.git' : 'git@github.com:acme/other.git'),
      repoIdOf: async (d) => { asked.push(d); return d === b ? 'r2' : 'rX'; },
    }));
    expect(found).toBe(b);
    expect(asked).toEqual([b]);
  });

  it('offline, one checkout naming the repo is the answer; none is null', async () => {
    const a = gitDir();
    const d = deps({ candidates: () => [a], remote: () => 'https://github.com/acme/app.git' });
    expect(await findCheckout({ repoId: 'r3', repoName: 'acme/app' }, d)).toBe(a);
    expect(await findCheckout({ repoId: 'r3', repoName: 'acme/zzz' }, d)).toBeNull();
  });

  it('lists checkouts from session state files, main checkout over worktree, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-sessions-'));
    const main = gitDir(); const other = gitDir();
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ repoPath: `${main}/wt`, canonicalRepoPath: main }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ repoPath: other }));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ repoPath: '/nope/gone' }));
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(dir, 'a.json'), t - 100, t - 100);
    expect(candidateCheckouts(dir)).toEqual([other, main]);
  });
});

describe('the launch script', () => {
  it('cds into the checkout and runs origin issue start, every value quoted', () => {
    const s = launchScript("/Users/me/it's here", { repoId: 'r', shortId: 'e2069d70', agent: 'claude', repoName: null, worktree: false, background: false }, ['/usr/bin/node', '/opt/origin/index.js']);
    expect(s).toContain(`cd '/Users/me/it'\\''s here' || exit 1`);
    // exec'd, so the agent's shell owns the terminal (a child shell is stopped by SIGTTOU).
    const run = s.split('\n').find((l) => l.includes('issue start'))!;
    expect(run.startsWith('exec "${SHELL:-/bin/sh}" -ilc ')).toBe(true);
    // What that shell runs, once sh has unquoted it.
    const inner = execFileSync('sh', ['-c', `printf %s ${run.slice('exec "${SHELL:-/bin/sh}" -ilc '.length)}`], { encoding: 'utf-8' });
    expect(inner).toBe(`'/usr/bin/node' '/opt/origin/index.js' issue start 'e2069d70' --agent 'claude'; exec "\${SHELL:-/bin/sh}" -il`);
  });

  it('passes --worktree through', () => {
    const s = launchScript('/r', { repoId: 'r', shortId: 'x1', agent: 'claude', repoName: null, worktree: true, background: false }, ['n', 'o']);
    expect(s).toContain("--agent '\\''claude'\\'' --worktree;");
  });

  it('first unsets an inherited agent session', () => {
    const s = launchScript('/r', { repoId: 'r', shortId: 'x1', agent: 'claude', repoName: null, worktree: false, background: false }, ['n', 'o']);
    const lines = s.split('\n');
    expect(lines.findIndex((l) => l.includes('CLAUDE_CODE_'))).toBeLessThan(lines.findIndex((l) => l.includes('issue start')));
  });

  it('with no checkout, says so and how to start by hand', () => {
    const s = launchScript(null, { repoId: 'r', shortId: 'x1', agent: 'codex', repoName: 'acme/app', worktree: true, background: false }, ['n', 'o']);
    expect(s).toContain('could not find a checkout of acme/app');
    expect(s).toContain('origin issue start x1 --agent codex --worktree');
    expect(s).not.toContain('issue start \'x1\'');
  });
});

describe('a repeated click', () => {
  it('is one launch within 10s; another link, or later, is a new one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-last-')), 'last.json');
    expect(isRepeatLaunch('getorigin://a', 1000, file)).toBe(false);
    expect(isRepeatLaunch('getorigin://a', 5000, file)).toBe(true);
    expect(isRepeatLaunch('getorigin://b', 5100, file)).toBe(false);
    expect(isRepeatLaunch('getorigin://b', 20000, file)).toBe(false);
  });
});

describe('the command the handler runs', () => {
  it('keeps the bin link as invoked: the folder it resolves to is replaced by the next upgrade', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-self-'));
    const versioned = path.join(dir, '.cli-1-abc', 'index.js');
    fs.mkdirSync(path.dirname(versioned));
    fs.writeFileSync(versioned, '');
    const link = path.join(dir, 'origin');
    fs.symlinkSync(versioned, link);
    expect(selfCommand(link)).toEqual([process.execPath, link]);
  });
});

describe('a race link', () => {
  it('runs origin issue race with the agents, quoted, and --force only when asked', () => {
    expect(raceCommandLine({ repoId: 'r', shortId: 'ISS-7', agents: ['claude', 'codex'], repoName: null }, ['/usr/bin/node', "/opt/it's/index.js"]))
      .toBe("'/usr/bin/node' '/opt/it'\\''s/index.js' issue race 'ISS-7' --agents 'claude,codex'");
    expect(raceCommandLine({ repoId: 'r', shortId: 'ISS-7', agents: ['claude', 'codex'], repoName: null, force: true }, ['n', 'o'])).toMatch(/--agents 'claude,codex' --force$/);
  });
});

describe('a cloud link', () => {
  it('runs origin issue cloud with the runner and env quoted — an env with spaces stays one argument', () => {
    expect(cloudCommandLine({ repoId: 'r', shortId: 'ISS-7', runner: 'codex', env: 'acme web', repoName: null }, ['/usr/bin/node', '/opt/index.js']))
      .toBe("'/usr/bin/node' '/opt/index.js' issue cloud 'ISS-7' --runner 'codex' --env 'acme web'");
  });
});
