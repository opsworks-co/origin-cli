// Replace the globally installed CLI without a moment in which `origin` is gone.
//
// `npm install -g <tarball>` removes the old package and its bin link before it
// writes the new ones. Measured on a quiet Mac, `bin/origin` did not resolve for
// ~750 ms of a 3 s reinstall; under load, longer. Every hook that fires then
// (`PATH=… origin hooks claude-code …`) exits 127 and is lost. Session 1476cd52
// (2026-09-27): a sibling's `origin upgrade` ran as the user submitted a prompt,
// UserPromptSubmit failed with "origin: command not found", no turn was opened,
// and the commit that prompt made was attested to the turn before it.
//
// Two renames (live → old, staged → live) are not enough: a loaded machine can
// deschedule the process between them for milliseconds, and a 5 ms poller saw
// the gap in 2 of 25 runs. Only ONE rename(2) is atomic, and rename over an
// existing symlink replaces it in one step. So the package lives in a
// versioned directory beside its npm name, and `<root>/@origin/cli` is a
// symlink to it:
//
//   @origin/cli              -> .cli-<version>-<tag>     (swapped by one rename)
//   @origin/.cli-<version>-<tag>/dist/index.js
//   bin/origin               -> ../lib/node_modules/@origin/cli/dist/index.js
//
// The first upgrade finds a real directory at `@origin/cli`. It points
// `bin/origin` straight at the new copy (one rename), converts the directory to
// the symlink, then points `bin/origin` back at its npm path (one rename).
// `origin` resolves at every instant of both.
//
// Anything unusual — Windows (no symlinked bins; a directory in use cannot be
// renamed), no live copy, a bin that is not a symlink, a staged tree that is
// not the version asked for, a failed step — falls back to the in-place
// `npm install -g` this replaced, after putting back whatever it had moved.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface AtomicInstallDeps {
  /** `npm root -g`. */
  globalRoot?: () => string;
  /** Runs npm with these args; throws on failure. */
  npm?: (args: string[]) => void;
  platform?: NodeJS.Platform;
  log?: (msg: string) => void;
}

export type AtomicInstallResult =
  | { ok: true; how: 'swapped' | 'npm-install' }
  | { ok: false; error: string };

// A staging copy older than this is nobody's work in progress, and a copy
// replaced this long ago has no hook still running from it.
const STALE_MS = 60 * 60 * 1000;

