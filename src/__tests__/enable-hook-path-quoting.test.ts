// The unix hook launcher prefix `PATH=<binDir>:$PATH origin hooks …` was
// emitted with binDir UNQUOTED. A bin dir with a space in it (`/Users/John
// Smith/.nvm/…/bin`) split the assignment, so the shell ran a "command" named
// `Smith/.nvm/…:$PATH` — every agent hook and every local git hook exited 127
// and nothing was captured. These tests run the generated strings through a
// real /bin/sh, and check that an install over the OLD bare form replaces it
// (not duplicates it) and that the health check heals it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  posixPathShim,
  shDoubleQuoteEscape,
  isOriginHookCommand,
  ORIGIN_HOOK_COMMAND_TAIL,
  installCursorHooks,
  HOOK_CONFIG_SPECS,
} from '../commands/enable.js';
import { checkHookConfig, repairHookConfig } from '../hook-config-health.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

// Every shape enable writes (posixPathShim, originCmd's Windows branches,
// originPowershellCmd) plus the legacy `windsurf` id — these must stay Origin's.
const ORIGIN_FORMS: Array<[string, string, string]> = [
  ['bare', 'origin hooks cursor stop', 'cursor'],
  ['old unquoted PATH shim', 'PATH=/opt/homebrew/bin:$PATH origin hooks cursor stop', 'cursor'],
  ['quoted PATH shim with a space', 'PATH="/Users/John Smith/bin:$PATH" origin hooks claude-code stop', 'claude-code'],
  ['absolute unix path', '/opt/homebrew/bin/origin hooks gemini session-start', 'gemini'],
  ['legacy windsurf id', 'PATH="/x/bin:$PATH" origin hooks windsurf stop', 'windsurf'],
  ['Windows node + entry, short paths',
    'C:\\PROGRA~1\\nodejs\\node.exe C:\\Users\\jsmith\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js hooks codex stop', 'codex'],
  ['Windows node + entry, quoted',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js" hooks devin stop', 'devin'],
  ['Windows node + a dev checkout\'s dist', 'C:\\src\\my-fork\\packages\\cli\\dist\\index.js hooks cursor stop', 'cursor'],
  ['Windows origin.cmd, quoted', '"C:\\Users\\John Smith\\AppData\\Roaming\\npm\\origin.cmd" hooks cursor stop', 'cursor'],
  ['Windows origin.cmd, unquoted', 'C:\\Users\\jsmith\\AppData\\Roaming\\npm\\origin.cmd hooks antigravity stop', 'antigravity'],
  ['Windows origin.exe', 'C:\\tools\\origin.exe hooks copilot stop', 'copilot'],
  ['PowerShell node + entry',
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\jsmith\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js' hooks copilot session-start", 'copilot'],
  ['PowerShell origin path', "& 'C:\\Users\\John Smith\\AppData\\Roaming\\npm\\origin' hooks copilot stop", 'copilot'],
  ['event-less tail', 'origin hooks cursor', 'cursor'],
];

// Other tools' hooks that merely say `hooks <agent>`: never Origin's.
const FOREIGN_FORMS: Array<[string, string]> = [
  ['entire hooks claude-code stop', 'claude-code'],
  ['/usr/local/bin/mytool hooks cursor stop', 'cursor'],
  ['my-origin hooks claude-code x', 'claude-code'],
  ['originate hooks claude-code x', 'claude-code'],
  ['"C:\\tools\\mytool.exe" hooks codex stop', 'codex'],
];

describe('isOriginHookCommand needs Origin\'s launcher before `hooks <agent>`', () => {
  it.each(ORIGIN_FORMS)('matches %s', (_label, cmd, agent) => {
    expect(isOriginHookCommand(cmd)).toBe(true);
    expect(isOriginHookCommand(cmd, agent)).toBe(true);
    // The tail match starts at `hooks`, so stripLauncherPaths keeps working.
    expect(cmd.slice(cmd.match(ORIGIN_HOOK_COMMAND_TAIL)!.index)).toMatch(new RegExp(`^hooks ${agent}`));
    // The health check also scans raw JSON text, where quotes come escaped.
    expect(ORIGIN_HOOK_COMMAND_TAIL.test(JSON.stringify({ command: cmd }))).toBe(true);
  });

  it.each(FOREIGN_FORMS)('does NOT match %s', (cmd, agent) => {
    expect(isOriginHookCommand(cmd)).toBe(false);
    expect(isOriginHookCommand(cmd, agent)).toBe(false);
    expect(ORIGIN_HOOK_COMMAND_TAIL.test(JSON.stringify({ command: cmd }))).toBe(false);
  });

  it('scopes to one agent', () => {
    expect(isOriginHookCommand('origin hooks cursor stop', 'claude-code')).toBe(false);
    expect(isOriginHookCommand('origin hooks claude-codex stop', 'claude-code')).toBe(false);
  });
});

/** A bin dir at `<tmp>/<name>/bin` holding an `origin` that echoes its argv. */
function fakeBinDir(root: string, name: string): string {
  const dir = path.join(root, name, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'origin'), '#!/bin/sh\necho "ran: $*"\n', { mode: 0o755 });
  return dir;
}

function sh(cmd: string) {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } });
}

