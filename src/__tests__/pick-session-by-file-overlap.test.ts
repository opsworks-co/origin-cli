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
