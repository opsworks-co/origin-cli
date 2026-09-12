/**
 * A TODO travels with the repo; until now its closure did not.
 *
 * `openTodos` lives on the memory note attached to the root commit, so it
 * reaches every clone. Closing one wrote a tombstone to
 * `~/.origin/origin-todos.json` — outside any repo — so the item stayed open on
 * every other machine, every fresh clone and CI, forever. On this repo that was
 * 60 open items of which a third were already dealt with.
 *
 * The second half is why nothing closed them on its own. Matching merged PRs to
 * TODO text by hand was tried against those 60 and fails on their actual shape:
 * most read "I did NOT fix X while doing Y", so Y's PR merging is the moment
 * they START mattering. The link is therefore asserted by the session that did
 * the work (`[Origin: Closes] <id>`) and CONFIRMED by the default branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pushMemoryNotes, syncNotesFromRemote } from '../git-notes.js';
import { mergeMemoryPayloads, readTodoClosures, todoClosureKey } from '../memory.js';
import { getOpenTodos, markTodoDone } from '../todo.js';
import { matchTodoForClosure, recordPendingClosures, sweepTodoClosures } from '../todo-sweep.js';

const TODO = 'the shadow-ref leak still has no owner; a retention policy needs designing';
const OTHER = 'mobile layout unverified; alert() still used on a few pages';
const SID = 'd5cc625b-3af00000-1111-2222-333344445555';

let tmpRoot: string, upstream: string, alice: string, bob: string;
let aliceHome: string, bobHome: string;
let prevHome: string | undefined, prevUserProfile: string | undefined;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

// The developer's own globally-installed Origin hooks would annotate these
// fixture commits mid-test.
const muteHooks = (dir: string) => git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));

function writeMemory(repo: string, sessions: any[]): void {
  const root = git(repo, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  git(repo, 'notes', '--ref=origin-memory', 'add', '-f', '-m',
    JSON.stringify({ version: 2, sessions, commits: [] }, null, 2), root);
}

const session = (id: string, openTodos: string[]) => ({
  sessionId: id,
  agentSlug: 'claude-code',
  model: 'claude',
  startedAt: '2026-09-01T00:00:00.000Z',
  endedAt: '2026-09-01T01:00:00.000Z',
  branch: 'main',
  summary: `work ${id}`,
  filesChanged: [`${id}.ts`],
  promptCount: 1,
  linesAdded: 10,
  linesRemoved: 0,
  openTodos,
});

/**
 * Each clone is a different machine, so each gets its own local TODO store.
 *
 * USERPROFILE as well as HOME: `os.homedir()` — which is what locates
 * `~/.origin/origin-todos.json` — reads USERPROFILE on Windows and ignores
 * HOME entirely. With only HOME set, every test in this file shared the
 * RUNNER'S REAL store, and since a TODO's id is `hash(text + sessionId)` the
 * closure written by the first test suppressed the identically-worded TODO in
 * the later ones (`getOpenTodos` matches a recorded id across repos). The
 * claim tests then had no open TODO to name and recorded nothing. Green on
 * POSIX, red only on the Windows job.
 */
const asMachine = (home: string) => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
};

