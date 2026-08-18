/**
 * Quality of the memory RECORD itself — the four ways it misinformed a reader
 * rather than failing to reach one. From a review of what an agent actually
 * received from Origin's memory on a live session (2026-08-18):
 *
 *  1. TRUNCATION mid-word. An injected digest ended "The branch is two commits
 *     a" — reads as a finished thought, and the cut landed exactly on the fact
 *     worth carrying. A truncated summary was indistinguishable from a complete
 *     one.
 *  2. (The `openTodos: []` half of that review landed separately in #1068,
 *     which routes [Origin: Open] into openTodos and is tested there.)
 *  3. A session window that didn't contain its own commits: 89 seconds
 *     (15:52:10Z–15:53:39Z) credited with a commit made 14 hours earlier. One
 *     of the two is wrong and a reader can't tell which, so both stop being
 *     evidence.
 *  4. The pointer listed three ways to DUMP the whole store and no way to QUERY
 *     it, so an agent never asked a question the digest hadn't already answered.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  truncateAtBoundary,
  reconcileSessionWindow,
  buildMemoryPointerContext,
  summarizeFromCommitSubjects,
  type SessionMemoryEntry,
  type CommitMemoryEntry,
} from '../memory.js';

describe('truncateAtBoundary — never cut mid-word, always say you cut', () => {
  it('leaves text that fits completely alone (no marker on a complete summary)', () => {
    expect(truncateAtBoundary('Short and complete.', 100)).toBe('Short and complete.');
  });

  it('does not split a word', () => {
    const out = truncateAtBoundary('The branch is two commits ahead of origin', 27);
    expect(out).not.toContain('comm ');
    // Whatever survives, the last real word is whole.
    const words = out.replace(/\s*….*$/, '').split(' ');
    expect('The branch is two commits ahead of origin').toContain(words[words.length - 1]);
  });

  it('marks the truncation so a cut summary is distinguishable from a complete one', () => {
    const out = truncateAtBoundary('The branch is two commits ahead of origin and unpushed', 30);
    expect(out).toContain('truncated');
  });

  it('carries the hint that names where the rest lives', () => {
    const out = truncateAtBoundary('a'.repeat(50) + ' more text here', 20, 'run `origin context memory`');
    expect(out).toContain('origin context memory');
  });

  it('prefers a sentence boundary when one is within reach of the budget', () => {
    const text = 'Fixed the flaky offline test. Then started on the provenance route which is unfinished.';
    const out = truncateAtBoundary(text, 45);
    expect(out.startsWith('Fixed the flaky offline test.')).toBe(true);
  });

  it('does not leave dangling punctuation before the marker', () => {
    const out = truncateAtBoundary('polish the page, verify the pointer, then ship it', 20);
    expect(out).not.toMatch(/[,;:\-]\s*…/);
  });
});

describe('post-commit summary — one noise filter, shared with session end', () => {
  // Review regression: preferring the raw commit subject bypassed the noise
  // filter the session-end path applies. For a commit-and-go session — which
  // never reaches session end — whatever lands here is permanent.
  it('rejects a merge subject as a summary', () => {
    expect(summarizeFromCommitSubjects(["Merge branch 'main' into feature"])).toBeNull();
    expect(summarizeFromCommitSubjects(['Merge pull request #12 from x/y'])).toBeNull();
  });

  it('rejects Origin\'s own bookkeeping commits', () => {
    expect(summarizeFromCommitSubjects(['origin shadow abc 2026-08-18T00:00:00Z'])).toBeNull();
    expect(summarizeFromCommitSubjects(['Notes added by \'git notes add\''])).toBeNull();
  });

  it('still accepts a real subject', () => {
    expect(summarizeFromCommitSubjects(['fix(memory): stop the double injection']))
      .toBe('fix(memory): stop the double injection');
  });
});

describe('reconcileSessionWindow — the window must contain what the record claims', () => {
  const entry = (over: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry => ({
    sessionId: '17d943c5',
    agentSlug: 'claude-code',
    model: 'claude-opus-5',
    startedAt: '2026-08-18T15:52:10Z',
    endedAt: '2026-08-18T15:53:39Z',
    branch: 'main',
    summary: 'add a script',
    filesChanged: ['cheers.py'],
    promptCount: 4,
    linesAdded: 309,
    linesRemoved: 2,
    openTodos: [],
    ...over,
  });

  const commit = (over: Partial<CommitMemoryEntry> = {}): CommitMemoryEntry => ({
    commitSha: 'd5d4b70',
    sessionId: '17d943c5',
    agentSlug: 'claude-code',
    message: 'add cheers.py',
    filesChanged: ['cheers.py'],
    linesAdded: 12,
    linesRemoved: 0,
    branch: 'main',
    committedAt: '2026-08-18T01:37:02Z',
    ...over,
  });

  it('grows back to cover a commit it is credited with (the 89s-window / 14h-old-commit case)', () => {
    const out = reconcileSessionWindow(entry(), undefined, [commit()]);
    expect(new Date(out.startedAt).getTime()).toBeLessThanOrEqual(new Date('2026-08-18T01:37:02Z').getTime());
  });

  it('never shrinks the window on upsert — a re-stamped startedAt cannot orphan earlier work', () => {
    const previous = entry({ startedAt: '2026-08-18T09:00:00Z', endedAt: '2026-08-18T09:30:00Z' });
    const out = reconcileSessionWindow(entry(), previous, []);
    expect(out.startedAt).toBe('2026-08-18T09:00:00Z');
    // …and the newer end time still wins.
    expect(out.endedAt).toBe('2026-08-18T15:53:39Z');
  });

  it('ignores commits belonging to OTHER sessions', () => {
    const foreign = commit({ sessionId: 'someone-else', committedAt: '2020-01-01T00:00:00Z' });
    const out = reconcileSessionWindow(entry(), undefined, [foreign]);
    expect(out.startedAt).toBe('2026-08-18T15:52:10Z');
  });

  it('survives unparseable timestamps rather than writing Invalid Date', () => {
    const out = reconcileSessionWindow(entry(), undefined, [commit({ committedAt: 'not-a-date' })]);
    expect(out.startedAt).toBe('2026-08-18T15:52:10Z');
    expect(new Date(out.endedAt).toString()).not.toBe('Invalid Date');
  });

  it('leaves everything except the window untouched', () => {
    const e = entry();
    const out = reconcileSessionWindow(e, undefined, [commit()]);
    expect({ ...out, startedAt: e.startedAt, endedAt: e.endedAt }).toEqual(e);
  });
});

describe('memory pointer — offers a way to QUERY, not only to dump', () => {
  let tmp: string;
  let repo: string;
  let realHome: string | undefined;
  let realUserProfile: string | undefined;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-pointer-query-'));
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
    git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
    git('config', 'user.email', 'dev@test.dev');
    git('config', 'user.name', 'Dev');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-m', 'initial');

    const root = git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
    const payload = JSON.stringify({
      version: 2,
      sessions: [{
        sessionId: 's1', agentSlug: 'claude-code', model: 'claude-opus-5',
        startedAt: '2026-08-18T10:00:00Z', endedAt: '2026-08-18T10:20:00Z', branch: 'main',
        summary: 'polish the policies page', filesChanged: ['Policies.tsx'],
        promptCount: 3, linesAdded: 40, linesRemoved: 2, openTodos: [],
      }],
      commits: [],
    });
    git('notes', '--ref=origin-memory', 'add', '-f', '-m', payload, root);
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('names the per-line and per-file query commands, not just the three dump routes', () => {
    const pointer = buildMemoryPointerContext(repo)!;
    expect(pointer).toContain('origin why');
    expect(pointer).toContain('origin ask');
    expect(pointer).toContain('origin prompts');
    expect(pointer).toContain('origin todo list');
  });

  it('still points at the full record for readers who want all of it', () => {
    const pointer = buildMemoryPointerContext(repo)!;
    expect(pointer).toContain('origin context memory');
    expect(pointer).toContain('git notes --ref=origin-memory show');
    expect(pointer).toContain('digest');
  });
});
