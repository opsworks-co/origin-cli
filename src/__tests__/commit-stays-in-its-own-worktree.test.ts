/**
 * A commit made in worktree A must never be credited to a session living in
 * worktree B.
 *
 * Observed on this machine with six live Claude worktrees, 2026-09-02 14:25:43
 * (~/.origin/hooks.log):
 *
 *   [prepare-commit-msg] trailers written  {"sessionId":"bd3c110a-286", …}
 *   [post-commit] disambiguated by Origin-Session trailer  {"ofActive":1}
 *   [post-commit] recorded commit on session  {"commitSha":"6d9fdd4c", …}
 *   [post-commit] branch changed
 *       {"from":"claude/prompt-2-to-3-migration-6388f5",
 *          "to":"claude/image-capture-modes"}
 *
 * `6d9fdd4c` was made in `screenshots-prompts-strategy-da0c24` by session
 * d731ff09. bd3c110a works in `adoring-cerf-65e553`. Once prepare-commit-msg
 * had written bd3c110a's id into the sibling's message, post-commit stopped
 * guessing: a trailer outranks everything, so it took the commit, restamped the
 * session's branch, and pushed 15 files / +454/-22 onto turn 2 of a session
 * that had written two files. The page read 17 files · +728/-43 · 2 branches.
 *
 * Both hooks trust a lone candidate absolutely — pickActiveSessionForCommit
 * returns on `length === 1` before scoring anything — so the fix has to be a
 * precondition on the candidate list, not another tie-breaker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excludeSessionsFromOtherTrees } from '../commands/hooks.js';

let root: string;
let mine: string;
let sibling: string;

const session = (id: string, repoPath: string | null, lastCwd: string | null): any => ({
  sessionId: id,
  ...(repoPath ? { repoPath } : {}),
  ...(lastCwd ? { lastCwd } : {}),
  startedAt: new Date(0).toISOString(),
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-trees-'));
  mine = path.join(root, 'adoring-cerf-65e553');
  sibling = path.join(root, 'screenshots-prompts-strategy-da0c24');
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('excludeSessionsFromOtherTrees', () => {
  it('drops the sibling worktree session that took 6d9fdd4c', () => {
    const kept = excludeSessionsFromOtherTrees(
      [
        session('bd3c110a-286f-4d04-bbce-55cdb657cf53', mine, mine),
        session('d731ff09-21a0-4c1e-9f77-1f2b3c4d5e6f', sibling, sibling),
      ],
      sibling, // the hook fires in the tree the commit is being made in
    );
    expect(kept.map((s) => s.sessionId.slice(0, 12))).toEqual(['d731ff09-21a']);
  });

  it('leaves a lone candidate that is genuinely this tree alone', () => {
    const kept = excludeSessionsFromOtherTrees(
      [session('d731ff09-21a0-4c1e-9f77-1f2b3c4d5e6f', sibling, sibling)],
      sibling,
    );
    expect(kept).toHaveLength(1);
  });

  it('leaves an UNCLAIMED tree alone — that is the EnterWorktree case', () => {
    // The session registered under the main checkout before the worktree
    // existed; the worktree fallback reached out to find it. Its tree being
    // "elsewhere" is what that fallback expects, and dropping it credits the
    // commit to nobody (worktree-capture.test.ts pins this).
    const only = [session('sess-main-1', root, root)];
    expect(excludeSessionsFromOtherTrees(only, sibling)).toEqual(only);
  });

  it('empties the list rather than handing back the wrong session', () => {
    // A claimant exists but the narrowing is about to hand back the other one.
    // "Some session" is worse than none: an unattributed commit is recoverable,
    // a mis-attributed one silently rewrites another session's branch and diff.
    const kept = excludeSessionsFromOtherTrees(
      [
        session('bd3c110a-286f-4d04-bbce-55cdb657cf53', mine, mine),
        session('d731ff09-21a0-4c1e-9f77-1f2b3c4d5e6f', sibling, null),
      ],
      sibling,
    );
    expect(kept.map((s) => s.sessionId.slice(0, 12))).toEqual(['d731ff09-21a']);
  });

  it('keeps a session with no recorded tree — unknown is not elsewhere', () => {
    // Mirrors what `unknownCwd` already keeps today; Cursor records no lastCwd.
    const kept = excludeSessionsFromOtherTrees(
      [session('c0ffee00-0000-4000-8000-000000000000', null, null)],
      sibling,
    );
    expect(kept).toHaveLength(1);
  });

  it('keeps a session that moved INTO this tree by hand', () => {
    // repoPath is the main checkout, but the agent `cd`-ed into the worktree
    // (session-worktree.ts). Dropping it would lose its own commits.
    const kept = excludeSessionsFromOtherTrees(
      [session('deadbeef-0000-4000-8000-000000000000', root, path.join(sibling, 'apps', 'api'))],
      sibling,
    );
    expect(kept).toHaveLength(1);
  });

  it('is inert when every candidate is already in this tree', () => {
    const sessions = [
      session('aaaaaaaa-0000-4000-8000-000000000000', sibling, sibling),
      session('bbbbbbbb-0000-4000-8000-000000000000', sibling, path.join(sibling, 'packages')),
    ];
    expect(excludeSessionsFromOtherTrees(sessions, sibling)).toEqual(sessions);
  });
});
