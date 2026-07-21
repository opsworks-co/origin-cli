// Native-Windows hook generation: on Windows, agent hooks.json `command` fields
// must NOT carry the POSIX `PATH=dir:$PATH origin …` shim (invalid under
// cmd/PowerShell). originCmd emits an absolute-path invocation there instead,
// so command-only agents (Cursor/Codex/Gemini/Claude/Antigravity — no
// `powershell` field) still fire on Windows. isWindows() is mocked true so the
// Windows branch is exercised on every OS; on the windows-latest CI leg it runs
// against the real platform too.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../utils/platform.js', async (orig) => {
  const actual = await orig<typeof import('../utils/platform.js')>();
  return { ...actual, isWindows: () => true };
});

import { installCursorHooks, installDevinHooks, installCopilotHooks } from '../commands/enable.js';

describe('enable hook generation on native Windows (isWindows → true)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-win-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('Cursor: command drops the POSIX PATH= shim but still routes to origin', () => {
    installCursorHooks(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf-8'));
    const cmd = cfg.hooks.sessionStart[0].command;
    expect(cmd).not.toMatch(/PATH=/); // the sh shim is invalid on Windows
    expect(cmd).toContain('hooks cursor session-start');
  });

  it('Cursor: re-install is idempotent against the Windows command form', () => {
    installCursorHooks(dir);
    installCursorHooks(dir); // second pass must recognize the Windows-form entry
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf-8'));
    const originEntries = cfg.hooks.sessionStart.filter(
      (h: any) => typeof h.command === 'string' && h.command.includes('hooks cursor'),
    );
    expect(originEntries).toHaveLength(1);
  });

  it('Copilot: still carries a powershell field on Windows', () => {
    installCopilotHooks(dir);
    const cp = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'origin.json'), 'utf-8'));
    expect(cp.hooks.sessionStart[0].powershell).toContain('hooks copilot session-start');
  });

  it('Devin: uses the OS-aware command form (.devin/hooks.v1.json, no powershell field)', () => {
    installDevinHooks(dir);
    const dv = JSON.parse(fs.readFileSync(path.join(dir, '.devin', 'hooks.v1.json'), 'utf-8'));
    expect(dv.SessionStart[0].hooks[0].command).toContain('hooks devin session-start');
    expect(dv.SessionStart[0].hooks[0].powershell).toBeUndefined();
  });
});
