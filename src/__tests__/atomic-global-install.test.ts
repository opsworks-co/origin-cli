// `origin upgrade` never leaves a moment in which `origin` is not on disk —
// see atomic-global-install.ts. Session 1476cd52 (2026-09-27) lost a prompt's
// submit hook to "origin: command not found" while a sibling upgraded.
//
// Driven with real npm against a scratch prefix and a tiny @origin/cli
// tarball, with a poller that watches the bin while the install runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { installGlobalAtomically } from '../atomic-global-install.js';
import { throughLiveInstall } from '../live-install-path.js';

const posix = process.platform !== 'win32';
let dir: string;
let prefix: string;
let root: string;
let bin: string;

function pack(version: string): string {
  const src = path.join(dir, `src-${version}`);
  fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({
    name: '@origin/cli', version, bin: { origin: './dist/index.js' },
  }));
  fs.writeFileSync(path.join(src, 'dist', 'index.js'), `#!/usr/bin/env node\nconsole.log('${version}')\n`);
  // Enough files that npm's reify takes a measurable time.
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(src, 'dist', `m${i}.js`), `export const x${i} = ${i};\n`);
  const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: src, encoding: 'utf-8' }).trim().split('\n').pop()!;
  return path.join(dir, out);
}

const npmIntoPrefix = (args: string[]) => {
  // The plain path installs into the test prefix, not the machine's.
  const withPrefix = args.includes('--prefix') ? args : [...args.slice(0, 2), '--prefix', prefix, ...args.slice(2)];
  execFileSync('npm', withPrefix, { stdio: ['ignore', 'pipe', 'pipe'] });
};

