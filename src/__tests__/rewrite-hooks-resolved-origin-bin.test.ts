/**
 * The repo-local post-rewrite and post-checkout hooks launch the CLI the shared
 * preamble resolved ("$ORIGIN_BIN"), like every other hook — not `origin` by
 * name.
 *
 * By name they ran whatever came first on the PATH the preamble builds, which
 * starts with /opt/homebrew/bin. On a machine with a Homebrew `origin` and an
 * nvm one, rebase and checkout ran the Homebrew CLI while every other hook ran
 * the one `enable` chose; git-hook-keychain-guard.test.ts failed there because
 * the rewrite hooks never reached its stub. Here a decoy `origin` placed ahead
 * of the stub on the hook's PATH plays the Homebrew one, on any machine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KEYCHAIN_GUARD_MARKER, hookShimPreamble } from '../commands/enable.js';
import { installRewriteHooks, useResolvedOriginBin } from '../history-preservation.js';
import { CAPTURE_REWRITES, detachedWithRewrites } from '../post-rewrite-hook-stdin.js';
import { detachedLaunch, indentFragment } from '../hook-detach.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const BARE = /(^|[ \t|;(])origin hooks git-post-(rewrite|checkout)/m;

posixOnly('rewrite hooks launch the resolved "$ORIGIN_BIN"', () => {
  let root: string;
  let bin: string;
  let decoy: string;
  let savedPath: string | undefined;

  const hookPath = (name: string) => path.join(root, '.git', 'hooks', name);
  const read = (name: string) => fs.readFileSync(hookPath(name), 'utf-8');

  function fakeOrigin(dir: string) {
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'origin'), `#!/bin/sh\necho "args=$*" >> "${log}"\n`, { mode: 0o755 });
    return log;
  }

  /** Run a hook with the decoy ahead of the real stub on PATH; true when the stub (and not the decoy) was launched. */
  async function launchesTheResolvedCli(name: string, args: string[]) {
    const stubLog = path.join(bin, 'calls.log');
    const decoyLog = path.join(decoy, 'calls.log');
    const r = spawnSync('/bin/sh', [hookPath(name), ...args], {
      cwd: root,
      input: name === 'post-rewrite' ? 'old new\n' : '',
      encoding: 'utf-8',
      env: { HOME: root, PATH: `${decoy}:${bin}:/usr/bin:/bin` },
    });
    expect(r.status).toBe(0);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(stubLog) && !fs.existsSync(decoyLog) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(decoyLog)).toBe(false);
    expect(fs.readFileSync(stubLog, 'utf-8')).toContain(`args=hooks git-${name}`);
  }

  /** The hooks as the CLI wrote them before they used "$ORIGIN_BIN". */
  function writeOldHooks(userTail = '') {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(hookPath('post-rewrite'), [
      '#!/bin/sh',
      hookShimPreamble(),
      '# origin-post-rewrite',
      CAPTURE_REWRITES,
      detachedWithRewrites('origin hooks git-post-rewrite "$@"'),
    ].join('\n') + '\n', { mode: 0o755 });
    fs.writeFileSync(hookPath('post-checkout'), [
      '#!/bin/sh',
      hookShimPreamble(),
      '# origin-post-checkout',
      'if [ "$3" = "1" ]; then',
      `  ${indentFragment(detachedLaunch('origin hooks git-post-checkout "$@"'), '  ')}`,
      'fi',
    ].join('\n') + '\n' + userTail, { mode: 0o755 });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-rewrite-bin-'));
    bin = path.join(root, 'bin');
    decoy = path.join(root, 'decoy');
    fs.mkdirSync(bin);
    fs.mkdirSync(decoy);
    spawnSync('git', ['init', '-q'], { cwd: root });
    fakeOrigin(bin);
    fakeOrigin(decoy);
    savedPath = process.env.PATH;
    // resolveOriginBin() looks `origin` up on PATH when the hook is written:
    // the stub is the CLI `enable` chose.
    process.env.PATH = `${bin}:${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['post-rewrite', []],
    ['post-checkout', ['old', 'new', '1']],
  ])('a fresh %s launches "$ORIGIN_BIN", not the first `origin` on PATH', async (name, args) => {
    installRewriteHooks(root);
    expect(read(name)).toContain(`"$ORIGIN_BIN" hooks git-${name} "$@"`);
    expect(read(name)).not.toMatch(BARE);
    await launchesTheResolvedCli(name, args);
  });

  it.each([
    ['post-rewrite', []],
    ['post-checkout', ['old', 'new', '1']],
  ])('enable rewrites an old %s to "$ORIGIN_BIN"; a second enable changes nothing', async (name, args) => {
    writeOldHooks();
    installRewriteHooks(root);
    const once = read(name);
    expect(once).toContain(`"$ORIGIN_BIN" hooks git-${name} "$@"`);
    expect(once).not.toMatch(BARE);
    installRewriteHooks(root);
    expect(read(name)).toBe(once);
    await launchesTheResolvedCli(name, args);
  });

  it('a hook from before the preamble gets the preamble, the stdin repair and "$ORIGIN_BIN"', () => {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(hookPath('post-rewrite'), '#!/bin/sh\n# origin-post-rewrite\norigin hooks git-post-rewrite "$@" &\n');
    installRewriteHooks(root);
    const once = read('post-rewrite');
    expect(once).toContain(KEYCHAIN_GUARD_MARKER);
    expect(once).toContain(CAPTURE_REWRITES);
    expect(once).toContain('"$ORIGIN_BIN" hooks git-post-rewrite "$@"');
    expect(once).not.toMatch(BARE);
    installRewriteHooks(root);
    expect(read('post-rewrite')).toBe(once);
  });

  it('only Origin\'s block is rewritten: the user\'s lines around it stay as they are', () => {
    const userTail = 'echo mine; origin hooks git-post-checkout "$@"\n';
    writeOldHooks(userTail);
    const head = '#!/bin/sh\norigin hooks git-post-checkout "$@" # my own\n';
    fs.writeFileSync(hookPath('post-checkout'), read('post-checkout').replace('#!/bin/sh\n', head));
    installRewriteHooks(root);
    const script = read('post-checkout');
    expect(script.startsWith(head)).toBe(true);
    expect(script.endsWith(`fi\n${userTail}`)).toBe(true);
    const block = script.slice(script.indexOf('# origin-post-checkout\n'), script.lastIndexOf(`fi\n${userTail}`));
    expect(block).toContain('"$ORIGIN_BIN" hooks git-post-checkout "$@"');
    expect(block).not.toMatch(BARE);
  });

  it('useResolvedOriginBin leaves a script without the preamble, or without Origin\'s marker, alone', () => {
    const noPreamble = '#!/bin/sh\n# origin-post-rewrite\norigin hooks git-post-rewrite "$@" &\n';
    expect(useResolvedOriginBin(noPreamble, '# origin-post-rewrite')).toBeNull();
    const users = `#!/bin/sh\n${KEYCHAIN_GUARD_MARKER}\norigin hooks git-post-rewrite "$@" &\n`;
    expect(useResolvedOriginBin(users, '# origin-post-rewrite')).toBeNull();
  });
});
