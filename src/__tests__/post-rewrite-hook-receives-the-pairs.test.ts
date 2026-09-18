// The installed post-rewrite hook must hand git's "old new" pairs to the CLI.
//
// git writes them to the hook's STDIN. Both of Origin's scripts ran the CLI
// backgrounded (`… >/dev/null 2>&1 &`, #703), and a command backgrounded with
// `&` in a non-interactive shell reads /dev/null — so from 2026-07-17 the CLI
// received an empty input on every rebase and amend. No rewrite pair was ever
// recorded; hooks.log held zero `[post-rewrite]` lines.
//
// Prod 47b6f0e4 (2026-09-17): commit a2bd7c49, rebased two seconds later to
// 7f21862e. post-commit skipped the replay, post-rewrite never heard of it,
// and the old sha — owned by no turn — rendered under a turn from the day
// before. Every test that covered rewrite folding used its own hook script,
// never the one we install.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeGlobalPostRewriteHook } from '../commands/enable.js';
import {
  needsStdinRepair, repairInstalledPostRewriteHooks, repairLocalPostRewriteScript,
} from '../post-rewrite-hook-stdin.js';

const isWindows = process.platform === 'win32';
const PAIRS = 'aaaa111aaaa111 bbbb222bbbb222\ncccc333cccc333 dddd444dddd444\n';

const OLD_GLOBAL = (bin: string) => `#!/bin/sh
# origin-global-post-rewrite
ORIGIN_BIN="${bin}"
if [ -n "$ORIGIN_BIN" ]; then
  "$ORIGIN_BIN" hooks git-post-rewrite "$@" >/dev/null 2>&1 &
fi
`;
const OLD_LOCAL = `#!/bin/sh
echo "the user's own hook"

# origin-post-rewrite
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"
origin hooks git-post-rewrite "$@" >/dev/null 2>&1 &
`;

// The other half. Delivery to the process is not delivery to the handler: it
// read stdin with `require('fs')` in an ES module, inside a try/catch, so the
// pairs were discarded even when they arrived. Every test above uses a stand-in
// CLI and could not see that. This one pipes a real pair into the BUILT binary.
const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = process.env.ORIGIN_E2E_BIN || path.join(cliRoot, 'dist', 'index.js');

