/**
 * A Codex turn whose Stop never fired (an errored turn) is found from the
 * rollout, and only once Codex's own Stop timeout has passed (TODO 6d70bb43).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CODEX_MISSED_STOP_GRACE_MS, codexTurnMissingItsStop } from '../codex-missed-stop.js';
import { CODEX_STOP_HOOK_TIMEOUT_SEC } from '../commands/enable.js';
import { parseCodexRolloutLive } from '../agents/codex.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const base = {
  lastTurnEnd: { at: NOW - 12 * 60_000, promptCount: 3 },
  rolloutPrompts: 3, statePrompts: 3, lastClosedTurnIndex: 1, now: NOW, alreadyRan: new Set<number>(),
};

describe('codexTurnMissingItsStop', () => {
  it('waits out Codex\'s Stop timeout, so a slow real Stop is never doubled', () => {
    expect(CODEX_MISSED_STOP_GRACE_MS).toBeGreaterThan(CODEX_STOP_HOOK_TIMEOUT_SEC * 1000);
    expect(codexTurnMissingItsStop({ ...base, lastTurnEnd: { at: NOW - 60_000, promptCount: 3 } })).toBeNull();
  });

  it('names the last turn when it ended long ago and is still open', () => {
    expect(codexTurnMissingItsStop(base)).toBe(2);
  });

  it('leaves a turn its Stop already closed', () => {
    expect(codexTurnMissingItsStop({ ...base, lastClosedTurnIndex: 2 })).toBeNull();
  });

  it('leaves it when a newer prompt is running — that prompt\'s Stop re-derives every turn', () => {
    expect(codexTurnMissingItsStop({ ...base, rolloutPrompts: 4, statePrompts: 4 })).toBeNull();
  });

  it('runs once per turn', () => {
    expect(codexTurnMissingItsStop({ ...base, alreadyRan: new Set([2]) })).toBeNull();
  });

  it('does nothing without an end', () => {
    expect(codexTurnMissingItsStop({ ...base, lastTurnEnd: undefined })).toBeNull();
  });
});

describe('parseCodexRolloutLive — lastTurnEnd', () => {
  const write = (entries: object[]) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-end-')), 'rollout.jsonl');
    fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return f;
  };
  const user = (text: string, t: string) => ({ timestamp: t, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const done = (t: string, error?: object) => ({ timestamp: t, type: 'event_msg', payload: { type: 'task_complete', ...(error && { error }) } });

  it('reports the end of the last turn, errored or not', () => {
    const parsed = parseCodexRolloutLive(write([
      user('first', '2026-09-28T10:00:00Z'), done('2026-09-28T10:01:00Z'),
      user('second', '2026-09-28T10:02:00Z'), done('2026-09-28T10:03:00Z', { message: "You've hit your usage limit." }),
    ]))!;
    expect(parsed.lastTurnEnd).toEqual({ at: Date.parse('2026-09-28T10:03:00Z'), promptCount: 2, errored: true });
  });

  it('reports none while the last prompt is still running', () => {
    const parsed = parseCodexRolloutLive(write([
      user('first', '2026-09-28T10:00:00Z'), done('2026-09-28T10:01:00Z'),
      user('second', '2026-09-28T10:02:00Z'),
    ]))!;
    expect(parsed.lastTurnEnd).toBeUndefined();
  });
});
