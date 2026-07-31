import { describe, it, expect } from 'vitest';
import { parseDevinMetadataCache, selectDevinSessionForRepo, type DevinDesktopSession } from '../devin-desktop.js';

// Fixture mirrors the real shape of Devin Desktop's
// `windsurf.acp.metadataCache` value (VS Code state.vscdb).
const RAW = JSON.stringify({
  version: 11,
  sessions: [
    {
      sessionId: '13d1c77c-425d-4ce6-ae37-f94d87f4b448',
      providerId: 'cascade',
      status: 'end_turn',
      title: 'Explore Repository Contents',
      cwd: 'file:///Users/me/Documents/origin-demo-1',
      workspaceDirs: ['/Users/me/Documents/origin-demo-1'],
      updatedAt: '2026-07-21T02:08:37.566Z',
      _meta: { 'cognition.ai/createdAt': '2026-07-21T02:08:37.510Z', 'cognition.ai/isArchived': true },
    },
    { sessionId: 'no-workspace', providerId: 'devin-cloud', title: 'x' }, // dropped: no repo
  ],
});

describe('parseDevinMetadataCache', () => {
  it('extracts session id, provider, title, repo path and timestamps', () => {
    const s = parseDevinMetadataCache(RAW);
    expect(s).toHaveLength(1); // the workspace-less entry is filtered out
    expect(s[0]).toMatchObject({
      sessionId: '13d1c77c-425d-4ce6-ae37-f94d87f4b448',
      provider: 'cascade',
      title: 'Explore Repository Contents',
      repoPath: '/Users/me/Documents/origin-demo-1',
      createdAt: '2026-07-21T02:08:37.510Z',
      archived: true,
    });
  });

  it('falls back to cwd (stripping file://) when workspaceDirs is absent', () => {
    const raw = JSON.stringify({ sessions: [{ sessionId: 'a', title: 't', cwd: 'file:///repo/x' }] });
    expect(parseDevinMetadataCache(raw)[0].repoPath).toBe('/repo/x');
  });

  it('returns [] on malformed or empty input', () => {
    expect(parseDevinMetadataCache('not json')).toEqual([]);
    expect(parseDevinMetadataCache('{}')).toEqual([]);
    expect(parseDevinMetadataCache('')).toEqual([]);
  });
});

const sess = (over: Partial<DevinDesktopSession>): DevinDesktopSession => ({
  sessionId: 's', provider: 'cascade', title: 't', repoPath: '/repo/demo',
  createdAt: '', updatedAt: '', archived: false, ...over,
});
const NOW = Date.parse('2026-07-21T03:00:00.000Z');

describe('selectDevinSessionForRepo (commit-time attribution)', () => {
  it('picks the most recent Devin session for the repo within the window', () => {
    const sessions = [
      sess({ sessionId: 'old', repoPath: '/repo/demo', updatedAt: '2026-07-21T02:50:00.000Z' }),
      sess({ sessionId: 'new', repoPath: '/repo/demo', updatedAt: '2026-07-21T02:58:00.000Z' }),
    ];
    expect(selectDevinSessionForRepo(sessions, '/repo/demo', NOW)?.sessionId).toBe('new');
  });

  it('matches by same repo folder name and by subdir prefix', () => {
    const byName = [sess({ sessionId: 'w', repoPath: '/Users/me/Documents/demo', updatedAt: '2026-07-21T02:59:00.000Z' })];
    expect(selectDevinSessionForRepo(byName, '/Users/other/demo', NOW)?.sessionId).toBe('w'); // same basename
    expect(selectDevinSessionForRepo(byName, '/Users/me/Documents/demo/src', NOW)?.sessionId).toBe('w'); // commit in a subdir
  });

  it('ignores sessions outside the time window or in other repos', () => {
    const sessions = [
      sess({ sessionId: 'stale', repoPath: '/repo/demo', updatedAt: '2026-07-21T02:00:00.000Z' }), // 60m ago
      sess({ sessionId: 'other', repoPath: '/repo/elsewhere', updatedAt: '2026-07-21T02:59:00.000Z' }),
    ];
    expect(selectDevinSessionForRepo(sessions, '/repo/demo', NOW)).toBeNull();
  });
});
