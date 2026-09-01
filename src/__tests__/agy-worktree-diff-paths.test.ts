/**
 * A transcript-derived diff must name its files the same way the turn's
 * `filesChanged` does. It did not, for any agent that records absolute paths
 * and has no cwd on disk: buildDiffFromEdits writes whatever the edit record
 * carried, and diffHeaderPath only strips what makes a path absolute — it is
 * never told the repo root.
 *
 * Antigravity runs out of its own worktree under ~/.gemini, so a turn's body
 * read `diff --git a/Users/me/.gemini/antigravity/worktrees/repo/branch/app.py`
 * while its filesChanged said `app.py`. Every consumer that joins the two on
 * path missed — see foldUncommittedIntoSessionDiff, where it made the server
 * append a turn's whole window to a session diff that already contained it
 * (session a4d0708a: +1666/-96 shown against a real +1103/-70).
 *
 * The same diff also still carried sections for files OUTSIDE the repo — agy
 * writes its plan and walkthrough notes into its brain dir — which filesChanged
 * had already dropped, so those lines were counted as repo work.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import { scopeDiffPathsToRepo } from '../paths.js';
import { countDiffLines } from '../transcript-adapters.js';

const HOME = os.homedir().replace(/\\/g, '/');
const ROOT = `${HOME}/.gemini/antigravity/worktrees/kotleta/generate_additional_clean_code`;
// What the header actually looks like: diffHeaderPath has stripped the drive.
const headerPath = (abs: string) => abs.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');

const section = (p: string, adds: number, dels: number) => [
  `diff --git a/${p} b/${p}`,
  `--- a/${p}`,
  `+++ b/${p}`,
  `@@ -1,${dels} +1,${adds} @@`,
  ...Array.from({ length: dels }, (_, i) => `-old ${i}`),
  ...Array.from({ length: adds }, (_, i) => `+new ${i}`),
  '',
].join('\n');

describe('scopeDiffPathsToRepo', () => {
  it('rewrites a worktree-absolute header to the repo-relative path', () => {
    const out = scopeDiffPathsToRepo(ROOT, section(headerPath(`${ROOT}/pretty.py`), 3, 1));
    expect(out).toContain('diff --git a/pretty.py b/pretty.py');
    expect(out).toContain('--- a/pretty.py');
    expect(out).toContain('+++ b/pretty.py');
    expect(out).not.toContain('antigravity/worktrees');
  });

  it('keeps a nested path nested', () => {
    const out = scopeDiffPathsToRepo(ROOT, section(headerPath(`${ROOT}/src/deep/app.py`), 1, 0));
    expect(out).toContain('diff --git a/src/deep/app.py b/src/deep/app.py');
  });

  it('drops sections for files outside the repo, and their lines with them', () => {
    // agy's own notes live in the brain dir — under home, outside the worktree.
    const brain = headerPath(`${HOME}/.gemini/antigravity/brain/conv-1/walkthrough.md`);
    const diff = section(headerPath(`${ROOT}/pretty.py`), 3, 1) + section(brain, 46, 30);
    expect(countDiffLines(diff)).toEqual({ linesAdded: 49, linesRemoved: 31 });

    const out = scopeDiffPathsToRepo(ROOT, diff);
    expect(out).not.toContain('walkthrough.md');
    expect(countDiffLines(out)).toEqual({ linesAdded: 3, linesRemoved: 1 });
  });

  it('leaves an already repo-relative diff completely alone', () => {
    // Every other agent's capture arrives like this, and rule 3 must not touch
    // it — a rewrite here would be the same class of bug in the other direction.
    const diff = section('apps/web/src/App.tsx', 2, 2);
    expect(scopeDiffPathsToRepo(ROOT, diff)).toBe(diff);
  });

  it('leaves an out-of-repo path that is not under home alone rather than guessing', () => {
    // /tmp scratch, another drive, a sibling checkout: we know it is not ours,
    // but dropping on that basis would also drop a repo-relative path that
    // simply does not match. Only the home-dir case is certain enough to cut.
    const diff = section('var/tmp/scratch.py', 5, 0);
    expect(scopeDiffPathsToRepo(ROOT, diff)).toBe(diff);
  });

  it('drops NOTHING when the root matches no section — a wrong root must not delete work', () => {
    // LIVE REGRESSION, session 65014e0b. The watcher resolved an Antigravity
    // session to the main clone while the agent was writing in its own worktree
    // under ~/.gemini. Nothing was under the root, every section was under the
    // user's home, and the drop rule emptied the whole diff — three files and
    // +1352 lines became one file and +37/-37, because the emptied diff let the
    // (wrong) working-tree window win downstream.
    //
    // A bad root must degrade to "paths left alone", never to data loss.
    const WRONG_ROOT = 'C:/soft/kotleta';
    const diff = section(headerPath(`${ROOT}/styles.css`), 400, 0)
      + section(headerPath(`${ROOT}/app.js`), 600, 20)
      + section(headerPath(`${HOME}/.gemini/antigravity/brain/c/walkthrough.md`), 40, 0);

    const out = scopeDiffPathsToRepo(WRONG_ROOT, diff);
    expect(out).toBe(diff);
    expect(countDiffLines(out)).toEqual({ linesAdded: 1040, linesRemoved: 20 });
  });

  it('still drops out-of-repo sections once the root has proved itself', () => {
    // One section resolves under the root, so the root demonstrably describes
    // this diff and the brain-dir note can be cut with confidence.
    const diff = section(headerPath(`${ROOT}/styles.css`), 400, 0)
      + section(headerPath(`${HOME}/.gemini/antigravity/brain/c/walkthrough.md`), 40, 0);

    const out = scopeDiffPathsToRepo(ROOT, diff);
    expect(out).toContain('diff --git a/styles.css b/styles.css');
    expect(out).not.toContain('walkthrough.md');
    expect(countDiffLines(out)).toEqual({ linesAdded: 400, linesRemoved: 0 });
  });

  it('is a no-op on empty input and on text with no diff header', () => {
    expect(scopeDiffPathsToRepo(ROOT, '')).toBe('');
    expect(scopeDiffPathsToRepo(ROOT, 'not a diff')).toBe('not a diff');
    expect(scopeDiffPathsToRepo('', section('pretty.py', 1, 0))).toBe(section('pretty.py', 1, 0));
  });

  it('reproduces session a4d0708a turn 3: five files, repo-relative, brain notes gone', () => {
    const files: Array<[string, number, number]> = [
      ['pretty.py', 70, 5],
      ['server.py', 152, 0],
      ['client.py', 147, 1],
      ['monitor_server.py', 44, 8],
      ['monitor.html', 150, 12],
    ];
    const brain = headerPath(`${HOME}/.gemini/antigravity/brain/c/implementation_plan.md`);
    const raw = files.map(([f, a, d]) => section(headerPath(`${ROOT}/${f}`), a, d)).join('')
      + section(brain, 32, 41);

    const out = scopeDiffPathsToRepo(ROOT, raw);
    for (const [f] of files) expect(out).toContain(`diff --git a/${f} b/${f}`);
    expect(out).not.toContain('implementation_plan.md');
    // The turn's real repo work — what the commit landed, brain notes excluded.
    expect(countDiffLines(out)).toEqual({ linesAdded: 563, linesRemoved: 26 });
  });
});
