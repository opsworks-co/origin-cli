// Which commit did the OPEN turn make? (TODO 0b224406)
//
// capture-e2e-cursor-binary: turn 3 committed "add helper"; Cursor never
// announced turn 4, so its prePromptSha stayed the pre-session base, which is
// not an own commit — and the old fallback then took EVERY own commit as a
// candidate. Whenever a heartbeat tick landed inside turn 4, turn 4's row went
// out with "add helper", and the server keeps the first sha it sees on a row.
import { describe, it, expect } from 'vitest';
import { commitMadeByOpenTurn, type TurnCommitInputs } from '../heartbeat-turn-commit.js';

// base ← helper ← fix   (a straight line; `adopted` is a shadow cut on helper)
const PARENT: Record<string, string | null> = { base: null, helper: 'base', fix: 'helper' };
const isAncestor = (anc: string, desc: string): boolean => {
  for (let c: string | null = desc; c; c = PARENT[c] ?? null) if (c === anc) return true;
  return false;
};
const TIME: Record<string, number> = { base: 1000, helper: 2000, fix: 3000 };
const inputs = (over: Partial<TurnCommitInputs>): TurnCommitInputs => ({
  ownCommits: ['helper'], attested: [], start: 'helper', promptStartedAt: 0,
  isAncestor, commitTime: (sha) => TIME[sha] ?? null, ...over,
});

describe('commitMadeByOpenTurn', () => {
  it('the incident: an unannounced turn that began on the previous turn\'s commit made none', () => {
    // start = the adoption shadow's parent = helper, the previous turn's commit.
    expect(commitMadeByOpenTurn(inputs({ start: 'helper' }))).toBeNull();
  });

  it('the old fallback\'s shape: a stale start that is not an own commit still does not hand out every commit', () => {
    // start = base (a stale prePromptSha). helper descends from it, so ancestry
    // alone would still say "made in this turn" — which is why the caller
    // resolves the turn's shadow first. What must never happen again is the
    // no-anchor case taking the session's first commit.
    expect(commitMadeByOpenTurn(inputs({ start: null }))).toBeNull();
  });

  it('a commit that descends from the turn\'s start is the turn\'s', () => {
    expect(commitMadeByOpenTurn(inputs({ ownCommits: ['helper', 'fix'], start: 'helper' }))).toBe('fix');
  });

  it('a commit post-commit attested to this turn wins over ancestry', () => {
    expect(commitMadeByOpenTurn(inputs({ ownCommits: ['helper', 'fix'], attested: ['helper'], start: 'helper' }))).toBe('helper');
    // …but only an own commit.
    expect(commitMadeByOpenTurn(inputs({ ownCommits: ['helper'], attested: ['stranger'], start: 'helper' }))).toBeNull();
  });

  it('a commit made after the prompt started counts even when the start is not its ancestor', () => {
    // Codex: the commit lands before the heartbeat notices the prompt.
    expect(commitMadeByOpenTurn(inputs({ ownCommits: ['fix'], start: null, promptStartedAt: 2500 }))).toBe('fix');
    // …but never one the turn's start already contains.
    expect(commitMadeByOpenTurn(inputs({ ownCommits: ['helper'], start: 'fix', promptStartedAt: 1500 }))).toBeNull();
  });
});
