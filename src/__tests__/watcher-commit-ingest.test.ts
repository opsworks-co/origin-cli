/**
 * A commit made by an agent that fires no hooks had no way to reach the server.
 *
 * `/commits/ingest` was called from the post-commit HOOK only. For Antigravity
 * — the whole reason the watcher exists — no hook ever fires, so the commit
 * existed server-side purely as the reconstruction built from per-prompt
 * captures. That reconstruction leaves `additions`/`deletions`/`patch` null ON
 * PURPOSE (a turn's scoped counts are not the commit's) and expects a real
 * payload to arrive later and fill them. For these agents it never arrived.
 *
 * Session 4aa080fa, commit c3a29ffe: git says +239/-0 across one file with the
 * subject "feat: add Enterprise Quantum Spaghetti Engine (shitty_code.py)".
 * Origin stored `additions: null, deletions: null, message: ''` — no "commit
 * total" chip, and "subject not captured".
 */
import { describe, it, expect } from 'vitest';
import { pendingCommitIngests } from '../transcript-watch.js';

describe('pendingCommitIngests', () => {
  it('sends a commit the session owns and has not sent yet', () => {
    expect(pendingCommitIngests(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('never re-sends one already delivered', () => {
    expect(pendingCommitIngests(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(pendingCommitIngests(['a'], ['a'])).toEqual([]);
  });

  it('only ever offers commits the session OWNS', () => {
    // sessionCommitShas is ownership (#1306). A commit outside it belongs to
    // another session and must not be ingested under this one — there is no
    // input to this function that can produce one.
    expect(pendingCommitIngests([], ['x'])).toEqual([]);
    expect(pendingCommitIngests(undefined, undefined)).toEqual([]);
  });

  it('bounds one poll, leaving the rest for the next', () => {
    const many = Array.from({ length: 12 }, (_, i) => `sha${i}`);
    const first = pendingCommitIngests(many, [], 5);
    expect(first).toHaveLength(5);
    // The remainder is not dropped — it is still pending once the first land.
    expect(pendingCommitIngests(many, first, 5)).toEqual(['sha5', 'sha6', 'sha7', 'sha8', 'sha9']);
  });

  it('a failed send stays pending rather than being marked done', () => {
    // The reconcile loop pushes to `ingestedCommitShas` only after the call
    // resolves, so a throw leaves the sha here on the next poll.
    const owned = ['a', 'b'];
    const deliveredSoFar: string[] = ['a']; // 'b' threw last time
    expect(pendingCommitIngests(owned, deliveredSoFar)).toEqual(['b']);
  });
});