function npmBin(): string { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

function defaultNpm(args: string[]): void {
  execFileSync(npmBin(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

function defaultGlobalRoot(): string {
  return execFileSync(npmBin(), ['root', '-g'], {
    windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim();
}

function versionAt(dir: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function isSymlink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Point `link` at `target` in one rename, whatever `link` was before. */
function swapLink(link: string, target: string, tag: string): void {
  const tmp = `${link}.tmp-${tag}`;
  try { fs.unlinkSync(tmp); } catch { /* none */ }
  fs.symlinkSync(target, tmp);
  try {
    fs.renameSync(tmp, link);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw err;
  }
}

/**
 * Install `tarball` as the global @origin/cli. `expectedVersion`, when given,
 * must be what the staged package says it is before it replaces anything.
 */
export function installGlobalAtomically(
  tarball: string,
  expectedVersion: string | null,
  deps: AtomicInstallDeps = {},
): AtomicInstallResult {
  const npm = deps.npm || defaultNpm;
  const log = deps.log || (() => {});
  const platform = deps.platform || process.platform;

  const plain = (why: string): AtomicInstallResult => {
    log(`installing in place (${why})`);
    try {
      npm(['install', '-g', tarball]);
      return { ok: true, how: 'npm-install' };
    } catch (err: any) {
      return { ok: false, error: String(err?.stderr || err?.message || err) };
    }
  };

  if (platform === 'win32') return plain('Windows has no symlinked bin to swap');
  let root: string;
  try { root = (deps.globalRoot || defaultGlobalRoot)(); } catch { return plain('npm root -g failed'); }
  if (!root) return plain('npm root -g said nothing');
  const scope = path.join(root, '@origin');
  const live = path.join(scope, 'cli');
  const binDir = path.resolve(root, '..', '..', 'bin');
  const bin = path.join(binDir, 'origin');
  if (!fs.existsSync(path.join(live, 'package.json'))) return plain('no installed copy to swap');
  if (!isSymlink(bin)) return plain('bin/origin is not a symlink');

  const tag = `${process.pid}-${Date.now()}`;
  const cleanup = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };

  // 1. Stage: a global install into a prefix inside the scope — the same
  //    filesystem as `live`, and `lib/node_modules/@origin/cli` with its
  //    dependencies nested, the shape npm gives the live copy.
  const stagingPrefix = path.join(scope, `.cli-staging-${tag}`);
  try {
    npm(['install', '-g', '--prefix', stagingPrefix, tarball]);
  } catch (err: any) {
    cleanup(stagingPrefix);
    return plain(`staging install failed: ${String(err?.message || err).split('\n')[0]}`);
  }
  const staged = path.join(stagingPrefix, 'lib', 'node_modules', '@origin', 'cli');
  const stagedVersion = versionAt(staged);
  if (!fs.existsSync(path.join(staged, 'dist', 'index.js')) || !stagedVersion
    || (expectedVersion && stagedVersion !== expectedVersion)) {
    cleanup(stagingPrefix);
    return plain(`staged copy is not ${expectedVersion || 'a CLI'} (found ${stagedVersion || 'nothing'})`);
  }
  const versionedName = `.cli-${stagedVersion}-${tag}`;
  const versioned = path.join(scope, versionedName);
  try {
    fs.renameSync(staged, versioned);
  } catch (err: any) {
    cleanup(stagingPrefix);
    return plain(`could not place the staged copy: ${err?.code || err}`);
  }
  cleanup(stagingPrefix);
  try { fs.chmodSync(path.join(versioned, 'dist', 'index.js'), 0o755); } catch { /* npm set it */ }

  const npmTarget = path.relative(binDir, path.join(live, 'dist', 'index.js'));
  let replaced: string | null = null;
  try {
    if (isSymlink(live)) {
      // 2a. Every upgrade after the first: one rename.
      replaced = path.resolve(scope, fs.readlinkSync(live));
      swapLink(live, versionedName, tag);
    } else {
      // 2b. The first: keep `origin` on the new copy while the npm directory
      //     becomes a symlink, then hand it back to its npm path.
      swapLink(bin, path.relative(binDir, path.join(versioned, 'dist', 'index.js')), tag);
      const old = path.join(scope, `.cli-old-${tag}`);
      try {
        fs.renameSync(live, old);
        swapLink(live, versionedName, tag);
      } catch (err) {
        if (!fs.existsSync(live) && fs.existsSync(old)) { try { fs.renameSync(old, live); } catch { /* */ } }
        try { swapLink(bin, npmTarget, tag); } catch { /* */ }
        throw err;
      }
      replaced = old;
      swapLink(bin, npmTarget, tag);
    }
  } catch (err: any) {
    cleanup(versioned);
    return plain(`could not swap the new copy in: ${err?.code || err}`);
  }

  // 3. What the swap replaced. The first upgrade's `.cli-old-*` was the real
  //    `@origin/cli`: processes running from it name their files by that path,
  //    which now reaches the new copy, so it can go. A versioned copy is the
  //    real path of every module a running process loaded, and a process
  //    that started a moment ago can still `import()` a file from it — so it
  //    stays until it is stale, counted from now, not from when it was
  //    installed. Daemons leave it long before that: they read the installed
  //    version through `@origin/cli` (live-install-path.ts) and restart.
  //    Copies an interrupted upgrade left behind long ago go too — never the
  //    one `cli` points at now.
  const current = (() => { try { return path.resolve(scope, fs.readlinkSync(live)); } catch { return versioned; } })();
  if (replaced && replaced !== current && path.dirname(replaced) === scope) {
    if (path.basename(replaced).startsWith('.cli-old-')) cleanup(replaced);
    else { try { const now = new Date(); fs.utimesSync(replaced, now, now); } catch { /* swept by age */ } }
  }
  try {
    for (const name of fs.readdirSync(scope)) {
      if (!name.startsWith('.cli-')) continue;
      const p = path.join(scope, name);
      if (p === current) continue;
      let age = 0;
      try { age = Date.now() - fs.lstatSync(p).mtimeMs; } catch { continue; }
      if (age > STALE_MS) cleanup(p);
    }
  } catch { /* best effort */ }

  log(`swapped ${stagedVersion} in`);
  return { ok: true, how: 'swapped' };
}
