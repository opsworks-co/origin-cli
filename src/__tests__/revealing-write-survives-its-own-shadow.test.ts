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
import {
  diffSectionsFor,
  EDIT_HOOK_TOOL,
  rescueRevealingWrite,
  scopeAfterFileEditDiffs,
} from '../commands/hooks/after-file-edit.js';
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

describe('after-file-edit blob ownership', () => {
  it('removes an extractor-missed file from both stored diffs', () => {
    const prior = section('first.ts');
    const current = section('second.ts');
    const missed = section('session-state.ts');
    const wholeTree = [prior, current, missed].join('\n');
    const state = {
      liveEdits: [{
        promptIndex: 2,
        toolName: EDIT_HOOK_TOOL,
        capturedAt: new Date().toISOString(),
        edits: [{
          file: 'first.ts',
          op: 'write' as const,
          oldContent: 'old',
          newContent: 'new',
          source: 'uncommitted' as const,
          evidence: 'edit_hook' as const,
        }],
      }],
    };

    // Cursor names second.ts now; first.ts was named by this turn's earlier
    // edit hook. session-state.ts is merely dirty in the same working tree —
    // the exact production shape behind TODO 58f09990.
    const scoped = scopeAfterFileEditDiffs(
      state, 2, ['second.ts'], wholeTree, wholeTree,
    );

    expect([...scoped.files]).toEqual(['second.ts', 'first.ts']);
    for (const blob of [scoped.diff, scoped.uncommittedDiff]) {
      expect(blob).toContain('first.ts');
      expect(blob).toContain('second.ts');
      expect(blob).not.toContain('session-state.ts');
    }
  });

  it('does not borrow edit evidence from another turn or producer', () => {
    const state = {
      liveEdits: [
        {
          promptIndex: 1,
          toolName: EDIT_HOOK_TOOL,
          capturedAt: new Date().toISOString(),
          edits: [{ file: 'other-turn.ts', op: 'write' as const, source: 'uncommitted' as const }],
        },
        {
          promptIndex: 2,
          toolName: 'origin:shell-probe',
          capturedAt: new Date().toISOString(),
          edits: [{ file: 'inferred.ts', op: 'write' as const, source: 'uncommitted' as const }],
        },
      ],
    };
    const wholeTree = [
      section('current.ts'),
      section('other-turn.ts'),
      section('inferred.ts'),
    ].join('\n');

    const scoped = scopeAfterFileEditDiffs(
      state, 2, ['current.ts'], wholeTree, wholeTree,
    );

    expect(scoped.diff).toContain('current.ts');
    expect(scoped.diff).not.toContain('other-turn.ts');
    expect(scoped.diff).not.toContain('inferred.ts');
  });

  it('still owns the current hook path when the ledger declined the write', () => {
    // An oversized Cursor write never enters liveEdits (content cap). The hook
    // path is then the only ownership evidence — dropping it is how
    // session-state.ts vanished from the mapping while remaining in the blob.
    const wholeTree = [section('session-state.ts'), section('sibling.ts')].join('\n');
    const scoped = scopeAfterFileEditDiffs(
      { liveEdits: [] }, 0, ['session-state.ts'], wholeTree, wholeTree,
    );
    expect([...scoped.files]).toEqual(['session-state.ts']);
    expect(scoped.diff).toContain('session-state.ts');
    expect(scoped.diff).not.toContain('sibling.ts');
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
