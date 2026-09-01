/**
 * Two capture defects found on prod session 0a8e2164 (repo `origin`), a long
 * Claude Code session that outlived its own transcript and did part of its
 * work in a linked git worktree.
 *
 * What the record looked like:
 *   state.prompts            : 4   (head lost — started mid-conversation)
 *   transcript on disk       : 5
 *   completedPromptMappings  : 7   (indices 0-6, original numbering)
 *
 *   turn "verify the session shows +329 now"  →  +327 −20  (the PREVIOUS
 *                                                 turn's work)
 *   three turns that really edited files      →  +0, no files
 *
 * 1. Prompt-index drift. A turn's promptIndex is its position in the prompt
 *    list and the server keys PromptChange rows on it, so the list may only
 *    grow. `parsed.prompts.length > 0 ? parsed.prompts : state.prompts` let a
 *    ROLLED transcript win — it is non-empty, just shorter — renumbering every
 *    turn under it and landing each diff on an earlier turn's row.
 *
 * 2. Worktree edits captured but undisplayable. makeRepoRelative only stripped
 *    paths under the session's own checkout, so an edit in a linked worktree
 *    shipped as `/private/tmp/.../wt-x/apps/api/foo.ts`. That resolves against
 *    no repo root server-side, so the files vanish from the turn even though
 *    every edit was captured with full content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reconcilePromptHistory } from '../session-state.js';
import { extractEditsFromToolCall } from '../prompt-capture/index.js';

describe('reconcilePromptHistory', () => {
  it('takes the transcript when nothing is stored yet', () => {
    expect(reconcilePromptHistory([], ['a', 'b'])).toEqual(['a', 'b']);
    expect(reconcilePromptHistory(undefined, ['a'])).toEqual(['a']);
  });

  it('grows normally while the transcript keeps the whole conversation', () => {
    expect(reconcilePromptHistory(['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps our numbering when the transcript drops earlier turns', () => {
    // The regression: 5 surviving prompts against 7 stored. Index 0 must stay
    // index 0, or every stored row shifts under its diff.
    const stored = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const parsed = ['p2', 'p3', 'p4', 'p5', 'p6'];
    expect(reconcilePromptHistory(stored, parsed)).toEqual(stored);
  });

  it('appends only what is new when the transcript is both trimmed and extended', () => {
    const stored = ['p0', 'p1', 'p2'];
    const parsed = ['p1', 'p2', 'p3'];   // lost the head, gained a tail
    expect(reconcilePromptHistory(stored, parsed)).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('never renumbers when the two lists share nothing', () => {
    // Renumbering is the one outcome that corrupts already-written rows, so
    // an unrecognizable transcript appends rather than replaces.
    const out = reconcilePromptHistory(['p0', 'p1'], ['x0']);
    expect(out.slice(0, 2)).toEqual(['p0', 'p1']);
    expect(out).toContain('x0');
  });

  it('does not double the history when the transcript lost a MIDDLE prompt', () => {
    // Prod Cursor session a46eb6b6, which held 20 rows for 11 prompts: prompts
    // 0-9 repeated as 10-19, every duplicate a turn with no work on it.
    //
    // The transcript had dropped one prompt from the middle (X) while gaining
    // a new one at the end (Z). The subsequence walk reaches 8 of 10 and the
    // tail-overlap loop needs a run to the END of prev, so both decline — and
    // the old fallback was `[...prev, ...next]`, which re-appended all eight
    // prompts we already had rows for. promptIndex is positional, so that is a
    // second row per turn, not a cosmetic repeat.
    const stored = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X', 'Y'];
    const parsed = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Y', 'Z'];
    const out = reconcilePromptHistory(stored, parsed);
    expect(out).toEqual([...stored, 'Z']);
    expect(out.length).toBe(11);
    // The invariant that makes it safe: nothing already written moves.
    expect(out.slice(0, stored.length)).toEqual(stored);
  });

  it('still lands a genuinely re-sent prompt rather than swallowing it', () => {
    // Same fallback, with a repeat: asking the same thing twice is new work and
    // must get its own index, not be mistaken for the earlier row. Counting as
    // a multiset rather than a set is what buys that.
    const stored = ['A', 'B', 'C', 'X', 'Y'];
    const out = reconcilePromptHistory(stored, ['A', 'B', 'C', 'Y', 'A', 'Z']);
    expect(out).toEqual([...stored, 'A', 'Z']);
    expect(out.slice(0, stored.length)).toEqual(stored);
  });

  it('keeps a transcript-only prompt even when it sits mid-sequence', () => {
    // W is new and appears BEFORE prompts we already hold. Appending only
    // "everything after the last match" would silently drop it; the merge
    // keeps every unaccounted entry, in order, at the end.
    const stored = ['A', 'B', 'C', 'X', 'Y'];
    const out = reconcilePromptHistory(stored, ['A', 'B', 'W', 'C', 'Y', 'Z']);
    expect(out).toEqual([...stored, 'W', 'Z']);
    expect(out.slice(0, stored.length)).toEqual(stored);
  });

  it('holds the line when the transcript goes empty', () => {
    expect(reconcilePromptHistory(['p0', 'p1'], [])).toEqual(['p0', 'p1']);
  });

  it('is what the prod 0a8e2164 shape needed', () => {
    const stored = [
      'why prompt 2 didnt capture changes',
      'yes, fix it and add the regression test',
      'open a PR for this review and merge. the deploy',
      'Review target: 1077',
      'yes, fix the +229 vs +329 mismatch',
      'verify the session shows +329 now',
      'fix the invariant telemetry to compare net',
    ];
    // What the CLI could still parse after the transcript rolled.
    const parsed = stored.slice(2);
    // What shipped before: a non-empty transcript won outright, so the
    // current turn was announced as index 4 — landing its diff on the row
    // already holding "yes, fix the +229 vs +329 mismatch".
    const oldBehaviour = parsed.length > 0 ? parsed : stored;
    expect(oldBehaviour.indexOf('fix the invariant telemetry to compare net')).toBe(4);

    const reconciled = reconcilePromptHistory(stored, parsed);
    // The current turn keeps index 6, not 4 — no row is overwritten.
    expect(reconciled.length).toBe(7);
    expect(reconciled.indexOf('fix the invariant telemetry to compare net')).toBe(6);
  });
});

describe('makeRepoRelative via extractEditsFromToolCall — linked worktrees', () => {
  let tmp: string;
  let mainRepo: string;
  let worktree: string;
  let haveGit = true;

  beforeAll(() => {
    // realpathSync.NATIVE: on Windows os.tmpdir() hands back the 8.3 short
    // name (C:/Users/RUNNER~1/...) while git writes the long one
    // (C:/Users/runneradmin/...) into the worktree's .git pointer. Comparing
    // the two forms never matches, and the resolver correctly declines to
    // claim a path it cannot tie to this repo — a test artifact, not a code
    // defect, but it fails only on the Windows runner.
    tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-wt-'));
    mainRepo = path.join(tmp, 'repo');
    worktree = path.join(tmp, 'wt-feature');
    fs.mkdirSync(mainRepo, { recursive: true });
    const git = (args: string[], cwd = mainRepo) =>
      execFileSync('git', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x',
          GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
        },
      });
    try {
      git(['init', '-q', '.']);
      fs.writeFileSync(path.join(mainRepo, 'seed.txt'), 'seed\n');
      git(['add', '.']);
      git(['commit', '-qm', 'seed']);
      // A real linked worktree — its root gets a `.git` FILE, which is the
      // marker the resolver keys on.
      git(['worktree', 'add', '-q', '--detach', worktree]);
    } catch {
      haveGit = false;
    }
  });

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const edit = (filePath: string, repoPath: string) =>
    extractEditsFromToolCall(
      'Edit',
      { file_path: filePath, old_string: 'a', new_string: 'b' },
      repoPath,
      'claude',
      false,
    );

  it('makes a worktree edit repo-relative against the session checkout', () => {
    if (!haveGit) return;
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);

    const abs = path.join(worktree, 'apps', 'api', 'src', 'routes', 'sessions.ts');
    const out = edit(abs, mainRepo);

    expect(out).toHaveLength(1);
    // The regression: this used to come back as the full /tmp/... path.
    expect(out[0].file).toBe('apps/api/src/routes/sessions.ts');
    expect(path.isAbsolute(out[0].file)).toBe(false);
  });

  it('still handles an edit inside the session checkout itself', () => {
    if (!haveGit) return;
    const abs = path.join(mainRepo, 'apps', 'api', 'src', 'routes', 'sessions.ts');
    expect(edit(abs, mainRepo)[0].file).toBe('apps/api/src/routes/sessions.ts');
  });

  it('leaves a genuinely foreign path alone', () => {
    if (!haveGit) return;
    // An unrelated repo is NOT this session's worktree: rewriting its paths
    // would silently claim another checkout's files as this repo's.
    const other = path.join(tmp, 'other');
    fs.mkdirSync(path.join(other, 'src'), { recursive: true });
    fs.writeFileSync(path.join(other, '.git'), 'gitdir: /somewhere/else/.git/worktrees/x\n');

    const abs = path.join(other, 'src', 'thing.ts');
    expect(edit(abs, mainRepo)[0].file).toBe(abs.replace(/\\/g, '/'));
  });
});
