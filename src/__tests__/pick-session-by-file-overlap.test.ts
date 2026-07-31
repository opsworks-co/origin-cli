// Unit tests for post-commit concurrent-session disambiguation.
// When two same-agent sessions run in one repo, process detection can't
// tell them apart; we attribute the commit to the session whose recent
// edits overlap the committed files. Regression for the GitLab MR case
// where a Gemini commit was credited to a sibling Gemini session, making
// the real committing turn render a false "uncommitted" badge.

import { describe, expect, it } from 'vitest';
import { pickSessionByFileOverlap } from '../commands/hooks.js';

type S = { sessionId: string; completedPromptMappings?: Array<{ filesChanged?: string[] }> };

describe('pickSessionByFileOverlap', () => {
  it('picks the session whose recent prompt edited the committed files', () => {
    // a2c6ef61: its LAST prompt edited the committed files.
    const a2c6ef61: S = {
      sessionId: 'a2c6ef61',
      completedPromptMappings: [
        { filesChanged: ['first-file.txt'] },
        { filesChanged: ['scripts/repo-health.sh', 'scripts/status-summary.sh'] },
        { filesChanged: ['README.md', 'docs/gitlab-integration.md'] }, // latest
      ],
    };
    // 54f5b4cf: touched the same files but only in an OLDER prompt.
    const f54: S = {
      sessionId: '54f5b4cf',
      completedPromptMappings: [
        { filesChanged: ['README.md', 'docs/gitlab-integration.md'] }, // old
        { filesChanged: ['docs/workflow.md'] },
        { filesChanged: ['scripts/git-info.sh'] }, // latest — unrelated
      ],
    };
    const commitFiles = ['README.md', 'docs/gitlab-integration.md'];
    const winner = pickSessionByFileOverlap([f54, a2c6ef61], commitFiles);
    expect(winner?.sessionId).toBe('a2c6ef61');
  });

  it('picks by overlap when sessions worked on disjoint files', () => {
    const docs: S = { sessionId: 'docs', completedPromptMappings: [{ filesChanged: ['README.md', 'docs/tips.md'] }] };
    const code: S = { sessionId: 'code', completedPromptMappings: [{ filesChanged: ['src/app.ts', 'src/util.ts'] }] };
    expect(pickSessionByFileOverlap([docs, code], ['src/app.ts'])?.sessionId).toBe('code');
    expect(pickSessionByFileOverlap([docs, code], ['docs/tips.md'])?.sessionId).toBe('docs');
  });

  it('matches on basename so repo-relative vs absolute paths still align', () => {
    const s: S = { sessionId: 's', completedPromptMappings: [{ filesChanged: ['/Users/x/repo/src/app.ts'] }] };
    expect(pickSessionByFileOverlap([s], ['src/app.ts'])?.sessionId).toBe('s');
  });

  it('returns null when no session edited any committed file', () => {
    const s: S = { sessionId: 's', completedPromptMappings: [{ filesChanged: ['other.txt'] }] };
    expect(pickSessionByFileOverlap([s], ['unrelated.md'])).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(pickSessionByFileOverlap([] as S[], ['a.txt'])).toBeNull();
    expect(pickSessionByFileOverlap([{ sessionId: 's' }] as S[], [])).toBeNull();
  });
});

// pickSessionForCommit — the full disambiguation ladder (process → branch →
// file overlap). Branch is the fix for a STALE session left RUNNING on another
// branch (e.g. an old mislabeled Devin run) orphaning a real commit.
import { pickSessionForCommit } from '../commands/hooks.js';

type CS = {
  sessionId: string;
  agentSlug?: string | null;
  model?: string | null;
  branch?: string | null;
  completedPromptMappings?: Array<{ filesChanged?: string[] }>;
};

