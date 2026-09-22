/**
 * The unit tests above inject every git answer, so they prove the WALK and
 * nothing about the probe. This one runs the probe against a real repository:
 * real `git log`, real `git notes`, real trailers, real dates.
 *
 * Then it closes the loop that the bug actually broke — claim, then rebase,
 * then assert post-rewrite records BOTH pairs. That last step is the whole
 * point: the claim exists so `owns()` can say yes later.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claimCommitsMadeBeforeRegistration } from '../claim-commits-made-before-registration.js';

let repo: string;
const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true }).toString().trim();

/** Commit a change and return its sha. `whenIso` back-dates it, which is how
 *  the fixture expresses "this is the repo's pre-existing history" rather than
 *  something the conversation produced. */
function commit(file: string, body: string, message: string, whenIso?: string): string {
  fs.writeFileSync(path.join(repo, file), body);
  git(['add', '-A']);
  const env = whenIso
    ? { ...process.env, GIT_AUTHOR_DATE: whenIso, GIT_COMMITTER_DATE: whenIso }
    : process.env;
  execFileSync('git', ['commit', '-m', message], { cwd: repo, encoding: 'utf-8', windowsHide: true, env });
  return git(['rev-parse', 'HEAD']);
}

/** A day before any conversation in these tests. */
const LONG_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-claim-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('seed.txt', 'seed\n', 'chore: seed', LONG_AGO);
});

afterEach(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

const SESSION = 'd74b8927-38a2-4e84-96af-f6605c94599f';
/** What the recovered transcript says the blind turns edited. The claim needs
 *  file evidence: every other signal only says "nobody has recorded this". */
const EDITED = ['a.txt', 'b.txt'];
/** A session that registered a minute ago, holding nothing yet. */
const freshState = () => ({ startedAt: new Date(Date.now() - 60_000).toISOString(), sessionCommitShas: [] as string[] });

describe('claiming against a real repository', () => {
  it('claims the commit made in the blind window', () => {
    const orphan = commit('a.txt', 'a\n', 'feat: made before Origin registered');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED)).toEqual([orphan]);
  });

  it('will not touch a commit that predates the conversation', () => {
    const old = commit('a.txt', 'a\n', 'feat: from yesterday');
    // Conversation started AFTER that commit landed.
    const state = { startedAt: new Date(Date.now() + 60_000).toISOString(), sessionCommitShas: [] };
    expect(claimCommitsMadeBeforeRegistration(repo, state, SESSION, EDITED)).not.toContain(old);
  });

  it('stops at a commit already carrying an Origin note', () => {
    const noted = commit('a.txt', 'a\n', 'feat: someone else recorded this');
    git(['notes', '--ref=origin', 'add', '-m', '{"sessionId":"someone-else"}', noted]);
    const mine = commit('b.txt', 'b\n', 'feat: mine, above the noted one');

    const claimed = claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED);
    expect(claimed).toEqual([mine]);
    expect(claimed).not.toContain(noted);
  });

  it('stops at a commit trailered to another session', () => {
    const theirs = commit(
      'a.txt', 'a\n',
      'feat: theirs\n\nOrigin-Session: 99999999-aaa | Claude Code | 1 prompts | turn 0',
    );
    const mine = commit('b.txt', 'b\n', 'feat: mine');

    const claimed = claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED);
    expect(claimed).toEqual([mine]);
    expect(claimed).not.toContain(theirs);
  });

  it('claims through a commit trailered to US with a truncated id', () => {
    // The real trailer shape. A plain equality check against the full uuid
    // reads this as a stranger's and stops the walk on our own commit.
    const ours = commit(
      'a.txt', 'a\n',
      'feat: ours\n\nOrigin-Session: d74b8927-38a | Claude Code | 1 prompts | turn 0',
    );
    const alsoOurs = commit('b.txt', 'b\n', 'feat: also ours');

    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED))
      .toEqual([ours, alsoOurs]);
  });

  it('skips shas we already hold instead of stopping on them', () => {
    const first = commit('a.txt', 'a\n', 'feat: already recorded');
    const second = commit('b.txt', 'b\n', 'feat: the blind one');
    const state = { startedAt: new Date(Date.now() - 60_000).toISOString(), sessionCommitShas: [first] };

    const claimed = claimCommitsMadeBeforeRegistration(repo, state, SESSION, EDITED);
    expect(claimed).toEqual([second]);
  });

  it('claims nothing when the session has no start time', () => {
    commit('a.txt', 'a\n', 'feat: whatever');
    expect(claimCommitsMadeBeforeRegistration(repo, { sessionCommitShas: [] }, SESSION, EDITED)).toEqual([]);
  });
});

