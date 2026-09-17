/**
 * What the restored-from-history checks cost, and what they answer.
 *
 * Review of #1684: the history walk (`git log --raw` reachable from the window
 * start) ran once per changed row on every Stop — O(turns x history), 0.2-0.85s
 * per call on a 52k-commit repo, ~15s for 30 turns. Stop and session-end now
 * re-check rows with `filesPutBackAcrossTheGap`, which never walks history; the
 * walk runs only at the next prompt, where a row may be replaced or extended,
 * and once per (tip, path set) per process.
 *
 * Driven against real git; processes counted with GIT_TRACE2_PERF.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShadowCommit } from '../git-capture.js';
import { dropInheritedFilesFromTurns, type InheritedFilesRow } from '../drop-inherited-files.js';
import {
  clearHistoryCache,
  filesPutBackAcrossTheGap,
  filesRestoredFromHistory,
} from '../restored-from-history.js';

let repo: string;
let trace: string;
const git = (args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

/** A turn boundary the way the hooks record one. */
function boundary(tag: string): string {
  return createShadowCommit(repo, tag) || git(['rev-parse', 'HEAD']);
}

/** Top-level git processes started while `fn` ran, and how many were `git log`. */
function gitProcessesDuring(fn: () => void): { all: number; log: number } {
  try { fs.rmSync(trace, { force: true }); } catch { /* none */ }
  process.env.GIT_TRACE2_PERF = trace;
  try { fn(); } finally { delete process.env.GIT_TRACE2_PERF; }
  if (!fs.existsSync(trace)) return { all: 0, log: 0 };
  const starts = fs.readFileSync(trace, 'utf-8').split('\n')
    .filter((l) => /\|\s*d0\s*\|/.test(l) && /\|\s*start\s*\|/.test(l));
  return { all: starts.length, log: starts.filter((l) => /\slog\s/.test(l)).length };
}

beforeEach(() => {
  clearHistoryCache();
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'restored-history-reads-')));
  trace = path.join(repo, '..', `${path.basename(repo)}-trace2.txt`);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks')]);
  write('keep.txt', 'k\n');
  write('pkg.json', 'v1\n');
  write('NOTES.md', 'n1\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  write('pkg.json', 'v2\n');
  write('NOTES.md', 'n2\n');
  git(['add', '-A']); git(['commit', '-qm', 'second']);
});

afterEach(() => {
  delete process.env.GIT_TRACE2_PERF;
  fs.rmSync(repo, { recursive: true, force: true });
  try { fs.rmSync(trace, { force: true }); } catch { /* none */ }
});

describe('filesRestoredFromHistory', () => {
  it('never counts a deletion as a restoration; a present older version still is one', () => {
    const start = boundary('t0');
    fs.rmSync(path.join(repo, 'NOTES.md'));
    git(['checkout', 'HEAD~1', '--', 'pkg.json']);
    expect([...filesRestoredFromHistory(repo, start, null, ['NOTES.md', 'pkg.json'])]).toEqual(['pkg.json']);
  });

  it('walks history once per window and path set in a process', () => {
    const start = boundary('t0');
    git(['checkout', 'HEAD~1', '--', 'pkg.json']);
    const first = gitProcessesDuring(() => { filesRestoredFromHistory(repo, start, null, ['pkg.json']); });
    const again = gitProcessesDuring(() => { filesRestoredFromHistory(repo, start, null, ['pkg.json']); });
    expect(first.log).toBe(1);
    expect(again.log).toBe(0);
    expect([...filesRestoredFromHistory(repo, start, null, ['pkg.json'])]).toEqual(['pkg.json']);
  });
});

