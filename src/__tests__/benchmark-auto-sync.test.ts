import { describe, it, expect } from 'vitest';
import { maybeAutoSyncBenchmark } from '../benchmark-auto-sync.js';

describe('maybeAutoSyncBenchmark', () => {
  it('never throws and no-ops safely on empty/invalid input', () => {
    expect(() => maybeAutoSyncBenchmark('')).not.toThrow();
    expect(() => maybeAutoSyncBenchmark('/nonexistent/repo/path')).not.toThrow();
  });
});