describe('against a real repository: is this commit OURS?', () => {
  it('will not take a commit committed by somebody else', () => {
    // A teammate's commit, arrived by `git pull` during the blind window: no
    // note, no trailer, no live peer, inside the time bounds, and over a file
    // we edited. Every signal the walk had before this said take it.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'theirs\n');
    git(['add', '-A']);
    execFileSync('git', [
      '-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com',
      'commit', '-m', 'feat: theirs, pulled in',
    ], { cwd: repo, encoding: 'utf-8', windowsHide: true });

    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED)).toEqual([]);
  });

  it('will not take a commit over files this conversation never touched', () => {
    // The human's own `git commit -m wip` in the same window.
    commit('THEIR_NOTES.md', 'notes\n', 'docs: my own scratch');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED)).toEqual([]);
  });

  it('will not take a commit we merely REPLAYED — cherry-pick keeps its author', () => {
    // We become the committer, they stay the author. The committer check
    // passes by construction; the author check is what catches it.
    git(['checkout', '-q', '-b', 'theirs']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'theirs\n');
    git(['add', '-A']);
    execFileSync('git', [
      '-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.com',
      'commit', '-m', 'feat: theirs',
    ], { cwd: repo, encoding: 'utf-8', windowsHide: true });
    const theirSha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', 'main']);
    git(['cherry-pick', theirSha]);

    // Committed by us, authored by them.
    expect(git(['log', '-1', '--format=%ce'])).toBe('t@example.com');
    expect(git(['log', '-1', '--format=%ae'])).toBe('teammate@example.com');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED)).toEqual([]);
  });

  it('matches a non-ASCII path, which git quotes by default', () => {
    // `core.quotePath` is ON by default: `git show --name-only` prints
    // `"caf\303\251.ts"` for this file, which matches nothing the transcript
    // recorded and declines the claim silently.
    const accented = 'café.ts';
    const orphan = commit(accented, 'x\n', 'feat: over an accented path');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, [accented]))
      .toEqual([orphan]);
  });

  it('matches from a SUBDIRECTORY, where `diff.relative` would re-root the paths', () => {
    // With `diff.relative` set and the hook running in a subdirectory, git
    // prints cwd-relative paths while the transcript's are repo-relative.
    git(['config', 'diff.relative', 'true']);
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    const orphan = commit('pkg/deep.ts', 'x\n', 'feat: in a subdirectory');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, ['pkg/deep.ts']))
      .toEqual([orphan]);
    // And from inside that subdirectory, which is what a hook's cwd can be.
    expect(claimCommitsMadeBeforeRegistration(path.join(repo, 'pkg'), freshState(), SESSION, ['pkg/deep.ts']))
      .toEqual([orphan]);
  });

  it('claims nothing when the transcript recorded no edits at all', () => {
    commit('a.txt', 'a\n', 'feat: made before Origin registered');
    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, [])).toEqual([]);
  });

  it('does not look inside a merge commit', () => {
    // A merge made during the blind window is not something a turn authored,
    // and `--name-only` reports nothing for it, so it could only ever stop the
    // walk short of the orphan underneath.
    const orphan = commit('a.txt', 'a\n', 'feat: the orphan');
    git(['checkout', '-q', '-b', 'side', 'HEAD~1']);
    // Back-dated: at `%cI`'s one-second granularity these two commits can
    // otherwise share a timestamp, and `git log` then orders the merge's
    // parents by luck. The side commit must sort BELOW the orphan every run.
    commit('side.txt', 'side\n', 'feat: on the side', new Date(Date.now() - 300_000).toISOString());
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-m', 'merge: side', 'side']);

    expect(claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED)).toEqual([orphan]);
  });
});

describe('the loop the bug broke: claim, then rebase, then BOTH pairs', () => {
  it('post-rewrite records the pair for a claimed commit', async () => {
    // Reproduces d74b8927 end to end at the module level.
    //   1. two commits, the FIRST made while Origin was blind
    //   2. the session registers late and claims it
    //   3. a rebase rewrites both
    //   4. post-rewrite must record BOTH pairs, not just the second
    const blind = commit('a.txt', 'a\n', 'feat: made before registration');
    const state: any = { ...freshState(), sessionId: SESSION, sessionTag: 'tag', repoPath: repo };

    const claimed = claimCommitsMadeBeforeRegistration(repo, state, SESSION, EDITED);
    expect(claimed, 'the blind commit was not claimed').toEqual([blind]);
    state.sessionCommitShas = claimed;

    // The second commit is owned the ordinary way, by post-commit.
    const owned = commit('b.txt', 'b\n', 'feat: made after registration');
    state.sessionCommitShas.push(owned);

    // Rewrite both, as a rebase does.
    git(['commit', '--amend', '-m', 'feat: made after registration (reworded)']);
    const newOwned = git(['rev-parse', 'HEAD']);

    const { applyRewritePairsToState } = await import('../session-state.js');
    // Both pairs as git would hand them over. The old code could only apply
    // the second, because `owns()` never saw the first sha.
    const changed = applyRewritePairsToState(state, [
      { from: blind, to: 'f'.repeat(40) },
      { from: owned, to: newOwned },
    ]);

    expect(changed).toBe(true);
    expect(state.sessionCommitShas).toContain(newOwned);
    expect(state.sessionCommitShas).toContain('f'.repeat(40));
    expect(state.sessionCommitShas, 'the rewritten originals should be gone')
      .not.toContain(blind);
  });
});

describe('a note that has not been folded yet still counts as owned', () => {
  it('stops at a commit whose note is only in the STAGING ref', () => {
    // A note fetched from another machine lands on the staging ref and only
    // reaches the live ref when the fold runs. Reading just the live ref
    // would call this commit unowned and take someone else's work.
    const staged = commit('a.txt', 'a\n', 'feat: recorded on another machine');
    git(['notes', '--ref=origin-remote', 'add', '-m', '{"sessionId":"elsewhere"}', staged]);
    const mine = commit('b.txt', 'b\n', 'feat: mine');

    const claimed = claimCommitsMadeBeforeRegistration(repo, freshState(), SESSION, EDITED);
    expect(claimed).toEqual([mine]);
    expect(claimed).not.toContain(staged);
  });
});
