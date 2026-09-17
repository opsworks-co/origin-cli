/**
 * The post-commit capture must describe the commit git just made, even when
 * HEAD has already moved on.
 *
 * The hook script backgrounds the capture, and the capture used to read
 * `git rev-parse HEAD` itself. Session 874ff028 ran `git checkout -B <branch>
 * origin/main` right after `git commit`: the capture read another session's
 * commit (bda43822), skipped it as foreign, and the real commit was never
 * recorded. The script now resolves the sha before backgrounding and passes it
 * as ORIGIN_COMMIT_SHA.
 *
 * Driven against REAL git and the REAL generated hook script.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { upgradePostCommitHookScript, writeGlobalPostCommitHook } from '../commands/enable.js';
import { committedShaForHook } from '../commands/hooks/post-commit.js';

let dir: string;
let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-pc-sha-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

/** Point the generated hook's ORIGIN_BIN resolution at a fake origin. */
function patchOriginBin(hookPath: string, fakeBin: string) {
  const src = fs.readFileSync(hookPath, 'utf-8');
  const start = src.indexOf('ORIGIN_BIN=""');
  const end = src.indexOf('\nfi\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  fs.writeFileSync(hookPath, src.slice(0, start) + `ORIGIN_BIN="${fakeBin}"` + src.slice(end + '\nfi'.length));
  fs.chmodSync(hookPath, '755');
}

async function waitForFile(file: string, ms: number): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf-8');
      if (text.endsWith('\n')) return text.trim();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fake origin never wrote ${file}`);
}

describe('the global post-commit hook script', () => {
  it('hands the capture the committed sha, not whatever HEAD is when it runs', async () => {
    const hooks = path.join(dir, 'hooks');
    fs.mkdirSync(hooks);
    writeGlobalPostCommitHook(hooks);
    const seen = path.join(dir, 'seen.txt');
    const fake = path.join(dir, 'fake-origin');
    // The capture runs late — long enough for the agent's next command to land.
    fs.writeFileSync(fake, `#!/bin/sh\nsleep 1\necho "$ORIGIN_COMMIT_SHA" > "${seen}.tmp"\nmv "${seen}.tmp" "${seen}"\n`);
    fs.chmodSync(fake, '755');
    patchOriginBin(path.join(hooks, 'post-commit'), fake);
    git('config', 'core.hooksPath', hooks);

    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'fix/x');
    write('x.ts', 'export const x = 1;\n'); git('add', '-A'); git('commit', '-qm', 'fix: x');
    const committed = git('rev-parse', 'HEAD');
    // What session 874ff028 did next: move the branch before the capture ran.
    git('checkout', '-q', '-B', 'fix/x', base);

    expect(await waitForFile(seen, 10_000)).toBe(committed);
  }, 20_000);
});

describe('committedShaForHook', () => {
  it('uses the sha the hook passed even after HEAD moved, and clears the variable', () => {
    write('a.ts', 'a\n'); git('add', '-A'); git('commit', '-qm', 'a');
    const a = git('rev-parse', 'HEAD');
    write('b.ts', 'b\n'); git('add', '-A'); git('commit', '-qm', 'b');
    const env: NodeJS.ProcessEnv = { ORIGIN_COMMIT_SHA: a };
    expect(committedShaForHook(repo, env)).toBe(a);
    expect(env.ORIGIN_COMMIT_SHA).toBeUndefined();
  });

  it('falls back to HEAD for an old hook script or a sha that is not a commit here', () => {
    const headSha = git('rev-parse', 'HEAD');
    expect(committedShaForHook(repo, {})).toBe(headSha);
    expect(committedShaForHook(repo, { ORIGIN_COMMIT_SHA: 'deadbeef'.repeat(5) })).toBe(headSha);
    expect(committedShaForHook(repo, { ORIGIN_COMMIT_SHA: '$(rm -rf /)' })).toBe(headSha);
  });
});

describe('hook scripts installed by an older CLI are upgraded', () => {
  it('rewrites an outdated global script', () => {
    const hooks = path.join(dir, 'global');
    fs.mkdirSync(hooks);
    const hookPath = path.join(hooks, 'post-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# origin-global-post-commit\nif [ -n "$ORIGIN_BIN" ]; then\n  "$ORIGIN_BIN" hooks git-post-commit >/dev/null 2>&1 &\nfi\n');
    expect(upgradePostCommitHookScript(hookPath, 'global')).toBe(true);
    const out = fs.readFileSync(hookPath, 'utf-8');
    expect(out).toContain('ORIGIN_COMMIT_SHA="$_origin_commit_sha"');
    expect(out.indexOf('_origin_commit_sha="$(git rev-parse HEAD')).toBeLessThan(out.indexOf('hooks git-post-commit'));
    expect(upgradePostCommitHookScript(hookPath, 'global'), 'an up-to-date script is left alone').toBe(false);
  });

  it('replaces only Origin\'s line in a local hook the user also owns', () => {
    const hookPath = path.join(dir, 'local-post-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho user-before\n\n# origin-post-commit\nPATH=/x:$PATH origin hooks git-post-commit >/dev/null 2>&1 &\necho user-after\n');
    expect(upgradePostCommitHookScript(hookPath, 'local')).toBe(true);
    const out = fs.readFileSync(hookPath, 'utf-8');
    expect(out).toContain('echo user-before');
    expect(out).toContain('echo user-after');
    expect(out).toMatch(/ORIGIN_COMMIT_SHA="\$_origin_commit_sha" .*hooks git-post-commit >\/dev\/null 2>&1 &/);
    expect(out.match(/hooks git-post-commit/g)?.length).toBe(1);
  });
});