describe('filesPutBackAcrossTheGap (Stop and session-end)', () => {
  it('drops only what was rewritten between the previous Stop and this prompt and then put back', () => {
    write('mine.txt', 'mine\n');
    const stopEnd = boundary('t0-end');
    // A background job rewrites pkg.json to an older version before the prompt.
    git(['checkout', 'HEAD~1', '--', 'pkg.json']);
    const start = boundary('t1');
    // The job puts it back during the turn; the turn itself deletes NOTES.md.
    git(['checkout', 'HEAD', '--', 'pkg.json']);
    fs.rmSync(path.join(repo, 'NOTES.md'));
    const state = { turnEndShadows: [{ promptIndex: 0, shadowSha: stopEnd, capturedAt: '' }] };
    expect([...filesPutBackAcrossTheGap(repo, state, 1, start, null, ['pkg.json', 'NOTES.md', 'mine.txt'])]).toEqual(['pkg.json']);
  });

  it('keeps a turn\'s own `git checkout HEAD~1 -- pkg.json`: nothing straddles a gap', () => {
    const stopEnd = boundary('t0-end');
    const start = boundary('t1');
    git(['checkout', 'HEAD~1', '--', 'pkg.json']);
    const state = { turnEndShadows: [{ promptIndex: 0, shadowSha: stopEnd, capturedAt: '' }] };
    expect(filesPutBackAcrossTheGap(repo, state, 1, start, null, ['pkg.json']).size).toBe(0);
  });

  it('keeps a file this turn\'s own git command named, even across a gap (`git checkout -- f` of a between-turn edit)', () => {
    const stopEnd = boundary('t0-end');
    write('pkg.json', 'v2\nuser edit\n');
    const start = boundary('t1');
    git(['checkout', '--', 'pkg.json']);
    const state = {
      turnEndShadows: [{ promptIndex: 0, shadowSha: stopEnd, capturedAt: '' }],
      gitPathspecsByTurn: [{ promptIndex: 1, paths: ['pkg.json'] }],
    };
    expect(filesPutBackAcrossTheGap(repo, state, 1, start, null, ['pkg.json']).size).toBe(0);
    expect([...filesPutBackAcrossTheGap(repo, { turnEndShadows: state.turnEndShadows }, 1, start, null, ['pkg.json'])]).toEqual(['pkg.json']);
  });

  it('re-checks 30 carried rows at Stop without one history walk', () => {
    const shadows: Array<{ promptIndex: number; shadowSha: string }> = [];
    const ends: Array<{ promptIndex: number; shadowSha: string; capturedAt: string }> = [];
    const rows: InheritedFilesRow[] = [];
    for (let i = 0; i < 30; i++) {
      shadows.push({ promptIndex: i, shadowSha: boundary(`t${i}`) });
      write(`f${i}.txt`, `turn ${i}\n`);
      if (i % 2 === 0) git(['checkout', 'HEAD~1', '--', 'pkg.json']);
      else git(['checkout', 'HEAD', '--', 'pkg.json']);
      const end = boundary(`t${i}-end`);
      ends.push({ promptIndex: i, shadowSha: end, capturedAt: '' });
      rows.push({ promptIndex: i, filesChanged: [`f${i}.txt`, 'pkg.json'], diff: '' });
    }
    shadows.push({ promptIndex: 30, shadowSha: boundary('t30') });
    const state = { promptShadows: shadows, turnEndShadows: ends, prompts: Array.from({ length: 31 }, () => 'p') };

    const spent = gitProcessesDuring(() => {
      dropInheritedFilesFromTurns(state, rows, {
        inheritedFiles: () => new Set(),
        authoredFiles: () => new Set(),
        restoredFromHistory: (from, to, local, files) => filesPutBackAcrossTheGap(repo, state, local, from, to, files),
      });
    });
    expect(spent.log).toBe(0);
    // One batched blob read per row that has a previous Stop; nothing rewrote
    // a file in any gap, so no working-tree read follows.
    expect(spent.all).toBeLessThanOrEqual(rows.length);
    expect(rows.every((r) => (r.filesChanged as string[]).includes('pkg.json'))).toBe(true);
  });
});
