// A background run's agent exited: end every Origin session still open in its
// worktree. Codex has no SessionEnd hook, Copilot's fires after every turn and
// cursor-agent's print mode is not known to fire one, so without this the
// run stayed Running until the 90-minute idle sweep.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openRunSessions, sessionAgentFor, sessionEndInput, type RunRecord } from '../headless-run-end.js';
import { sessionEndIsOnlyAStop } from '../commands/hooks/session-end.js';

const START = '2026-10-12T18:00:00.000Z';

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-run-end-')));
  const gitDir = path.join(root, 'repo', '.git');
  const mirror = path.join(root, 'mirror');
  const worktree = path.join(root, 'repo-worktrees', 'ISS-1-fix');
  for (const d of [gitDir, mirror, worktree]) fs.mkdirSync(d, { recursive: true });
  const write = (dir: string, name: string, s: Record<string, unknown>) => fs.writeFileSync(path.join(dir, name), JSON.stringify(s));
  return { root, gitDir, mirror, worktree, write };
}

describe('sessions a finished background run leaves open', () => {
  for (const [agent, slug] of [['codex', 'codex'], ['copilot', 'copilot'], ['cursor', 'cursor'], ['claude', 'claude-code']] as const) {
    it(`finds the ${agent} run's open session in its worktree, and only that`, () => {
      const t = setup();
      const run: RunRecord = { shortId: 'ISS-1', agent, worktree: t.worktree, startedAt: START };
      const base = { agentSlug: slug, status: 'RUNNING', startedAt: '2026-10-12T18:00:02.000Z', lastCwd: t.worktree, repoPath: t.worktree };
      t.write(t.gitDir, 'origin-session-a.json', { ...base, sessionId: 'mine', agentSessionId: 'conv-1', transcriptPath: '/t.jsonl' });
      t.write(t.gitDir, 'origin-session-b.json', { ...base, sessionId: 'ended', status: 'ENDED' });
      t.write(t.gitDir, 'origin-session-c.json', { ...base, sessionId: 'elsewhere', lastCwd: path.join(t.root, 'repo'), repoPath: path.join(t.root, 'repo') });
      t.write(t.gitDir, 'origin-session-d.json', { ...base, sessionId: 'older', startedAt: '2026-10-12T17:00:00.000Z' });
      t.write(t.gitDir, 'origin-session-e.json', { ...base, sessionId: 'other-agent', agentSlug: slug === 'codex' ? 'cursor' : 'codex' });
      t.write(t.gitDir, 'config.json', { ...base, sessionId: 'not-a-state-file' });
      // The same session mirrored under ~/.origin/sessions counts once.
      t.write(t.mirror, 'mine.json', { ...base, sessionId: 'mine' });
      const open = openRunSessions(run, t.gitDir, t.mirror);
      expect(open).toEqual([{ sessionId: 'mine', agentSlug: slug, agentSessionId: 'conv-1', transcriptPath: '/t.jsonl' }]);
      const input = sessionEndInput(run, open[0]);
      expect(input).toMatchObject({ hook_event_name: 'SessionEnd', cwd: t.worktree, session_id: 'conv-1', transcript_path: '/t.jsonl' });
      expect(input.conversation_id).toBe(agent === 'cursor' ? 'conv-1' : undefined);
    });
  }

  it('maps --agent to the slug sessions are recorded under', () => {
    expect(sessionAgentFor('claude')).toBe('claude-code');
    expect(sessionAgentFor('antigravity')).toBe('antigravity');
  });

  it('the wrapper\'s end is final for every agent; the agents\' own headless SessionEnd only for Claude Code', () => {
    const headless = { ORIGIN_HEADLESS_RUN: '1' };
    for (const slug of ['claude-code', 'codex', 'copilot', 'cursor']) {
      expect(sessionEndIsOnlyAStop(slug, {})).toBe(true);
      // run-ended: the process is gone.
      expect(sessionEndIsOnlyAStop(slug, headless, sessionEndInput(
        { shortId: 'x', agent: slug, worktree: '/w', startedAt: START },
        { sessionId: 's', agentSlug: slug, agentSessionId: null, transcriptPath: null },
      ))).toBe(false);
      // …but not the same reason outside a headless run.
      expect(sessionEndIsOnlyAStop(slug, {}, { reason: 'headless_run_exited' })).toBe(true);
    }
    // Copilot fires sessionEnd after every turn, even headless (2026-10-12: it
    // ended a `copilot -p` run 35 s before Copilot finished); Cursor likewise.
    expect(sessionEndIsOnlyAStop('claude-code', headless, { reason: 'other' })).toBe(false);
    expect(sessionEndIsOnlyAStop('copilot', headless, { reason: 'complete' })).toBe(true);
    expect(sessionEndIsOnlyAStop('cursor', headless, {})).toBe(true);
  });
});
