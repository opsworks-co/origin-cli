import { describe, expect, it, vi } from 'vitest';
import { retryTransient, TransientFsRetryExhaustedError } from '../transient-fs.js';

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe('retryTransient (#1568)', () => {
  it('rides out a refusal that clears — Windows holding a file another process has open', () => {
    let calls = 0;
    const onRetry = vi.fn();
    const out = retryTransient(() => {
      if (++calls < 3) throw fsError('EPERM');
      return 'renamed';
    }, onRetry);
    expect(out).toBe('renamed');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('brands a refusal that does not clear so it cannot look like an initial sandbox denial', () => {
    const started = Date.now();
    let thrown: unknown;
    try { retryTransient(() => { throw fsError('EACCES'); }, undefined, 50); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(TransientFsRetryExhaustedError);
    expect((thrown as TransientFsRetryExhaustedError).code).toBe('EACCES');
    expect((thrown as TransientFsRetryExhaustedError).originalError).toMatchObject({ code: 'EACCES' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not retry an error that is not contention', () => {
    let calls = 0;
    expect(() => retryTransient(() => { calls++; throw fsError('ENOENT'); })).toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});
