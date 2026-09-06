// The post-commit hook's incremental PATCH must be DURABLE.
//
// That PATCH carries `gitCapture` — `commitShas` + `commitDetails` — and for a
// commit that never reaches a git host it is the ONLY producer of the Commit
// row. The webhook backfill cannot see an unpushed branch, and the stop hook's
// session-level gitCapture is a shadow-baseline reconstruction that ships
// `commitShas: []`. So if this one call is dropped, the sha survives only as
// the per-prompt stamp and the turn renders a "committed" badge that leads
// nowhere: no Commit row, no inline commit card, no commit diff, and nothing
// that can ever heal it — not a re-run, not a later stop, not a backfill.
//
// The regression: the send was a raw `api.updateSession` whose catch logged
// "API update error (non-fatal)" and threw the payload away. Session f4704142
// (Copilot, unpushed worktree branch) lost its commit exactly that way — the
// API stalled on a concurrent 2.3MB write, the fetch aborted, and the capture
// was gone. The stop hook's payload, which goes through durableUpdateSession,
// was queued and landed, which is why every per-turn number on that session is
// correct and only the commit is missing.
//
// update-queue.ts's own header already lists post-commit as a durable caller,
// and the handler already drains the queue — only the send was never converted.
//
// This is a source-level guard on purpose. The queue's behaviour is covered by
// update-queue.test.ts; what is NOT otherwise covered is that this particular
// call site keeps using it, and reverting it to `api.updateSession` is a
// one-word edit that no behavioural test in this package would catch.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

const HOOKS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'commands',
  'hooks.ts',
);

/** The post-commit incremental-update send, isolated from the rest of hooks.ts. */
function postCommitSendBlock(): string {
  const src = hooksSource();
  const start = src.indexOf("debugLog('post-commit', 'sending incremental update'");
  expect(
    start,
    'post-commit no longer logs "sending incremental update" — retarget this test',
  ).toBeGreaterThan(-1);
  const end = src.indexOf("debugLog('post-commit', 'API update complete'", start);
  expect(
    end,
    'post-commit no longer logs "API update complete" — retarget this test',
  ).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('post-commit sends its gitCapture durably', () => {
  it('routes the commit-carrying PATCH through durableUpdateSession', () => {
    expect(postCommitSendBlock()).toContain('durableUpdateSession(');
  });

  it('does not call api.updateSession directly (a failure there is unrecoverable)', () => {
    expect(postCommitSendBlock()).not.toMatch(/\bapi\.updateSession\s*\(/);
  });

  it('still sends gitCapture — the payload the Commit row is built from', () => {
    expect(postCommitSendBlock()).toContain('gitCapture');
  });

  it('imports durableUpdateSession from the queue module', () => {
    const src = hooksSource();
    expect(src).toMatch(
      /import\s*\{[^}]*\bdurableUpdateSession\b[^}]*\}\s*from\s*'\.\.\/update-queue\.js'/,
    );
  });
});
