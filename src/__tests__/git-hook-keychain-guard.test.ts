/**
 * The global git hooks under a sandboxed agent with NODE_USE_SYSTEM_CA=1.
 *
 * Codex --full-auto runs `git commit` inside a macOS seatbelt sandbox. With
 * NODE_USE_SYSTEM_CA=1 in the environment, Node 22+ reads the Keychain on its
 * first TLS connection; the sandbox refuses ("SecItemCopyMatching failed -50")
 * and Node segfaults. The pre-commit hook exited 139, the commit aborted, and
 * the agent recommitted with --no-verify — no secret scan, no policies
 * (dep-179, PR #2398). Reproduced on this machine with
 *   codex sandbox -c sandbox_mode=workspace-write -- \
 *     /opt/homebrew/bin/node -e 'require("tls").createSecureContext()'   → 139
 * while the same command with NODE_USE_SYSTEM_CA unset exits 0.
 *
 * These run the REAL generated hook through /bin/sh with stand-ins: a fake
 * `origin` that segfaults (kill -SEGV) when NODE_USE_SYSTEM_CA=1 and the
 * "Keychain" is denied, and a fake `security` / `uname` for the probe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  KEYCHAIN_GUARD_MARKER,
  installGitCommitMsgHook,
  installGitPostCommitHook,
  installGitPreCommitHook,
  installGitPrepareCommitMsgHook,
  installGitPrePushHook,
  upgradeLocalHookPreamble,
  upgradeOutdatedGlobalHooks,
  writeGlobalCommitMsgHook,
  writeGlobalPreCommitHook,
} from '../commands/enable.js';
import { installRewriteHooks } from '../history-preservation.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('global git hooks survive a Keychain-less sandbox', () => {
  let root: string;
  let bin: string;
  let hooks: string;
  let log: string;
  let savedPath: string | undefined;

  /**
   * keychain: what `security list-keychains` answers. crash: whether the fake
   * CLI segfaults under NODE_USE_SYSTEM_CA=1 (what real Node does when the
   * Keychain is denied). exitCode: what the fake CLI returns otherwise.
   */
  function setup(opts: { keychain: 'ok' | 'denied'; crash: boolean; exitCode?: number }) {
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\nexit ${opts.keychain === 'ok' ? 0 : 1}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'origin'), `#!/bin/sh
echo "CA=$NODE_USE_SYSTEM_CA args=$*" >> "${log}"
if [ "$NODE_USE_SYSTEM_CA" = "1" ] && [ "${opts.crash ? 1 : 0}" = "1" ]; then
  echo "ERROR: SecItemCopyMatching failed -50" >&2
  kill -SEGV $$
fi
exit ${opts.exitCode ?? 0}
`, { mode: 0o755 });
    // resolveOriginBin() looks `origin` up on PATH when the hook is written.
    process.env.PATH = `${bin}:${savedPath}`;
    writeGlobalPreCommitHook(hooks);
    writeGlobalCommitMsgHook(hooks);
  }

  function runHook(name: string, env: Record<string, string> = {}) {
    const r = spawnSync('/bin/sh', [path.join(hooks, name), path.join(root, 'MSG')], {
      cwd: root,
      encoding: 'utf-8',
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, ...env },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : [];
    return { status: r.status, stderr: r.stderr, calls };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-keychain-'));
    bin = path.join(root, 'bin');
    hooks = path.join(root, 'git-hooks');
    log = path.join(root, 'calls.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(hooks);
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the fake CLI really crashes the way Node does (the bug, pre-guard)', () => {
    setup({ keychain: 'denied', crash: true });
    // Spawned directly, not through `sh -c`: dash (Ubuntu's /bin/sh) forks
    // the command instead of exec'ing it, so the SIGSEGV would surface as the
    // outer shell's exit 139 with no signal.
    const r = spawnSync(path.join(bin, 'origin'), ['hooks', 'git-pre-commit'], {
      encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', NODE_USE_SYSTEM_CA: '1' },
    });
    expect(r.signal).toBe('SIGSEGV');
    expect(r.stderr).toContain('SecItemCopyMatching failed -50');
  });

  it('pre-commit runs on the bundled CA store when the Keychain is denied, and says why', () => {
    setup({ keychain: 'denied', crash: true });
    const r = runHook('pre-commit', { NODE_USE_SYSTEM_CA: '1' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['CA=0 args=hooks git-pre-commit']);
    expect(r.stderr).toContain('Keychain unreachable');
    expect(r.stderr).not.toContain('SecItemCopyMatching');
  });

  it('commit-msg gets the same guard', () => {
    setup({ keychain: 'denied', crash: true });
    const r = runHook('commit-msg', { NODE_USE_SYSTEM_CA: '1' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([`CA=0 args=hooks git-commit-msg ${path.join(root, 'MSG')}`]);
  });

  it('a policy block still blocks — the guard only changes the CA store', () => {
    setup({ keychain: 'denied', crash: true, exitCode: 1 });
    const r = runHook('pre-commit', { NODE_USE_SYSTEM_CA: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['CA=0 args=hooks git-pre-commit']);
  });

  it('a crash the probe missed is retried once without NODE_USE_SYSTEM_CA', () => {
    // Keychain listable, but the CLI still dies — some other sandbox shape.
    setup({ keychain: 'ok', crash: true });
    const r = runHook('pre-commit', { NODE_USE_SYSTEM_CA: '1' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['CA=1 args=hooks git-pre-commit', 'CA=0 args=hooks git-pre-commit']);
    expect(r.stderr).toContain('retrying on Node\'s bundled CA store');
  });

  it('leaves NODE_USE_SYSTEM_CA alone when the Keychain is reachable', () => {
    setup({ keychain: 'ok', crash: false });
    const r = runHook('pre-commit', { NODE_USE_SYSTEM_CA: '1' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['CA=1 args=hooks git-pre-commit']);
    expect(r.stderr).toBe('');
  });

  it('does not probe at all when NODE_USE_SYSTEM_CA is unset', () => {
    setup({ keychain: 'denied', crash: true });
    const r = runHook('pre-commit');
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['CA= args=hooks git-pre-commit']);
    expect(r.stderr).toBe('');
  });

  it('upgrades Origin hooks written before the guard, and only those', () => {
    setup({ keychain: 'ok', crash: false });
    const old = fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf-8')
      .split('\n').filter((l) => !l.includes(KEYCHAIN_GUARD_MARKER)).join('\n');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), old);
    const users = '#!/bin/sh\n# my own post-merge\nexit 0\n';
    fs.writeFileSync(path.join(hooks, 'post-merge'), users);

    expect(upgradeOutdatedGlobalHooks(hooks)).toEqual(['pre-commit']);
    expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf-8')).toContain(KEYCHAIN_GUARD_MARKER);
    expect(fs.readFileSync(path.join(hooks, 'post-merge'), 'utf-8')).toBe(users);
    // Idempotent.
    expect(upgradeOutdatedGlobalHooks(hooks)).toEqual([]);
  });
});

posixOnly('repo-local git hooks survive a Keychain-less sandbox', () => {
  let root: string;
  let bin: string;
  let log: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-local-keychain-'));
    bin = path.join(root, 'bin');
    log = path.join(root, 'calls.log');
    fs.mkdirSync(bin);
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'origin'), `#!/bin/sh
echo "CA=$NODE_USE_SYSTEM_CA args=$*" >> "${log}"
if [ "$NODE_USE_SYSTEM_CA" = "1" ]; then kill -SEGV $$; fi
`, { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const hooks = [
    { name: 'pre-commit', install: installGitPreCommitHook, args: [] },
    { name: 'commit-msg', install: installGitCommitMsgHook, args: ['MSG'] },
    { name: 'prepare-commit-msg', install: installGitPrepareCommitMsgHook, args: ['MSG', 'message', ''] },
    { name: 'post-commit', install: installGitPostCommitHook, args: [] },
    { name: 'pre-push', install: installGitPrePushHook, args: [] },
    { name: 'post-rewrite', install: installRewriteHooks, args: [] },
    { name: 'post-checkout', install: installRewriteHooks, args: ['old', 'new', '1'] },
  ];

  it.each(hooks)('$name runs Origin with bundled CAs when Keychain access is denied', async ({ name, install, args }) => {
    install(root);
    const hook = path.join(root, '.git', 'hooks', name);
    const r = spawnSync('/bin/sh', [hook, ...args], {
      cwd: root,
      input: name === 'post-rewrite' ? 'old new\n' : '',
      encoding: 'utf-8',
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin`, NODE_USE_SYSTEM_CA: '1' },
    });
    expect(r.status).toBe(0);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fs.readFileSync(log, 'utf-8')).toContain('CA=0 args=hooks');
    expect(r.stderr).not.toContain('SecItemCopyMatching');
  });

  it('a commit-msg hook that only gets the preamble logs "already installed", not "installed"', () => {
    const hook = path.join(root, '.git', 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\n# origin-commit-msg\norigin hooks git-commit-msg "$1"\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      installGitCommitMsgHook(root);
      expect(log.mock.calls.flat().join('\n')).toContain('already installed');
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/hook installed \(commit message policies\)/);
    } finally {
      log.mockRestore();
    }
    expect(fs.readFileSync(hook, 'utf-8')).toContain(KEYCHAIN_GUARD_MARKER);
  });

  it('the upgrade puts the preamble before Origin\'s own marker line, not a user comment that contains it', () => {
    const hook = path.join(root, 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\n# origin-post-checkout TODO: integrate\necho mine\n\n# origin-post-checkout\norigin hooks git-post-checkout "$@"\n');
    expect(upgradeLocalHookPreamble(hook, '# origin-post-checkout')).toBe(true);
    const lines = fs.readFileSync(hook, 'utf-8').split('\n');
    const guard = lines.findIndex((l) => l.includes(KEYCHAIN_GUARD_MARKER));
    expect(guard).toBeGreaterThan(lines.indexOf('echo mine'));
    expect(guard).toBeLessThan(lines.indexOf('# origin-post-checkout'));
    // A file with only the look-alike comment is not Origin's: left alone.
    const users = '#!/bin/sh\n# origin-post-checkout TODO: integrate\n';
    fs.writeFileSync(hook, users);
    expect(upgradeLocalHookPreamble(hook, '# origin-post-checkout')).toBe(false);
    expect(fs.readFileSync(hook, 'utf-8')).toBe(users);
  });

  it.each(['post-rewrite', 'post-checkout'])('a fresh %s puts the preamble before the marker, like every other path', (name) => {
    installRewriteHooks(root);
    const script = fs.readFileSync(path.join(root, '.git', 'hooks', name), 'utf-8');
    expect(script.indexOf(KEYCHAIN_GUARD_MARKER)).toBeGreaterThan(0);
    expect(script.indexOf(KEYCHAIN_GUARD_MARKER)).toBeLessThan(script.indexOf(`# origin-${name}\n`));
  });
});
