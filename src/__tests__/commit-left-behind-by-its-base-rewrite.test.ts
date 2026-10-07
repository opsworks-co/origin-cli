/**
 * A commit left behind when its own base was rewritten is not a branch of
 * the turn (TODO f998fc39).
 *
 * Session 690e594c (CLI .1910), turn 1: the version bump f1e51e72 sat on
 * f2c1714b. The branch was rebased (f2c1714b → f400d05f, recorded by
 * post-rewrite), the bump was reset away and redone on the new base as
 * a2bed1ad. f1e51e72 stayed in the turn's attested commits. No branch held
 * it, it had no rewrite of its own, and the same-parents test could not pair
 * it with its redo — their parents differ by that very rewrite — so it stood
 * `stranded`: its own branch patch, a second package.json section beside the
 * redo's, and the row's primary sha. Turn 2's 4a3e48f9 was the same shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';
import { createShadowCommit } from '../git-capture.js';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
const sections = (diff: string, file: string) => (diff.match(new RegExp(`^diff --git a/${file.replace('.', '\\.')} b/`, 'gm')) || []).length;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-left-behind-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  write('a.ts', 'a1\n'); write('package.json', '{"version":"1"}\n');
  commitAll('base');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

function leftBehindBump() {
  const baseline = createShadowCommit(repo, 'turn0') || git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'fix');
  write('a.ts', 'a1\na2\n');
  const feature = commitAll('fix: a');
  write('package.json', '{"version":"2"}\n');
  const bump = commitAll('chore: bump');
  // Drop the bump, rebase the feature onto a newer main, redo the bump there.
  git('reset', '-q', '--hard', 'HEAD~1');
  git('checkout', '-q', 'main');
  write('other.ts', 'o\n'); commitAll('main moves on');
  git('checkout', '-q', 'fix');
  git('rebase', '-q', 'main');
  const rebased = git('rev-parse', 'HEAD');
  write('package.json', '{"version":"3"}\n');
  const redo = commitAll('chore: bump');
  // As in 690e594c: the rewritten base is an EARLIER turn's commit; this
  // turn holds only the bump it left behind and the redo.
  const state = {
    promptTurnIds: ['t_prev', 't_0'],
    commitTurns: [{ sha: feature, turnId: 't_prev' }, { sha: bump, turnId: 't_0' }, { sha: redo, turnId: 't_0' }],
    rewrittenCommits: [{ from: feature, to: rebased }],
    promptShadows: [{ promptIndex: 0, shadowSha: baseline }, { promptIndex: 1, shadowSha: baseline }],
    prePromptSha: null,
  };
  const mapping: Record<string, unknown> = { promptIndex: 1, filesChanged: [], diff: '', uncommittedDiff: '', linesAdded: 0, linesRemoved: 0 };
  return { feature, bump, rebased, redo, state, mapping };
}

describe('a commit left behind by a rewrite of its own base', () => {
  it('is not sent as a branch of the turn: one package.json section, the redo, and the redo as primary', () => {
    const { bump, redo, state, mapping } = leftBehindBump();
    const logs: Array<Record<string, unknown>> = [];
    preferCommitPatchForCommittedTurns(state as never, [mapping as never], repo, {
      log: (_e, d) => logs.push(d as Record<string, unknown>),
    });
    const diff = String(mapping.diff || '');
    expect(sections(diff, 'package.json')).toBe(1);
    expect(diff).toContain('+{"version":"3"}');
    expect(diff).not.toContain('+{"version":"2"}');
    expect(mapping.commitSha).not.toBe(bump);
    expect(mapping.commitSha).toBe(redo);
    expect(JSON.stringify(logs)).not.toContain(bump.slice(0, 8));
  });

  it('a commit whose base was rewritten WITH it (its own rewrite recorded) keeps today\'s handling', () => {
    const { bump, state, mapping } = leftBehindBump();
    // Record the bump as rewritten too: it was carried, not left behind.
    (state.rewrittenCommits as Array<{ from: string; to: string }>).push({ from: bump, to: bump });
    expect(() => preferCommitPatchForCommittedTurns(state as never, [mapping as never], repo, {})).not.toThrow();
  });
});
