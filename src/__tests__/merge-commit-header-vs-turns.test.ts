// A merge commit gives the session header nothing its turns don't also have.
//
// The rule: a merge credits the session with its own conflict fixes, never
// with what the other parent brought in, and the turn that committed it owns
// those fixes too. Two sessions in the OR-60 worktree broke it on 2026-11-02,
// and the release gate read header_exceeds_turns /
// header_file_unclaimed_by_turns for both.
//
//   8cf9e6b1 — started mid-merge, resolved three files with shell commands,
//              committed with `git commit -q`. Post-commit never ran (Entire's
//              chained hook hung and was killed). The header found the merge
//              through its trailer and showed its resolution; no turn had it.
//   d7c5cad1 — ran a clean `git merge origin/main`, which git commits with no
//              post-commit. Stop measured the no-commit session's uncommitted
//              work as session-start shadow → working tree, so main's 51 files
//              became the header of a session that wrote nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { captureSessionStartBaseline } from '../commands/hooks/session-start.js';
import { ownedRangeCommitShas, uncommittedSinceSessionStart } from '../commands/hooks/stop.js';
import { sessionAuthoredSnapshot } from '../commands/hooks/post-commit.js';
import { captureGitState } from '../git-capture.js';
import { attestHookMissedTrailerCommits, trailerTurnRow } from '../hook-missed-trailer-commits.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const files = (diff: string) => [...new Set([...diff.matchAll(/^diff --git a\/(.*?) b\//gm)].map((m) => m[1]))].sort();
const sign = (diff: string, s: '+' | '-') => diff.split('\n').filter((l) => l.startsWith(s) && !l.startsWith(s.repeat(3))).length;

/** main and feature edit the same line of conflict.ts; main also adds theirs.ts. */
function forkedRepo(prefix: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t'); git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = 0;\nexport const C = 3;\n');
  fs.writeFileSync(path.join(repo, 'base.ts'), 'export const BASE = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  // Both sides are older than the session.
  const old = { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 3600_000).toISOString() };
  git(repo, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = "feature";\nexport const C = 3;\n');
  execFileSync('git', ['commit', '-qam', 'feature side'], { cwd: repo, env: old });
  git(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = "main";\nexport const C = 3;\n');
  fs.writeFileSync(path.join(repo, 'theirs.ts'), Array.from({ length: 40 }, (_, i) => `export const THEIRS_${i} = ${i};`).join('\n') + '\n');
  git(repo, 'add', '-A');
  execFileSync('git', ['commit', '-qm', 'main side'], { cwd: repo, env: old });
  git(repo, 'checkout', '-q', 'feature');
  return repo;
}

describe('trailerTurnRow', () => {
  it('reads the committing turn from the trailer as a server row', () => {
    expect(trailerTurnRow('8cf9e6b1-45b | Claude Code | 1 prompt | turn 1')).toBe(0);
    expect(trailerTurnRow('8cf9e6b1-45b | Claude Code | 4 prompts | turn 28 | 1 sub-agent')).toBe(27);
    expect(trailerTurnRow('8cf9e6b1-45b | Claude Code | 3 prompts')).toBeNull();
  });
});

describe('8cf9e6b1: a merge committed with its post-commit missed', () => {
  const sessionId = '8cf9e6b1-45ba-41f0-8070-ea9ce1787380';
  let repo = '';
  let mergeSha = '';
  let state: any;

  beforeAll(() => {
    repo = forkedRepo('origin-merge-missed-');
    // The merge stops on the conflict, THEN the session starts: MERGE_HEAD is
    // set and both the conflicted file and main's new file are start dirt.
    try { git(repo, 'merge', 'main'); } catch { /* conflict, expected */ }
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const baseline = captureSessionStartBaseline(repo, 'merge-missed');
    expect(baseline.sessionStartDirtyFiles).toEqual(expect.arrayContaining(['conflict.ts', 'theirs.ts']));
    // The turn resolves the conflict by shell and commits; prepare-commit-msg
    // stamped the trailer, post-commit never ran.
    fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = "resolved";\nexport const C = 3;\n');
    git(repo, 'add', 'conflict.ts');
    git(repo, 'commit', '-q', '--no-edit', '-m', 'Merge main into feature',
      '-m', `Origin-Session: ${sessionId.slice(0, 12)} | Claude Code | 1 prompt | turn 1`);
    mergeSha = git(repo, 'rev-parse', 'HEAD');
    state = {
      sessionId, sessionTag: 'merge-missed', repoPath: repo, startedAt,
      ...baseline,
      sessionCommitShas: [],
      promptTurnIds: ['t_turn1'],
      promptIndexBase: 0,
    };
  });

  it('the header credits the merge with its resolution only', () => {
    const header = sessionAuthoredSnapshot(repo, state);
    expect(header.source).toBe('trailer');
    expect(header.filesChanged).toEqual(['conflict.ts']);
    expect(header.diff).not.toContain('THEIRS_');
  });

  it('the committing turn owns the same resolution the header shows', () => {
    const attested = attestHookMissedTrailerCommits(state, ownedRangeCommitShas(repo, state));
    expect(attested).toEqual([mergeSha]);
    expect(state.commitTurns).toEqual([expect.objectContaining({ sha: mergeSha, turnId: 't_turn1', via: 'trailer' })]);

    // The turn as Stop built it: the conflict fix was start dirt, so the
    // window shows nothing of its own.
    const turn: any = { promptIndex: 0, filesChanged: [], diff: '', linesAdded: 0, linesRemoved: 0 };
    preferCommitPatchForCommittedTurns(state, [turn], repo);

    const header = sessionAuthoredSnapshot(repo, state);
    expect(files(turn.diff)).toEqual(header.filesChanged);
    expect(turn.diff).not.toContain('THEIRS_');
    expect(sign(turn.diff, '+')).toBe(header.linesAdded);
    expect(sign(turn.diff, '-')).toBe(header.linesRemoved);
    expect(header.linesAdded).toBeGreaterThan(0);
  });

  it('attests nothing twice, and nothing another session trailered', () => {
    expect(attestHookMissedTrailerCommits(state, [mergeSha])).toEqual([]);
    const other = { ...state, sessionId: 'ffffffff-0000-0000-0000-000000000000', commitTurns: [], sessionCommitShas: [] };
    expect(attestHookMissedTrailerCommits(other, [mergeSha])).toEqual([]);
  });
});

describe('d7c5cad1: a clean `git merge` in a session with no recorded commit', () => {
  let repo = '';
  let state: any;

  beforeAll(() => {
    repo = forkedRepo('origin-merge-clean-');
    // Resolve feature's conflict up front, so the session's merge is clean.
    try { git(repo, 'merge', 'main'); } catch { /* conflict */ }
    fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = "resolved";\nexport const C = 3;\n');
    git(repo, 'add', 'conflict.ts');
    execFileSync('git', ['commit', '-q', '--no-edit'], {
      cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 1800_000).toISOString() },
    });
    // main moves on with work the session never sees.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'later.ts'), Array.from({ length: 30 }, (_, i) => `export const LATER_${i} = ${i};`).join('\n') + '\n');
    git(repo, 'add', '-A');
    execFileSync('git', ['commit', '-qm', 'main moves on'], {
      cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 1200_000).toISOString() },
    });
    git(repo, 'checkout', '-q', 'feature');
    // One pre-existing dirty file, as AGENTS.md was.
    fs.writeFileSync(path.join(repo, 'notes.md'), 'scratch\n');
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const baseline = captureSessionStartBaseline(repo, 'merge-clean');
    expect(baseline.sessionStartShadowSha).toBeTruthy();
    // The session: a clean merge (no post-commit, no trailer), then one real
    // uncommitted edit.
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main');
    fs.writeFileSync(path.join(repo, 'base.ts'), 'export const BASE = 2;\n');
    state = {
      sessionId: 'd7c5cad1-2cfd-459c-990b-2abd69ca559f', sessionTag: 'merge-clean', repoPath: repo, startedAt,
      ...baseline,
      sessionCommitShas: [],
      promptTurnIds: ['t_turn1'],
      promptIndexBase: 0,
    };
  });

  it('reproduces the field the header used to read: it holds what the merge brought in', () => {
    const snap = captureGitState(repo, state.sessionStartShadowSha, { fullContext: true });
    expect(snap.baselineIsShadow).toBe(true);
    expect(files(snap.workingTreeDiff)).toContain('later.ts');
  });

  it("the session's uncommitted work is its own edit, not the merge", () => {
    const uncommitted = uncommittedSinceSessionStart(repo, state.sessionStartShadowSha);
    expect(uncommitted).not.toBeNull();
    expect(files(uncommitted!)).toEqual(['base.ts']);
    const header = sessionAuthoredSnapshot(repo, state, { uncommittedDiff: uncommitted });
    expect(header.filesChanged).toEqual(['base.ts']);
    expect(header.diff).not.toContain('LATER_');
    expect(header.linesAdded).toBe(1);
    expect(header.linesRemoved).toBe(1);
  });

  it('the untrailered merge is not attested to a turn', () => {
    expect(attestHookMissedTrailerCommits(state, ownedRangeCommitShas(repo, state))).toEqual([]);
  });
});

