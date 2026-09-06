/**
 * The heartbeat re-sends the CURRENT turn every tick. Two things it must not
 * do: count the turn's own baseline commit as the turn's work, and re-derive a
 * turn Stop has already closed.
 *
 * Prod bc4a1438 (vodka): turn 3 committed b7f2dfd1 and Stop stored it as
 * +52/-1 from the ledger. Turn 4 was a question. Its baseline shadow WAS
 * b7f2dfd1 (HEAD, clean tree), `git merge-base --is-ancestor X X` is true, so
 * every tick published the whole commit — five files, +1227 — onto the
 * chat-only turn 4 with a fresh `hb_` stamp, ten minutes after Stop had
 * written it empty.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { commitLandedInTurn, turnIsClosed } from '../turn-commit-scope.js';

const isAncestorOf = (graph: Record<string, string[]>) =>
  (anc: string, desc: string): boolean => {
    // desc's ancestor chain, inclusive — git's own answer for X,X is true.
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === anc) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const p of graph[n] || []) stack.push(p);
    }
    return false;
  };

describe('commitLandedInTurn', () => {
  const B = 'b7f2dfd1decc74bfcf6428b03ab6ea310f69b3c8';
  const graph = isAncestorOf({ [B]: ['1d5973cb49c926ad18f2cf8cb32f3aecce04d0b4'], 'aaaaaaa1': [B] });

  it('a commit that descends from the baseline is the turn\'s', () => {
    expect(commitLandedInTurn(B, 'aaaaaaa1', graph)).toBe(true);
  });

  it('the baseline ITSELF is the turn\'s start, not its work', () => {
    expect(commitLandedInTurn(B, B, graph)).toBe(false);
    // Abbreviated on either side — the state file and the commit list do not
    // always carry the same length.
    expect(commitLandedInTurn(B.slice(0, 12), B, graph)).toBe(false);
    expect(commitLandedInTurn(B, B.slice(0, 8), graph)).toBe(false);
  });

  it('a commit from before the baseline is not the turn\'s', () => {
    expect(commitLandedInTurn(B, '1d5973cb49c926ad18f2cf8cb32f3aecce04d0b4', graph)).toBe(false);
  });

  it('no usable baseline keeps every session commit, as before', () => {
    expect(commitLandedInTurn(null, 'aaaaaaa1', graph)).toBe(true);
    expect(commitLandedInTurn('not-a-sha', 'aaaaaaa1', graph)).toBe(true);
  });

  it('never claims something that is not a sha', () => {
    expect(commitLandedInTurn(B, 'HEAD', graph)).toBe(false);
  });
});

describe('turnIsClosed', () => {
  it('is false until Stop has closed that turn', () => {
    expect(turnIsClosed({}, 0)).toBe(false);
    expect(turnIsClosed({ lastClosedTurnIndex: null }, 0)).toBe(false);
    expect(turnIsClosed({ lastClosedTurnIndex: 1 }, 2)).toBe(false);
  });
  it('is true for the closed turn and every turn before it', () => {
    expect(turnIsClosed({ lastClosedTurnIndex: 1 }, 1)).toBe(true);
    expect(turnIsClosed({ lastClosedTurnIndex: 3 }, 1)).toBe(true);
  });
});

describe('the heartbeat honours both', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'heartbeat.ts'), 'utf-8',
  );
  it('skips a turn Stop closed before deriving anything for it', () => {
    const body = src.slice(src.indexOf('async function pushInflightDiff'));
    const skip = body.indexOf('if (turnIsClosed(state, promptIndex)) return;');
    const derive = body.indexOf('committedDiff');
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(derive);
  });
  it('scopes session commits to the turn through commitLandedInTurn, not a bare ancestry test', () => {
    const body = src.slice(src.indexOf('async function pushInflightDiff'));
    expect(body).toContain('if (!commitLandedInTurn(promptBaseline, sha, isAncestor)) continue;');
    expect(body).not.toContain('!isAncestor(promptBaseline, sha)) continue;');
  });
});