describe.skipIf(isWindows || !fs.existsSync(BIN))('the built CLI acts on the pairs it is piped', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-postrewrite-cli-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('an amend\'s "<old> <new>" on stdin carries the attribution note to the new sha', () => {
    const repo = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(repo); fs.mkdirSync(home);
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    const before = git('rev-parse', 'HEAD');
    const note = JSON.stringify({ origin: { version: 1, sessionId: 'e2e-post-rewrite' } });
    git('notes', '--ref=origin', 'add', '-m', note, before);
    git('commit', '-q', '--amend', '-m', 'first, reworded');
    const after = git('rev-parse', 'HEAD');
    expect(() => git('notes', '--ref=origin', 'show', after)).toThrow(); // git did not carry it

    const run = spawnSync(process.execPath, [BIN, 'hooks', 'git-post-rewrite', 'amend'], {
      cwd: repo, env, input: `${before} ${after}\n`, encoding: 'utf-8', timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(git('notes', '--ref=origin', 'show', after)).toContain('e2e-post-rewrite');
  }, 90_000);
});

describe.skipIf(isWindows)('the installed post-rewrite hook delivers git\'s pairs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-postrewrite-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  /** A stand-in CLI that records the stdin it was given. */
  function fakeOrigin(out: string): string {
    const bin = path.join(dir, 'fake-origin');
    fs.writeFileSync(bin, `#!/bin/sh\ncat > "${out}.tmp"\nmv "${out}.tmp" "${out}"\n`);
    fs.chmodSync(bin, '755');
    return bin;
  }
  function patchOriginBin(hookPath: string, bin: string) {
    const src = fs.readFileSync(hookPath, 'utf-8');
    const start = src.indexOf('ORIGIN_BIN=""');
    const end = src.indexOf('\nfi\n', start);
    expect(start).toBeGreaterThan(-1);
    fs.writeFileSync(hookPath, src.slice(0, start) + `ORIGIN_BIN="${bin}"` + src.slice(end + '\nfi'.length));
    fs.chmodSync(hookPath, '755');
  }
  async function received(out: string): Promise<string> {
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    return fs.existsSync(out) ? fs.readFileSync(out, 'utf-8') : '<the CLI never ran>';
  }
  const runHook = (hookPath: string, cwd: string) =>
    spawnSync(hookPath, ['rebase'], { input: PAIRS, cwd, encoding: 'utf-8', timeout: 15_000 });

  it('THE BUG: the script as installed since #703 hands the CLI an empty stdin', async () => {
    const out = path.join(dir, 'got-old');
    const hook = path.join(dir, 'post-rewrite');
    fs.writeFileSync(hook, OLD_GLOBAL(fakeOrigin(out)));
    fs.chmodSync(hook, '755');
    expect(runHook(hook, dir).status).toBe(0);
    expect(await received(out)).toBe('');
  });

  it('the generated global hook pipes the pairs into the backgrounded CLI', async () => {
    const out = path.join(dir, 'got');
    writeGlobalPostRewriteHook(dir);
    const hook = path.join(dir, 'post-rewrite');
    patchOriginBin(hook, fakeOrigin(out));
    expect(runHook(hook, dir).status).toBe(0);
    expect(await received(out)).toBe(PAIRS);
  });

  it('…and the repo\'s own chained hook still gets them, though stdin was already read', async () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const localOut = path.join(dir, 'got-local');
    const local = path.join(repo, '.git', 'hooks', 'post-rewrite');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, `#!/bin/sh\ncat > "${localOut}"\n`);
    fs.chmodSync(local, '755');
    const hooks = path.join(dir, 'global');
    fs.mkdirSync(hooks);
    writeGlobalPostRewriteHook(hooks);
    patchOriginBin(path.join(hooks, 'post-rewrite'), fakeOrigin(path.join(dir, 'got-cli')));
    expect(runHook(path.join(hooks, 'post-rewrite'), repo).status).toBe(0);
    expect(await received(localOut)).toBe(PAIRS);
    expect(await received(path.join(dir, 'got-cli'))).toBe(PAIRS);
  });

  it('a REAL amend, through core.hooksPath, reaches the CLI as "<old> <new>"', async () => {
    const out = path.join(dir, 'got-amend');
    const hooks = path.join(dir, 'global');
    fs.mkdirSync(hooks);
    writeGlobalPostRewriteHook(hooks);
    patchOriginBin(path.join(hooks, 'post-rewrite'), fakeOrigin(out));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('config', 'core.hooksPath', hooks);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    const before = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'first, reworded');
    const after = git('rev-parse', 'HEAD');
    expect(after).not.toBe(before);
    expect((await received(out)).trim()).toBe(`${before} ${after}`);
  });

  it('repairs a repo-local block in place and leaves the user\'s own hook alone', () => {
    expect(needsStdinRepair(OLD_LOCAL)).toBe(true);
    const fixed = repairLocalPostRewriteScript(OLD_LOCAL)!;
    expect(fixed).toContain('echo "the user\'s own hook"');
    expect(fixed).toContain('ORIGIN_REWRITES="$(cat)"');
    expect(fixed).toContain(`{ printf '%s\\n' "$ORIGIN_REWRITES" | origin hooks git-post-rewrite "$@"; } >/dev/null 2>&1 &`);
    // The capture comes before the command that needs it, and only once.
    expect(fixed.indexOf('ORIGIN_REWRITES="$(cat)"')).toBeLessThan(fixed.indexOf('| origin hooks'));
    expect(fixed.match(/\$\(cat\)/g)).toHaveLength(1);
    expect(repairLocalPostRewriteScript(fixed)).toBeNull();
    expect(repairLocalPostRewriteScript('#!/bin/sh\necho unrelated\n')).toBeNull();
  });

  it('repairs the block written before #711, which had no redirect at all', () => {
    const preRedirect = '#!/bin/sh\n# origin-post-rewrite\norigin hooks git-post-rewrite "$@" &\n';
    const fixed = repairLocalPostRewriteScript(preRedirect)!;
    expect(fixed).toContain(`| origin hooks git-post-rewrite "$@"; } >/dev/null 2>&1 &`);
    expect(fixed.match(/>\/dev\/null 2>&1/g)).toHaveLength(1);
    expect(fixed).toContain('ORIGIN_REWRITES="$(cat)"');
    expect(repairLocalPostRewriteScript(fixed)).toBeNull();
  });

  // Every shell a user's /bin/sh might be. dash matters most: it is /bin/sh on
  // Debian and Ubuntu, and it parks the original fd 2 at fd 10 when a builtin
  // is redirected — so a `2>/dev/null` on printf alone still held git's pipe.
  const shells = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((sh) => fs.existsSync(sh));
  it.each(shells)('a rebase bigger than the pipe buffer does not hold git\'s pipe open under %s', (shell) => {
    // 2000 pairs ≈ 164 KB > 64 KB. The CLI stand-in sleeps before it reads, as
    // a cold node start does. `hook 2>&1 | cat` is how git reads the hook.
    const SLEEP = 3;
    const bin = path.join(dir, 'slow-origin');
    const got = path.join(dir, 'got-big');
    fs.writeFileSync(bin, `#!/bin/sh\nsleep ${SLEEP}\ncat > "${got}"\n`);
    fs.chmodSync(bin, '755');
    writeGlobalPostRewriteHook(dir);
    const hook = path.join(dir, 'post-rewrite');
    patchOriginBin(hook, bin);
    const big = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(40, 'a')} ${String(i).padStart(40, 'b')}`).join('\n') + '\n';
    const started = Date.now();
    spawnSync('sh', ['-c', `${shell} "${hook}" rebase 2>&1 | cat`], { input: big, cwd: dir, encoding: 'utf-8', timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan((SLEEP * 1000) / 2);
  });

  it('an earlier cut of this fix — piped, but without the brace group — is repaired too', async () => {
    const hooks = path.join(dir, 'global');
    fs.mkdirSync(hooks);
    const interim = `#!/bin/sh\n# origin-global-post-rewrite\nORIGIN_BIN="/nowhere/origin"\nif [ -t 0 ]; then ORIGIN_REWRITES=""; else ORIGIN_REWRITES="$(cat)"; fi\nprintf '%s\\n' "$ORIGIN_REWRITES" | "$ORIGIN_BIN" hooks git-post-rewrite "$@" >/dev/null 2>&1 &\n`;
    fs.writeFileSync(path.join(hooks, 'post-rewrite'), interim);
    expect(needsStdinRepair(interim)).toBe(true);
    expect(await repairInstalledPostRewriteHooks(null, hooks)).toHaveLength(1);
    expect(needsStdinRepair(fs.readFileSync(path.join(hooks, 'post-rewrite'), 'utf-8'))).toBe(false);
  });

  it('repairs the hooks already on disk — an upgrade never rewrites them', async () => {
    const hooks = path.join(dir, 'global');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-rewrite'), OLD_GLOBAL('/nowhere/origin'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const local = path.join(repo, '.git', 'hooks', 'post-rewrite');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, OLD_LOCAL);

    const repaired = await repairInstalledPostRewriteHooks(repo, hooks);
    expect(repaired.map((p) => fs.realpathSync(p)).sort()).toEqual(
      [path.join(hooks, 'post-rewrite'), local].map((p) => fs.realpathSync(p)).sort());
    expect(needsStdinRepair(fs.readFileSync(path.join(hooks, 'post-rewrite'), 'utf-8'))).toBe(false);
    expect(needsStdinRepair(fs.readFileSync(local, 'utf-8'))).toBe(false);
    // Second run: nothing left to do.
    expect(await repairInstalledPostRewriteHooks(repo, hooks)).toEqual([]);
  });
});
