/**
 * post-commit scopes a commit to the turn from the tree the turn INHERITED,
 * per file — not from a shadow cut before a checkout.
 *
 * Session c5487aa9 turn 2 (2026-09-15). The turn ran
 * `git checkout -b review/pr-1642 pr-1642` — a branch whose commit ced61af0c
 * was authored by ANOTHER session and created
 * `capture-e2e-codex-native-resume.test.ts` — merged origin/main (47ffa773),
 * then committed ca004c24, which changed that test file by +2/-1. post-commit
 * logged:
 *
 *   [post-commit] scoped commit to prompt baseline
 *     {"promptIndex":1,"commitLines":"+2/-1","promptLines":"+64/-0"}
 *
 * The baseline was the turn's shadow, cut before the checkout; the file did
 * not exist there, so baseline→commit read as a whole new file.
 *
 * Stop answers this class with `inheritedBaseline`: the NEWEST inherited
 * commit behind all the turn's own. The merge brought in TWO foreign lines —
 * ced61af0c (the PR, holding the file) and acd0c65bd (main, not holding it) —
 * and in the real session main's commit was the newer one. Newest-first picks
 * a tree without the file, and the +64 stands. So each file is asked on its
 * own which inherited commit it came from, and the test runs in BOTH commit
 * date orders.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inheritedBaselineForTurn, inheritedBeforeStatesForTurn, scopedCommitForTurn } from '../commands/hooks.js';
import { preferCommitPatchForCommittedTurns } from '../commit-patch-for-committed-turn.js';

const SESSION = 'c5487aa9-8594-4af0-9bc3-42aafd775cc7';
const EARLIER_TURN = 't_earlier';
const TURN = 't_c511894ae02e4d0b';
const FILE = 'packages/cli/src/__tests__/capture-e2e-codex-native-resume.test.ts';

const SESSION_STARTED_AT = '2026-09-14T23:56:45.000Z';

let repo: string, home: string, prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();

const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';

const at = (iso: string) => ({ GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });

/** A commit another session made: same local identity, a trailer naming it. */
function foreignCommit(message: string, trailer: string, iso: string, email = 'dev@test.dev') {
  git(['add', '-A']);
  git(['commit', '-q', '-m', `${message}\n\nOrigin-Session: ${trailer} | Codex | 30 prompts`], {
    ...at(iso), GIT_COMMITTER_EMAIL: email,
  });
  return git(['rev-parse', 'HEAD']);
}

/** The shadow the turn's baseline is: the working tree at turn start. */
function shadowOf(ref: string): string {
  const tree = git(['rev-parse', `${ref}^{tree}`]);
  return git(['commit-tree', tree, '-p', ref, '-m', 'origin shadow prompt-1']);
}