/** Polls `bin` every 1 ms until `stop` exists; resolves to [polls, misses]. */
function watchBin(stop: string): Promise<[number, number]> {
  const script = `
    const fs=require('fs');let n=0,miss=0;
    const t=setInterval(()=>{n++;try{fs.statSync(${JSON.stringify(bin)})}catch{miss++}
      if(fs.existsSync(${JSON.stringify(stop)})){clearInterval(t);console.log(n+' '+miss)}},1);`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { const [n, m] = out.trim().split(' ').map(Number); resolve([n, m]); });
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-atomic-install-'));
  prefix = path.join(dir, 'prefix');
  root = path.join(prefix, 'lib', 'node_modules');
  bin = path.join(prefix, 'bin', 'origin');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe.skipIf(!posix)('installing the CLI over itself', () => {
  it('npm install -g leaves a window with no bin (the bug this replaces)', async () => {
    npmIntoPrefix(['install', '-g', pack('1.0.0')]);
    const next = pack('1.0.1');
    const stop = path.join(dir, 'stop');
    const watching = watchBin(stop);
    await new Promise((r) => setTimeout(r, 50));
    npmIntoPrefix(['install', '-g', next]);
    fs.writeFileSync(stop, '');
    const [polls, misses] = await watching;
    expect(polls).toBeGreaterThan(0);
    expect(misses).toBeGreaterThan(0);
  }, 120_000);

  it('the atomic install never leaves the bin missing — first upgrade and every one after', async () => {
    npmIntoPrefix(['install', '-g', pack('1.0.0')]);
    const next = ['1.0.1', '1.0.2', '1.0.3'].map((v) => [v, pack(v)] as const);
    const stop = path.join(dir, 'stop');
    const watching = watchBin(stop);
    await new Promise((r) => setTimeout(r, 50));
    const results = next.map(([v, tgz]) => {
      const res = installGlobalAtomically(tgz, v, { globalRoot: () => root, npm: npmIntoPrefix, platform: 'darwin' });
      return [res, execFileSync(bin, { encoding: 'utf-8' }).trim()];
    });
    fs.writeFileSync(stop, '');
    const [polls, misses] = await watching;
    expect(results).toEqual(next.map(([v]) => [{ ok: true, how: 'swapped' }, v]));
    expect(polls).toBeGreaterThan(100);
    expect(misses).toBe(0);
    // `cli` is a symlink to the live copy. The first upgrade's old npm
    // directory is gone; the versioned copies it replaced since are kept for
    // the hooks still running from them.
    const scope = path.join(root, '@origin');
    const left = fs.readdirSync(scope).sort();
    expect(left.map((n) => n.split('-').slice(0, 2).join('-'))).toEqual(['.cli-1.0.1', '.cli-1.0.2', '.cli-1.0.3', 'cli']);
    expect(fs.lstatSync(path.join(scope, 'cli')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(scope, 'cli'))).toBe(left[2]);
    // npm's own view of the install still reads through the symlink.
    expect(JSON.parse(fs.readFileSync(path.join(scope, 'cli', 'package.json'), 'utf-8')).version).toBe('1.0.3');
    expect(fs.readlinkSync(bin)).toBe('../lib/node_modules/@origin/cli/dist/index.js');
  }, 180_000);

  it('a replaced copy outlives the swap by an hour, counted from the swap', async () => {
    npmIntoPrefix(['install', '-g', pack('1.0.0')]);
    const deps = { globalRoot: () => root, npm: npmIntoPrefix, platform: 'darwin' as const };
    installGlobalAtomically(pack('1.0.1'), '1.0.1', deps);
    const scope = path.join(root, '@origin');
    const v1 = path.join(scope, fs.readlinkSync(path.join(scope, 'cli')));
    // Installed "long ago": the age that matters is time since it was replaced.
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(v1, longAgo, longAgo);

    installGlobalAtomically(pack('1.0.2'), '1.0.2', deps);
    // A hook that loaded its modules from 1.0.1 a moment ago can still import
    // the rest of them.
    expect(fs.existsSync(path.join(v1, 'dist', 'm399.js'))).toBe(true);
    await expect(import(pathToFileURL(path.join(v1, 'dist', 'm7.js')).href)).resolves.toMatchObject({ x7: 7 });

    // Once it has been replaced for an hour, the next upgrade sweeps it.
    fs.utimesSync(v1, longAgo, longAgo);
    installGlobalAtomically(pack('1.0.3'), '1.0.3', deps);
    expect(fs.existsSync(v1)).toBe(false);
    expect(fs.readdirSync(scope).map((n) => n.split('-').slice(0, 2).join('-')).sort()).toEqual(['.cli-1.0.2', '.cli-1.0.3', 'cli']);
  }, 180_000);

  it('a path inside the running copy reads the installed version through `@origin/cli`', () => {
    npmIntoPrefix(['install', '-g', pack('1.0.0')]);
    const deps = { globalRoot: () => root, npm: npmIntoPrefix, platform: 'darwin' as const };
    installGlobalAtomically(pack('1.0.1'), '1.0.1', deps);
    const scope = path.join(root, '@origin');
    const v1 = path.join(scope, fs.readlinkSync(path.join(scope, 'cli')));
    // What a daemon started from 1.0.1 sees as its own directory: Node's real path.
    const ownDir = fs.realpathSync(path.join(scope, 'cli', 'dist'));
    expect(ownDir).toBe(fs.realpathSync(path.join(v1, 'dist')));

    installGlobalAtomically(pack('1.0.2'), '1.0.2', deps);
    const version = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf-8')).version;
    // Read from its own copy it would never notice the upgrade; read through
    // the npm name it does, and restarts onto 1.0.2.
    expect(version(ownDir)).toBe('1.0.1');
    expect(version(throughLiveInstall(ownDir))).toBe('1.0.2');
    expect(throughLiveInstall(ownDir)).toBe(path.join(fs.realpathSync(scope), 'cli', 'dist'));
  }, 180_000);

  it('keeps the live copy when the staged one is not the version asked for', () => {
    npmIntoPrefix(['install', '-g', pack('1.0.0')]);
    const logs: string[] = [];
    const res = installGlobalAtomically(pack('1.0.1'), '9.9.9', {
      globalRoot: () => root, npm: npmIntoPrefix, platform: 'darwin', log: (m) => logs.push(m),
    });
    // Falls back to the in-place install npm always did, and says why.
    expect(res).toEqual({ ok: true, how: 'npm-install' });
    expect(logs.join('\n')).toMatch(/staged copy is not 9\.9\.9 \(found 1\.0\.1\)/);
    expect(fs.readdirSync(path.join(root, '@origin'))).toEqual(['cli']);
  }, 120_000);

  it('installs in place when there is no copy to swap', () => {
    const res = installGlobalAtomically(pack('1.0.0'), '1.0.0', { globalRoot: () => root, npm: npmIntoPrefix, platform: 'darwin' });
    expect(res).toEqual({ ok: true, how: 'npm-install' });
    expect(execFileSync(bin, { encoding: 'utf-8' }).trim()).toBe('1.0.0');
  }, 120_000);

  it('on Windows, installs in place', () => {
    const calls: string[][] = [];
    const res = installGlobalAtomically('x.tgz', '1.0.0', { npm: (a) => { calls.push(a); }, platform: 'win32' });
    expect(res).toEqual({ ok: true, how: 'npm-install' });
    expect(calls).toEqual([['install', '-g', 'x.tgz']]);
  });
});

describe('throughLiveInstall', () => {
  let scope: string;
  beforeEach(() => {
    scope = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-live-path-')), 'lib', 'node_modules', '@origin');
    fs.mkdirSync(path.join(scope, '.cli-1.2.3-99-1', 'dist'), { recursive: true });
  });

  it.skipIf(!posix)('maps a versioned copy to `@origin/cli` while that exists', () => {
    const inside = path.join(scope, '.cli-1.2.3-99-1', 'dist');
    expect(throughLiveInstall(inside)).toBe(inside);
    fs.symlinkSync('.cli-1.2.3-99-1', path.join(scope, 'cli'));
    expect(throughLiveInstall(inside)).toBe(path.join(scope, 'cli', 'dist'));
    expect(throughLiveInstall(path.join(scope, '.cli-1.2.3-99-1'))).toBe(path.join(scope, 'cli'));
  });

  it('leaves every other path alone', () => {
    fs.mkdirSync(path.join(scope, 'cli'));
    for (const p of [
      path.join(scope, 'cli', 'dist'),
      path.join(scope, '.cli-staging-99-1', 'lib', 'node_modules', '@origin', 'cli', 'dist'),
      path.join(scope, '.cli-old-99-1', 'dist'),
      '/Users/me/origin/packages/cli/dist',
      path.join(scope, '..', 'other', '.cli-1.2.3', 'dist'),
    ]) expect(throughLiveInstall(p)).toBe(p);
  });
});
