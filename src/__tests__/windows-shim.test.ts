// An npm-installed agent on Windows is a .cmd shim. Node won't spawn one
// without a shell, and cmd.exe would parse the prompt — so the shim's target
// is read out of it and run directly (windows-shim.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchTarget, shimTarget } from '../windows-shim.js';

let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-shim-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function file(rel: string, text = ''): string {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

const NPM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
].join('\r\n');

// npm before cmd-shim 4, and pnpm's shape.
const OLD_NPM = [
  '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ') ELSE (', '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ')', '',
].join('\r\n');

describe('shimTarget', () => {
  it("reads the node script out of npm's shim", () => {
    const cli = file('node_modules/@anthropic-ai/claude-code/cli.js');
    expect(shimTarget(file('claude.cmd', NPM))).toBe(cli);
  });

  it('reads the older %~dp0 form', () => {
    const cli = file('node_modules/@openai/codex/bin/codex.js');
    expect(shimTarget(file('codex.cmd', OLD_NPM))).toBe(cli);
  });

  it('reads a shim over a native .exe', () => {
    const exe = file('node_modules/tool/bin/tool.exe');
    expect(shimTarget(file('tool.cmd', '@ECHO off\r\n"%~dp0\\node_modules\\tool\\bin\\tool.exe"   %*\r\n'))).toBe(exe);
  });

  it('refuses what it cannot reproduce: a missing target, extra arguments, an unknown variable', () => {
    expect(shimTarget(file('a.cmd', NPM))).toBeNull(); // cli.js is not there
    file('node_modules/x/cli.js');
    expect(shimTarget(file('b.cmd', '"%~dp0\\node_modules\\x\\cli.js" --flag %*\r\n'))).toBeNull();
    expect(shimTarget(file('c.cmd', '"%APPDATA%\\x\\cli.js" %*\r\n'))).toBeNull();
    expect(shimTarget(path.join(dir, 'nope.cmd'))).toBeNull();
  });
});

describe('launchTarget', () => {
  it('runs a script shim with node and the prompt as argv', () => {
    const cli = file('node_modules/@anthropic-ai/claude-code/cli.js');
    const shim = file('claude.cmd', NPM);
    const prompt = 'x" & calc & "%PATH%^|';
    expect(launchTarget(shim, [prompt], { platform: 'win32', findNode: () => 'C:\\node\\node.exe' }))
      .toEqual({ file: 'C:\\node\\node.exe', args: [cli, prompt] });
  });

  it("prefers the node.exe beside the shim, as the shim does, and falls back to this process's node", () => {
    const cli = file('node_modules/@anthropic-ai/claude-code/cli.js');
    const shim = file('claude.cmd', NPM);
    expect(launchTarget(shim, ['p'], { platform: 'win32', findNode: () => null })).toEqual({ file: process.execPath, args: [cli, 'p'] });
    const local = file('node.exe');
    expect(launchTarget(shim, ['p'], { platform: 'win32', findNode: () => 'elsewhere' })).toEqual({ file: local, args: [cli, 'p'] });
  });

  it('refuses a shim it cannot read rather than hand it to cmd.exe', () => {
    const shim = file('agy.cmd', '@echo off\r\ncall "%LOCALAPPDATA%\\agy\\agy.exe" %*\r\n');
    expect(() => launchTarget(shim, ['p'], { platform: 'win32' })).toThrow(/cmd\.exe would let cmd\.exe parse the prompt/);
  });

  it('leaves everything else alone', () => {
    expect(launchTarget('/usr/bin/claude', ['p'], { platform: 'linux' })).toEqual({ file: '/usr/bin/claude', args: ['p'] });
    expect(launchTarget('C:\\bin\\claude.exe', ['p'], { platform: 'win32' })).toEqual({ file: 'C:\\bin\\claude.exe', args: ['p'] });
    expect(launchTarget('/x/claude.cmd', ['p'], { platform: 'darwin' })).toEqual({ file: '/x/claude.cmd', args: ['p'] });
  });
});
