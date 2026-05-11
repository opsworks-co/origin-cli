// Unit tests for the optional commit-signing helper.
//
// We can't easily test that `commit-tree -S` actually produces a signed
// commit (requires a working GPG/SSH setup in CI), but we can verify the
// helper returns the right argv based on config — which is the contract
// every callsite depends on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
}));

import { loadConfig } from '../config.js';
import { getCommitSigningArgs, isCommitSigningEnabled, resetSigningCacheForTests } from '../signing.js';

const mockLoadConfig = loadConfig as unknown as ReturnType<typeof vi.fn>;

describe('signing helper', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    resetSigningCacheForTests();
  });

  afterEach(() => {
    mockLoadConfig.mockReset();
    resetSigningCacheForTests();
  });

  it('returns [] when signSnapshots is unset', () => {
    mockLoadConfig.mockReturnValue({} as any);
    expect(getCommitSigningArgs()).toEqual([]);
    expect(isCommitSigningEnabled()).toBe(false);
  });

  it('returns [] when signSnapshots is explicitly false', () => {
    mockLoadConfig.mockReturnValue({ signSnapshots: false } as any);
    expect(getCommitSigningArgs()).toEqual([]);
    expect(isCommitSigningEnabled()).toBe(false);
  });

  it('returns ["-S"] when signSnapshots is true', () => {
    mockLoadConfig.mockReturnValue({ signSnapshots: true } as any);
    expect(getCommitSigningArgs()).toEqual(['-S']);
    expect(isCommitSigningEnabled()).toBe(true);
  });

  it('returns [] when config is null (not configured)', () => {
    mockLoadConfig.mockReturnValue(null);
    expect(getCommitSigningArgs()).toEqual([]);
    expect(isCommitSigningEnabled()).toBe(false);
  });

  it('returns [] when loadConfig throws', () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('config read failed'); });
    expect(getCommitSigningArgs()).toEqual([]);
    expect(isCommitSigningEnabled()).toBe(false);
  });

  it('memoizes after first resolve — repeated reads do not re-hit loadConfig', () => {
    mockLoadConfig.mockReturnValue({ signSnapshots: true } as any);
    // Three identical calls — only one loadConfig hit.
    getCommitSigningArgs();
    isCommitSigningEnabled();
    getCommitSigningArgs();
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it('resetSigningCacheForTests forces re-read', () => {
    mockLoadConfig.mockReturnValueOnce({ signSnapshots: true } as any);
    expect(getCommitSigningArgs()).toEqual(['-S']);
    resetSigningCacheForTests();
    mockLoadConfig.mockReturnValueOnce({ signSnapshots: false } as any);
    expect(getCommitSigningArgs()).toEqual([]);
  });
});
