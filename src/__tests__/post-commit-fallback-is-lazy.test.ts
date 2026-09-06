/**
 * post-commit paid for the fallback whether or not it used it.
 *
 * The session-to-date snapshot has two sources: the OWNED walk
 * (`sessionToDateCommittedSnapshot`), which is what the header should be, and
 * the raw `session-start..HEAD` capture, kept only as a fallback for a session
 * with no recorded shas — Codex bypasses `.git/hooks/post-commit` on some
 * installs, and a blank sessionDiff is worse than an inflated one.
 *
 * The fallback was computed FIRST, unconditionally, and discarded unlooked-at
 * whenever the owned walk answered — which is the normal case. It is not a
 * cheap thing to discard. `captureGitState` re-reads metadata for every commit
 * in the session range at five git spawns each (`log -1 %B`, `%an`, `%ct`,
 * `diff-tree --name-only`, `diff-tree --numstat`), then renders the range at
 * `--unified=2000`, re-running the whole diff up to three times as the byte
 * ladder steps down. Measured on this repo by calling it directly: 1.6s over a
 * 10-commit range, 4.0s over 30, 7.2s over 60 — on EVERY `git commit`, growing
 * for the length of the session, and post-commit runs before git returns, so it
 * is latency a person sits through.
 *
 * Nothing observable changes when the order is wrong, which is why this is a
 * source-order guard rather than a behaviour test: both orders produce the same
 * payload. Only the clock and the process table can tell them apart.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

const HOOKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts',
);

describe('post-commit computes the raw capture only when it needs it', () => {
  const src = hooksSource();
  const lines = src.split('\n');
  const lineOf = (re: RegExp) => lines.findIndex((l) => re.test(l));

  const ownedAt = lineOf(/owned = sessionToDateCommittedSnapshot\(hookCwd, state/);
  const captureAt = lineOf(/captureGitState\(hookCwd, state\.headShaAtStart, \{ fullContext: true \}\)/);

  it('still has both the owned walk and the raw fallback', () => {
    expect(ownedAt).toBeGreaterThan(-1);
    expect(captureAt).toBeGreaterThan(-1);
  });

  it('asks the owned walk before it builds the fallback', () => {
    expect(ownedAt).toBeLessThan(captureAt);
  });

  it('guards the fallback on the owned walk having come back unscoped', () => {
    // Within the handful of lines above the capture, so a future edit that
    // hoists it out of the guard fails here rather than silently costing ~2s a
    // commit again.
    const preamble = lines.slice(Math.max(0, captureAt - 3), captureAt).join('\n');
    expect(preamble).toMatch(/if \(!owned\.scoped\)/);
  });

  it('keeps the empty-range gate off the expensive path', () => {
    // The old `if (snap.committedDiff)` gate needed the capture to exist. Its
    // replacement must not: a `--name-only` range check is what decides
    // whether a snapshot is sent at all.
    const gateAt = lineOf(/rangeHasContent = !!execFileSync\(/);
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(ownedAt);
    expect(lines.slice(gateAt, gateAt + 3).join('\n')).toMatch(/'--name-only'/);
  });
});
