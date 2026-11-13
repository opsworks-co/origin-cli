/**
 * The search for a session from another repository has three answers, not two.
 *
 * `sessionsWorkingInForeignTree` returned `[]` both when no session reached the
 * committing checkout and when several did and were deliberately not guessed
 * between. post-commit could not tell those apart, so after the refusal it ran
 * its no-session process detection anyway: a host with exactly one standalone
 * agent running (a real Codex, here) turned "two sessions — not guessing" into
 * a `detected-codex-*` note on the commit. `findSessionWorkingInForeignTree`
 * keeps `none`, `unique` and `ambiguous` apart, and the git-hook lookup carries
 * the outcome to post-commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filesWrittenInTree, findSessionWorkingInForeignTree, pickEndedForeignSessionByFiles, recordForeignTrees, settleForeignTreeProbes, armForeignTreeProbes } from '../foreign-trees.js';
import { listSessionsForGitHookUnscoped, lookupSessionsForGitHook, sessionWroteCommitFileInTree } from '../commands/hooks/post-commit.js';
import { getGitCommonDir } from '../session-state.js';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  return fs.realpathSync.native(dir);
}

describe('foreign session lookup outcome', () => {
  let tmp: string;
  let repoB: string;
  let mirrorDir: string;
  const written: string[] = [];

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-foreign-outcome-')));
    repoB = makeRepo(tmp, 'repo-b');
    mirrorDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(mirrorDir, { recursive: true });
  });

  afterEach(() => {
    for (const f of written.splice(0)) fs.rmSync(f, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A live session homed in its own repository that reached `tree` in its running turn. */
  function mirrorSession(sessionId: string, tree: string, opts: { turnClosed?: boolean; branch?: string; files?: string[] } = {}): void {
    const home = makeRepo(tmp, `home-${sessionId}`);
    const state: Record<string, unknown> = {
      sessionId,
      repoPath: home,
      startedAt: new Date().toISOString(),
      prompts: ['look at the other repository'],
      foreignTrees: [{ path: tree, commonDir: getGitCommonDir(repoB), at: new Date().toISOString(), turn: 0 }],
    };
    if (opts.branch) state.branch = opts.branch;
    if (opts.files) state.completedPromptMappings = [{ promptIndex: 0, filesChanged: opts.files }];
    if (opts.turnClosed) state.lastClosedTurnIndex = 0;
    else state.activeTurn = { index: 0 };
    const file = path.join(mirrorDir, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(state));
    written.push(file);
  }

  it('none: no session reached the checkout', () => {
    expect(findSessionWorkingInForeignTree(repoB)).toEqual({ outcome: 'none' });
    expect(lookupSessionsForGitHook(repoB)).toMatchObject({ sessions: [], foreign: { outcome: 'none' } });
  });

  it('none: the only session that reached it has closed that turn', () => {
    mirrorSession('foreign-closed-0001', repoB, { turnClosed: true });

    expect(findSessionWorkingInForeignTree(repoB)).toEqual({ outcome: 'none' });
  });

  it('unique: one live session reached the checkout in its running turn', () => {
    mirrorSession('foreign-unique-0001', repoB);

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome).toBe('unique');
    expect(found.outcome === 'unique' && found.session.sessionId).toBe('foreign-unique-0001');

    const lookup = lookupSessionsForGitHook(repoB);
    expect(lookup.foreign?.outcome).toBe('unique');
    expect(lookup.sessions.map((s) => s.sessionId)).toEqual(['foreign-unique-0001']);
  });

  it('unique: the session that recorded THIS tree wins over one that recorded only a sibling', () => {
    mirrorSession('foreign-exact-0001', repoB);
    mirrorSession('foreign-sibling-0002', path.join(tmp, 'repo-b-sibling-worktree'));

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome === 'unique' && found.session.sessionId).toBe('foreign-exact-0001');
  });

  it('ambiguous: two live sessions reached the checkout and nothing tells them apart', () => {
    mirrorSession('foreign-first-0001', repoB);
    mirrorSession('foreign-second-0002', repoB);

    const found = findSessionWorkingInForeignTree(repoB);
    expect(found.outcome).toBe('ambiguous');
    expect(found.outcome === 'ambiguous' && [...found.sessionIds].sort())
      .toEqual(['foreign-first-0001', 'foreign-second-0002']);

    // The session list is empty exactly as for `none` — only the outcome
    // tells post-commit that process detection must not run.
    const lookup = lookupSessionsForGitHook(repoB);
    expect(lookup.sessions).toEqual([]);
    expect(lookup.foreign?.outcome).toBe('ambiguous');
    expect(listSessionsForGitHookUnscoped(repoB)).toEqual([]);
  });

  // Prod 08705ba (PR #3076, 2026-11-03): Claude Code session db727022, homed in
  // `origin`, wrote a patch in the sibling checkout, its turn closed, and an hour
  // later a person committed that work from PyCharm, on the same branch name.
  // No turn running and no commit claim, so the search answered `none` and the
  // process fallback wrote a `detected-codex-*` note.
  describe('a closed turn, for a commit made later by hand', () => {
    const BRANCH = 'OR-27-isolate';
    const setRecordedBranches = (sessionId: string, branches: string[]) => {
      const p = path.join(mirrorDir, `${sessionId}.json`);
      const st = JSON.parse(fs.readFileSync(p, 'utf-8'));
      st.foreignTrees[0].branches = branches;
      fs.writeFileSync(p, JSON.stringify(st));
    };
    const addOutOfRepoFile = (sessionId: string, file: string) => {
      const p = path.join(mirrorDir, `${sessionId}.json`);
      const st = JSON.parse(fs.readFileSync(p, 'utf-8'));
      st.completedPromptMappings[0].outOfRepoFiles = [file];
      fs.writeFileSync(p, JSON.stringify(st));
    };
    const onBranch = () => {
      // A commit first: an unborn HEAD has no branch to read.
      git(repoB, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'base']);
      git(repoB, ['checkout', '-q', '-b', BRANCH]);
    };

    it('unique: the session is on the same branch and touched a committed file', () => {
      onBranch();
      mirrorSession('foreign-later-0001', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });

      const lookup = lookupSessionsForGitHook(repoB, { commitFiles: ['FORK_PATCH.md'] });
      expect(lookup.foreign?.outcome).toBe('unique');
      expect(lookup.sessions.map((s) => s.sessionId)).toEqual(['foreign-later-0001']);
    });

    it('none: the session touched only half of the commit', () => {
      onBranch();
      mirrorSession('foreign-later-0014', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['FORK_PATCH.md', 'other.py'] }).foreign).toEqual({ outcome: 'none' });
    });

    it('unique: the write is recorded by its absolute path in this checkout', () => {
      onBranch();
      mirrorSession('foreign-later-0010', repoB, { turnClosed: true, branch: BRANCH, files: [] });
      addOutOfRepoFile('foreign-later-0010', path.join(repoB, 'rhodecode', 'patch.py'));

      const lookup = lookupSessionsForGitHook(repoB, { commitFiles: ['rhodecode/patch.py'] });
      expect(lookup.sessions.map((s) => s.sessionId)).toEqual(['foreign-later-0010']);
    });

    it('reads an out-of-repo path stored with the home collapsed to ~', () => {
      const tree = path.join(os.homedir(), 'Python', 'rhodecode-enterprise-ce');
      const session = { completedPromptMappings: [{ outOfRepoFiles: ['~/Python/rhodecode-enterprise-ce/FORK_PATCH.md'] }] };

      expect(sessionWroteCommitFileInTree(session, ['FORK_PATCH.md'], tree)).toBe(true);
      expect(sessionWroteCommitFileInTree(session, ['other.py'], tree)).toBe(false);
    });

    it('none: an out-of-repo write with the same name, in another directory', () => {
      onBranch();
      mirrorSession('foreign-later-0011', repoB, { turnClosed: true, branch: BRANCH, files: [] });
      addOutOfRepoFile('foreign-later-0011', path.join(repoB, 'docs', 'patch.py'));

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['rhodecode/patch.py'] }).foreign).toEqual({ outcome: 'none' });
    });

    // Prod fe9fc5ad (OR-61): session 64d4d405 stayed on main in its own checkout
    // and ran `git switch -c OR-61` in the sibling one. The session's branch is
    // its own checkout's and says nothing about this one.
    it('unique: the checkout was on this branch when the session reached it, whatever its own branch', () => {
      onBranch();
      mirrorSession('foreign-later-0012', repoB, { turnClosed: true, branch: 'main', files: ['test_repository.py'] });
      setRecordedBranches('foreign-later-0012', [BRANCH]);

      const lookup = lookupSessionsForGitHook(repoB, { commitFiles: ['test_repository.py'] });
      expect(lookup.sessions.map((s) => s.sessionId)).toEqual(['foreign-later-0012']);
    });

    it('none: the session reached the checkout only on other branches', () => {
      onBranch();
      mirrorSession('foreign-later-0013', repoB, { turnClosed: true, branch: 'main', files: ['test_repository.py'] });
      setRecordedBranches('foreign-later-0013', ['OR-61-other']);

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['test_repository.py'] }).foreign).toEqual({ outcome: 'none' });
    });

    it('recording keeps every branch the checkout was on, across a switch', () => {
      onBranch();
      const home = makeRepo(tmp, 'home-record');
      const state: any = { sessionId: 'record-0001', repoPath: home, prompts: ['x'], activeTurn: { index: 0 } };

      expect(recordForeignTrees(state, { filePaths: [path.join(repoB, 'a.py')] })).toBe(true);
      git(repoB, ['checkout', '-q', '-b', 'OR-next']);
      expect(recordForeignTrees(state, { filePaths: [path.join(repoB, 'a.py')] })).toBe(true);

      expect(state.foreignTrees).toHaveLength(1);
      expect(state.foreignTrees[0].branches).toEqual([BRANCH, 'OR-next']);
    });

    it('none: same branch, but the session touched none of the committed files', () => {
      onBranch();
      mirrorSession('foreign-later-0002', repoB, { turnClosed: true, branch: BRANCH, files: ['notes.md'] });

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['by-hand.py'] }).foreign).toEqual({ outcome: 'none' });
    });

    it('none: it touched a committed file, but on another branch', () => {
      onBranch();
      mirrorSession('foreign-later-0003', repoB, { turnClosed: true, branch: 'main', files: ['README.md'] });

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['README.md'] }).foreign).toEqual({ outcome: 'none' });
    });

    it('none: main is on every clone, so sharing it is no evidence', () => {
      git(repoB, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'base']);
      mirrorSession('foreign-later-0009', repoB, { turnClosed: true, branch: 'main', files: ['README.md'] });

      expect(lookupSessionsForGitHook(repoB, { commitFiles: ['README.md'] }).foreign).toEqual({ outcome: 'none' });
    });

    it('none: a caller that names no commit files has no evidence', () => {
      onBranch();
      mirrorSession('foreign-later-0004', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });

      expect(lookupSessionsForGitHook(repoB).foreign).toEqual({ outcome: 'none' });
    });

    it('a session with its turn running wins over one with only a closed turn', () => {
      onBranch();
      mirrorSession('foreign-later-0005', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });
      mirrorSession('foreign-running-0006', repoB);

      const found = lookupSessionsForGitHook(repoB, { commitFiles: ['FORK_PATCH.md'] });
      expect(found.foreign?.outcome).toBe('unique');
      expect(found.sessions.map((s) => s.sessionId)).toEqual(['foreign-running-0006']);
    });

    it('ambiguous: two closed sessions have the same evidence', () => {
      onBranch();
      mirrorSession('foreign-later-0007', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });
      mirrorSession('foreign-later-0008', repoB, { turnClosed: true, branch: BRANCH, files: ['FORK_PATCH.md'] });

      const found = lookupSessionsForGitHook(repoB, { commitFiles: ['FORK_PATCH.md'] });
      expect(found.foreign?.outcome).toBe('ambiguous');
      expect(found.sessions).toEqual([]);
    });
  });

  describe('files a session changed in another checkout', () => {
    const deps = (dirty: Record<string, number>) => ({
      listDirty: () => Object.keys(dirty),
      stat: (_t: string, f: string) => (f in dirty ? { mtimeMs: dirty[f], size: 1 } : null),
    });
    const stateIn = (tree: string): any => ({
      sessionId: 'probe-0001', repoPath: '/home/repo', prompts: ['x'], activeTurn: { index: 3 },
      foreignTrees: [{ path: tree, commonDir: '/c', at: 'now', turn: 3 }],
    });

    it('a file the command changed is recorded with its turn; one dirty and unchanged is not', () => {
      const st = stateIn(repoB);
      armForeignTreeProbes(st, { cwd: repoB, command: 'python3 - <<EOF', toolCallId: 'c1' }, deps({ 'old.py': 1 }));
      settleForeignTreeProbes(st, 'c1', deps({ 'old.py': 1, 'new.py': 2 }));

      expect(st.foreignTrees[0].files).toEqual([{ file: 'new.py', turn: 3 }]);
      expect(st.foreignTrees[0].probes).toBeUndefined();
    });

    it('a read-shaped command is not probed', () => {
      const st = stateIn(repoB);
      armForeignTreeProbes(st, { cwd: repoB, command: 'ls -la', toolCallId: 'c2' }, deps({}));

      expect(st.foreignTrees[0].probes).toBeUndefined();
    });

    it('a command that did not reach the checkout is not probed', () => {
      const st = stateIn(repoB);
      armForeignTreeProbes(st, { cwd: '/elsewhere', command: 'python3 - <<EOF', toolCallId: 'c3' }, deps({}));

      expect(st.foreignTrees[0].probes).toBeUndefined();
    });

    it('filesWrittenInTree reads the probe record and the turns\' out-of-repo writes', () => {
      const st = stateIn(repoB);
      st.promptIndexBase = 2;
      st.foreignTrees[0].files = [{ file: 'a.py', turn: 0 }];
      st.completedPromptMappings = [{ promptIndex: 3, outOfRepoFiles: [path.join(repoB, 'b.py'), '/elsewhere/c.py'] }];

      expect(filesWrittenInTree(st, repoB)).toEqual([{ file: 'b.py', turn: 1 }, { file: 'a.py', turn: 0 }]);
    });
  });

  describe('an ended session from another repository', () => {
    const ended = (id: string, files: string[], branches = ['OR-53']): any => ({
      sessionId: id,
      foreignTrees: [{ path: repoB, commonDir: '/c', at: 'x', turn: 1, branches, files: files.map((file) => ({ file, turn: 1 })) }],
    });

    it('owns the commit when it wrote most of its files on this branch', () => {
      const owner = pickEndedForeignSessionByFiles([ended('e1', ['a.py', 'b.py'])], repoB, 'OR-53', ['a.py', 'b.py', 'c.py']);
      expect(owner?.state.sessionId).toBe('e1');
      expect(owner?.promptIndexes).toEqual([1]);
    });

    it('does not own it holding half or less', () => {
      expect(pickEndedForeignSessionByFiles([ended('e2', ['a.py'])], repoB, 'OR-53', ['a.py', 'b.py'])).toBeNull();
    });

    it('does not own it from another branch', () => {
      expect(pickEndedForeignSessionByFiles([ended('e3', ['a.py'], ['OR-27'])], repoB, 'OR-53', ['a.py'])).toBeNull();
    });

    it('does not own it on main or master, which every clone has', () => {
      for (const branch of ['main', 'master']) {
        expect(pickEndedForeignSessionByFiles([ended('e8', ['a.py'], [branch])], repoB, branch, ['a.py'])).toBeNull();
      }
    });

    it('two sessions with the same evidence own nothing; more evidence wins', () => {
      expect(pickEndedForeignSessionByFiles([ended('e4', ['a.py']), ended('e5', ['a.py'])], repoB, 'OR-53', ['a.py'])).toBeNull();
      const owner = pickEndedForeignSessionByFiles([ended('e6', ['a.py', 'b.py']), ended('e7', ['a.py', 'b.py', 'c.py'])], repoB, 'OR-53', ['a.py', 'b.py', 'c.py']);
      expect(owner?.state.sessionId).toBe('e7');
    });
  });
});
