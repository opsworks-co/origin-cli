/**
 * `abandonedOnlyFiles` names the files whose ONLY life was a commit the session
 * reset away. Everything downstream treats that list as proof: the row loses
 * the file's section, the ledger loses even a `tool_call` edit of it, and the
 * session's file list drops it. So a file still on disk may never be on it.
 *
 * RCCE-423 review gate: the "still here" check was
 * `git ls-files --others --exclude-standard`, which never names an IGNORED
 * file. A path force-added into the WIP commit (`git add -f`), reset away, and
 * then written again by the agent is on disk and hidden from that command — so
 * it read as abandoned and the agent's first-hand write was thrown away with
 * the commit. Existence is asked of the filesystem, as vanished-watched-files
 * already asks it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { abandonedOnlyFiles, sessionAuthoredNothing } from '../commands/hooks.js';
import { dropVanishedWatchedAdds } from '../vanished-watched-files.js';
import { trimWatchedEdits } from '../trim-watched-edits.js';

let repo = '';
let base = '';
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
/** A fresh state object each time: the helper memoizes per state. */
const stateAt = (shas: string[]) => ({
  sessionId: 's-abandoned-only', sessionTag: 'abandoned-only', agentSlug: 'claude-code',
  repoPath: repo, headShaAtStart: base, startedAt: new Date(Date.now() - 60_000).toISOString(),
  prompts: [], sessionCommitShas: shas,
}) as any;

beforeEach(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-abandoned-only-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  write('.gitignore', 'src/ignored.ts\n');
  write('src/base.ts', 'export const BASE = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Force-add `files` into one WIP commit and reset it away. Returns its sha. */
function wipAndReset(files: Array<[string, string]>): string {
  for (const [f, body] of files) { write(f, body); git('add', '-f', f); }
  git('commit', '-qm', 'wip');
  const sha = git('rev-parse', 'HEAD');
  git('reset', '-q', '--hard', base);
  for (const [f] of files) fs.rmSync(path.join(repo, f), { force: true });
  return sha;
}

describe('abandonedOnlyFiles and a file that is still on disk', () => {
  it('does not call an IGNORED file abandoned when it is back on disk', () => {
    const wip = wipAndReset([['src/ignored.ts', 'export const WIP = 1;\n']]);
    // The agent writes it again, after the reset. It is on disk...
    write('src/ignored.ts', 'export const REAL_WORK = 1;\n');
    expect(fs.lstatSync(path.join(repo, 'src/ignored.ts')).isFile()).toBe(true);
    // ...and git's untracked list does not name it, which is the whole trap.
    expect(git('ls-files', '--others', '--exclude-standard')).toBe('');
    expect(abandonedOnlyFiles(repo, stateAt([wip])), 'a file on disk was called abandoned')
      .not.toContain('src/ignored.ts');
  });

  it('positive control: a file that really is gone is still named', () => {
    const wip = wipAndReset([['src/gone.ts', 'export const GONE = 1;\n']]);
    expect(abandonedOnlyFiles(repo, stateAt([wip]))).toEqual(['src/gone.ts']);
  });

  it('tells the two apart in one commit', () => {
    const wip = wipAndReset([
      ['src/ignored.ts', 'export const WIP = 1;\n'],
      ['src/gone.ts', 'export const GONE = 1;\n'],
    ]);
    write('src/ignored.ts', 'export const REAL_WORK = 1;\n');
    expect(abandonedOnlyFiles(repo, stateAt([wip]))).toEqual(['src/gone.ts']);
  });

  it('keeps a plain untracked file that was rewritten after the reset', () => {
    const wip = wipAndReset([['src/plain.ts', 'export const WIP = 1;\n']]);
    write('src/plain.ts', 'export const REAL_WORK = 1;\n');
    expect(abandonedOnlyFiles(repo, stateAt([wip]))).not.toContain('src/plain.ts');
  });

  const symlinks = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-symlink-probe-'));
    try { fs.symlinkSync('nowhere', path.join(probe, 'l')); return true; }
    catch { return false; }
    finally { try { fs.rmSync(probe, { recursive: true, force: true }); } catch { /* ignore */ } }
  })();

  // A symlink whose target is missing is still a directory entry the tree has.
  it.skipIf(!symlinks)('keeps a dangling symlink that is really on disk', () => {
    const wip = wipAndReset([['src/ignored.ts', 'export const WIP = 1;\n']]);
    fs.symlinkSync('target-that-is-not-there.ts', path.join(repo, 'src/ignored.ts'));
    expect(fs.existsSync(path.join(repo, 'src/ignored.ts')), 'the probe needs a DANGLING link').toBe(false);
    expect(abandonedOnlyFiles(repo, stateAt([wip]))).not.toContain('src/ignored.ts');
  });

  it('names nothing when git cannot answer at all', () => {
    const wip = wipAndReset([['src/gone.ts', 'export const GONE = 1;\n']]);
    expect(abandonedOnlyFiles(path.join(repo, 'no-such-dir'), stateAt([wip]))).toEqual([]);
  });
});

// What the list is used for, end to end: with the ignored file off it, the
// passes that consume it cannot touch the agent's first-hand work.
describe('the passes fed by abandonedOnlyFiles', () => {
  const addSection = (file: string, line: string) => [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    '',
  ].join('\n');

  // The session-level snapshot is git's answer, and git never shows an ignored
  // file, so "the session authored nothing" stays TRUE here — which is what
  // replaces the stale SessionDiff post-commit wrote before the reset. It says
  // nothing about the turns: the empty snapshot carries session diff fields
  // only, and the agent's first-hand write stays on its row and in its ledger
  // (the test below). Making the proof fail on any ignored file would bring the
  // pre-reset diff back, which is the bug this work exists to fix.
  it('the empty-session proof still holds, and takes no turn work with it', () => {
    const wip = wipAndReset([['src/ignored.ts', 'export const WIP = 1;\n']]);
    write('src/ignored.ts', 'export const REAL_WORK = 1;\n');
    expect(sessionAuthoredNothing(repo, stateAt([wip])), 'the stale pre-reset session diff would survive').toBe(true);
    expect(git('diff', '--name-only', base), 'the tracked tree is not the start\'s').toBe('');
  });

  it('keeps the recreated ignored file in the row and in the ledger', () => {
    const wip = wipAndReset([['src/ignored.ts', 'export const WIP = 1;\n']]);
    write('src/ignored.ts', 'export const REAL_WORK = 1;\n');
    const abandoned = abandonedOnlyFiles(repo, stateAt([wip]));

    const row: any = {
      promptIndex: 0, filesChanged: ['src/ignored.ts'],
      diff: addSection('src/ignored.ts', 'export const REAL_WORK = 1;'),
      uncommittedDiff: '', linesAdded: 1, linesRemoved: 0,
    };
    const ledger = JSON.stringify({ edits: [{ file: 'src/ignored.ts', op: 'write', evidence: 'tool_call' }] });
    const byIndex = new Map<number, string>([[0, ledger]]);

    dropVanishedWatchedAdds(repo, [row], { editsByIndex: byIndex, commitShas: [], abandonedFiles: abandoned });
    expect(row.filesChanged, 'the row lost work that is on disk').toEqual(['src/ignored.ts']);
    expect(row.diff).toContain('REAL_WORK');

    const out = trimWatchedEdits(ledger, row, abandoned);
    expect(out.dropped, 'the ledger lost a tool call for work that is on disk').toEqual([]);
  });
});
