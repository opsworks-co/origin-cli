/**
 * A turn that ends in an API error or an interrupt fires no Stop. Prod vodka
 * a219d616: turn 2 died on ECONNRESET, stayed "open", and the retry's eight
 * files and its commit were filed under it. The transcript says which turns
 * died; this reads it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openTurnLiveness } from '../turn-liveness.js';

const T0 = Date.parse('2026-09-03T14:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const user = (s: number, text: string) => JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'text', text }] } });
const toolUse = (s: number, id: string) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const toolResult = (s: number, id: string) => JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const text = (s: number, t: string) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const apiError = (s: number) => JSON.stringify({ type: 'assistant', timestamp: at(s), isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection dropped (ECONNRESET)' }] } });
const sysError = (s: number) => JSON.stringify({ type: 'system', subtype: 'api_error', timestamp: at(s), content: '' });

function transcript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-liveness-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('openTurnLiveness', () => {
  it('a turn whose last word was an API error is dead', () => {
    const p = transcript([user(0, 'Try again'), toolUse(5, 'a'), toolResult(6, 'a'), apiError(30)]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 40_000 })).toBe('dead');
  });

  it('a system api_error entry counts the same', () => {
    const p = transcript([user(0, 'go'), toolUse(5, 'a'), toolResult(6, 'a'), sysError(30), sysError(31)]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 40_000 })).toBe('dead');
  });

  it('an interrupt ends the turn', () => {
    const p = transcript([user(0, 'go'), toolUse(5, 'a'), toolResult(6, 'a'), user(10, '[Request interrupted by user]')]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 12_000 })).toBe('dead');
  });

  it('a running tool keeps the turn alive — the queued-prompt case', () => {
    const p = transcript([user(0, 'long task'), toolUse(5, 'a'), user(7, 'queued prompt')]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 8_000 })).toBe('alive');
  });

  it('recent activity with no error keeps it alive', () => {
    const p = transcript([user(0, 'go'), toolUse(5, 'a'), toolResult(6, 'a'), text(7, 'working…')]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 20_000 })).toBe('alive');
  });

  it('a turn silent for longer than the idle window is dead — a Stop that never came', () => {
    const p = transcript([user(0, 'go'), toolUse(5, 'a'), toolResult(6, 'a'), text(7, 'done')]);
    expect(openTurnLiveness(p, at(1), { now: T0 + 7_000 + 121_000 })).toBe('dead');
  });

  it('an earlier turn\'s error does not condemn the open one', () => {
    // Turn 1 died at 30s; turn 2 opened at 60s and is mid-tool.
    const p = transcript([user(0, 'a'), apiError(30), user(60, 'b'), toolUse(65, 'x')]);
    expect(openTurnLiveness(p, at(60), { now: T0 + 70_000 })).toBe('alive');
  });

  it('is unknown without a transcript', () => {
    expect(openTurnLiveness(null, at(0))).toBe('unknown');
    expect(openTurnLiveness('/nonexistent/x.jsonl', at(0))).toBe('unknown');
  });
});
