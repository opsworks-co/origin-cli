// A re-attach renumbered a whole conversation back to row 0.
//
// The auto-create path in user-prompt-submit rebuilds `state` from an EXPLICIT
// field list when the active-session lookup misses. Every field absent from
// that list is silently reset — and `promptIndexBase` was absent. Prod
// f7881a6e held base 6; after the re-attach its next two turns were written
// onto rows 0 and 1, on top of turn one's real work and a chat-only question,
// while rows 6 and 7 received the same content again.
//
// That is also what undid a hand-repair of row 1 a day later. Not a heal, not
// the read-time commit anchoring — just this turn's diff landing on another
// turn's row, which is indistinguishable from a capture bug when you only look
// at the rendered page.
//
// The literal is unavoidably a list, so this test reads it: any field the
// re-attach must preserve is asserted by NAME against the source.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

const HOOKS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts',
);

/** The re-attach state literal, from `state = {` after the carry-over log. */
function reattachLiteral(): string {
  const src = hooksSource();
  const anchor = src.indexOf('auto-create re-attach — carrying prompt history');
  expect(anchor).toBeGreaterThan(-1);
  const start = src.indexOf('state = {', anchor);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n        };', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('the re-attach carries what identifies a turn', () => {
  const literal = reattachLiteral();

  // Losing any of these renumbers or re-mints turns, and the session starts
  // overwriting rows that belong to earlier turns.
  it.each([
    ['promptIndexBase', 'local→server offset; without it turn 0 writes to row 0'],
    ['promptTurnIds', 'every writer keys rows by turnId; a re-mint strands the row'],
    ['lastClosedTurnIndex', 'the next capture binds lastClosed + 1'],
    ['commitTurns', 'observed sha→turn evidence, positional-free'],
    ['completedPromptMappings', 'the prior turns\' captured work'],
    ['promptShadows', 'per-turn baselines'],
    ['sessionCommitShas', 'which commits are this session\'s'],
    ['rewrittenCommits', 'the (orphan → rewrite) pairs; without them the next Stop re-badges the originals'],
    ['headShaAtStart', 'the conversation\'s baseline, not today\'s HEAD'],
  ])('carries %s — %s', (field) => {
    expect(literal).toContain(`${field}: priorState?.${field}`);
  });

  it('looks the prior state up by conversation when the tag misses', () => {
    // Session 8a06aaf6 (2026-09-09): adopted from a worktree handshake, so its
    // file lived under the handshake's tag; the re-attach after an 11h gap
    // looked under the conversation's tag, found nothing, started empty.
    const src = hooksSource();
    const anchor = src.indexOf('auto-create re-attach — carrying prompt history');
    const window = src.slice(Math.max(0, anchor - 2500), anchor);
    expect(window).toContain('loadSessionState(repoPath, autoTag)');
    expect(window).toContain('findPriorStateForConversation(');
  });

  it('does NOT carry activeTurn', () => {
    // A turn left open by a missed close would survive as "still running" and
    // attest the next commit to a turn that ended long ago.
    expect(literal).not.toMatch(/^\s*activeTurn:/m);
  });
});
