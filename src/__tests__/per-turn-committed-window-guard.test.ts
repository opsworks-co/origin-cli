/**
 * A per-turn mapping must scope the committed side to THAT TURN's window.
 *
 * `sessionScopedCommittedDiff` replays every sha in `state.sessionCommitShas`.
 * That is right for the SESSION diff and wrong for a single turn: without a
 * `sinceSha` it hands turn N everything the session has committed so far, so
 * every turn after a commit re-reports it.
 *
 * Prod 192cdf12 (repo `baton`, Cursor). The CLI's own log records what it sent
 * for turn 3:
 *
 *     {"i":2,"t":"t_5e5a8d98","f":13,"a":244,"r":4,"d":63422}
 *
 * 244 = 119 + 125 — turn 1's committed work plus turn 3's own — and 13 files is
 * turn 1's 9 unioned with turn 3's 8. The over-claim is arithmetic, not
 * inference. It also seeded the read side: the server then had to decide which
 * of those rows each line belonged to, and that fold is what deleted turn 3's
 * closing braces (API #1313/#1314/#1315/#1316).
 *
 * The parameter existed and one of four call sites passed it. That is the same
 * shape as the API-side bug, so the interesting test here is not "does the
 * function window correctly" — it did — but "does every per-turn caller ask it
 * to". Hence the mechanical guard below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { __testSessionScopedCommittedDiff } from '../commands/hooks.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf-8', env: ENV }).trim();

let repo = '';
let turn1Commit = '';
let turn3Baseline = '';

beforeAll(() => {
  // realpathSync.native: macOS hands out /var/… where git reports /private/var.
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-window-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'agent@local']);
  git(repo, ['config', 'user.name', 'Agent']);

  fs.writeFileSync(path.join(repo, 'index.js'), 'const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);

  // Turn 1 commits its work — the row that later turns must not re-report.
  fs.writeFileSync(path.join(repo, 'index.js'), 'const a = 1;\nconst wave = 2;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Add wave transform']);
  turn1Commit = git(repo, ['rev-parse', 'HEAD']);

  // Turn 3 starts here: its baseline is HEAD, so turn 1's commit is behind it.
  turn3Baseline = turn1Commit;
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

const state = () => ({ sessionCommitShas: [turn1Commit] });

describe('sessionScopedCommittedDiff — per-turn windowing', () => {
  it('replays the session commit when asked for the SESSION range', () => {
    // No baseline = session scope. The session diff genuinely wants this.
    const out = __testSessionScopedCommittedDiff(repo, state());
    expect(out).toContain('const wave = 2;');
  });

  it('drops a commit that lands BEFORE the turn baseline', () => {
    // Turn 3's window starts at turn 1's commit, so that commit is not in it.
    const out = __testSessionScopedCommittedDiff(repo, state(), turn3Baseline);
    expect(out).toBe('');
  });

  it('keeps a commit the turn itself made', () => {
    const before = git(repo, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'index.js'), 'const a = 1;\nconst wave = 2;\nconst bold = 3;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'Add bold transform']);
    const mine = git(repo, ['rev-parse', 'HEAD']);

    const out = __testSessionScopedCommittedDiff(
      repo, { sessionCommitShas: [turn1Commit, mine] } as any, before,
    );
    const added = out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(added).toEqual(['+const bold = 3;']);
    // Turn 1's row is still present, but only as CONTEXT — it is not claimed.
    expect(out).toContain(' const wave = 2;');
  });
});

/**
 * The window parameter is optional, so a caller that forgets it compiles, runs,
 * and silently over-claims — exactly how three of four sites ended up wrong.
 * Only the SESSION-level diff in handleStop may go unwindowed.
 */
describe('every per-turn caller passes a window', () => {
  const HOOKS = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts',
  );

  it('leaves no unwindowed call outside the session-diff site', () => {
    const src = fs.readFileSync(HOOKS, 'utf-8');
    const lines = src.split('\n');
    const offenders: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('sessionScopedCommittedDiff(')) continue;
      // Skip the declaration and the exported test seam.
      if (/function sessionScopedCommittedDiff|__testSessionScopedCommittedDiff/.test(lines[i])) continue;
      // The call may wrap onto following lines; read to its closing paren.
      const call = lines.slice(i, i + 4).join(' ');
      const args = call.slice(call.indexOf('sessionScopedCommittedDiff(') + 'sessionScopedCommittedDiff('.length);
      const argText = args.slice(0, args.indexOf(')'));
      const argc = argText.split(',').filter((a) => a.trim().length > 0).length;
      if (argc < 3) offenders.push(`${i + 1}: ${lines[i].trim()}`);
    }

    // handleStop builds the SESSION diff (feeding sessionDiff and AI Blame),
    // which is session-scoped on purpose. Exactly one such site may exist.
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/let sessionCommitted = sessionScopedCommittedDiff/);
  });
});
