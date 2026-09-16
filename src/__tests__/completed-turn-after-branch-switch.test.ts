import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mergePromptMappings } from '../commands/hooks/session-end.js';
import { recordTranscriptCommitProofs, withLegacyWritesRendered } from '../commands/hooks/stop.js';
import { sessionAuthoredSnapshot } from '../commands/hooks/post-commit.js';
import { inheritedFileSourcesForTurn } from '../commands/hooks.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

let repo: string;
afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

it('recovers both branches and the closing turn in the same Stop, without a next prompt', () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-completed-turn-'));
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const write = (name: string, content: string) => fs.writeFileSync(path.join(repo, name), content);
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  write('base.ts', 'base\n');
  const start = commit('base');
  git('checkout', '-qb', 'first');
  write('first.ts', 'first\nsecond\n');
  const first = commit('first task');
  git('checkout', '-q', 'main');
  write('foreign.ts', 'another session\n');
  commit('foreign work');
  git('checkout', '-qb', 'second');
  write('second.ts', 'one\ntwo\nthree\n');
  const second = commit('second task');
  const state: any = {
    repoPath: repo, headShaAtStart: start,
    // The capture log for 805c1429 held only this branch in its list.
    sessionCommitShas: [second],
    promptTurnIds: ['t_first', 't_chat', 't_second'],
    promptShadows: [
      { promptIndex: 0, shadowSha: start },
      { promptIndex: 1, shadowSha: first },
      { promptIndex: 2, shadowSha: first },
    ],
    commitTurns: [{ sha: first, turnId: 't_first', via: 'transcript' }],
  };
  recordTranscriptCommitProofs(state, [{ promptIndex: 0, sha: first }, { promptIndex: 2, sha: second }]);
  const empty = (promptIndex: number) => ({ promptIndex, diff: '', filesChanged: [] as string[], linesAdded: 0, linesRemoved: 0 });
  // Stop appended a second closing row, then its ledger pass emptied both.
  const rows = mergePromptMappings([], [empty(0), empty(1), empty(2), empty(2)]);
  expect(rows).toHaveLength(3);
  expect(preferCommitPatchForCommittedTurns(state, rows, repo, {
    inheritedFiles: (base, turn, files, end) => inheritedFileSourcesForTurn(repo, state, base, turn, files, end),
  })).toBe(2);
  expect(rows.map(row => [row.linesAdded, row.linesRemoved])).toEqual([[2, 0], [0, 0], [3, 0]]);
  expect(rows[2].filesChanged).toEqual(['second.ts']);
  // The wire's final legacy pass must not replace Git's creation with a
  // transcript rewrite whose before-state already contains this turn's work.
  const wire = withLegacyWritesRendered(rows[2], JSON.stringify({ edits: [{
    file: 'second.ts', op: 'write', oldContent: 'one\ntwo\n', newContent: 'one\ntwo\nthree\n',
  }] }));
  expect(wire).toBe(rows[2]);
  expect(wire.linesAdded).toBe(3);
  const snapshot = sessionAuthoredSnapshot(repo, state);
  expect(new Set(snapshot.commitShas)).toEqual(new Set([first, second]));
  expect(new Set(snapshot.filesChanged)).toEqual(new Set(['first.ts', 'second.ts']));
  expect([snapshot.linesAdded, snapshot.linesRemoved]).toEqual([5, 0]);
});
