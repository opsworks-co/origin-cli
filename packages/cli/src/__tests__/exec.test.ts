/**
 * Tests for the safe exec wrapper.
 *
 * The wrapper is the only place in the CLI permitted to import
 * `child_process`, so it's the only thing standing between user input and
 * arbitrary command execution. These tests cover:
 *
 *   1. Argument validation — non-string args / non-array args throw
 *   2. Shell-injection resistance — args containing shell metacharacters
 *      are passed verbatim, not interpreted
 *   3. runDetailed status semantics — non-zero exit returned, not thrown
 *   4. gitOrNull — returns null on failure rather than throwing
 *   5. safeIdentifier / ensureUnderRoot — path traversal & illegal chars
 */

import { describe, it, expect } from 'vitest';
import {
  run,
  runDetailed,
  gitOrNull,
  safeIdentifier,
  ensureUnderRoot,
} from '../utils/exec.js';

describe('run / runDetailed', () => {
  it('throws if file is not a string', () => {
    expect(() => run('' as any, [])).toThrow(/non-empty string/);
    expect(() => run(undefined as any, [])).toThrow(/non-empty string/);
  });

  it('throws if args is not an array', () => {
    expect(() => run('echo', 'hi' as any)).toThrow(/array of strings/);
  });

  it('throws if any arg is not a string', () => {
    expect(() => run('echo', [42 as any])).toThrow(/all args must be strings/);
  });

  it('passes args verbatim — shell metacharacters are NOT interpreted', () => {
    // If args were going through a shell, `;` would terminate the command
    // and run `echo PWNED`. With execFileSync + array args, the literal
    // string is the only argument echo receives.
    const out = run('echo', ['hello; echo PWNED']);
    // The entire payload is echoed as ONE line (with a single trailing
    // newline). If a shell were involved, PWNED would appear on its own
    // second line, so the output would have at least two newlines.
    expect(out.trim()).toBe('hello; echo PWNED');
    expect(out.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('passes backticks and $() verbatim', () => {
    const out = run('echo', ['$(whoami)', '`id`']);
    expect(out).toContain('$(whoami)');
    expect(out).toContain('`id`');
  });

  it('runDetailed returns non-zero status without throwing', () => {
    const r = runDetailed('false', []);
    expect(r.status).not.toBe(0);
  });

  it('runDetailed returns status 0 on success', () => {
    const r = runDetailed('true', []);
    expect(r.status).toBe(0);
  });

  it('runDetailed captures stdout', () => {
    const r = runDetailed('echo', ['captured']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('captured');
  });

  it('runDetailed pipes input on stdin', () => {
    const r = runDetailed('cat', [], { input: 'piped-content' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('piped-content');
  });
});

describe('gitOrNull', () => {
  it('returns null on failure instead of throwing', () => {
    // Run in a directory that is definitely not a git repo.
    const result = gitOrNull(['rev-parse', '--git-dir'], { cwd: '/' });
    expect(result).toBeNull();
  });
});

describe('safeIdentifier', () => {
  it('accepts alphanumeric, dot, dash, underscore', () => {
    expect(safeIdentifier('foo_bar-1.2')).toBe('foo_bar-1.2');
  });

  it('rejects shell metacharacters', () => {
    expect(() => safeIdentifier('foo;rm -rf /')).toThrow(/invalid characters/);
    expect(() => safeIdentifier('foo bar')).toThrow(/invalid characters/);
    expect(() => safeIdentifier('foo|bar')).toThrow(/invalid characters/);
    expect(() => safeIdentifier('foo`bar')).toThrow(/invalid characters/);
    expect(() => safeIdentifier('foo$bar')).toThrow(/invalid characters/);
  });

  it('rejects empty string', () => {
    expect(() => safeIdentifier('')).toThrow(/non-empty string/);
  });
});

describe('ensureUnderRoot', () => {
  it('accepts a child path under the root', () => {
    const out = ensureUnderRoot('/tmp/foo', 'bar/baz');
    expect(out).toBe('/tmp/foo/bar/baz');
  });

  it('rejects path traversal via ..', () => {
    expect(() => ensureUnderRoot('/tmp/foo', '../etc/passwd')).toThrow(/escapes root/);
  });

  it('rejects absolute paths outside root', () => {
    expect(() => ensureUnderRoot('/tmp/foo', '/etc/passwd')).toThrow(/escapes root/);
  });

  it('accepts the root itself', () => {
    const out = ensureUnderRoot('/tmp/foo', '.');
    expect(out).toBe('/tmp/foo');
  });
});
