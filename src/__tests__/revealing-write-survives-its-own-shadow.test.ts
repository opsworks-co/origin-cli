// When afterFileEdit is the thing that DISCOVERS a turn, it cuts that turn's
// shadow from a working tree that already holds the write which revealed it.
// The turn's own window is then empty by construction — and the hook used to
// return on that, so the write reached neither the mapping nor filesChanged.
//
// Prod 2ecac40a turn 2 (Cursor) opened by editing `session-state.ts`, 153KB.
// hooks.log: `no diff against shadow, skipping`. That file alone of the turn's
// five was missing when the turn committed all five — and a commit that looks
// only partly captured is exactly what lets the server's pc heal copy it onto
// another turn.
//
// The end-to-end proof runs the built binary (capture-e2e-cursor-binary, turn
// 4, where the revealing write is over the ledger's content cap so the
// evidence path declines too). These are the fast checks on the two pieces.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { diffSectionsFor, rescueRevealingWrite } from '../commands/hooks/after-file-edit.js';
import { captureGitState, createShadowCommit } from '../git-capture.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

const section = (file: string) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('diffSectionsFor', () => {
  const text = [section('a.ts'), section('b.ts'), section('c.ts')].join('\n');

  it('keeps only the named files, in the order the diff has them', () => {
    const out = diffSectionsFor(text, new Set(['c.ts', 'a.ts']));
    expect(out.match(/^diff --git a\/(\S+)/gm)).toEqual(['diff --git a/a.ts', 'diff --git a/c.ts']);
  });

  it('is empty for a file the diff does not mention, and for an empty scope', () => {
    expect(diffSectionsFor(text, new Set(['nope.ts']))).toBe('');
    expect(diffSectionsFor(text, new Set())).toBe('');
    expect(diffSectionsFor('', new Set(['a.ts']))).toBe('');
  });

  it('matches a rename on either side — the file is the turn\'s work under both names', () => {
    const renamed = 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-x\n+y';
    expect(diffSectionsFor(renamed, new Set(['new.ts']))).toContain('b/new.ts');
    expect(diffSectionsFor(renamed, new Set(['old.ts']))).toContain('b/new.ts');
  });

  it('ignores a leading fragment that is not a diff --git section', () => {
    expect(diffSectionsFor('warning: whatever\n' + section('a.ts'), new Set(['a.ts'])))
      .toContain('diff --git a/a.ts');
  });
});

describe('rescueRevealingWrite against a real repo', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reveal-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@origin.dev');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'before\n');
    fs.writeFileSync(path.join(repo, 'other.ts'), 'untouched\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'seed');
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  const capture = (baseline: string) => captureGitState(repo, baseline);

  it('recovers the write the turn\'s own shadow swallowed', () => {
    const editBaseline = git(repo, 'rev-parse', 'HEAD');
    // Cursor writes the file, THEN the hook notices the turn and shadows it.
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'after\n');
    const swallowing = createShadowCommit(repo, 'turn-2')!;

    // The precondition: the turn's own window says nothing happened.
    const own = captureGitState(repo, swallowing);
    expect((own.workingTreeDiff || '') + (own.uncommittedDiff || '')).not.toContain('mine.ts');

    const rescued = rescueRevealingWrite(editBaseline, ['mine.ts'], capture);
    expect(rescued).toContain('+after');
    expect(rescued).toContain('-before');
  });

  it('brings back only the named file, not everything between the two baselines', () => {
    // A previous turn's work sits between the baselines. Scoping is what keeps
    // this rescue from re-claiming it.
    fs.writeFileSync(path.join(repo, 'other.ts'), 'an earlier turn wrote this\n');
    const editBaseline = createShadowCommit(repo, 'turn-1')!;
    fs.writeFileSync(path.join(repo, 'other.ts'), 'and changed it again\n');
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'after\n');
    createShadowCommit(repo, 'turn-2');

    const rescued = rescueRevealingWrite(editBaseline, ['mine.ts'], capture);
    expect(rescued).toContain('+after');
    expect(rescued).not.toContain('other.ts');
  });

  it('recovers a file created by the revealing write, not only a modified one', () => {
    const editBaseline = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'fresh.ts'), 'brand new\n');
    createShadowCommit(repo, 'turn-2');
    expect(rescueRevealingWrite(editBaseline, ['fresh.ts'], capture)).toContain('+brand new');
  });

  it('declines rather than guesses when it has no baseline or no file', () => {
    expect(rescueRevealingWrite(undefined, ['mine.ts'], capture)).toBe('');
    expect(rescueRevealingWrite(git(repo, 'rev-parse', 'HEAD'), [], capture)).toBe('');
  });

  it('returns empty rather than throwing when the capture blows up', () => {
    expect(rescueRevealingWrite('deadbeef', ['mine.ts'], () => { throw new Error('bad rev'); })).toBe('');
  });
});
