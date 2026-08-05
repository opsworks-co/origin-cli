// Windows credential lockdown: ~/.origin/config.json holds the org API key, but
// `chmod 0o600` is a no-op on Windows so the file inherited its parent's ACL —
// on Codex-sandbox machines that granted `CodexSandboxUsers:(RX)`, leaking the
// key to other users. lockdownWindowsPath() resets the ACL via icacls.
//
// The invariant these tests pin (on every OS, but the icacls path only runs on
// the native-Windows CI job): the call NEVER throws and NEVER locks the owner
// out of their own file. On non-Windows it's a documented no-op.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lockdownWindowsPath } from '../config.js';

describe('lockdownWindowsPath', () => {
  it('leaves the owner able to read the file (no self-lockout) and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-acl-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'x'.repeat(55) }));

    expect(() => lockdownWindowsPath(file, false)).not.toThrow();

    // The whole point of the fail-safe ordering: the current user must still be
    // able to read their own credential file after the ACL reset.
    expect(() => fs.readFileSync(file, 'utf-8')).not.toThrow();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).apiKey).toHaveLength(55);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('locks a directory (and its contents) without throwing or locking the owner out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-acl-'));
    fs.writeFileSync(path.join(dir, 'agent.json'), '{}');

    expect(() => lockdownWindowsPath(dir, true)).not.toThrow();

    // Owner can still list + read after locking the directory tree.
    expect(fs.readdirSync(dir)).toContain('agent.json');
    expect(() => fs.readFileSync(path.join(dir, 'agent.json'), 'utf-8')).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op on non-Windows platforms', () => {
    if (process.platform === 'win32') return; // real behavior covered by the Windows CI job
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-acl-'));
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, '{}');
    const before = fs.statSync(file).mode;
    lockdownWindowsPath(file, false);
    // Mode is unchanged — the function returned early before any ACL/chmod work.
    expect(fs.statSync(file).mode).toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
