/**
 * The ledger must replace a turn's capture BEFORE the payload is built.
 *
 * It did not. `applyLedgerCaptures` sat ~300 lines below `stopUpdatePayload`,
 * so on every Stop the server received the legacy reconstruction and only the
 * local state file ever saw the ledger's answer — the whole of stage 2 was
 * inert on the path that actually fires.
 *
 * Nothing failed. Every unit test passed, because they call the applier
 * directly; the ORDER of two statements in a 17,000-line function is not
 * something a unit test can see. It was found by taking the first real session
 * captured on this build and comparing its stored row against what the ledger
 * produces for the same turn — 5 files versus 4, and `diffSource` null on every
 * row.
 *
 * A source-order guard, in the same shape as path-comparison-guard.test.ts,
 * because the failure is positional and invisible to behaviour tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hooksSource } from './helpers/hooks-source.js';

const HOOKS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'hooks.ts',
);

describe('ledger ordering in handleStop', () => {
  const src = hooksSource();

  it('applies the ledger before the stop payload is constructed', () => {
    const applied = src.indexOf('applyLedgerCaptures(state, promptMappings');
    const payload = src.indexOf('const stopUpdatePayload = {');
    expect(applied, 'applyLedgerCaptures call not found — update this guard').toBeGreaterThan(-1);
    expect(payload, 'stopUpdatePayload not found — update this guard').toBeGreaterThan(-1);
    expect(
      applied,
      'applyLedgerCaptures runs AFTER stopUpdatePayload is built, so the payload '
      + 'the server receives is the legacy reconstruction and the ledger is inert.',
    ).toBeLessThan(payload);
  });

  it('applies the ledger before the state round-trip too', () => {
    // The heartbeat re-sends from completedPromptMappings, so a ledger answer
    // that lands after this write is lost to every later producer.
    const applied = src.indexOf('applyLedgerCaptures(state, promptMappings');
    const stateWrite = src.indexOf('state.completedPromptMappings = promptMappings.map');
    expect(stateWrite).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(stateWrite);
  });

  it('carries diffSource across the state round-trip', () => {
    // That pick is explicit: a field not listed is silently dropped, and losing
    // provenance lets the server's editsJson synthesis win back a row the
    // ledger had already answered for.
    const start = src.indexOf('state.completedPromptMappings = promptMappings.map');
    const pick = src.slice(start, start + 1600);
    expect(pick, 'diffSource is dropped on the state round-trip').toContain('diffSource');
  });
});
