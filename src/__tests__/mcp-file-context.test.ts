import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getFileContext } from '../mcp/file-context.js';

// Exercises the real git-notes read path against a throwaway repo — no
// mocking of git, so a wrong note ref / parse shape fails here, not in prod.

let repo: string;
let gitConfig: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Fully isolate from the developer's real git config / hooks.
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: gitConfig,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).toString();
}

function commitFile(file: string, content: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(['add', file]);
  git(['commit', '-m', `edit ${file}`]);
  return git(['rev-parse', 'HEAD']).trim();
}

function addOriginNote(sha: string, origin: Record<string, unknown>): void {
  git(['notes', '--ref=origin', 'add', '-f', '-m', JSON.stringify({ origin }), sha]);
}

function addAcceptanceNote(sha: string, acceptanceRate: number): void {
  git([
    'notes', '--ref=origin-acceptance', 'add', '-f',
    '-m', JSON.stringify({ version: 1, sessionId: 's', computedAt: '2026-07-10T00:00:00Z', addedLines: 10, survivingLines: Math.round(acceptanceRate * 10), acceptanceRate }),
    sha,
  ]);
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-fctx-'));
  gitConfig = path.join(repo, '.gitconfig-isolated');
  fs.writeFileSync(gitConfig, '[init]\n  defaultBranch = main\n');
  git(['init']);
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('getFileContext', () => {
  it('surfaces the prompt + attribution behind a file (summary by default)', () => {
    const sha = commitFile('auth.ts', 'export const login = () => {}\n');
    addOriginNote(sha, {
      sessionId: 's1',
      agent: 'codex',
      model: 'gpt-5.5',
      promptSummary: 'Add a login function',
      fullPrompt: 'Add a login function that validates the session token and returns a user object.',
      originUrl: 'https://getorigin.io/sessions/s1',
    });

    const res = getFileContext(repo, ['auth.ts']);
    expect(res.error).toBeUndefined();
    expect(res.commits).toHaveLength(1);
    const c = res.commits[0];
    expect(c.agent).toBe('codex');
    expect(c.model).toBe('gpt-5.5');
    expect(c.touched).toEqual(['auth.ts']);
    expect(c.prompt).toBe('Add a login function');       // summary, not full
    expect(c.sessionUrl).toBe('https://getorigin.io/sessions/s1');
  });

  it('returns the full prompt when includeDetail is set', () => {
    const res = getFileContext(repo, ['auth.ts'], { includeDetail: true });
    expect(res.commits[0].prompt).toContain('validates the session token');
  });

  it('returns a compact signals headline by default, full detail only on request', () => {
    const sha = commitFile('pay.ts', 'export const charge = () => {}\n');
    addOriginNote(sha, {
      sessionId: 's3',
      agent: 'claude',
      promptSummary: 'Add charge()',
      filesRead: ['pay.ts', 'stripe.ts', 'money.ts'],
      markers: {
        decision: ['Used integer cents to avoid float rounding'],
        open: ['Refunds not implemented yet'],
        verify: ['Confirm currency is always USD'],
        intent: ['Support one-off payments'],
      },
    });
    addAcceptanceNote(sha, 0.3); // low → fragile

    // Default: signals present, but heavy detail withheld.
    const lean = getFileContext(repo, ['pay.ts']);
    const c = lean.commits[0];
    expect(c.markers).toBeUndefined();
    expect(c.filesRead).toBeUndefined();
    expect(c.signals.decisions).toBe(1);
    expect(c.signals.openItems).toBe(1);
    expect(c.signals.verifyItems).toBe(1);
    expect(c.signals.filesReadCount).toBe(3);
    expect(c.signals.acceptanceRate).toBeCloseTo(0.3);
    expect(c.signals.fragile).toBe(true);

    // Detail: full markers + filesRead now included.
    const full = getFileContext(repo, ['pay.ts'], { includeDetail: true });
    const cd = full.commits[0];
    expect(cd.markers?.decision).toEqual(['Used integer cents to avoid float rounding']);
    expect(cd.markers?.open).toEqual(['Refunds not implemented yet']);
    expect(cd.filesRead).toEqual(['pay.ts', 'stripe.ts', 'money.ts']);
  });

  it('does not flag fragile when acceptance is high', () => {
    const sha = commitFile('stable.ts', 'export const ok = 1\n');
    addOriginNote(sha, { sessionId: 's4', promptSummary: 'add ok' });
    addAcceptanceNote(sha, 0.95);
    const c = getFileContext(repo, ['stable.ts']).commits[0];
    expect(c.signals.acceptanceRate).toBeCloseTo(0.95);
    expect(c.signals.fragile).toBeUndefined();
  });

  it('flags promptWithheld when the note carries no prompt text', () => {
    const sha = commitFile('secret.ts', 'const KEY = 1\n');
    addOriginNote(sha, { sessionId: 's2', agent: 'claude', promptTextWithheld: true });

    const res = getFileContext(repo, ['secret.ts']);
    expect(res.commits[0].promptWithheld).toBe(true);
    expect(res.commits[0].prompt).toBeUndefined();
  });

  it('returns a message (not an error) for a tracked file with no Origin notes', () => {
    commitFile('plain.ts', 'const x = 1\n'); // committed, but no note added
    const res = getFileContext(repo, ['plain.ts']);
    expect(res.error).toBeUndefined();
    expect(res.commits).toHaveLength(0);
    expect(res.message).toMatch(/No Origin attribution/i);
  });

  // Regression: `-z` NUL-TERMINATES each log record, so a NUL between the
  // fields too (the old `%H%x00%cI`) left no double-NUL to split records on.
  // The whole log collapsed into ONE record — only the newest commit per path
  // was inspected, and per_path_limit silently did nothing. This bites hardest
  // on squash-merge repos, where the newest commit is the unannotated squash
  // and the tool reports "no attribution" against a full notes history.
  it('reaches PAST the newest commit when that commit has no note', () => {
    const older = commitFile('layered.ts', 'v1\n');
    addOriginNote(older, { version: 1, sessionId: 'sess-older', promptSummary: 'the annotated one' });
    commitFile('layered.ts', 'v2\n'); // newest, deliberately NOT annotated

    const res = getFileContext(repo, ['layered.ts'], { perPathLimit: 5 });
    expect(res.commits).toHaveLength(1);
    expect(res.commits[0].prompt).toBe('the annotated one');
  });

  it('returns MULTIPLE annotated commits for one path, newest first', () => {
    const first = commitFile('multi.ts', 'a\n');
    addOriginNote(first, { version: 1, sessionId: 'sess-1', promptSummary: 'first' });
    const second = commitFile('multi.ts', 'b\n');
    addOriginNote(second, { version: 1, sessionId: 'sess-2', promptSummary: 'second' });

    const res = getFileContext(repo, ['multi.ts'], { perPathLimit: 5 });
    expect(res.commits.map((c) => c.prompt)).toEqual(['second', 'first']);
  });

  // Regression: max_commits used to slice CANDIDATES before checking which
  // carried notes, so annotated commits behind unannotated ones were dropped
  // — the squash-merge shape again. It must bound the RESULT set.
  it('caps on annotated results, not on candidates inspected', () => {
    const a = commitFile('capped.ts', '1\n');
    addOriginNote(a, { version: 1, sessionId: 'cap-1', promptSummary: 'oldest' });
    const b = commitFile('capped.ts', '2\n');
    addOriginNote(b, { version: 1, sessionId: 'cap-2', promptSummary: 'middle' });
    commitFile('capped.ts', '3\n'); // newest two carry no note
    commitFile('capped.ts', '4\n');

    // Only 2 annotated commits exist and they sit behind 2 bare ones.
    const res = getFileContext(repo, ['capped.ts'], { perPathLimit: 10, maxCommits: 2 });
    expect(res.commits.map((c) => c.prompt)).toEqual(['middle', 'oldest']);
  });

  it('errors cleanly on a non-git path', () => {
    const res = getFileContext(os.tmpdir(), ['whatever.ts']);
    expect(res.error).toMatch(/Not a git repository/);
  });

  it('errors when no paths are provided', () => {
    const res = getFileContext(repo, []);
    expect(res.error).toMatch(/No file paths/);
  });
});
