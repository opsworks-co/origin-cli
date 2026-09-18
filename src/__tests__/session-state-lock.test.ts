import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STATE_LOCK_WAIT_MS, withSessionStateLock } from '../session-state-lock.js';

const roots: string[] = [];
const statePath = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-state-lock-'));
  roots.push(dir);
  return path.join(dir, 'session.json');
};
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it('a competing write waits out its whole budget rather than joining a live owner', () => {
  const file = statePath();
  let ran = false;
  withSessionStateLock(file, () => {
    const began = Date.now();
    withSessionStateLock(file, () => { ran = true; }, 60);
    // It could not take the lock — it waited the full 60ms first.
    expect(Date.now() - began).toBeGreaterThanOrEqual(50);
    expect(ran).toBe(true);
  });
});

// The policy claude-hook-lock.ts states and this lock now follows: "a rare
// lost update on state is recoverable, a killed hook is not". Throwing here
// took the prompt with it — user-prompt-submit read the throw as a failed
// registration and filed the prompt under a `local-` id the server 404s.
it('never throws on timeout: it saves without the lock and says so', () => {
  const file = statePath();
  withSessionStateLock(file, () => {
    expect(withSessionStateLock(file, () => 'saved anyway', 20)).toBe('saved anyway');
  });
  const log = (() => { try { return fs.readFileSync(path.join(os.homedir(), '.origin', 'hooks.log'), 'utf-8'); } catch { return ''; } })();
  expect(log).toContain('saving without the state lock');
});

// Codex's SessionStart and UserPromptSubmit are installed with `timeout: 10`
// (commands/enable.ts) and Codex KILLS a hook at its timeout; on Claude,
// withClaudeHookLock may already have spent 20s before the save. The default
// has to leave room for both.
it('waits well inside the hook budget it shares', () => {
  expect(STATE_LOCK_WAIT_MS).toBeLessThanOrEqual(5_000);
  expect(20_000 + STATE_LOCK_WAIT_MS).toBeLessThan(60_000);
});

it('releases after a failed write so the next hook can save', () => {
  const file = statePath();
  expect(() => withSessionStateLock(file, () => { throw new Error('write failed'); })).toThrow('write failed');
  expect(withSessionStateLock(file, () => 'saved', 10)).toBe('saved');
});

it('does not serialize independent session files', () => {
  const first = statePath(), second = statePath();
  const began = Date.now();
  expect(withSessionStateLock(first, () => withSessionStateLock(second, () => 'saved', 1_000))).toBe('saved');
  expect(Date.now() - began).toBeLessThan(500);
});

// The lock lives under `~/.origin`; the state file it guards does not. An
// unwritable home used to fail a save outright with
// `EACCES … mkdir …/state-locks` — a save that succeeds on main, into a
// perfectly writable `.git`, lost to the lock's own bookkeeping.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unwritable home', () => {
  it('still saves — the lock degrades to unlocked, it does not fail the write', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-locked-home-'));
    roots.push(home);
    const realHome = process.env.HOME;
    fs.chmodSync(home, 0o500);
    try {
      process.env.HOME = home;
      expect(os.homedir()).toBe(home);
      expect(withSessionStateLock(statePath(), () => 'saved')).toBe('saved');
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      fs.chmodSync(home, 0o700);
    }
  });
});