beforeEach(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-todo-close-')));
  upstream = path.join(tmpRoot, 'upstream.git');
  alice = path.join(tmpRoot, 'alice');
  bob = path.join(tmpRoot, 'bob');
  aliceHome = path.join(tmpRoot, 'home-alice');
  bobHome = path.join(tmpRoot, 'home-bob');
  fs.mkdirSync(aliceHome); fs.mkdirSync(bobHome);

  execFileSync('git', ['init', '--bare', '-b', 'main', upstream], { stdio: 'pipe' });
  execFileSync('git', ['clone', upstream, alice], { stdio: 'pipe' });
  muteHooks(alice);
  git(alice, 'config', 'user.email', 'alice@test.dev');
  git(alice, 'config', 'user.name', 'Alice');
  fs.writeFileSync(path.join(alice, 'file.txt'), 'hello\n');
  git(alice, 'add', '.');
  git(alice, 'commit', '-m', 'initial');
  git(alice, 'push', 'origin', 'HEAD:main');
  git(alice, 'branch', '--set-upstream-to=origin/main', 'main');

  execFileSync('git', ['clone', upstream, bob], { stdio: 'pipe' });
  muteHooks(bob);
  git(bob, 'config', 'user.email', 'bob@test.dev');
  git(bob, 'config', 'user.name', 'Bob');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a TODO closure travels with the repo', () => {
  it('closing on one machine closes it on a fresh clone', () => {
    writeMemory(alice, [session('s1', [TODO, OTHER])]);

    asMachine(aliceHome);
    const open = getOpenTodos(alice);
    expect(open.map((t) => t.text)).toContain(TODO);
    const target = open.find((t) => t.text === TODO)!;
    expect(markTodoDone(target.id, alice)).toBeTruthy();
    // Closed here, and recorded IN THE NOTE rather than only in ~/.origin.
    expect(getOpenTodos(alice).map((t) => t.text)).not.toContain(TODO);
    expect(readTodoClosures(alice).map((c) => c.key)).toEqual([todoClosureKey(TODO)]);

    pushMemoryNotes(alice, 'origin');

    // Bob is a different machine: empty local store, so only the note can carry
    // the closure. This is the assertion the old shape failed.
    asMachine(bobHome);
    expect(syncNotesFromRemote(bob)).toBe(true);
    const bobOpen = getOpenTodos(bob).map((t) => t.text);
    expect(bobOpen).not.toContain(TODO);
    // ...and it closed ONLY what was closed.
    expect(bobOpen).toContain(OTHER);
  });

  it('a closure recorded on either side survives the cross-machine merge, and confirmed beats pending', () => {
    const pending = {
      key: todoClosureKey(TODO), id: 'aaaaaaaa', text: TODO,
      reason: 'claimed', at: '2026-09-02T00:00:00.000Z', state: 'pending' as const,
    };
    const confirmed = { ...pending, state: 'closed' as const, confirmedAt: '2026-09-03T00:00:00.000Z' };
    const base = { version: 2, sessions: [session('s1', [TODO])], commits: [] };

    for (const [a, b] of [[pending, confirmed], [confirmed, pending]] as const) {
      const merged = mergeMemoryPayloads(
        { ...base, closedTodos: [a] } as any,
        { ...base, closedTodos: [b] } as any,
      );
      expect(merged.closedTodos).toHaveLength(1);
      // A merge is evidence arriving, never evidence withdrawn — so a stale
      // `pending` must not un-close a confirmed closure on the next sync.
      expect(merged.closedTodos![0].state).toBe('closed');
    }
  });

  it('drops a closure once the TODO it suppresses has aged out of the window', () => {
    // The closure exists to hide something. When the session carrying that
    // something falls out of the retained window the TODO is gone anyway, and
    // the closure is dead weight in a payload that has to stay push-sized.
    const merged = mergeMemoryPayloads(
      {
        version: 2, sessions: [session('s1', [OTHER])], commits: [],
        closedTodos: [{ key: todoClosureKey(TODO), id: 'a', text: TODO, reason: 'r', at: 'x', state: 'closed' }],
      } as any,
      { version: 2, sessions: [], commits: [] } as any,
    );
    expect(merged.closedTodos).toEqual([]);
  });
});

