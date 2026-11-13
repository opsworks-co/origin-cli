// A pick among several live sessions needs the same evidence a lone session does.
//
// test2, 2026-11-09 02:44: a Claude Code session ran `cd ~/test2 && git commit`
// (PR_CREATE_CHECK.md). Two Codex sessions sat idle in test2, no turn open, their
// recorded turns all in examples/*. pgrep saw six agents and abstained, neither
// session was on the new branch, the file overlap was zero — and the recency rung
// credited 2a932db4 because it started later. The commit's note, PR #3083's
// session card and the turn's line counts all named a Codex chat that never saw
// the file. A lone session in that state is refused (loneSessionMayOwnCommit);
// having a second idle session next to it must not turn "no evidence" into a pick.
import { describe, expect, it } from 'vitest';
import { pickSessionForCommit } from '../commands/hooks/post-commit.js';

type Sess = {
  sessionId: string; agentSlug: string; branch: string; startedAt: string;
  activeTurn?: { index: number } | null;
  completedPromptMappings?: Array<{ filesChanged?: string[] }>;
};

const idle = (id: string, startedAt: string, files: string[]): Sess => ({
  sessionId: id, agentSlug: 'codex', branch: 'codex/line-count-example', startedAt,
  activeTurn: null, completedPromptMappings: [{ filesChanged: files }],
});

const older = idle('2b496ab3', '2026-11-08T20:18:20Z', ['examples/README.md', 'examples/hello.py']);
const newer = idle('2a932db4', '2026-11-08T22:38:08Z', ['examples/line_count.py']);
const opts = { currentBranch: 'claude/pr-create-check', commitFiles: ['PR_CREATE_CHECK.md'], hookCwd: '/Users/a/test2' };

describe('commit owner among several sessions needs evidence', () => {
  it('credits no one when recency would pick an idle session that never touched the files (test2, 2694a61b)', () => {
    const r = pickSessionForCommit([older, newer], opts);
    expect(r.session).toBeNull();
    expect(r.reason).toBe('no-evidence');
  });

  it('credits no one when process detection leaves one idle session with no evidence', () => {
    const claude = { ...idle('c1', '2026-11-08T21:00:00Z', ['examples/x.py']), agentSlug: 'claude-code' };
    const r = pickSessionForCommit([older, claude], { ...opts, detectedSlug: 'codex' });
    expect(r.session).toBeNull();
    expect(r.reason).toBe('no-evidence');
  });

  it('still lets recency pick a session with a turn open', () => {
    const working = { ...newer, activeTurn: { index: 3 } };
    const r = pickSessionForCommit([older, working], opts);
    expect(r.reason).toBe('recency');
    expect(r.session?.sessionId).toBe('2a932db4');
  });

  it('still lets recency pick a session with no recorded turns to contradict it', () => {
    const fresh = { ...newer, completedPromptMappings: [] };
    expect(pickSessionForCommit([older, fresh], opts).session?.sessionId).toBe('2a932db4');
  });

  it('leaves the file-overlap pick alone', () => {
    const r = pickSessionForCommit([older, newer], { ...opts, commitFiles: ['examples/hello.py'] });
    expect(r.reason).toBe('file-overlap');
    expect(r.session?.sessionId).toBe('2b496ab3');
  });
});
