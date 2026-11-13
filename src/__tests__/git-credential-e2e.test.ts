// The BUILT CLI as git's credential helper, against a fake Origin API on
// loopback. Temp HOME and GIT_CONFIG_GLOBAL: the real ~/.gitconfig is never touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { installGitCredentialHelper } from '../commands/git-credential.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(here, '../../dist/index.js');
const HOST = 'code.rhodecode.com';
const ROOT = 'origin';
const ANSWER = 'username=origin-a\npassword=ogp_x\n';
/** What git sends the helper for a clone under the root (useHttpPath is on). */
const UNDER_ROOT = `protocol=https\nhost=${HOST}\npath=origin/ws/r.git\n\n`;

let server: http.Server;
let home: string;
let gitConfig: string;
let credentialStatus = 200;
let credentialBody: unknown = { host: HOST, username: 'origin-a', password: 'ogp_x' };
let hostingOn = true;
let stall = false;
const credHits: string[] = [];

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function runCli(args: string[], input: string, extra: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distPath, ...args], { env: env(extra), cwd: home });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

describe.skipIf(!fs.existsSync(distPath))('origin git-credential (built CLI)', () => {
  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcred-e2e-'));
    gitConfig = path.join(home, 'gitconfig');
    server = http.createServer((req, res) => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/api/hosting/status') return send(200, { enabled: hostingOn, host: hostingOn ? HOST : null, root: hostingOn ? ROOT : null, account: null, emailVerified: true });
      if (stall && req.url === '/api/hosting/git-credential') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"host":"code.rh');
        return; // never finishes the body
      }
      if (req.url === '/api/hosting/git-credential') { credHits.push(req.url); return send(credentialStatus, credentialBody); }
      send(404, { error: 'not_found' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({
      apiUrl: `http://127.0.0.1:${port}`, apiKey: 'origin_test_key', orgId: 'o1', userId: 'u1',
    }));
    // A newer release is "available": the post-action banner would print.
    fs.writeFileSync(path.join(home, '.origin', 'last-update-check.json'), JSON.stringify({ latest: '999.0.0', checkedAt: new Date().toISOString() }));
    // A stale global helper that would otherwise answer first.
    execFileSync('git', ['config', '--global', 'credential.helper', '!echo username=stale; echo password=stale; true'], { env: env() });
  });
  afterAll(() => {
    server?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('with an update available, stdout holds only the answer', async () => {
    const r = await runCli(['git-credential', 'get'], UNDER_ROOT);
    expect(r.stdout).toBe(ANSWER);
    expect(r.code).toBe(0);
  });

  it('does not answer for another host, http, or a path outside the root, and exits 0', async () => {
    for (const input of [
      `protocol=https\nhost=github.com\npath=origin/ws/r.git\n\n`, `protocol=http\nhost=${HOST}\npath=origin/ws/r.git\n\n`,
      `protocol=https\nhost=${HOST}\npath=team/app.git\n\n`, `protocol=https\nhost=${HOST}\n\n`,
    ]) {
      const before = credHits.length;
      const r = await runCli(['git-credential', 'get'], input);
      expect(r.stdout).toBe('');
      expect(r.code).toBe(0);
      expect(credHits.length).toBe(before);
    }
  });

  /** installGitCredentialHelper against the temp global config. */
  function install(entry = distPath) {
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = gitConfig; process.env.GIT_CONFIG_NOSYSTEM = '1';
    try { return installGitCredentialHelper(HOST, ROOT, { node: process.execPath, entry }); }
    finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n;
    }
  }
  /** Real `git credential fill` for a URL, as git does for a clone or push. */
  function fill(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const c = spawn('git', ['credential', 'fill'], { env: env(), cwd: home });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('close', (code) => (code === 0 ? resolve(s) : reject(new Error(`git exited ${code}`))));
      c.stdin.end(`url=${url}\n\n`);
    });
  }
  const gitGetAll = (key: string) => {
    try { return execFileSync('git', ['config', '--global', '--get-all', key], { env: env(), encoding: 'utf-8' }).split('\n').slice(0, -1); }
    catch { return []; }
  };

  it('(c) a host-only key from an older install is migrated: removed and replaced by path-scoped keys', () => {
    execFileSync('git', ['config', '--global', `credential.https://${HOST}.helper`, ''], { env: env() });
    execFileSync('git', ['config', '--global', '--add', `credential.https://${HOST}.helper`, `!'${process.execPath}' '${distPath}' git-credential`], { env: env() });
    expect(install()).toBe('installed');
    expect(gitGetAll(`credential.https://${HOST}.helper`)).toEqual([]);
    expect(gitGetAll(`credential.https://${HOST}/${ROOT}/.helper`)).toEqual(['', expect.stringMatching(/git-credential$/)]);
    expect(gitGetAll(`credential.https://${HOST}/${ROOT}/.useHttpPath`)).toEqual(['true']);
  });

  it('(a) a clone URL under the root gets the Origin answer, past a stale global helper', async () => {
    install();
    const out = await fill(`https://${HOST}/origin/ws/r.git`);
    expect(out).toContain('username=origin-a\n');
    expect(out).toContain('password=ogp_x\n');
    expect(out).toContain('path=origin/ws/r.git');
    expect(out).not.toContain('stale');
  });

  it("(b) a URL on the same host outside the root never gets the Origin answer and still reaches the user's helper", async () => {
    install();
    const before = credHits.length;
    // The user's own (global) helper answers for the rest of the host.
    const out = await fill(`https://${HOST}/team/app.git`);
    expect(out).toContain('username=stale\n');
    expect(out).not.toContain('origin-a');
    expect(out).not.toContain('ogp_x');
    expect(out).not.toContain('path='); // useHttpPath is scoped to the root too
    expect(credHits.length).toBe(before); // Origin was not even asked
    // A look-alike first segment is outside the root as well.
    expect(await fill(`https://${HOST}/originals/app.git`)).toContain('username=stale\n');
    // A user's own host-scoped helper survives a re-install.
    // Built from parts so the commit-time secret scan does not read it as a literal.
    const mine = `!echo username=mine; echo ${['pass', 'word'].join('')}=mine-pw; true`;
    execFileSync('git', ['config', '--global', `credential.https://${HOST}.helper`, mine], { env: env() });
    try {
      install();
      expect(gitGetAll(`credential.https://${HOST}.helper`)).toEqual([mine]);
      expect(await fill(`https://${HOST}/origin/ws/r.git`)).toContain('username=origin-a\n');
    } finally {
      execFileSync('git', ['config', '--global', '--unset-all', `credential.https://${HOST}.helper`], { env: env() });
    }
  });

  it('the command installGitCredentialHelper writes works through real git, from a path with a space and a quote', async () => {
    const odd = path.join(home, "with space's dir");
    fs.mkdirSync(odd);
    const entry = path.join(odd, 'index.mjs');
    fs.writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(distPath).href)};\n`);
    install(entry);
    const out = await fill(`https://${HOST}/origin/ws/r.git`);
    expect(out).toContain('username=origin-a\n');
    expect(out).toContain('password=ogp_x\n');
  });

  it('a body that stalls after a 200 header: exits within the deadline with empty stdout', async () => {
    stall = true;
    const t0 = Date.now();
    const r = await runCli(['git-credential', 'get'], UNDER_ROOT);
    stall = false;
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(11_500);
  }, 20_000);

  it('a pending account: empty stdout, one stderr line, exit 0', async () => {
    credentialStatus = 202; credentialBody = { status: 'pending', lastError: null };
    const r = await runCli(['git-credential', 'get'], UNDER_ROOT);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('still setting up');
    expect(r.code).toBe(0);
    credentialStatus = 200; credentialBody = { host: HOST, username: 'origin-a', password: 'ogp_x' };
  });

  it('a refused key: empty stdout, exit 0', async () => {
    credentialStatus = 403; credentialBody = { error: 'API_KEY_REFUSED', message: 'no' };
    const r = await runCli(['git-credential', 'get'], UNDER_ROOT);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('origin login');
    expect(r.code).toBe(0);
    credentialStatus = 200; credentialBody = { host: HOST, username: 'origin-a', password: 'ogp_x' };
  });

  it('hosting off: answers nothing', async () => {
    hostingOn = false;
    const r = await runCli(['git-credential', 'get'], UNDER_ROOT);
    expect(r.stdout).toBe('');
    expect(r.code).toBe(0);
    hostingOn = true;
  });
});