beforeEach(() => {
  prevHome = process.env.HOME; prevUserProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('README.md', 'seed\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed'], at('2026-09-14T12:00:00Z'));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function stateFor(shadow: string, own: string[]) {
  return {
    sessionId: SESSION, sessionTag: 'fb6151ba-bf4', repoPath: repo, lastCwd: repo,
    startedAt: SESSION_STARTED_AT,
    prompts: ['earlier', 'review and merge 1642'],
    promptTurnIds: [EARLIER_TURN, TURN],
    promptShadows: [{ promptIndex: 1, shadowSha: shadow }],
    sessionCommitShas: own,
    commitTurns: own.map((sha) => ({ sha, turnId: TURN })),
  } as any;
}

/**
 * The c5487aa9 shape. `prNewer` decides which foreign line carries the later
 * committer date — the order `inheritedBaseline` walks.
 */
function runTheTurn(prNewer: boolean) {
  const PR_AT = prNewer ? '2026-09-15T00:25:49Z' : '2026-09-15T00:09:52Z';
  const MAIN_AT = prNewer ? '2026-09-15T00:09:52Z' : '2026-09-15T00:25:49Z';
  const base = git(['rev-parse', 'HEAD']);

  // Another session's PR branch creates the test file.
  git(['checkout', '-q', '-b', 'pr-1642']);
  write(FILE, lines(63, 'resume'));
  const pr = foreignCommit('fix(codex): resume the exact native conversation', 'f53bd03d-2fd', PR_AT);

  // origin/main moves on in a file that has nothing to do with it (a GitHub
  // squash). Local main has not been pulled when the turn starts.
  git(['checkout', '-q', '-b', 'upstream', base]);
  write('packages/cli/src/turn-diff.ts', lines(12, 'turnDiff'));
  const mainTip = foreignCommit('fix(capture): editsJson', '02fb5c9e-e80', MAIN_AT, 'noreply@github.com');
  git(['update-ref', 'refs/remotes/origin/main', mainTip]);
  git(['checkout', '-q', 'main']);
  git(['branch', '-q', '-D', 'upstream']);

  // ── Turn 2 ──────────────────────────────────────────────────────────────
  const shadow = shadowOf('main');
  git(['checkout', '-q', '-b', 'review/pr-1642', pr]);
  git(['merge', '-q', '--no-ff', '--no-edit', 'origin/main',
    '-m', `Merge origin/main\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts`],
  at('2026-09-15T00:56:07Z'));
  const merge = git(['rev-parse', 'HEAD']);

  // The turn's own edit: +2/-1.
  const body = fs.readFileSync(path.join(repo, FILE), 'utf-8').split('\n');
  body[10] = 'const resume10 = "edited";';
  body.splice(20, 0, 'const added = true;');
  write(FILE, body.join('\n'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', `fix: ENOTEMPTY\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts`],
    at('2026-09-15T00:56:27Z'));
  const ours = git(['rev-parse', 'HEAD']);
  return { shadow, merge, ours, pr, mainTip };
}

function commitStat(sha: string) {
  return git(['show', '--numstat', '--format=', sha]).split('\n').filter(Boolean)
    .reduce((acc, l) => {
      const [a, r] = l.split('\t');
      return { added: acc.added + Number(a), removed: acc.removed + Number(r) };
    }, { added: 0, removed: 0 });
}

describe('post-commit scopes a commit from the tree the turn inherited, per file', () => {
  for (const prNewer of [false, true]) {
    const order = prNewer ? 'the PR line is newer than main' : 'main is newer than the PR line (c5487aa9)';

    it(`credits the turn +2/-1, not the checked-out file's +64, when ${order}`, () => {
      const { shadow, merge, ours } = runTheTurn(prNewer);
      expect(commitStat(ours)).toEqual({ added: 2, removed: 1 });

      const state = stateFor(shadow, [merge, ours]);
      const scoped = scopedCommitForTurn(repo, state, 1, shadow, ours, [FILE]);

      expect(scoped).not.toBeNull();
      expect({ added: scoped!.linesAdded, removed: scoped!.linesRemoved }).toEqual({ added: 2, removed: 1 });
      expect(scoped!.files).toEqual([FILE]);
      expect(scoped!.diff).toContain('+const added = true;');
      expect(scoped!.diff).not.toContain('+const resume0 = 0;');
    });
  }

  for (const prNewer of [false, true]) {
    const order = prNewer ? 'the PR line is newer than main' : 'main is newer than the PR line (c5487aa9)';

    it(`Stop: the inherited tree holds BOTH foreign lines when ${order}`, () => {
      const { shadow, merge, ours, pr, mainTip } = runTheTurn(prNewer);
      const state = stateFor(shadow, [merge, ours]);

      const inherited = inheritedBaselineForTurn(repo, state, shadow, 1);
      expect(inherited).toBeTruthy();
      const at = (rev: string, f: string) => git(['show', `${rev}:${f}`]);
      expect(at(inherited!, FILE)).toBe(at(pr, FILE));
      expect(at(inherited!, 'packages/cli/src/turn-diff.ts')).toBe(at(mainTip, 'packages/cli/src/turn-diff.ts'));

      const before = inheritedBeforeStatesForTurn(repo, state, shadow, 1);
      // The ledger's before-state for the file is the PR's version, not "absent".
      expect(before.get(FILE)?.trim()).toBe(at(pr, FILE));
    });

    it(`Stop: the commit patch gives the turn +2/-1 when ${order}`, () => {
      const { shadow, merge, ours } = runTheTurn(prNewer);
      const state = stateFor(shadow, [merge, ours]);
      const pm: any = { promptIndex: 1, filesChanged: [FILE], linesAdded: 64, linesRemoved: 0, diff: `diff --git a/${FILE} b/${FILE}\n` };

      preferCommitPatchForCommittedTurns(state, [pm], repo, {
        inheritedBaseline: (shadowSha, localTurn) => inheritedBaselineForTurn(repo, state, shadowSha, localTurn),
      });

      expect({ added: pm.linesAdded, removed: pm.linesRemoved }).toEqual({ added: 2, removed: 1 });
      expect(pm.diff).not.toContain('+const resume0 = 0;');
    });
  }

  /**
   * Two inherited lines that CONFLICT. The turn stands on `left` and merges
   * `right`; both created shared.ts. There is no clean merged tree, and picking
   * the newer line by date is the coin toss this file exists to remove. The
   * resolution is the turn's own work, measured — as mergeOwnDiff measures a
   * merge — against the side the turn stood on: its first-parent line.
   */
  function runConflictingTurn(rightNewer: boolean) {
    const base = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '-b', 'left']);
    write('shared.ts', lines(10, 'left'));
    write('left-only.ts', lines(3, 'lo'));
    const left = foreignCommit('left', 'f53bd03d-2fd', rightNewer ? '2026-09-15T00:10:00Z' : '2026-09-15T00:20:00Z');
    git(['checkout', '-q', '-b', 'right', base]);
    write('shared.ts', lines(10, 'right'));
    write('right-only.ts', lines(4, 'ro'));
    const right = foreignCommit('right', '02fb5c9e-e80', rightNewer ? '2026-09-15T00:20:00Z' : '2026-09-15T00:10:00Z');
    git(['checkout', '-q', 'main']);
    const shadow = shadowOf('main');

    git(['checkout', '-q', '-b', 'turn', left]);
    expect(() => git(['merge', '-q', '--no-edit', 'right'])).toThrow();
    write('shared.ts', lines(10, 'left') + 'const resolved = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', `Merge right\n\nOrigin-Session: ${SESSION.slice(0, 12)} | Claude Code | 2 prompts`],
      at('2026-09-15T00:56:00Z'));
    const merge = git(['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(repo, 'shared.ts'), 'const tail = 1;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'ours'], at('2026-09-15T00:57:00Z'));
    const ours = git(['rev-parse', 'HEAD']);
    return { shadow, left, right, merge, ours };
  }

  for (const rightNewer of [false, true]) {
    const order = rightNewer ? 'the merged-in line is newer' : 'the line the turn stood on is newer';

    it(`Stop: conflicting lines resolve to the side the turn stood on when ${order}`, () => {
      const { shadow, left, right, merge, ours } = runConflictingTurn(rightNewer);
      const state = stateFor(shadow, [merge, ours]);

      const inherited = inheritedBaselineForTurn(repo, state, shadow, 1);
      expect(inherited).toBeTruthy();
      const at = (rev: string, f: string) => git(['show', `${rev}:${f}`]);
      expect(at(inherited!, 'shared.ts')).toBe(at(left, 'shared.ts'));
      expect(at(inherited!, 'left-only.ts')).toBe(at(left, 'left-only.ts'));
      expect(at(inherited!, 'right-only.ts')).toBe(at(right, 'right-only.ts'));

      const pm: any = { promptIndex: 1, filesChanged: ['shared.ts'], linesAdded: 12, linesRemoved: 0, diff: 'diff --git a/shared.ts b/shared.ts\n' };
      preferCommitPatchForCommittedTurns(state, [pm], repo, {
        inheritedBaseline: (shadowSha, localTurn) => inheritedBaselineForTurn(repo, state, shadowSha, localTurn),
      });
      // The resolution line and the tail — nothing of either branch.
      expect({ added: pm.linesAdded, removed: pm.linesRemoved }).toEqual({ added: 2, removed: 0 });
    });

    it(`post-commit: a file both lines touched is measured from the side the turn stood on when ${order}`, () => {
      const { shadow, merge, ours } = runConflictingTurn(rightNewer);
      const state = stateFor(shadow, [merge, ours]);

      const scoped = scopedCommitForTurn(repo, state, 1, shadow, ours, ['shared.ts']);
      expect(scoped!.inheritedFiles).toEqual(['shared.ts']);
      expect({ added: scoped!.linesAdded, removed: scoped!.linesRemoved }).toEqual({ added: 2, removed: 0 });
    });
  }

  it('still scopes from the shadow when nothing was inherited (dirty baseline, the +15 → +5 case)', () => {
    write('ten-lines.txt', lines(10, 'line'));
    const tree = (() => {
      const idx = path.join(repo, '.git', 'tmp-index');
      const env = { GIT_INDEX_FILE: idx };
      git(['read-tree', 'HEAD'], env);
      git(['add', '-A'], env);
      const t = git(['write-tree'], env);
      fs.unlinkSync(idx);
      return t;
    })();
    const shadow = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'origin shadow prompt-1']);
    fs.appendFileSync(path.join(repo, 'ten-lines.txt'), lines(5, 'more'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fifteen'], at('2026-09-15T00:30:00Z'));
    const ours = git(['rev-parse', 'HEAD']);

    const scoped = scopedCommitForTurn(repo, stateFor(shadow, [ours]), 1, shadow, ours, ['ten-lines.txt']);
    expect({ added: scoped!.linesAdded, removed: scoped!.linesRemoved }).toEqual({ added: 5, removed: 0 });
  });

  it('keeps the turn\'s own earlier commit of the file in its count', () => {
    const shadow = shadowOf('main');
    write('own.ts', lines(30, 'own'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'create'], at('2026-09-15T00:30:00Z'));
    const first = git(['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(repo, 'own.ts'), lines(2, 'tail'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'extend'], at('2026-09-15T00:31:00Z'));
    const second = git(['rev-parse', 'HEAD']);

    const scoped = scopedCommitForTurn(repo, stateFor(shadow, [first, second]), 1, shadow, second, ['own.ts']);
    expect({ added: scoped!.linesAdded, removed: scoped!.linesRemoved }).toEqual({ added: 32, removed: 0 });
  });
});
