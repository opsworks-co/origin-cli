import { describe, it, expect } from 'vitest';
import { deriveRepoFullName } from '../commands/benchmark-bakeoff.js';

describe('deriveRepoFullName (bakeoff)', () => {
  it('parses https and ssh remotes', () => {
    expect(deriveRepoFullName('https://github.com/opsworks-co/origin.git')).toBe('opsworks-co/origin');
    expect(deriveRepoFullName('git@github.com:opsworks-co/origin.git')).toBe('opsworks-co/origin');
    expect(deriveRepoFullName('https://gitlab.com/group/proj')).toBe('group/proj');
  });
  it('returns null for junk', () => {
    expect(deriveRepoFullName('nope')).toBeNull();
  });
});
