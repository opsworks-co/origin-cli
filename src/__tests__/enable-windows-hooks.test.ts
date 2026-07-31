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

import { installCursorHooks, installDevinHooks, installCopilotHooks, installCodexHooks, backslashTolerantPathRe } from '../commands/enable.js';

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

  it('Copilot: the powershell field must NOT invoke npm\'s batch shim', () => {
    // origin.cmd is a BATCH file, so a hook that calls it spawns cmd.exe — and
    // under a GUI agent that cmd.exe gets a VISIBLE console window. Copilot fires
    // hooks on every lifecycle event, which produced a stream of black cmd
    // windows (user-reported). Every field must call node.exe directly.
    installCopilotHooks(dir);
    const cp = JSON.parse(fs.readFileSync(path.join(dir, '.github', 'hooks', 'origin.json'), 'utf-8'));
    for (const event of Object.keys(cp.hooks)) {
      for (const h of cp.hooks[event]) {
        for (const field of ['bash', 'command', 'powershell'] as const) {
          const v: string = h[field] || '';
          expect(v).not.toMatch(/origin\.cmd/i);
          // A bare `…\npm\origin` path IS the shim (npm resolves it to origin.cmd).
          expect(v).not.toMatch(/[\\/]npm[\\/]origin['"\s]/i);
          expect(v).toMatch(/node(\.exe)?['"]?\s/i);
        }
      }
    }
  });

  it('Devin: uses the OS-aware command form (.devin/hooks.v1.json, no powershell field)', () => {
    installDevinHooks(dir);
    const dv = JSON.parse(fs.readFileSync(path.join(dir, '.devin', 'hooks.v1.json'), 'utf-8'));
    expect(dv.SessionStart[0].hooks[0].command).toContain('hooks devin session-start');
    expect(dv.SessionStart[0].hooks[0].powershell).toBeUndefined();
  });

  // Regression: npm's `origin.cmd` is a BATCH file, so routing hooks through it
  // makes Windows launch cmd.exe on every fire — and under a GUI agent (Codex
  // Desktop) each one gets a visible console window. Codex fires
  // session-start/user-prompt-submit/stop constantly, which buried the user in
  // cmd windows. Invoke node.exe + the CLI's own entry script instead.
  it('routes through node.exe + the CLI entry, NOT the origin.cmd batch shim', () => {
    installCursorHooks(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf-8'));
    const cmd: string = cfg.hooks.sessionStart[0].command;

    // vitest runs from a real .js entry, so the node-direct form must win.
    expect(cmd).not.toMatch(/origin\.cmd/i);
    expect(cmd).toContain(process.execPath);
    expect(cmd).toContain('hooks cursor session-start');
  });

  it('quotes the node/entry paths so spaces (C:\\Program Files\\nodejs) survive', () => {
    installCursorHooks(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf-8'));
    const cmd: string = cfg.hooks.sessionStart[0].command;
    if (/\s/.test(process.execPath)) {
      expect(cmd).toContain(`"${process.execPath}"`);
    }
    // Whatever the form, the trailing args stay unquoted and parseable.
    expect(cmd.endsWith('hooks cursor session-start')).toBe(true);
  });
});

// FIX 3 — Windows is WATCHER-ONLY: `origin enable` must NOT install any Codex
// lifecycle hooks there. Codex's Windows sandbox blocks the hooks (they can't
// inject context or capture) yet still surfaces them as red "hook (failed)"
// errors; capture now runs through the hook-independent rollout watcher
// (`origin codex-watch`, auto-started by enable). So installCodexHooks on
// Windows registers NOTHING and STRIPS any Origin hook blocks a prior CLI wrote
// — leaving the user's own config and the `[features] hooks` flag untouched.
// isWindows() is mocked true for this whole file; macOS/Linux still install
// hooks (covered by the CLI test suite on non-Windows legs).
describe('Codex hooks: Windows is watcher-only (no lifecycle hooks installed)', () => {
  let home: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-codex-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const configPath = () => path.join(home, '.codex', 'config.toml');

  it('writes NO .codex/hooks.json and NO config.toml hook/trust blocks on Windows', () => {
    installCodexHooks(home);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    // With no pre-existing config.toml, the watcher-only path creates nothing
    // (it must not flip the [features] flag or write inline hooks).
    if (fs.existsSync(configPath())) {
      const toml = fs.readFileSync(configPath(), 'utf-8');
      expect(toml).not.toContain('# origin-codex-inline-hooks-begin');
      expect(toml).not.toContain('# origin-trusted-hooks-begin');
      expect(toml).not.toContain('[[hooks.SessionStart]]');
      expect(toml).not.toContain('[hooks.state.');
    }
  });

  it('does NOT flip the [features] hooks flag (leaves the user\'s config.toml untouched)', () => {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    // A user config with hooks explicitly DISABLED — we must not enable it.
    fs.writeFileSync(configPath(), '[features]\nhooks = false\n\n[misc]\nfoo = "bar"\n');
    installCodexHooks(home);
    const toml = fs.readFileSync(configPath(), 'utf-8');
    expect(toml).toContain('hooks = false');
    expect(toml).not.toContain('hooks = true');
    expect(toml).toContain('foo = "bar"');
  });

  it('strips a PRE-EXISTING Origin-only hooks.json (removes the file entirely)', () => {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node x hooks codex session-start', timeout: 10 }] }],
      },
    }, null, 2));
    installCodexHooks(home);
    expect(fs.existsSync(path.join(codexDir, 'hooks.json'))).toBe(false);
  });

  it('preserves a user\'s NON-Origin hooks.json entries while dropping only Origin\'s', () => {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node x hooks codex session-start', timeout: 10 }] },
          { hooks: [{ type: 'command', command: 'my-own-tool run', timeout: 5 }] },
        ],
      },
    }, null, 2));
    installCodexHooks(home);
    const hooksJson = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf-8'));
    const cmds = (hooksJson.hooks.SessionStart || []).flatMap((g: any) => (g.hooks || []).map((h: any) => h.command));
    expect(cmds).toContain('my-own-tool run');
    expect(cmds.some((c: string) => c.includes('hooks codex'))).toBe(false);
  });

  it('strips PRE-EXISTING Origin inline + trust blocks from config.toml, preserving user config', () => {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const cfg = configPath();
    const userTop = '[features]\nhooks = true\n\n[model]\nname = "gpt-5.5"\n';
    fs.writeFileSync(cfg,
      userTop +
      '\n# origin-codex-inline-hooks-begin\n' +
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = \'node x hooks codex session-start\'\ntimeout = 10\n' +
      '# origin-codex-inline-hooks-end\n' +
      '\n# origin-trusted-hooks-begin\n' +
      `[hooks.state."${cfg}:session_start:0:0"]\ntrusted_hash = "sha256:deadbeef"\n` +
      '# origin-trusted-hooks-end\n',
    );
    installCodexHooks(home);
    const toml = fs.readFileSync(cfg, 'utf-8');
    // Origin blocks gone…
    expect(toml).not.toContain('# origin-codex-inline-hooks-begin');
    expect(toml).not.toContain('# origin-trusted-hooks-begin');
    expect(toml).not.toContain('[[hooks.SessionStart]]');
    expect(toml).not.toContain('[hooks.state.');
    // …user config intact (including their own [features] hooks flag).
    expect(toml).toContain('hooks = true');
    expect(toml).toContain('name = "gpt-5.5"');
  });

  it('strips un-delimited orphan [hooks.state] trust tables from an older CLI', () => {
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const cfg = configPath();
    const hooksJson = path.join(codexDir, 'hooks.json');
    fs.writeFileSync(cfg,
      '[misc]\nkeep = 1\n' +
      `\n[hooks.state."${cfg}:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\n` +
      `\n[hooks.state."${hooksJson}:stop:0:0"]\ntrusted_hash = "sha256:bbb"\n`,
    );
    installCodexHooks(home);
    const toml = fs.readFileSync(cfg, 'utf-8');
    expect(toml).not.toContain('[hooks.state.');
    expect(toml).toContain('keep = 1');
  });

  // The Windows CI leg caught the real bug here: the orphan-[hooks.state] strip
  // matched only DOUBLE-backslash paths, so a real `C:\Users\...` trust key (as
  // Codex/an older CLI writes it) survived on Windows. Prove the regex fragment
  // matches BOTH single- and double-backslash forms, platform-independently.
  it('backslashTolerantPathRe matches a hooks.state key with single OR double backslashes', () => {
    const winPath = 'C:\\Users\\User2\\.codex\\config.toml';
    const re = new RegExp(`\\[hooks\\.state\\."${backslashTolerantPathRe(winPath)}:[^"]*"\\]`);
    // single-backslash form (raw path written straight into the file)
    expect(re.test('[hooks.state."C:\\Users\\User2\\.codex\\config.toml:session_start:0:0"]')).toBe(true);
    // double-backslash form (TOML basic-string escaping the CLI emits)
    expect(re.test('[hooks.state."C:\\\\Users\\\\User2\\\\.codex\\\\config.toml:stop:0:0"]')).toBe(true);
    // a DIFFERENT path must not match (no over-strip)
    expect(re.test('[hooks.state."C:\\Users\\Other\\config.toml:stop:0:0"]')).toBe(false);
    // POSIX path (no backslashes) still works
    const posix = backslashTolerantPathRe('/home/u/.codex/config.toml');
    expect(new RegExp(posix).test('/home/u/.codex/config.toml')).toBe(true);
  });

  it('is idempotent — re-running on Windows keeps writing nothing', () => {
    installCodexHooks(home);
    installCodexHooks(home);
    installCodexHooks(home);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
  });
});
