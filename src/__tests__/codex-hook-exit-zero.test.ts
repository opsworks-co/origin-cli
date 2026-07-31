// FIX 1 — Codex capture hooks must ALWAYS exit 0.
//
// Codex reads our stdout for context injection but treats a NON-ZERO exit as a
// FAILED hook and paints a red "SessionStart hook (failed) / hook exited with
// code 1" on the user's turn — even when capture SUCCEEDED. Capture is
// best-effort and must never fail or decorate the user's turn with an error.
//
// hooksCommand(event, 'codex') therefore wraps the whole handler: any thrown
// error / rejected promise is caught, logged, and the process still ends with
// exitCode 0. Other agents keep their exact exit semantics (a thrown error
// propagates) so nothing else changes.
//
// We force a deterministic failure by making the FIRST thing the handler does
// (ensureSqlite) reject. That happens before readStdin(), so the handler blows
// up early regardless of payload.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/sqlite.js', async (orig) => {
  const actual = await orig<typeof import('../utils/sqlite.js')>();
  return {
    ...actual,
    ensureSqlite: vi.fn(async () => { throw new Error('boom — simulated early hook failure'); }),
  };
});

import { hooksCommand } from '../commands/hooks.js';

describe('FIX 1 — codex hooks always exit 0', () => {
  let baseUnhandled: Function[];
  let baseUncaught: Function[];

  beforeEach(() => {
    // Snapshot global listeners so we can strip the ones the codex guard adds.
    baseUnhandled = process.listeners('unhandledRejection');
    baseUncaught = process.listeners('uncaughtException');
    process.exitCode = 1; // prove the codex path resets it to 0
  });

  afterEach(() => {
    for (const l of process.listeners('unhandledRejection')) {
      if (!baseUnhandled.includes(l)) process.removeListener('unhandledRejection', l as any);
    }
    for (const l of process.listeners('uncaughtException')) {
      if (!baseUncaught.includes(l)) process.removeListener('uncaughtException', l as any);
    }
    process.exitCode = 0;
  });

  it('swallows a thrown error and forces exitCode 0 for codex', async () => {
    // Must NOT reject even though the handler threw internally.
    await expect(hooksCommand('session-start', 'codex')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('does the same for the other codex lifecycle events (user-prompt-submit, stop)', async () => {
    process.exitCode = 1;
    await expect(hooksCommand('user-prompt-submit', 'codex')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
    process.exitCode = 1;
    await expect(hooksCommand('stop', 'codex')).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('does NOT change exit semantics for other agents — the error still propagates', async () => {
    // A non-codex agent must keep failing loudly (unchanged behavior); only
    // codex is special-cased to never surface as a failed hook.
    await expect(hooksCommand('session-start', 'cursor')).rejects.toThrow(/boom/);
  });
});
