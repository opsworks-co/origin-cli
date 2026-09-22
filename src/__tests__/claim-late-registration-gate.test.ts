/**
 * The gate around the claim, which had no test at all.
 *
 * Review of #1762: the stated safety property — "only run on a LATE attach" —
 * lived as an `if` wrapped around a call in the middle of a 2000-line hook.
 * Deleting that `if` would have let the walk run on every fresh session's
 * first prompt, and no test in the repo would have gone red. A property
 * nothing can fail is not a property.
 *
 * So the gate, the file-evidence requirement and the bookkeeping moved into
 * `applyLateRegistrationClaim`, and this file mutates each of them. The last
 * case reads the hook's source: an extracted function is only the gate if the
 * hook actually goes through it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyLateRegistrationClaim, gitCallTimeoutMs, MIN_GIT_CALL_TIMEOUT_MS } from '../claim-commits-made-before-registration.js';

const SESSION = 'd74b8927-38a2-4e84-96af-f6605c94599f';
const SHA = 'a'.repeat(40);
const EDITED = ['src/thing.ts'];

/** A stand-in walk that always finds something, so every case below is about
 *  the gate rather than about the walk declining on its own. */
const alwaysClaims = () => [SHA];

const state = (over: Record<string, any> = {}) => ({
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  sessionCommitShas: [] as string[],
  ...over,
});

describe('the late-attach gate', () => {
  it('runs the walk when the conversation already had turns', () => {
    const s = state();
    const claimed = applyLateRegistrationClaim(
      '/repo', s, SESSION, { isLateAttach: true, editedFiles: EDITED }, alwaysClaims as any,
    );
    expect(claimed).toEqual([SHA]);
  });

  it('does NOT run the walk on a session whose first prompt is its first prompt', () => {
    // No blind window to repair. Running the walk here would be nothing but an
    // opportunity to take something.
    let ran = false;
    const claimed = applyLateRegistrationClaim(
      '/repo', state(), SESSION, { isLateAttach: false, editedFiles: EDITED },
      ((...args: any[]) => { ran = true; return [SHA]; }) as any,
    );
    expect(ran).toBe(false);
    expect(claimed).toEqual([]);
  });

  it('says WHY when it declines for want of file evidence', () => {
    // The commonest reason is not "there was nothing to claim": a turn that
    // wrote through the shell records no `filesChanged` at all. Declining
    // silently makes that indistinguishable from the feature working.
    let told = 0;
    applyLateRegistrationClaim(
      '/repo', state(), SESSION,
      { isLateAttach: true, editedFiles: [], onNoEvidence: () => { told++; } },
      alwaysClaims as any,
    );
    expect(told).toBe(1);
  });

  it('does NOT run the walk when the transcript recorded no edits', () => {
    let ran = false;
    const claimed = applyLateRegistrationClaim(
      '/repo', state(), SESSION, { isLateAttach: true, editedFiles: [] },
      ((...args: any[]) => { ran = true; return [SHA]; }) as any,
    );
    expect(ran).toBe(false);
    expect(claimed).toEqual([]);
  });

  it('passes the edited files through to the walk', () => {
    let seen: ReadonlyArray<string> | undefined;
    applyLateRegistrationClaim(
      '/repo', state(), SESSION, { isLateAttach: true, editedFiles: EDITED },
      ((_cwd: string, _s: any, _id: string, files: ReadonlyArray<string>) => { seen = files; return []; }) as any,
    );
    expect(seen).toEqual(EDITED);
  });
});

describe('what the gate records', () => {
  it('appends to sessionCommitShas rather than replacing them', () => {
    const existing = 'b'.repeat(40);
    const s = state({ sessionCommitShas: [existing] });
    applyLateRegistrationClaim('/repo', s, SESSION, { isLateAttach: true, editedFiles: EDITED }, alwaysClaims as any);
    expect(s.sessionCommitShas).toEqual([existing, SHA]);
  });

  it('leaves the state untouched when nothing was claimed', () => {
    const s = state();
    applyLateRegistrationClaim('/repo', s, SESSION, { isLateAttach: true, editedFiles: EDITED }, (() => []) as any);
    expect(s.sessionCommitShas).toEqual([]);
  });

  it('swallows a throwing walk — the rescue rungs still get their chance', () => {
    const s = state();
    expect(() => applyLateRegistrationClaim(
      '/repo', s, SESSION, { isLateAttach: true, editedFiles: EDITED },
      (() => { throw new Error('git exploded'); }) as any,
    )).not.toThrow();
    expect(s.sessionCommitShas).toEqual([]);
  });
});

describe('one git call may not outlive the walk it belongs to', () => {
  it('gives a call what is left of the budget, never a flat ceiling', () => {
    // 2s budget, 1.5s already spent → 500ms left, not another 30s.
    expect(gitCallTimeoutMs(10_000, 9_500)).toBe(500);
    expect(gitCallTimeoutMs(10_000, 2_000)).toBe(8_000);
  });

  it('never kills a call on arrival, however spent the budget', () => {
    expect(gitCallTimeoutMs(10_000, 10_000)).toBe(MIN_GIT_CALL_TIMEOUT_MS);
    expect(gitCallTimeoutMs(10_000, 99_999)).toBe(MIN_GIT_CALL_TIMEOUT_MS);
  });
});

describe('the hook goes through the gate', () => {
  // An extracted gate proves nothing if the hook still calls the walk
  // directly. This reads the source, the way `reattach-carries-index-base`
  // reads the state literal, because there is no cheaper way to pin a wiring.
  const hookSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks', 'user-prompt-submit.ts'),
    'utf-8',
  );

  it('calls applyLateRegistrationClaim', () => {
    expect(hookSrc).toContain('applyLateRegistrationClaim(');
  });

  it('never calls the raw walk, which would bypass the gate', () => {
    expect(hookSrc).not.toContain('claimCommitsMadeBeforeRegistration(');
  });

  it('the walk\'s own git calls take their timeout from the budget', () => {
    // The arithmetic is unit-tested above, but nothing proves the runner USES
    // it — and a flat `timeout: 30_000` would pass every behavioural test in
    // this suite while restoring the two-minute worst case.
    const walkSrc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claim-commits-made-before-registration.ts'),
      'utf-8',
    );
    expect(walkSrc).toMatch(/timeout:\s*remaining/);
    expect(walkSrc).toMatch(/const remaining = gitCallTimeoutMs\(deadline\)/);
  });

  it('feeds it real transcript evidence, not an empty list', () => {
    // `editedFiles: []` would disable claiming everywhere and make the whole
    // feature silently dead — the kind of change that passes every other test.
    expect(hookSrc).toMatch(/extractPromptFileMappings\([\s\S]{0,400}filesChanged/);
  });

  it('scopes that evidence to the claim window', () => {
    // Unscoped, the mappings span the WHOLE transcript — days, on a resumed
    // conversation — while the claim floor collapses to `now - maxAge`.
    // Yesterday's edit to a file would then vouch for a commit somebody made
    // to that file this morning: the over-claim the file gate exists to stop,
    // wearing the gate's own evidence.
    expect(hookSrc).toMatch(/since: new Date\(Date\.now\(\) - DEFAULT_CLAIM_MAX_AGE_MS\)/);
  });
});
