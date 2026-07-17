import { describe, it, expect } from 'vitest';
import { classifySyncBlock, makeSyncBlock, describeSyncBlock } from '../sync-block.js';

/**
 * Regression guard for the "agent was disabled" mislabel: `origin status` used
 * to blame EVERY local session on a disabled agent. These lock in that the real
 * reason is derived from the actual API error shape (see api.ts request()).
 */
describe('classifySyncBlock', () => {
  it('maps AGENT_DISABLED', () => {
    expect(classifySyncBlock({ code: 'AGENT_DISABLED', status: 403 })).toBe('agent-disabled');
  });

  it('maps a 403 "Repository not registered" by structured code', () => {
    expect(classifySyncBlock({ code: 'REPO_NOT_REGISTERED', status: 403 })).toBe('repo-not-registered');
  });

  it('maps "Repository not registered" even without a code (older servers)', () => {
    // The exact shape api.ts produces from the 403 body: serverError = body.error
    expect(classifySyncBlock({ status: 403, serverError: 'Repository not registered' }))
      .toBe('repo-not-registered');
  });

  it('maps a hard budget 429', () => {
    expect(classifySyncBlock({ status: 429 })).toBe('budget');
  });

  it('maps a 401 to auth', () => {
    expect(classifySyncBlock({ status: 401 })).toBe('auth');
  });

  it('maps a network error (no HTTP status) to unreachable', () => {
    expect(classifySyncBlock({ message: 'fetch failed' })).toBe('unreachable');
  });

  it('falls back to generic error for other server statuses', () => {
    expect(classifySyncBlock({ status: 500, serverError: 'Boom' })).toBe('error');
  });
});

describe('makeSyncBlock', () => {
  it('records code, message, repoPath and timestamp', () => {
    const block = makeSyncBlock(
      { status: 403, serverError: 'Repository not registered', serverMessage: '"x" is not registered' },
      '/Users/me/origin-demo-12',
      '2026-07-17T00:00:00.000Z',
    );
    expect(block).toEqual({
      code: 'repo-not-registered',
      message: '"x" is not registered',
      repoPath: '/Users/me/origin-demo-12',
      at: '2026-07-17T00:00:00.000Z',
    });
  });
});

describe('describeSyncBlock', () => {
  it('gives repo-not-registered an owner-actionable hint (never "agent disabled")', () => {
    const { label, hint } = describeSyncBlock('repo-not-registered');
    expect(label).toMatch(/repo not registered/i);
    expect(hint).toMatch(/repo:add|Add Repo/i);
    expect(hint).not.toMatch(/agent/i);
  });

  it('gives agent-disabled its own distinct hint', () => {
    expect(describeSyncBlock('agent-disabled').hint).toMatch(/Agents tab/i);
  });
});
