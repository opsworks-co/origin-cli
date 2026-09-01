/**
 * A commit note must carry the tokens and cost of the session that made it.
 *
 * The note write used to omit both, reasoning that "this hook runs before the
 * transcript is parsed". The transcript is parsed in the SAME invocation, ~280
 * lines further down, for the session write — only the ORDER made the numbers
 * unknown. Every commit note in this repo therefore read `tokens: — cost: —`
 * while the session row it links to carried both, and `origin commit <sha>` —
 * the OFFLINE reader, used exactly where the session row is not reachable — was
 * the surface that lost them.
 *
 * Verified end-to-end before this guard was written, not just here: driving
 * `handlePostCommit` over a scratch repo with a synthetic transcript produced
 * `tokensUsed: 3200, costUsd: 0.6635` on the note, identical to the value the
 * session write logged for the same commit. The transcript deliberately
 * repeated one message id (Claude Code writes one JSONL row per content block,
 * re-stating `usage` on each); 3200 is the DEDUPED total — raw summing gives
 * 4300 — so the note goes through the parser's `seenMessageIds` collapse rather
 * than around it.
 *
 * This is a SOURCE guard, matching post-commit-ingest-durable.test.ts: driving
 * the hook for real needs git, fs, ~/.origin state and the API stood up, and
 * what is worth protecting here is the ordering, which a behavioural test would
 * assert through far more machinery.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const hooksSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts'),
  'utf-8',
);

/** The body of `handlePostCommit`, bounded by the next top-level export. */
const postCommitFn = (() => {
  const start = hooksSrc.indexOf('export async function handlePostCommit');
  expect(start, 'handlePostCommit is gone').toBeGreaterThan(-1);
  const after = hooksSrc.slice(start + 10);
  const next = after.search(/\nexport (?:async function|function|const) /);
  const fn = next === -1 ? after : after.slice(0, next);
  // Guards the slice itself: an anchor that stops matching would otherwise
  // make every assertion below pass against an empty string.
  expect(fn).toContain('let noteMetrics:');
  expect(fn).toContain('api.ingestCommits({');
  return fn;
})();

const noteCall = (() => {
  const start = hooksSrc.indexOf('writeGitNotes(repoPath, [commitSha], {');
  expect(start, 'post-commit no longer calls writeGitNotes(repoPath, [commitSha], …)').toBeGreaterThan(-1);
  return hooksSrc.slice(start, start + 4000);
})();

describe('post-commit note telemetry', () => {
  it('sends tokens and cost on the note', () => {
    expect(noteCall).toContain('tokensUsed: noteMetrics.tokensUsed');
    expect(noteCall).toContain('costUsd: noteMetrics.costUsd');
  });

  it('measures them BEFORE the note is written', () => {
    // The whole defect was ordering: the values existed, 280 lines too late.
    const hoist = hooksSrc.indexOf('let noteMetrics:');
    const write = hooksSrc.indexOf('writeGitNotes(repoPath, [commitSha], {');
    expect(hoist, 'the telemetry hoist is gone').toBeGreaterThan(-1);
    expect(hoist).toBeLessThan(write);
  });

  it('omits them rather than reporting zero when there is nothing to measure', () => {
    // A zero reads as a measurement — the exact false claim ("this real session
    // spent nothing") that made these fields optional in the first place.
    const block = hooksSrc.slice(hooksSrc.indexOf('let noteMetrics:'), hooksSrc.indexOf('writeGitNotes(repoPath, [commitSha], {'));
    expect(block).toContain('> 0 ?');
    expect(block).toContain(': undefined');
  });

  it('does not buy the numbers with a second transcript parse', () => {
    // parseTranscript walks the whole JSONL. Doing it twice per commit is a
    // real cost regression on a long session, so the session write must consume
    // the hoisted result instead of re-parsing.
    expect(hooksSrc).toContain('const parsed = parsedForSessionWrite');

    // Scoped to handlePostCommit — the stop and session-end hooks parse too,
    // and a file-wide count would just be measuring those.
    const parses = postCommitFn.match(/parseTranscript\(state\.transcriptPath, \{/g) || [];
    // One in the hoist, one as the session write's fallback for when the hoist
    // was skipped or threw. A third would mean an unconditional double walk.
    expect(parses.length).toBeLessThanOrEqual(2);
  });

  it('skips the parse for agents that never reach the session write', () => {
    // `detected-*` / `devin-*` sessions are excluded from the session write
    // below, so parsing for them would be pure added latency in a git hook.
    const block = hooksSrc.slice(hooksSrc.indexOf('let noteMetrics:'), hooksSrc.indexOf('writeGitNotes(repoPath, [commitSha], {'));
    expect(block).toContain("startsWith('detected-')");
    expect(block).toContain("startsWith('devin-')");
  });
});
