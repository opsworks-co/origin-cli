import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  gitCredentialCommand,
  parseCredentialInput,
  installGitCredentialHelper,
  pathUnderRoot,
  setupGitCredentialHelper,
  type GitCredentialIo,
} from '../commands/git-credential.js';
import { api } from '../api.js';

const HOST = 'code.rhodecode.com';
const CRED = { host: HOST, username: 'origin-a', password: 'ogp_x' };
const ROOT = 'origin';
/** A request git sends for a clone under the root (useHttpPath is on). */
const req = (host = HOST, path = 'origin/ws/r.git', protocol = 'https') => `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`;

function harness(input: string, over: Partial<GitCredentialIo> = {}) {
  let out = '';
  const io: GitCredentialIo = {
    stdin: input,
    out: (s) => { out += s; },
    fetchCredential: async () => CRED,
    ...over,
  };
  return { io, out: () => out };
}

describe('parseCredentialInput', () => {
  it('reads key=value lines up to the blank line, keeping "=" in values', () => {
    expect(parseCredentialInput('protocol=https\nhost=h.example\npath=a=b\n\nignored=1\n'))
      .toEqual({ protocol: 'https', host: 'h.example', path: 'a=b' });
  });
  it('tolerates CRLF', () => {
    expect(parseCredentialInput('protocol=https\r\nhost=h\r\n\r\n')).toEqual({ protocol: 'https', host: 'h' });
  });
});

describe('pathUnderRoot', () => {
  it.each([
    ['origin/ws/r.git', 'origin', true], ['Origin/WS/r', 'origin', true], ['/origin/ws/r', 'origin', true],
    ['origin', 'origin', false], ['originx/r', 'origin', false], ['team/origin/r', 'origin', false], [undefined, 'origin', false],
    ['origin-staging/ws/r', 'origin-staging', true], ['origin/ws/r', 'origin-staging', false], ['origin/ws/r', '../x', false],
  ])('%j under %j: %s', (path, root, want) => {
    expect(pathUnderRoot(path as string | undefined, root)).toBe(want);
  });
});

describe('gitCredentialCommand', () => {
  it('answers get for a path under the root on the hosting host over https', async () => {
    const h = harness(req());
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('username=origin-a\npassword=ogp_x\n');
  });
  it('compares the host and the root case-insensitively', async () => {
    const h = harness(req('Code.RhodeCode.com', 'ORIGIN/ws/r'));
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('username=origin-a\npassword=ogp_x\n');
  });
  it.each([
    // The host is checked against the credential's own host when it is not known up front.
    ['another host', req('github.com'), true],
    ['http', req(HOST, 'origin/ws/r', 'http'), false],
    ['a different port', req('code.rhodecode.com:8443'), true],
    ['no host', 'protocol=https\n\n', false],
    ['no path (a host-only install)', `protocol=https\nhost=${HOST}\n\n`, false],
    ['a path outside the root on the same host', req(HOST, 'team/app.git'), false],
    ['a look-alike root', req(HOST, 'originals/app.git'), false],
  ])('says nothing for %s', async (_n, input, mayFetch) => {
    let fetched = 0;
    const h = harness(input, { fetchCredential: async () => { fetched++; return CRED; } });
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('');
    if (!mayFetch) expect(fetched).toBe(0);
  });
  it('uses the root the server reports', async () => {
    const staging = harness(req(HOST, 'origin-staging/ws/r'), { fetchHosting: async () => ({ host: HOST, root: 'origin-staging' }) });
    await gitCredentialCommand('get', staging.io);
    expect(staging.out()).toBe('username=origin-a\npassword=ogp_x\n');
    const prod = harness(req(HOST, 'origin/ws/r'), { fetchHosting: async () => ({ host: HOST, root: 'origin-staging' }) });
    await gitCredentialCommand('get', prod.io);
    expect(prod.out()).toBe('');
  });
  it('does not even fetch a password for another host when the host is known', async () => {
    let fetched = 0;
    const h = harness(req('github.com'), {
      fetchHosting: async () => ({ host: HOST, root: ROOT }),
      fetchCredential: async () => { fetched++; return CRED; },
    });
    await gitCredentialCommand('get', h.io);
    expect(fetched).toBe(0);
    expect(h.out()).toBe('');
  });
  it.each(['store', 'erase'])('%s does nothing', async (action) => {
    let fetched = 0;
    const h = harness(req(), {
      fetchCredential: async () => { fetched++; return CRED; },
    });
    await gitCredentialCommand(action, h.io);
    expect(h.out()).toBe('');
    expect(fetched).toBe(0);
  });
  it.each([
    ['username with newline', { host: HOST, username: 'a\nb', password: 'ogp_x' }],
    ['secret with CR', { host: HOST, username: 'a', password: 'ogp_\rx' }],
    ['secret with NUL', { host: HOST, username: 'a', password: 'ogp_\0x' }],
  ])('refuses a credential with control characters: %s', async (_n, cred) => {
    const h = harness(req(), { fetchCredential: async () => cred });
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('');
  });
  it('refuses a malformed requested host', async () => {
    const h = harness(req('code.rhodecode.com/x y'));
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('');
  });
  it('gives up at the deadline with no answer', async () => {
    const h = harness(req(), {
      deadlineMs: 50,
      fetchCredential: () => new Promise(() => { /* never settles */ }),
    });
    await gitCredentialCommand('get', h.io);
    expect(h.out()).toBe('');
  });
  it('logged out, offline or pending: nothing, no throw', async () => {
    const none = harness(req(), { fetchCredential: async () => null });
    await gitCredentialCommand('get', none.io);
    expect(none.out()).toBe('');
    const boom = harness(req(), {
      fetchCredential: async () => { throw new Error('offline'); },
    });
    await expect(gitCredentialCommand('get', boom.io)).resolves.toBeUndefined();
    expect(boom.out()).toBe('');
  });
});

