/**
 * The hooks that start the CLI must outlive the agent that ran git.
 *
 * Codex kills whatever a git command's hooks leave running once its shell
 * command exits (session 7383ad5a). Each hook script below runs in its own
 * process group, killed the moment it returns; the CLI stand-in starts late
 * and must still run. Driven against the REAL generated scripts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DETACH_MARKER, upgradeOutdatedGlobalHooks, upgradePostCommitHookScript, writeGlobalPostCheckoutHook, writeGlobalPostMergeHook,
} from '../commands/enable.js';
import { repairInstalledLocalPostCheckoutHook, repairLocalPostCheckoutScript } from '../history-preservation.js';
import { detachedLaunch, hasUnsyncedDetach } from '../hook-detach.js';
import { repairLocalPostRewriteScript } from '../post-rewrite-hook-stdin.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-detach-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function patchOriginBin(hookPath: string, bin: string) {
  const src = fs.readFileSync(hookPath, 'utf-8');
  const start = src.indexOf('ORIGIN_BIN=""');
  const end = src.indexOf('\nfi\n', start);
  expect(start).toBeGreaterThan(-1);
  fs.writeFileSync(hookPath, src.slice(0, start) + `ORIGIN_BIN="${bin}"` + src.slice(end + '\nfi'.length));
  fs.chmodSync(hookPath, '755');
}

function lateOrigin(seen: string): string {
  const bin = path.join(dir, 'late-origin');
  fs.writeFileSync(bin, `#!/bin/sh\nsleep 1\necho "$*" > "${seen}.tmp"\nmv "${seen}.tmp" "${seen}"\n`);
  fs.chmodSync(bin, '755');
  return bin;
}

/** Run the hook in its own process group and kill the group when it returns. */
const runThenKillGroup = (hook: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn('sh', [hook, ...args], { cwd: dir, detached: true, stdio: 'ignore' });
  child.on('error', reject);
  child.on('exit', () => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already gone */ }
    resolve();
  });
});

async function waitForFile(file: string, ms: number): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8').trim();
    await new Promise((r) => setTimeout(r, 50));
  }
  return '<the CLI never ran>';
}

describe.skipIf(process.platform === 'win32')('a killed process group does not take the hook\'s CLI with it', () => {
  it('post-checkout', async () => {
    writeGlobalPostCheckoutHook(dir);
    const seen = path.join(dir, 'seen');
    patchOriginBin(path.join(dir, 'post-checkout'), lateOrigin(seen));
    await runThenKillGroup(path.join(dir, 'post-checkout'), ['a'.repeat(40), 'b'.repeat(40), '1']);
    expect(await waitForFile(seen, 10_000)).toBe(`hooks git-post-checkout ${'a'.repeat(40)} ${'b'.repeat(40)} 1`);
  }, 20_000);

  it('post-merge', async () => {
    writeGlobalPostMergeHook(dir);
    const seen = path.join(dir, 'seen');
    patchOriginBin(path.join(dir, 'post-merge'), lateOrigin(seen));
    await runThenKillGroup(path.join(dir, 'post-merge'), ['0']);
    expect(await waitForFile(seen, 10_000)).toBe('hooks git-post-merge');
  }, 20_000);
});

