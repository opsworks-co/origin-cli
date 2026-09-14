import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../utils/exec.js';
import { assertCliReleaseVersion, latestCliRelease } from './helpers/cli-release-version.js';

let repo: string;
function run(args: string[]) { return git(args, { cwd: repo }).trim(); }
function write(file: string, text: string) {
  const target = path.join(repo, 'packages/cli/src', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function commit() {
  run(['add', '.']);
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'source']);
}
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-version-policy-'));
  run(['init', '-b', 'main']);
  write('runtime.ts', 'export const value = 1;\n');
  commit();
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('release version guard against real Git history', () => {
  it('rejects an untagged version older than the latest release with changed runtime code', () => {
    run(['tag', 'cli-v0.20260913.1243']);
    write('runtime.ts', 'export const value = 2;\n');
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).toThrow('cli-v0.20260913.1243 is newer');
  });

  it('retains exact-tag collision detection', () => {
    run(['tag', 'cli-v0.20260913.524']);
    write('runtime.ts', 'export const value = 2;\n');
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).toThrow('already exists with different source');
  });

  it('accepts a genuinely newer version', () => {
    run(['tag', 'cli-v0.20260913.524']);
    write('runtime.ts', 'export const value = 2;\n');
    expect(() => assertCliReleaseVersion(repo, '0.20260913.1243')).not.toThrow();
  });

  it('rejects numerically equal versions with different zero padding', () => {
    run(['tag', 'cli-v0.20260913.0524']);
    write('runtime.ts', 'export const value = 2;\n');
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).toThrow('same numeric version');
  });

  it('allows unchanged runtime and test-only differences, even with an older version', () => {
    run(['tag', 'cli-v0.20260913.1243']);
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).not.toThrow();
    write('__tests__/new.test.ts', '// test');
    write('runtime.test.ts', '// colocated test');
    commit();
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).not.toThrow();
  });

  it('detects runtime deletions and handles annotated tags', () => {
    run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'tag', '-a', 'cli-v0.20260913.1243', '-m', 'release']);
    fs.unlinkSync(path.join(repo, 'packages/cli/src/runtime.ts'));
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).toThrow('runtime.ts');
  });

  it('does not confuse a same-named branch with the release tag', () => {
    run(['tag', 'cli-v0.20260913.1243']);
    write('runtime.ts', 'export const value = 2;\n');
    commit();
    run(['branch', 'cli-v0.20260913.1243']);
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).toThrow('is newer');
  });

  it('requires usable release tags in CI and fails on Git errors', () => {
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524')).not.toThrow();
    expect(() => assertCliReleaseVersion(repo, '0.20260913.524', true)).toThrow('CI has no stable');
    expect(() => assertCliReleaseVersion(path.join(repo, 'absent'), '0.20260913.524')).toThrow();
  });

  it('rejects invalid package versions instead of comparing partial numbers', () => {
    expect(() => assertCliReleaseVersion(repo, '0.20260913.bad')).toThrow('Invalid stable CLI version');
  });
});

it('orders stable tags numerically and ignores unrelated or prerelease tags', () => {
  expect(latestCliRelease(['v9.0.0', 'cli-v0.20260913.524', 'cli-v0.20260913.1243', 'cli-v0.20260914.100-rc.1', 'cli-vinvalid']))
    .toBe('cli-v0.20260913.1243');
});