describe('a claim is confirmed by the default branch, not by being made', () => {
  const claim = (repo: string, shas: string[]) => {
    asMachine(aliceHome);
    return recordPendingClosures({
      repoPath: repo, sessionId: SID, markers: [TODO],
      openTodos: getOpenTodos(repo).map((t) => ({ id: t.id, text: t.text })),
      shas,
    });
  };

  it('a pending claim does not hide the TODO — it annotates it', () => {
    writeMemory(alice, [session('s1', [TODO])]);
    git(alice, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(alice, 'fix.txt'), 'fix\n');
    git(alice, 'add', '.'); git(alice, 'commit', '-m', 'the fix');
    const sha = git(alice, 'rev-parse', 'HEAD');

    expect(claim(alice, [sha])).toBe(1);

    const still = getOpenTodos(alice).find((t) => t.text === TODO);
    expect(still).toBeTruthy();
    expect(still!.pending?.sessionId).toBe(SID);
    // Unmerged work is a claim about a branch, not an outcome.
    expect(sweepTodoClosures(alice)).toBe(0);
    expect(getOpenTodos(alice).map((t) => t.text)).toContain(TODO);
  });

  it('closes it once the commit is on the default branch', () => {
    writeMemory(alice, [session('s1', [TODO])]);
    git(alice, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(alice, 'fix.txt'), 'fix\n');
    git(alice, 'add', '.'); git(alice, 'commit', '-m', 'the fix');
    const sha = git(alice, 'rev-parse', 'HEAD');
    claim(alice, [sha]);

    git(alice, 'checkout', '-q', 'main');
    git(alice, 'merge', '--no-ff', '-m', 'merge the fix', 'feature');
    git(alice, 'push', 'origin', 'HEAD:main');
    git(alice, 'fetch', '-q', 'origin');

    expect(sweepTodoClosures(alice)).toBe(1);
    expect(getOpenTodos(alice).map((t) => t.text)).not.toContain(TODO);
    expect(readTodoClosures(alice)[0].confirmedAt).toBeTruthy();
  });

  it('a SQUASH keeps no sha, so the Origin-Session trailer is what confirms it', () => {
    writeMemory(alice, [session('s1', [TODO])]);
    git(alice, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(alice, 'fix.txt'), 'fix\n');
    git(alice, 'add', '.'); git(alice, 'commit', '-m', 'the fix');
    const branchSha = git(alice, 'rev-parse', 'HEAD');
    claim(alice, [branchSha]);

    // What a GitHub squash merge produces: a NEW commit on main with none of
    // the branch's shas, carrying the trailer the CLI stamped.
    git(alice, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(alice, 'fix.txt'), 'fix\n');
    git(alice, 'add', '.');
    git(alice, 'commit', '-m', `the fix (#99)\n\nOrigin-Session: ${SID.split('-')[0]} | Claude Code | 4 prompts`);
    git(alice, 'push', 'origin', 'HEAD:main');
    git(alice, 'fetch', '-q', 'origin');

    expect(git(alice, 'branch', '--contains', branchSha, '--list', 'main')).toBe('');
    expect(sweepTodoClosures(alice)).toBe(1);
    expect(getOpenTodos(alice).map((t) => t.text)).not.toContain(TODO);
  });
});

describe('a [Origin: Closes] marker only closes what it unambiguously names', () => {
  const open = [
    { id: 'ab12cd34', text: TODO },
    { id: 'ef56ab78', text: OTHER },
    { id: '99887766', text: 'mobile layout unverified on the settings page as well' },
  ];

  it('matches an id prefix', () => {
    expect(matchTodoForClosure('ab12', open)?.id).toBe('ab12cd34');
    expect(matchTodoForClosure('`ab12cd34` — fixed in this session', open)?.id).toBe('ab12cd34');
  });

  it('matches the TODO text verbatim, and a long distinctive fragment of it', () => {
    expect(matchTodoForClosure(TODO.toUpperCase(), open)?.id).toBe('ab12cd34');
    expect(matchTodoForClosure('the shadow-ref leak still has no owner', open)?.id).toBe('ab12cd34');
  });

  it('refuses an ambiguous or too-short match rather than guessing', () => {
    // Two TODOs share this opening; closing "one of them" is closing the wrong
    // one half the time, and a wrongly closed item is invisible from then on.
    expect(matchTodoForClosure('mobile layout unverified', open)).toBeNull();
    expect(matchTodoForClosure('the leak', open)).toBeNull();
    expect(matchTodoForClosure('', open)).toBeNull();
  });

  it('records nothing for a marker that names no open TODO', () => {
    writeMemory(alice, [session('s1', [TODO])]);
    asMachine(aliceHome);
    const openTodos = getOpenTodos(alice).map((t) => ({ id: t.id, text: t.text }));
    // Assert there was something to match, or this test passes for the wrong
    // reason — which is exactly how the store-isolation bug above stayed hidden
    // on Windows while three of its neighbours went red.
    expect(openTodos).toHaveLength(1);
    const n = recordPendingClosures({
      repoPath: alice, sessionId: SID, markers: ['something nobody ever recorded as open'],
      openTodos,
    });
    // An unmatched claim must not invent a closure of its own text: that would
    // suppress a future TODO that happens to be phrased the same way.
    expect(n).toBe(0);
    expect(readTodoClosures(alice)).toEqual([]);
  });
});
