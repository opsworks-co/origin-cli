// TODO 3e663e79: the heartbeat wrote the session state file back from an
// OLDER read — unlocked, in place — erasing fields a hook saved in between.
// Its three writers (budget flags, policy rules, Codex prompt mirror) now go
// through patchSessionStateFile: read inside the hooks' lock, change only
// their own fields, rename into place.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { patchSessionStateFile, withSessionStateLock } from '../session-state-lock.js';
import { TransientFsRetryExhaustedError } from '../transient-fs.js';

let dir: string;
let file: string;
let home: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-patch-'));
  file = path.join(dir, 'origin-session.json');
  home = process.env.HOME;
  process.env.HOME = dir; // lock root under ~/.origin — keep it in the sandbox
  fs.writeFileSync(file, JSON.stringify({ sessionId: 's1', prompts: ['a'] }));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = home;
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(fs.readFileSync(file, 'utf-8'));

describe('patchSessionStateFile', () => {
  it('keeps a field a hook saved AFTER the heartbeat first read the file', () => {
    const heartbeatsEarlyRead = read(); // what the old code would write back
    // A hook saves while the heartbeat is busy (shadow commits, a ping).
    fs.writeFileSync(file, JSON.stringify({ ...read(), lastClosedTurnIndex: 3, budgetBlockReported: true }));

    patchSessionStateFile(file, (s) => { s.enforcementRulesFetchedAt = 123; return true; });

    const after = read();
    expect(after.lastClosedTurnIndex, 'the hook\'s save was erased').toBe(3);
    expect(after.budgetBlockReported).toBe(true);
    expect(after.enforcementRulesFetchedAt).toBe(123);
    expect(heartbeatsEarlyRead.lastClosedTurnIndex).toBeUndefined();
  });

  it('writes nothing when the patch declines', () => {
    const before = fs.readFileSync(file, 'utf-8');
    const wrote = patchSessionStateFile(file, () => false);
    expect(wrote).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('leaves no temp file behind and the result is whole JSON', () => {
    patchSessionStateFile(file, (s) => { s.x = 'y'.repeat(10_000); return true; });
    expect(read().x.length).toBe(10_000);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('retries a transient Windows refusal while replacing the state file', () => {
    const realRename = fs.renameSync.bind(fs);
    let refusals = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (to === file && refusals++ < 2) throw Object.assign(new Error('held by reader'), { code: 'EPERM' });
      return realRename(from, to);
    }) as any);

    expect(patchSessionStateFile(file, (s) => { s.patched = true; return true; })).toBe(true);
    expect(read().patched).toBe(true);
    expect(refusals).toBe(3);
  });

  it('retries a transient Windows refusal while reading the state file', () => {
    const realRead = fs.readFileSync.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: any, ...args: any[]) => {
      if (target === file && attempts++ < 2) throw Object.assign(new Error('held by reader'), { code: 'EBUSY' });
      return (realRead as any)(target, ...args);
    }) as any);

    expect(patchSessionStateFile(file, (s) => { s.patched = true; return true; })).toBe(true);
    expect(attempts).toBe(3);
  });

  it('propagates read contention that outlasts the retry budget', () => {
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: any, ...args: any[]) => {
      if (target === file) throw Object.assign(new Error('file remains held'), { code: 'EACCES' });
      return (realRead as any)(target, ...args);
    }) as any);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 600));

    expect(() => patchSessionStateFile(file, () => true)).toThrow(TransientFsRetryExhaustedError);
  });

  it('removes its temp file when replacement contention outlasts the retry budget', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('target remains held'), { code: 'EPERM' });
    });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 600));

    expect(() => patchSessionStateFile(file, (s) => { s.patched = true; return true; }))
      .toThrow(TransientFsRetryExhaustedError);
    expect(fs.existsSync(`${file}.tmp.${process.pid}`)).toBe(false);
  });

  it('runs inside the same lock the hooks take', () => {
    // A save queued behind the heartbeat's patch must see the patched file.
    let seenInside: unknown;
    patchSessionStateFile(file, (s) => {
      s.fromHeartbeat = true;
      return true;
    });
    withSessionStateLock(file, () => { seenInside = read().fromHeartbeat; });
    expect(seenInside).toBe(true);
  });

  it('throws on a missing file so the caller\'s catch handles it', () => {
    fs.rmSync(file);
    expect(() => patchSessionStateFile(file, () => true)).toThrow();
  });
});

describe('heartbeat.ts', () => {
  it('never writes the session state file directly — only through patchSessionStateFile', () => {
    // The heartbeat is a detached daemon with no in-process harness, so its
    // wiring is pinned at the source: a direct write of `stateFile` is exactly
    // the unlocked write-back this TODO removed.
    const src = fs.readFileSync(path.join(__dirname, '..', 'heartbeat.ts'), 'utf-8');
    expect(src.match(/writeFileSync\(\s*stateFile\b/g) ?? []).toEqual([]);
    expect((src.match(/patchSessionStateFile\(stateFile/g) ?? []).length).toBe(3);
  });
});