describe('pickSessionForCommit', () => {
  const devin: CS = { sessionId: 'devin-1', agentSlug: 'devin', branch: 'feature/x' };
  const staleClaude: CS = { sessionId: 'claude-stale', agentSlug: 'claude-code', branch: 'main' };

  it('returns the only session when just one is active', () => {
    const r = pickSessionForCommit([devin], {});
    expect(r.reason).toBe('only');
    expect(r.session).toBe(devin);
  });

  it('process detection narrows to the running agent', () => {
    const r = pickSessionForCommit([devin, staleClaude], { detectedSlug: 'devin' });
    expect(r.reason).toBe('process');
    expect(r.session?.sessionId).toBe('devin-1');
  });

  it('BRANCH narrows out a stale session on another branch when process detection is ambiguous', () => {
    // No detectedSlug (or a process that matches neither): the commit is on
    // feature/x, so the session on feature/x owns it — the stale main session drops.
    const r = pickSessionForCommit([devin, staleClaude], { currentBranch: 'feature/x' });
    expect(r.reason).toBe('branch');
    expect(r.session?.sessionId).toBe('devin-1');
  });

  it('does NOT narrow by branch when every candidate shares the commit branch', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['a.txt'] }] };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['b.txt'] }] };
    // Both on main → branch can't split them → falls through to file overlap.
    const r = pickSessionForCommit([a, b], { currentBranch: 'main', commitFiles: ['b.txt'] });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('b');
  });

  it('falls back to file overlap after process + branch cannot decide', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['x.txt'] }] };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main', completedPromptMappings: [{ filesChanged: ['y.txt'] }] };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: ['y.txt'] });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('b');
  });

  it('returns null (ambiguous) when nothing can decide — never guesses', () => {
    const a: CS = { sessionId: 'a', agentSlug: 'devin', branch: 'main' };
    const b: CS = { sessionId: 'b', agentSlug: 'devin', branch: 'main' };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('ambiguous');
    expect(r.session).toBeNull();
  });

  it('branch narrowing keeps the real session even if the stale one started more recently', () => {
    // Order independence: stale session first in the list.
    const r = pickSessionForCommit([staleClaude, devin], { currentBranch: 'feature/x' });
    expect(r.session?.sessionId).toBe('devin-1');
  });
});

describe('pickSessionForCommit — recency tiebreak (stale vs active)', () => {
  it('picks the actively-working session over a STALE one on the same branch when nothing else decides', () => {
    // The real bug: both on the same branch, process detection inconclusive, no
    // file-overlap yet (current turn not stopped). The stale session last
    // stopped 45m ago; the active one seconds ago.
    const stale: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'stale', agentSlug: 'claude-code', branch: 'feature/x',
      startedAt: '2026-07-23T18:14:00Z', lastStopAt: '2026-07-23T18:14:30Z',
    };
    const active: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'active', agentSlug: 'devin', branch: 'feature/x',
      startedAt: '2026-07-23T19:00:00Z', lastStopAt: '2026-07-23T19:01:00Z',
    };
    const r = pickSessionForCommit([stale, active], { currentBranch: 'feature/x', commitFiles: [] });
    expect(r.reason).toBe('recency');
    expect(r.session?.sessionId).toBe('active');
  });

  it('stays ambiguous when two sessions are concurrently active (within the margin)', () => {
    const a: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'a', agentSlug: 'devin', branch: 'main',
      startedAt: '2026-07-23T19:00:00Z', lastStopAt: '2026-07-23T19:04:00Z',
    };
    const b: CS & { startedAt: string; lastStopAt: string } = {
      sessionId: 'b', agentSlug: 'devin', branch: 'main',
      startedAt: '2026-07-23T19:00:30Z', lastStopAt: '2026-07-23T19:04:30Z', // 30s gap < 2m margin
    };
    const r = pickSessionForCommit([a, b], { detectedSlug: 'devin', currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('ambiguous');
    expect(r.session).toBeNull();
  });

  it('falls back to startedAt when a session has no lastStopAt yet', () => {
    const older: CS & { startedAt: string } = { sessionId: 'old', agentSlug: 'devin', branch: 'main', startedAt: '2026-07-23T18:00:00Z' };
    const newer: CS & { startedAt: string } = { sessionId: 'new', agentSlug: 'devin', branch: 'main', startedAt: '2026-07-23T19:00:00Z' };
    const r = pickSessionForCommit([older, newer], { currentBranch: 'main', commitFiles: [] });
    expect(r.reason).toBe('recency');
    expect(r.session?.sessionId).toBe('new');
  });
});