describe('installGitCredentialHelper', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const cfg = () => path.join(dir, 'gitconfig');
  const all = (key: string) => {
    try { return execFileSync('git', ['config', '--global', '--get-all', key], { encoding: 'utf-8' }).split('\n').slice(0, -1); }
    catch { return []; }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcred-'));
    for (const k of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k];
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    process.env.GIT_CONFIG_GLOBAL = cfg(); process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const SCOPE = `credential.https://${HOST}/${ROOT}/`;
  const LEGACY = `credential.https://${HOST}.helper`;

  it('install writes the path-scoped entries once', () => {
    expect(installGitCredentialHelper(HOST, ROOT)).toBe('installed');
    expect(installGitCredentialHelper(HOST, ROOT)).toBe('unchanged');
    expect(all(`${SCOPE}.helper`)).toEqual(['', expect.stringMatching(/^!.*git-credential$/)]);
    expect(all(`${SCOPE}.useHttpPath`)).toEqual(['true']);
    expect(all(LEGACY)).toEqual([]);
  });
  it('install leaves other credential config alone', () => {
    execFileSync('git', ['config', '--global', 'credential.helper', 'osxkeychain']);
    execFileSync('git', ['config', '--global', '--add', 'credential.https://github.com.helper', 'store']);
    installGitCredentialHelper(HOST, ROOT);
    expect(all('credential.helper')).toEqual(['osxkeychain']);
    expect(all('credential.https://github.com.helper')).toEqual(['store']);
  });
  it('rejects an invalid host or root without touching git config', () => {
    expect(() => installGitCredentialHelper('bad host/x', ROOT)).toThrow();
    expect(() => installGitCredentialHelper(HOST, '../x')).toThrow();
    expect(() => installGitCredentialHelper(HOST, 'a/b')).toThrow();
    expect(all('credential.https://bad host/x/origin/.helper')).toEqual([]);
    expect(all(`credential.https://${HOST}/../x/.helper`)).toEqual([]);
  });
  it('repairs a changed entry', () => {
    installGitCredentialHelper(HOST, ROOT);
    execFileSync('git', ['config', '--global', '--add', `${SCOPE}.helper`, 'osxkeychain']);
    expect(installGitCredentialHelper(HOST, ROOT)).toBe('installed');
    expect(all(`${SCOPE}.helper`)).toEqual(['', expect.stringMatching(/^!.*git-credential$/)]);
  });
  it('migrates a host-only install: removed, replaced by the path-scoped entries', () => {
    execFileSync('git', ['config', '--global', LEGACY, '']);
    execFileSync('git', ['config', '--global', '--add', LEGACY, "!'/usr/bin/node' '/x/dist/index.js' git-credential"]);
    expect(installGitCredentialHelper(HOST, ROOT)).toBe('installed');
    expect(all(LEGACY)).toEqual([]);
    expect(all(`${SCOPE}.helper`)).toEqual(['', expect.stringMatching(/^!.*git-credential$/)]);
  });
  it('a host-only key the user added to keeps the user\'s lines', () => {
    execFileSync('git', ['config', '--global', LEGACY, '']);
    execFileSync('git', ['config', '--global', '--add', LEGACY, '!origin git-credential']);
    execFileSync('git', ['config', '--global', '--add', LEGACY, 'osxkeychain']);
    installGitCredentialHelper(HOST, ROOT);
    expect(all(LEGACY)).toEqual(['', 'osxkeychain']);
  });
  it('a host-only key with no Origin helper is not touched', () => {
    execFileSync('git', ['config', '--global', LEGACY, 'store']);
    installGitCredentialHelper(HOST, ROOT);
    expect(all(LEGACY)).toEqual(['store']);
  });

  it('setup reads only the status, scopes to the root it reports, and never asks for a credential', async () => {
    const status = vi.spyOn(api, 'getHostingStatus').mockResolvedValue({ enabled: true, host: HOST, root: 'origin-staging', account: null, emailVerified: true });
    const cred = vi.spyOn(api, 'getGitCredential').mockResolvedValue({});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await setupGitCredentialHelper();
      expect(status).toHaveBeenCalledTimes(1);
      expect(cred).not.toHaveBeenCalled();
      expect(all(`credential.https://${HOST}/origin-staging/.helper`)).toEqual(['', expect.stringMatching(/git-credential$/)]);
      expect(all(`credential.https://${HOST}/origin-staging/.useHttpPath`)).toEqual(['true']);
      expect(log.mock.calls.flat().join(' ')).toContain(`https://${HOST}/origin-staging/`);
    } finally {
      status.mockRestore(); cred.mockRestore(); log.mockRestore();
    }
  });
  it('setup against a server without root uses origin; an invalid root writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const status = vi.spyOn(api, 'getHostingStatus').mockResolvedValue({ enabled: true, host: HOST, account: null, emailVerified: true });
    try {
      await setupGitCredentialHelper();
      expect(all(`${SCOPE}.useHttpPath`)).toEqual(['true']);
      status.mockResolvedValue({ enabled: true, host: HOST, root: '../x', account: null, emailVerified: true });
      await setupGitCredentialHelper();
      expect(all(`credential.https://${HOST}/../x/.helper`)).toEqual([]);
    } finally {
      status.mockRestore(); log.mockRestore();
    }
  });
});