describe('hooks installed before the detached launch are upgraded', () => {
  it('rewrites an outdated global post-merge, then leaves it alone', () => {
    writeGlobalPostMergeHook(dir);
    const hook = path.join(dir, 'post-merge');
    // What an older CLI wrote: everything current except the detached launch.
    const current = fs.readFileSync(hook, 'utf-8');
    const start = current.indexOf(DETACH_MARKER);
    const end = current.indexOf('\n  fi\n', start) + '\n  fi'.length;
    fs.writeFileSync(hook, current.slice(0, start) + '"$ORIGIN_BIN" hooks git-post-merge >/dev/null 2>&1 &' + current.slice(end));
    expect(fs.readFileSync(hook, 'utf-8')).not.toContain(DETACH_MARKER);

    expect(upgradeOutdatedGlobalHooks(dir)).toEqual(['post-merge']);
    expect(fs.readFileSync(hook, 'utf-8')).toContain(DETACH_MARKER);
    expect(upgradeOutdatedGlobalHooks(dir)).toEqual([]);
  });

  it('repairs both repo-local post-checkout forms and keeps the user\'s lines', () => {
    const whole = '#!/bin/sh\n# origin-post-checkout\nexport PATH="/x:$PATH"\nif [ "$3" = "1" ]; then\n  origin hooks git-post-checkout "$@" >/dev/null 2>&1 &\nfi\n';
    const fixedWhole = repairLocalPostCheckoutScript(whole)!;
    expect(fixedWhole).toContain(DETACH_MARKER);
    // The detached launch and its plain-& fallback; the old line became them.
    expect(fixedWhole.match(/hooks git-post-checkout/g)).toHaveLength(2);

    const inserted = '#!/bin/sh\n# origin-post-checkout\nif [ "$3" = "1" ]; then\n  ( export PATH="/x:$PATH"; origin hooks git-post-checkout "$@" >/dev/null 2>&1 & )\nfi\necho user-line\n';
    const fixedInserted = repairLocalPostCheckoutScript(inserted)!;
    expect(fixedInserted).toContain(DETACH_MARKER);
    expect(fixedInserted).toContain('( export PATH="/x:$PATH"');
    expect(fixedInserted).toContain('echo user-line');

    expect(repairLocalPostCheckoutScript(fixedWhole)).toBeNull();
    expect(repairLocalPostCheckoutScript(fixedInserted)).toBeNull();
    expect(repairLocalPostCheckoutScript('#!/bin/sh\necho unrelated\n')).toBeNull();
  });

  it('a repaired local post-checkout is valid shell', () => {
    const inserted = '#!/bin/sh\n# origin-post-checkout\nif [ "$3" = "1" ]; then\n  ( export PATH="/x:$PATH"; origin hooks git-post-checkout "$@" >/dev/null 2>&1 & )\nfi\n';
    const p = path.join(dir, 'pc');
    fs.writeFileSync(p, repairLocalPostCheckoutScript(inserted)!);
    const r = spawnSync('sh', ['-n', p], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('the launch has left the process group before the hook returns', () => {
  // The kill lands the instant the launcher returns, leaving no time for a
  // child still on its way out of the group. 1 launch in 10 died before the pipe.
  const launchThenKill = (seen: string) => new Promise<void>((resolve, reject) => {
    const script = `${detachedLaunch(`sh -c 'sleep 0.2; echo ok > "$0"' "${seen}"`)}\nkill -KILL -- -$$\n`;
    const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });

  it('survives a kill with no delay at all', async () => {
    const seen = Array.from({ length: 60 }, (_, i) => path.join(dir, `seen-${i}`));
    for (const f of seen) await launchThenKill(f);
    const until = Date.now() + 10_000;
    while (Date.now() < until && !seen.every((f) => fs.existsSync(f))) await new Promise((r) => setTimeout(r, 50));
    expect(seen.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f))).toEqual([]);
  }, 30_000);
});

describe('hooks written with the launch that could die with its group are upgraded', () => {
  const OLD = 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec @ARGV';
  const age = (script: string) => {
    const now = "pipe(my $r, my $w); if (fork) { close $w; sysread($r, my $b, 1); exit 0 } close $r; POSIX::setsid(); close $w; exit 0 if fork; exec @ARGV";
    expect(script).toContain(now);
    return script.split(now).join(OLD);
  };

  it('a global hook, then never again', () => {
    writeGlobalPostMergeHook(dir);
    const hook = path.join(dir, 'post-merge');
    fs.writeFileSync(hook, age(fs.readFileSync(hook, 'utf-8')));
    expect(upgradeOutdatedGlobalHooks(dir)).toContain('post-merge');
    expect(hasUnsyncedDetach(fs.readFileSync(hook, 'utf-8'))).toBe(false);
    expect(upgradeOutdatedGlobalHooks(dir)).not.toContain('post-merge');
  });

  it('reaches Origin\'s script when another tool moved it aside and wraps it', () => {
    writeGlobalPostMergeHook(dir);
    const hook = path.join(dir, 'post-merge');
    const moved = path.join(dir, 'post-merge.pre-entire');
    fs.writeFileSync(moved, age(fs.readFileSync(hook, 'utf-8')), { mode: 0o755 });
    const wrapper = '#!/bin/sh\n# Entire CLI hooks\n"$(dirname "$0")/post-merge.pre-entire" "$@"\n';
    fs.writeFileSync(hook, wrapper);

    expect(upgradeOutdatedGlobalHooks(dir)).toEqual(['post-merge.pre-entire']);
    const out = fs.readFileSync(moved, 'utf-8');
    expect(hasUnsyncedDetach(out)).toBe(false);
    expect(out).toContain('# origin-global-post-merge\n');
    expect(fs.statSync(moved).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(hook, 'utf-8')).toBe(wrapper);
    expect(upgradeOutdatedGlobalHooks(dir)).toEqual([]);
  });

  it('leaves a sibling the hook in place does not run, and a moved user script', () => {
    writeGlobalPostMergeHook(dir);
    const hook = path.join(dir, 'post-merge');
    const old = age(fs.readFileSync(hook, 'utf-8'));
    const backup = path.join(dir, 'post-merge.bak');
    fs.writeFileSync(backup, old);
    const user = path.join(dir, 'post-merge.pre-entire');
    fs.writeFileSync(user, '#!/bin/sh\necho user-line\n');

    // A backup beside Origin's own hook, and beside a wrapper that doesn't name it.
    expect(upgradeOutdatedGlobalHooks(dir)).toEqual([]);
    fs.writeFileSync(hook, '#!/bin/sh\n"$(dirname "$0")/post-merge.pre-entire" "$@"\n');
    expect(upgradeOutdatedGlobalHooks(dir)).toEqual([]);
    expect(fs.readFileSync(backup, 'utf-8')).toBe(old);
    expect(fs.readFileSync(user, 'utf-8')).toBe('#!/bin/sh\necho user-line\n');
  });

  it('a repo-local post-commit keeps the user\'s lines', () => {
    const hook = path.join(dir, 'post-commit-local');
    fs.writeFileSync(hook, `#!/bin/sh\necho user-line\n# origin-post-commit\n${age(detachedLaunch('origin hooks git-post-commit'))}\necho after\n`);
    expect(upgradePostCommitHookScript(hook, 'local')).toBe(true);
    const out = fs.readFileSync(hook, 'utf-8');
    expect(hasUnsyncedDetach(out)).toBe(false);
    expect(out).toContain('echo user-line');
    expect(out).toContain('echo after');
    expect(upgradePostCommitHookScript(hook, 'local')).toBe(false);
  });

  it('a repo-local post-checkout and post-rewrite keep the user\'s lines', () => {
    const checkout = `#!/bin/sh\necho user-line\n${age(detachedLaunch('origin hooks git-post-checkout "$@"'))}\n`;
    const fixedCheckout = repairLocalPostCheckoutScript(checkout)!;
    expect(hasUnsyncedDetach(fixedCheckout)).toBe(false);
    expect(fixedCheckout).toContain('echo user-line');
    expect(repairLocalPostCheckoutScript(fixedCheckout)).toBeNull();

    const rewrite = `#!/bin/sh\necho user-line\n${age(detachedLaunch('origin hooks git-post-rewrite "$@"'))}\n`;
    const fixedRewrite = repairLocalPostRewriteScript(rewrite)!;
    expect(hasUnsyncedDetach(fixedRewrite)).toBe(false);
    expect(fixedRewrite).toContain('echo user-line');
    expect(repairLocalPostRewriteScript(fixedRewrite)).toBeNull();
  });
});

describe('session start repairs a repo-local post-checkout', () => {
  const OLD = 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec @ARGV';
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const initRepo = () => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    gitIn(repo, 'init', '-q');
    return repo;
  };
  const installOld = (repo: string) => {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho user-line\n# origin-post-checkout\n${detachedLaunch('origin hooks git-post-checkout "$@"').replace(/pipe\(my.*exec @ARGV/, OLD)}\n`);
    fs.chmodSync(hook, '755');
    expect(hasUnsyncedDetach(fs.readFileSync(hook, 'utf-8'))).toBe(true);
    return hook;
  };

  it('rewrites the launch, keeps the user\'s lines and the mode, then leaves it alone', () => {
    const repo = initRepo();
    const hook = installOld(repo);
    expect(repairInstalledLocalPostCheckoutHook(repo)).toEqual([hook]);
    const out = fs.readFileSync(hook, 'utf-8');
    expect(hasUnsyncedDetach(out)).toBe(false);
    expect(out).toContain('echo user-line');
    expect(fs.statSync(hook).mode & 0o111).toBe(0o111);
    expect(repairInstalledLocalPostCheckoutHook(repo)).toEqual([]);
  });

  it('finds the hook from a linked worktree, whose own .git is a file', () => {
    const repo = initRepo();
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'c');
    const linked = path.join(dir, 'linked');
    gitIn(repo, 'worktree', 'add', '-q', linked);
    const hook = installOld(repo);
    expect(repairInstalledLocalPostCheckoutHook(linked).map((p) => fs.realpathSync(p))).toEqual([fs.realpathSync(hook)]);
    expect(hasUnsyncedDetach(fs.readFileSync(hook, 'utf-8'))).toBe(false);
  });

  it('touches nothing with no hook, a user\'s own hook, or no repo, and never throws', () => {
    const repo = initRepo();
    expect(repairInstalledLocalPostCheckoutHook(repo)).toEqual([]);
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho unrelated\n');
    expect(repairInstalledLocalPostCheckoutHook(repo)).toEqual([]);
    expect(fs.readFileSync(hook, 'utf-8')).toBe('#!/bin/sh\necho unrelated\n');
    expect(repairInstalledLocalPostCheckoutHook(path.join(dir, 'no-such-dir'))).toEqual([]);
  });
});
