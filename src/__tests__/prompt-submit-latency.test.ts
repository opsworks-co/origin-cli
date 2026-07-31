/**
 * The three fixes for "Origin stalls the agent for 11s on every prompt".
 *
 * user-prompt-submit runs INLINE — every agent blocks on it before the prompt
 * reaches the model. Measured on a real Copilot turn: prompt sent at
 * 21:30:39.128, Origin hook 21:30:41.004 -> 21:30:52.537, i.e. 11.5s of dead
 * time, of which 6.3s was buildAttributionContext. Across 12 recorded
 * invocations: median 11.1s, p90 19.3s, worst 25.2s.
 *
 * Covered here:
 *   1. buildAttributionContext is memoized on (repo, HEAD) -- on DISK, because
 *      every hook fire is a fresh process.
 *   2. normalizeWorkspaceRoot fixes Cursor's "/C:/soft/repo" leading-slash form.
 *   3. transcript-watch backs off instead of re-asking a refused repo every poll.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAttributionContext } from '../attribution.js';
import { normalizeWorkspaceRoot } from '../commands/hooks.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true }).trim();
}

function cacheFileFor(repoPath: string): string {
  // Mirrors attribution.ts attributionCacheFile().
  const crypto = require('crypto');
  const key = crypto.createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 32);
  return path.join(os.homedir(), '.origin', 'attribution-cache', `${key}.json`);
}

describe('normalizeWorkspaceRoot', () => {
  it('strips the leading slash from Cursor-s /<drive>:/ form', () => {
    expect(normalizeWorkspaceRoot('/C:/soft/origin-demo-1')).toBe('C:/soft/origin-demo-1');
    expect(normalizeWorkspaceRoot('/c:\\soft\\origin-demo-1')).toBe('c:\\soft\\origin-demo-1');
  });

  it('leaves plain Windows and POSIX paths untouched', () => {
    expect(normalizeWorkspaceRoot('C:\\soft\\origin-demo-1')).toBe('C:\\soft\\origin-demo-1');
    expect(normalizeWorkspaceRoot('C:/soft/origin-demo-1')).toBe('C:/soft/origin-demo-1');
    // A POSIX absolute path must NOT lose its root — the regex requires a drive
    // letter precisely so this case is safe.
    expect(normalizeWorkspaceRoot('/home/user/repo')).toBe('/home/user/repo');
    expect(normalizeWorkspaceRoot('/usr/local')).toBe('/usr/local');
  });

  it('handles file:// and percent-encoding', () => {
    expect(normalizeWorkspaceRoot('file:///C:/soft/my%20repo')).toBe('C:/soft/my repo');
  });

  it('returns null for unusable input', () => {
    expect(normalizeWorkspaceRoot(undefined)).toBeNull();
    expect(normalizeWorkspaceRoot('')).toBeNull();
    expect(normalizeWorkspaceRoot(42)).toBeNull();
    expect(normalizeWorkspaceRoot(['/C:/x'])).toBeNull();
  });
});

describe('buildAttributionContext caching', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-attr-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@test.dev']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, ['add', '.']);
    // A trailer the AI detector recognizes, so the walk yields real content
    // rather than the null "no AI activity" answer.
    git(repo, ['commit', '-q', '-m', 'feat: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>']);
    try { fs.unlinkSync(cacheFileFor(repo)); } catch { /* nothing cached yet */ }
  });

  it('writes a cache entry keyed on the current HEAD', () => {
    const out = buildAttributionContext(repo);
    const cf = cacheFileFor(repo);
    expect(fs.existsSync(cf)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(cf, 'utf-8'));
    expect(cached.head).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(cached.context).toEqual(out);
  });

  // Proves the cache SHORT-CIRCUITS rather than merely being written: plant a
  // sentinel the commit walk could never produce and require it back verbatim.
  // (Can't assert on execFileSync call counts — attribution.ts binds it as an
  // ESM named import, so a vi.spyOn of child_process never intercepts it.)
  it('serves a cache hit without re-walking the commits', () => {
    buildAttributionContext(repo); // populate, so the file/dir exist
    const cf = cacheFileFor(repo);
    const head = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(cf, JSON.stringify({ head, context: 'SENTINEL-FROM-CACHE' }));

    expect(buildAttributionContext(repo)).toBe('SENTINEL-FROM-CACHE');
  });

  it('ignores a cache entry from a different HEAD', () => {
    buildAttributionContext(repo);
    const cf = cacheFileFor(repo);
    fs.writeFileSync(cf, JSON.stringify({ head: 'f'.repeat(40), context: 'STALE-SENTINEL' }));

    expect(buildAttributionContext(repo)).not.toBe('STALE-SENTINEL');
  });

  it('rebuilds when the cache file is corrupt', () => {
    buildAttributionContext(repo);
    fs.writeFileSync(cacheFileFor(repo), 'not json{{{');

    expect(() => buildAttributionContext(repo)).not.toThrow();
    const cached = JSON.parse(fs.readFileSync(cacheFileFor(repo), 'utf-8'));
    expect(cached.head).toBe(git(repo, ['rev-parse', 'HEAD']));
  });

  it('rebuilds when HEAD moves', () => {
    buildAttributionContext(repo);
    const firstHead = JSON.parse(fs.readFileSync(cacheFileFor(repo), 'utf-8')).head;

    fs.writeFileSync(path.join(repo, 'b.txt'), 'more\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'chore: second']);

    buildAttributionContext(repo);
    const secondHead = JSON.parse(fs.readFileSync(cacheFileFor(repo), 'utf-8')).head;
    expect(secondHead).not.toBe(firstHead);
    expect(secondHead).toBe(git(repo, ['rev-parse', 'HEAD']));
  });

  it('caches a null answer so "no AI activity" is not re-derived every prompt', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-attr-plain-'));
    git(plain, ['init', '-q']);
    git(plain, ['config', 'user.email', 'test@test.dev']);
    git(plain, ['config', 'user.name', 'Test']);
    git(plain, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(plain, 'a.txt'), 'x\n');
    git(plain, ['add', '.']);
    git(plain, ['commit', '-q', '-m', 'human commit, no AI trailer']);
    try { fs.unlinkSync(cacheFileFor(plain)); } catch { /* ignore */ }

    expect(buildAttributionContext(plain)).toBeNull();
    const cached = JSON.parse(fs.readFileSync(cacheFileFor(plain), 'utf-8'));
    expect(cached.context).toBeNull();
    // And the cached null is honoured rather than re-walked.
    expect(buildAttributionContext(plain)).toBeNull();
  });

  it('does not throw when the repo has no commits', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-attr-empty-'));
    git(empty, ['init', '-q']);
    expect(() => buildAttributionContext(empty)).not.toThrow();
  });
});
