/**
 * Telling OUR shell write apart from a sibling's concurrent one.
 *
 * The shell probe fingerprints every tree before a write-shaped command and
 * again after it, so what changed in between is what the command did. On a
 * quiet checkout that is strong. On a busy one it is not: session 6e9947a5 ran
 * alongside five other agents, and turn 0's probe attributed a sibling's
 * `apps/api/src/services/reconstructed-commits.ts` to us purely because the
 * sibling wrote it inside our window.
 *
 * Grading that evidence by whether OUR command text names the file closes it.
 * A concurrent writer can satisfy the window; it can never put its path into
 * our command.
 *
 * The consequence of NOT having this: ownership falls back to inference, the
 * exclusion drops any file a sibling also claims, and thirteen sessions in
 * this repo claim `packages/cli/src/commands/hooks.ts`. That file never
 * appeared on a single turn of 6e9947a5, which is also why every turn's line
 * count was short (+122 recorded against +142 actually committed).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileNamedInCommand } from '../commands/hooks.js';

const TREE = path.resolve('/repo');
const OURS = 'packages/cli/src/commands/hooks.ts';
const THEIRS = 'apps/api/src/services/reconstructed-commits.ts';

describe('fileNamedInCommand', () => {
  it('matches the repo-relative path a heredoc write names', () => {
    const cmd = "python3 - <<'PY'\np='packages/cli/src/commands/hooks.ts'\ns=open(p).read()\nPY";
    expect(fileNamedInCommand(cmd, OURS, TREE)).toBe(true);
  });

  it('matches an absolute path', () => {
    const cmd = `sed -i '' 's/a/b/' ${path.join(TREE, OURS)}`;
    expect(fileNamedInCommand(cmd, OURS, TREE)).toBe(true);
  });

  it("does NOT match a sibling's file that our command never mentions", () => {
    // The turn-0 leak, exactly: our command touched hooks.ts, the sibling
    // wrote reconstructed-commits.ts inside the same window.
    const cmd = "python3 - <<'PY'\np='packages/cli/src/commands/hooks.ts'\nPY";
    expect(fileNamedInCommand(cmd, THEIRS, TREE)).toBe(false);
  });

  it('does NOT match on basename alone', () => {
    // A loose basename match would let one mention of hooks.ts claim every
    // hooks.ts in the repo — the failure mode this whole change is undoing.
    expect(fileNamedInCommand('cat hooks.ts', OURS, TREE)).toBe(false);
    expect(fileNamedInCommand('echo reconstructed-commits.ts', THEIRS, TREE)).toBe(false);
  });

  it('normalises Windows separators on both sides', () => {
    expect(fileNamedInCommand(
      'type packages\\cli\\src\\commands\\hooks.ts',
      'packages\\cli\\src\\commands\\hooks.ts',
      TREE,
    )).toBe(true);
  });

  it('is false for empty or missing input', () => {
    expect(fileNamedInCommand('', OURS, TREE)).toBe(false);
    expect(fileNamedInCommand('anything', '', TREE)).toBe(false);
    expect(fileNamedInCommand(undefined as any, OURS, TREE)).toBe(false);
  });

  it('works without a tree (repo-relative match only)', () => {
    expect(fileNamedInCommand(`tee ${OURS}`, OURS)).toBe(true);
    expect(fileNamedInCommand('tee something-else.ts', OURS)).toBe(false);
  });

  it('a bare filename target still does not match — needs a directory', () => {
    // Guards the `rel.includes('/')` condition: a single-segment path is too
    // ambiguous to treat as proof.
    expect(fileNamedInCommand('tee README.md', 'README.md')).toBe(false);
  });
});
