/**
 * The post-commit ingest must not be fire-and-forget.
 *
 * `handlePostCommit` sent the commit — sha, message, files, line counts and the
 * per-commit patch — and returned without awaiting the request. The hook
 * process could then exit, or the API could restart under a deploy, before it
 * landed. The commit still reached Origin, but only via the server's discovery
 * sweep, which knows the sha and nothing else: the row stored `patch: null,
 * additions: null`, and every read surface fell back to guesses.
 *
 * Measured on prod: 20 of 46 commits in one 6-hour window had no patch, across
 * every session running at the time, all of them during a burst of
 * commit-then-deploy cycles — each deploy restarting the API mid-request.
 * `extractCommitDiff` returns a real diff for each of those shas today, so the
 * data was always there; it just never arrived.
 *
 * This is a SOURCE guard, deliberately. Driving handlePostCommit for real needs
 * the whole hook harness (git, fs, env, api) stood up, and the thing worth
 * protecting is one word. A behavioural test would assert the same word through
 * far more machinery.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const hooksSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts'),
  'utf-8',
);

describe('post-commit commit ingest', () => {
  it('is awaited, so the hook cannot exit before the commit lands', () => {
    // The live per-commit send. Backfill batches go through
    // `ingest: (data) => api.ingestCommits(...)`, which is a different shape.
    const direct = hooksSrc.match(/^\s*(?:await\s+)?api\.ingestCommits\(\{/gm) || [];

    expect(direct.length).toBeGreaterThan(0);
    for (const call of direct) expect(call).toContain('await');
  });

  it('gives the live ingest a timeout sized for a payload carrying a patch', () => {
    // The shared 8s default is sized for "tiny live calls" inside agent hooks.
    // This one carries up to 500KB of patch and runs under git, which imposes
    // no budget. Both prod aborts were this timeout firing while a deploy was
    // restarting the API — exactly when the commit still needs to arrive.
    const block = hooksSrc.slice(hooksSrc.indexOf('await api.ingestCommits({'));

    expect(block.slice(0, 1400)).toContain('COMMIT_INGEST_TIMEOUT_MS');
  });

  it('still sends the patch and the line counts', () => {
    // Without these the server can only store the sha: `patch: null,
    // additions: null` is exactly what the discovery sweep produces.
    //
    // Anchored on `const ingestCommit` rather than the call: the payload was
    // hoisted out of the call site so the durable-retry path can re-send the
    // same object. Same fields, one scope up.
    const start = hooksSrc.indexOf('const ingestCommit = {');
    expect(start, 'post-commit no longer builds `const ingestCommit`').toBeGreaterThan(-1);
    const block = hooksSrc.slice(start, hooksSrc.indexOf('api.ingestCommits({', start));

    expect(block).toContain('additions: linesAdded');
    expect(block).toContain('deletions: linesRemoved');
    expect(block).toContain('diff: diff');
  });
});