posixOnly('hook launcher quotes the bin dir', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'origin-quote-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('the old bare form exits 127 for a bin dir with a space (the bug)', () => {
    const dir = fakeBinDir(root, 'John Smith');
    expect(sh(`PATH=${dir}:$PATH origin hooks cursor stop`).status).toBe(127);
  });

  for (const name of ['John Smith', 'a$HOME b', 'tick`x`', 'q"uo\\te']) {
    it(`runs origin from a bin dir named ${JSON.stringify(name)}`, () => {
      const dir = fakeBinDir(root, name);
      const r = sh(posixPathShim(dir, 'origin hooks cursor stop'));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('ran: hooks cursor stop');
    });
  }

  it('$PATH still expands inside the quotes', () => {
    const dir = fakeBinDir(root, 'John Smith');
    const r = sh(posixPathShim(dir, `/bin/sh -c 'echo "$PATH"'`));
    expect(r.stdout.trim()).toBe(`${dir}:/usr/bin:/bin`);
    expect(posixPathShim('/x', 'origin')).toBe('PATH="/x:$PATH" origin');
  });

  it('shDoubleQuoteEscape round-trips through sh double quotes', () => {
    const s = 'a "b" $c `d` \\e f';
    const out = execFileSync('/bin/sh', ['-c', `printf %s "${shDoubleQuoteEscape(s)}"`], { encoding: 'utf-8' });
    expect(out).toBe(s);
  });

  it('isOriginHookCommand recognises both the old bare and the new quoted form', () => {
    expect(isOriginHookCommand('PATH=/opt/homebrew/bin:$PATH origin hooks cursor stop', 'cursor')).toBe(true);
    expect(isOriginHookCommand('PATH="/Users/John Smith/bin:$PATH" origin hooks cursor stop', 'cursor')).toBe(true);
    expect(isOriginHookCommand('PATH="/Users/John Smith/bin:$PATH" origin hooks cursor stop')).toBe(true);
  });

  describe('install + health over an old bare-form config', () => {
    let savedArgv1: string;
    let dir: string;
    let repo: string;
    beforeEach(() => {
      savedArgv1 = process.argv[1];
      dir = fakeBinDir(root, 'John Smith');
      // getOriginBinPath() resolves from the running CLI's own argv[1].
      process.argv[1] = path.join(dir, 'origin');
      repo = path.join(root, 'repo');
      fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
      const bare = (sub: string) => ({ command: `PATH=${dir}:$PATH origin hooks cursor ${sub}` });
      fs.writeFileSync(path.join(repo, '.cursor', 'hooks.json'), JSON.stringify({
        version: 1,
        hooks: {
          stop: [bare('stop'), { command: 'echo mine' }, ...FOREIGN_FORMS.map(([command]) => ({ command }))],
          sessionStart: [bare('session-start')],
        },
      }));
    });
    afterEach(() => { process.argv[1] = savedArgv1; });

    it('re-install replaces the bare entries with quoted, runnable ones', () => {
      installCursorHooks(repo);
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.cursor', 'hooks.json'), 'utf-8'));
      const ours = cfg.hooks.stop.filter((h: any) => isOriginHookCommand(h.command));
      expect(ours).toHaveLength(1);
      expect(cfg.hooks.stop.some((h: any) => h.command === 'echo mine')).toBe(true);
      // Other tools' `<tool> hooks <agent>` entries survive a re-install.
      for (const [command] of FOREIGN_FORMS) expect(cfg.hooks.stop.map((h: any) => h.command)).toContain(command);
      expect(ours[0].command).toBe(posixPathShim(dir, 'origin hooks cursor stop'));
      expect(sh(ours[0].command).stdout.trim()).toBe('ran: hooks cursor stop');
    });

    it('the health check reads the bare form as a moved launcher and repairs it', () => {
      installCursorHooks(repo); // establish the full expected shape …
      const file = path.join(repo, '.cursor', 'hooks.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // … then regress every Origin command to the old bare form.
      for (const entries of Object.values<any[]>(cfg.hooks)) {
        for (const h of entries) {
          if (isOriginHookCommand(h.command)) h.command = h.command.replace(/^PATH="([^"]*)" /, 'PATH=$1 ');
        }
      }
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));

      const spec = HOOK_CONFIG_SPECS.find((s) => s.agent === 'cursor')!;
      const report = checkHookConfig(spec, repo);
      expect(report.state).toBe('relocated');
      repairHookConfig(report);
      expect(checkHookConfig(spec, repo).state).toBe('ok');
    });
  });
});
