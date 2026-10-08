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
  installCursorHooks,
  HOOK_CONFIG_SPECS,
} from '../commands/enable.js';
import { checkHookConfig, repairHookConfig } from '../hook-config-health.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

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
        hooks: { stop: [bare('stop'), { command: 'echo mine' }], sessionStart: [bare('session-start')] },
      }));
    });
    afterEach(() => { process.argv[1] = savedArgv1; });

    it('re-install replaces the bare entries with quoted, runnable ones', () => {
      installCursorHooks(repo);
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.cursor', 'hooks.json'), 'utf-8'));
      const ours = cfg.hooks.stop.filter((h: any) => isOriginHookCommand(h.command));
      expect(ours).toHaveLength(1);
      expect(cfg.hooks.stop.some((h: any) => h.command === 'echo mine')).toBe(true);
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