describe('8cf9e6b1 as it really was: the resolution was already in the tree when the session started', () => {
  const sessionId = '8cf9e6b1-45ba-41f0-8070-ea9ce1787380';
  let repo = '';
  let mergeSha = '';
  let state: any;

  beforeAll(() => {
    repo = forkedRepo('origin-merge-preresolved-');
    // An earlier launch stopped on the conflict and resolved it, uncommitted.
    try { git(repo, 'merge', 'main'); } catch { /* conflict, expected */ }
    fs.writeFileSync(path.join(repo, 'conflict.ts'), 'export const A = 1;\nexport const B = "resolved";\nexport const C = 3;\n');
    // THEN this session starts, and only adds and commits.
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const baseline = captureSessionStartBaseline(repo, 'merge-preresolved');
    git(repo, 'add', 'conflict.ts');
    git(repo, 'commit', '-q', '--no-edit', '-m', 'Merge main into feature',
      '-m', `Origin-Session: ${sessionId.slice(0, 12)} | Claude Code | 1 prompt | turn 1`);
    mergeSha = git(repo, 'rev-parse', 'HEAD');
    state = {
      sessionId, sessionTag: 'merge-preresolved', repoPath: repo, startedAt,
      ...baseline,
      sessionCommitShas: [],
      promptTurnIds: ['t_turn1'],
      promptIndexBase: 0,
      // The turn started where the session did.
      promptShadows: [{ promptIndex: 0, shadowSha: baseline.sessionStartShadowSha }],
    };
  });

  it('neither the header nor the committing turn is credited the resolution', () => {
    expect(attestHookMissedTrailerCommits(state, ownedRangeCommitShas(repo, state))).toEqual([mergeSha]);
    const turn: any = { promptIndex: 0, filesChanged: ['conflict.ts'], diff: 'stale', linesAdded: 1, linesRemoved: 1 };
    preferCommitPatchForCommittedTurns(state, [turn], repo);
    expect(turn.filesChanged).toEqual([]);
    expect(turn.linesAdded).toBe(0);
    const header = sessionAuthoredSnapshot(repo, state);
    expect(header.filesChanged).toEqual([]);
    expect(header.linesAdded).toBe(0);
  });
});
