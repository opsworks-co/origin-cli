import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { captureShadowWindow, createShadowCommit } from '../git-capture.js';
import { recordPromptShadow } from '../session-state.js';
import { preferShadowRangeForTurns, type ShadowRangeMapping } from '../prefer-shadow-range.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { persistCompletedMappings } from '../commands/hooks/stop.js';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

// No agent-specific inference: actual prompt boundaries decide authorship.
describe.each(['claude-code', 'cursor', 'codex', 'gemini', 'antigravity', 'devin'])('%s: commit-only turn', (agentSlug) => {
  it('keeps shell-written files on the authoring turn and clears a stale PR-turn capture', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-commit-only-window-'));
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(repo, 'large.ts'), 'unchanged context\n'.repeat(15000));
    git('add', '.'); git('commit', '-qm', 'base');
    const state: any = { agentSlug, prompts: ['implement', 'open PR', 'what next'], promptTurnIds: ['T0', 'T1', 'T2'] };
    recordPromptShadow(state, 0, git('rev-parse', 'HEAD'), { completeBaseline: true });
    fs.appendFileSync(path.join(repo, 'large.ts'), 'authored\n');
    fs.writeFileSync(path.join(repo, 'new.ts'), 'shell-written\n');
    recordPromptShadow(state, 1, createShadowCommit(repo, 'before-pr'), { completeBaseline: true });
    git('add', '.'); git('commit', '-qm', 'ship previous work');
    const sha = git('rev-parse', 'HEAD');
    recordPromptShadow(state, 2, sha, { completeBaseline: true });
    state.commitTurns = [{ sha, turnId: 'T1' }];
    const rows: ShadowRangeMapping[] = [
      { promptIndex: 0, filesChanged: ['large.ts'], diff: 'partial capture', contentUnavailableFiles: ['new.ts'] },
      { promptIndex: 1, filesChanged: ['large.ts', 'new.ts'], diffSource: 'ledger', diff: 'stale HEAD diff', uncommittedDiff: 'stale HEAD diff', commitSha: sha },
      { promptIndex: 2, filesChanged: ['new.ts'], diff: 'another stale capture' },
    ];
    preferShadowRangeForTurns(state, rows, repo);
    preferCommitPatchForCommittedTurns(state, rows, repo);
    expect(rows[0].filesChanged).toEqual(['large.ts', 'new.ts']);
    expect(rows[0].linesAdded).toBe(2);
    expect(rows[0].diff).toContain('+shell-written');
    expect(rows[0].diff!.length).toBeLessThan(2000);
    expect(rows[0].contentUnavailableFiles).toEqual([]);
    for (const row of rows.slice(1)) {
      expect(row).toMatchObject({ filesChanged: [], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0, contentAuthoritative: true, diffSource: 'turn-window', commitSha: null });
    }
    persistCompletedMappings({ state, promptMappings: rows as any });
    expect(state.completedPromptMappings[1]).toMatchObject({ contentAuthoritative: true, turnWindowCaptured: true, diffSource: 'turn-window', filesChanged: [], linesAdded: 0 });
  });
});

it('does not trust HEAD when a dirty baseline snapshot failed', () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-incomplete-window-'));
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'a'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  const state: any = { prompts: ['turn'] };
  recordPromptShadow(state, 0, sha, { completeBaseline: false });
  const row = { promptIndex: 0, filesChanged: ['a'], diff: 'known work' };
  preferShadowRangeForTurns(state, [row], repo);
  expect(row.diff).toBe('known work');
});

it('does not extend an earlier turn through a late-discovered boundary', () => {
  const rows = [{ promptIndex: 0, filesChanged: ['a'], diff: 'earlier work' }];
  preferShadowRangeForTurns({ prompts: ['first', 'discovered after edit'], promptShadows: [
    { promptIndex: 0, shadowSha: 'abc', completeBaseline: true },
    { promptIndex: 1, shadowSha: 'def', completeBaseline: false },
  ] }, rows, '/unneeded');
  expect(rows[0].diff).toBe('earlier work');
});

it('does not claim a whole checkout window while another session is writing', () => {
  const rows = [{ promptIndex: 0, filesChanged: ['a'], diff: 'own observed write' }];
  preferShadowRangeForTurns({ prompts: ['first'], contendingSessionIds: ['other'], promptShadows: [
    { promptIndex: 0, shadowSha: 'abc', completeBaseline: true },
  ] }, rows, '/unneeded');
  expect(rows[0].diff).toBe('own observed write');
});

it('never certifies a partial index after git add fails', () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-failed-window-'));
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'a'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'a filter=origin-test\n');
  git('config', 'filter.origin-test.clean', 'nonexistent-origin-capture-filter');
  git('config', 'filter.origin-test.required', 'true');
  fs.writeFileSync(path.join(repo, 'a'), 'changed');
  expect(createShadowCommit(repo, 'failed')).toBeNull();
  expect(captureShadowWindow(repo, sha, null, { completeBaseline: true }).status).toBe('unavailable');
});
