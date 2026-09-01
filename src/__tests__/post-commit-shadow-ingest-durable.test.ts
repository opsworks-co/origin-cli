// The post-commit SHADOW INGEST must survive a failed attempt.
//
// #1247 awaited the call; #1250 gave it COMMIT_INGEST_TIMEOUT_MS (30s) instead
// of api.ts's 8s default. Neither makes the send reliable on its own: the same
// endpoint answered in 15.2s and in 33.5s minutes apart on a box at 0% idle
// CPU. When it does fail, the payload must be queued, not logged and dropped.
//
// That call is the only producer of `Commit.patch` and of per-commit
// `additions`/`deletions`. It inherited api.ts's 8s hook default while the
// server writes the patch into SQLite — measured at ~15.2s for a 9.7KB single
// commit against prod on 2026-08-26. So every shadow ingest aborted, for
// hours, on every commit, and the log line said "(non-fatal)" while the
// payload was thrown away.
//
// The damage is entirely on the read side, which is why it went unnoticed:
//   • commit-detail finds no patch and falls back to `diffSource:'sessionDiff'`
//     — so every commit in a session renders the SAME aggregate (session
//     cb853c02: eight commits all showing 15 files / +972 / -109, while
//     d3ea037f is really 7 files / +444 / -80);
//   • UnifiedSessionView's amber "committed" chip is gated on the commit's
//     stats being non-null, so it silently disappears from every turn.
// Re-ingesting one commit by hand with a 60s timeout restored both.
//
// Source-level guard, same rationale as post-commit-durable-gitcapture.ts: the
// queue's behaviour is covered in update-queue.test.ts; what is not otherwise
// covered is that THIS call site keeps its timeout and its enqueue, and
// dropping either is a one-line edit no behavioural test here would catch.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CLI_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(CLI_SRC, 'commands', 'hooks.ts');

/** The shadow-ingest call plus its handlers, isolated from the rest of hooks.ts. */
function shadowIngestBlock(): string {
  const src = fs.readFileSync(HOOKS, 'utf-8');
  const start = src.indexOf('const ingestCommit = {');
  expect(
    start,
    'post-commit no longer builds `const ingestCommit` — retarget this test',
  ).toBeGreaterThan(-1);
  const end = src.indexOf("debugLog('post-commit', 'shadow ingest setup failed'", start);
  expect(
    end,
    'post-commit no longer logs "shadow ingest setup failed" — retarget this test',
  ).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('post-commit shadow ingest', () => {
  it('passes an explicit timeout — the 8s api.ts default aborts a patch upload', () => {
    expect(shadowIngestBlock()).toMatch(/\{\s*timeoutMs:\s*COMMIT_INGEST_TIMEOUT_MS\s*\}/);
  });

  it('enqueues the commit on a retriable failure instead of only logging it', () => {
    const block = shadowIngestBlock();
    expect(block).toContain('isRetriableApiError(err)');
    expect(block).toMatch(/enqueueFailedUpdate\(\s*'ingestCommits'/);
  });

  it('queues the patch and line counts, not just the sha', () => {
    // A retry that dropped `diff`/`additions`/`deletions` would re-create the
    // same patch-less row the fallback already produces.
    const block = shadowIngestBlock();
    expect(block).toContain('commits: [ingestCommit]');
    expect(block).toMatch(/diff:\s*diff\s*\?\s*diff\.slice/);
    expect(block).toContain('additions: linesAdded');
    expect(block).toContain('deletions: linesRemoved');
  });

  it('imports the queue helpers it now depends on', () => {
    const src = fs.readFileSync(HOOKS, 'utf-8');
    expect(src).toMatch(
      /import\s*\{[^}]*\benqueueFailedUpdate\b[^}]*\}\s*from\s*'\.\.\/update-queue\.js'/s,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bisRetriableApiError\b[^}]*\}\s*from\s*'\.\.\/update-queue\.js'/s,
    );
  });

  it('keeps COMMIT_INGEST_TIMEOUT_MS well above the 8s default that caused the loss', () => {
    const src = fs.readFileSync(path.join(CLI_SRC, 'history-backfill.ts'), 'utf-8');
    const m = src.match(/export const COMMIT_INGEST_TIMEOUT_MS\s*=\s*([0-9_]+)/);
    expect(m, 'COMMIT_INGEST_TIMEOUT_MS is gone from history-backfill.ts').toBeTruthy();
    expect(Number(m![1].replace(/_/g, ''))).toBeGreaterThanOrEqual(30_000);
  });
});
