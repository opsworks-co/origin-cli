// Logon persistence used to be a Scheduled Task. On a default Windows 11 box
// Defender's behavioral ML flags the `schtasks /Create /SC ONLOGON` command
// line itself as Trojan:Win32/Commando.A!ml and blocks it — so the task never
// existed, `origin enable` printed green anyway, and both watchers vanished at
// every reboot. (Observed: six detections over two weeks, zero Origin* tasks
// on the machine, watchers alive only because enable had just spawned them.)
//
// The replacement is a plain file in the Startup folder: no subprocess, no
// scheduler, nothing for a persistence heuristic to catch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execCalls: string[][] = [];
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      return Buffer.from('');
    },
  };
});

import {
  registerLogonAutoStart,
  unregisterLogonAutoStart,
  startupEntryPath,
  startupFolder,
} from '../utils/logon-autostart.js';

const ENTRY = 'C:\\npm\\node_modules\\@origin\\cli\\dist\\index.js';

describe('registerLogonAutoStart', () => {
  let home: string;
  let prevAppData: string | undefined;
  let prevPlatform: PropertyDescriptor | undefined;

  const asWindows = () =>
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  beforeEach(() => {
    execCalls.length = 0;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-logon-')));
    prevAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    fs.mkdirSync(startupFolder(), { recursive: true });
    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    vi.restoreAllMocks();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a Startup .cmd that boots the watcher detached', () => {
    asWindows();
    const res = registerLogonAutoStart({
      name: 'OriginCodexWatch',
      entryScript: ENTRY,
      subcommand: 'codex-watch',
    });

    expect(res.registered).toBe(true);
    expect(res.reason).toBe('startup-cmd-created');

    const file = startupEntryPath('OriginCodexWatch');
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf-8');
    // `--ensure` spawns the daemon detached and exits, so the watcher outlives
    // the .cmd's console instead of dying with it.
    expect(body).toContain('codex-watch --ensure --quiet');
    expect(body).toContain(ENTRY);
    expect(body).toContain(process.execPath);
  });

  it('never shells out to create persistence — that is what Defender blocked', () => {
    asWindows();
    registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: ENTRY, subcommand: 'codex-watch' });

    const created = execCalls.filter(c => c.includes('/Create'));
    expect(created).toEqual([]);
  });

  it('cleans up the legacy Scheduled Task on machines that got one', () => {
    asWindows();
    registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: ENTRY, subcommand: 'codex-watch' });

    expect(execCalls).toContainEqual(['schtasks', '/Delete', '/F', '/TN', 'OriginCodexWatch']);
  });

  it('is idempotent — a second call leaves the same file and reports it current', () => {
    asWindows();
    const opts = { name: 'OriginTranscriptWatch', entryScript: ENTRY, subcommand: 'transcript-watch' };
    const first = registerLogonAutoStart(opts);
    const body = fs.readFileSync(startupEntryPath(opts.name), 'utf-8');

    const second = registerLogonAutoStart(opts);

    expect(first.reason).toBe('startup-cmd-created');
    expect(second.registered).toBe(true);
    expect(second.reason).toBe('startup-cmd-current');
    expect(fs.readFileSync(startupEntryPath(opts.name), 'utf-8')).toBe(body);
  });

  it('rewrites the entry when the CLI moves (upgrade to a new install path)', () => {
    asWindows();
    const name = 'OriginCodexWatch';
    registerLogonAutoStart({ name, entryScript: ENTRY, subcommand: 'codex-watch' });

    const moved = 'D:\\other\\dist\\index.js';
    const res = registerLogonAutoStart({ name, entryScript: moved, subcommand: 'codex-watch' });

    expect(res.reason).toBe('startup-cmd-created');
    const body = fs.readFileSync(startupEntryPath(name), 'utf-8');
    expect(body).toContain(moved);
    expect(body).not.toContain(ENTRY);
  });

  it('reports a failure instead of claiming success when the entry cannot be written', () => {
    asWindows();
    // Startup folder missing (redirected/locked-down profile) — the caller has
    // to be able to tell the user, which is the whole point of the change.
    fs.rmSync(startupFolder(), { recursive: true, force: true });

    const res = registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: ENTRY, subcommand: 'codex-watch' });

    expect(res.registered).toBe(false);
    expect(res.reason).toMatch(/^no-startup-folder:/);
  });

  it('reports a failure when the CLI entry script cannot be resolved', () => {
    asWindows();
    const res = registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: '', subcommand: 'codex-watch' });

    expect(res.registered).toBe(false);
    expect(res.reason).toBe('no-entry-script');
  });

  it('no-ops off Windows without touching the filesystem', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const res = registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: ENTRY, subcommand: 'codex-watch' });

    expect(res).toEqual({ registered: false, reason: 'not-windows' });
    expect(fs.existsSync(startupEntryPath('OriginCodexWatch'))).toBe(false);
    expect(execCalls).toEqual([]);
  });
});

describe('unregisterLogonAutoStart', () => {
  let home: string;
  let prevAppData: string | undefined;
  let prevPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    execCalls.length = 0;
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-logon-')));
    prevAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    fs.mkdirSync(startupFolder(), { recursive: true });
    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('removes the entry, and is a no-op when there is nothing to remove', () => {
    registerLogonAutoStart({ name: 'OriginCodexWatch', entryScript: ENTRY, subcommand: 'codex-watch' });
    expect(fs.existsSync(startupEntryPath('OriginCodexWatch'))).toBe(true);

    expect(unregisterLogonAutoStart('OriginCodexWatch').reason).toBe('startup-cmd-removed');
    expect(fs.existsSync(startupEntryPath('OriginCodexWatch'))).toBe(false);

    expect(unregisterLogonAutoStart('OriginCodexWatch').reason).toBe('startup-cmd-removed');
  });
});
