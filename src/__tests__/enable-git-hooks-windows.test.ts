/**
 * Windows coverage for the GLOBAL GIT HOOKS (~/.origin/git-hooks/*).
 *
 * enable-windows-hooks.test.ts covers AGENT hooks (hooks.json), which go through
 * originCmd() and are explicitly Windows-aware. The git hooks are a different
 * layer with no coverage at all, and they were broken on Windows:
 *
 *   resolveOriginBin() reports what `where` said — on Windows a BACKSLASH path
 *   (C:\Users\me\AppData\Roaming\npm\origin.cmd). MSYS `test -x` never matches
 *   that form, so the hook's primary branch always missed. The only fallback was
 *   `command -v origin`, and the shim's PATH additions were all macOS/Linux
 *   (/opt/homebrew, /usr/local, ~/.nvm, ~/.npm-global) — none of which exist on
 *   Windows, where npm installs to %APPDATA%\npm. When that wasn't already on
 *   the PATH git's hook shell inherited, ORIGIN_BIN came out EMPTY and every git
 *   hook exited 0 having done nothing: no notes on commit, no push on push, no
 *   fold on pull, no sync on clone.
 *
 * Verified before the fix with a name that exists nowhere on the host: the old
 * block resolved to nothing, the new one fires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { originBinCandidates } from '../commands/enable.js';

const WIN_CMD = 'C:\\Users\\me\\AppData\\Roaming\\npm\\origin.cmd';

describe('originBinCandidates', () => {
  it('offers MSYS-executable forms for a Windows backslash path', () => {
    const c = originBinCandidates(WIN_CMD);
    // The raw backslash form is kept (harmless) but cannot be the only one.
    expect(c).toContain(WIN_CMD);
    expect(c).toContain('C:/Users/me/AppData/Roaming/npm/origin.cmd');
    expect(c).toContain('/c/Users/me/AppData/Roaming/npm/origin.cmd');
  });

  it('prefers the extensionless sibling over npm\'s .cmd batch shim', () => {
    // Running the .cmd from sh spawns cmd.exe — a visible console window under
    // GUI agents, the trap originCmd() already documents.
    const c = originBinCandidates(WIN_CMD);
    const firstCmd = c.findIndex((x) => /\.cmd$/i.test(x));
    const firstPlain = c.findIndex((x) => !/\.cmd$/i.test(x));
    expect(firstPlain).toBeGreaterThanOrEqual(0);
    expect(firstPlain).toBeLessThan(firstCmd);
  });

  it('leaves a POSIX path exactly as-is (no macOS/Linux behaviour change)', () => {
    const posix = '/Users/x/.nvm/versions/node/v20.20.0/bin/origin';
    expect(originBinCandidates(posix)).toEqual([posix]);
  });

  it('returns nothing when resolution failed, so the shim falls through', () => {
    expect(originBinCandidates('origin')).toEqual([]);
    expect(originBinCandidates('')).toEqual([]);
  });
});

describe('generated global git hooks', () => {
  let dir: string;
  let writers: Record<string, (d: string) => void>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-githooks-'));
    const e: any = await import('../commands/enable.js');
    writers = {
      'post-merge': e.writeGlobalPostMergeHook,
      'post-commit': e.writeGlobalPostCommitHook,
      'post-checkout': e.writeGlobalPostCheckoutHook,
      'post-rewrite': e.writeGlobalPostRewriteHook,
      'pre-push': e.writeGlobalPrePushHook,
      'pre-commit': e.writeGlobalPreCommitHook,
    };
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const names = ['post-merge', 'post-commit', 'post-checkout', 'post-rewrite', 'pre-push', 'pre-commit'];

  it('every hook carries the Windows npm locations on PATH', () => {
    for (const n of names) {
      writers[n](dir);
      const body = fs.readFileSync(path.join(dir, n), 'utf-8');
      // Spelled via $HOME (Git Bash sets it to /c/Users/<user>) — the raw
      // %APPDATA% is a backslash Windows path and unusable as an MSYS PATH
      // element. Assert on the PATH line itself, not the whole body: the shim's
      // comment mentions %APPDATA% precisely to explain why it isn't used.
      const pathLine = body.split('\n').find((l) => l.startsWith('export PATH=')) || '';
      expect(pathLine, `${n} missing the Windows npm dir`).toContain('$HOME/AppData/Roaming/npm');
      expect(pathLine).not.toContain('%APPDATA%');
    }
  });

  it('every hook keeps a fallback that can match on Windows', () => {
    for (const n of names) {
      writers[n](dir);
      const body = fs.readFileSync(path.join(dir, n), 'utf-8');
      expect(body, `${n} lost its AppData fallback`).toContain('"$HOME/AppData/Roaming/npm/origin"');
      expect(body).toContain('command -v origin');
    }
  });

  it('keeps the embedded path AHEAD of command -v (unchanged precedence)', () => {
    writers['post-commit'](dir);
    const body = fs.readFileSync(path.join(dir, 'post-commit'), 'utf-8');
    const loop = body.indexOf('for _origin_c in');
    const cmdv = body.indexOf('command -v origin');
    const appdata = body.indexOf('"$HOME/AppData/Roaming/npm/origin"');
    expect(loop).toBeGreaterThanOrEqual(0);
    // embedded candidates → command -v → platform fallbacks. Strictly additive:
    // anything that resolved before still resolves the same way first.
    expect(loop).toBeLessThan(cmdv);
    expect(cmdv).toBeLessThan(appdata);
  });

  it.skipIf(process.platform === 'win32')('every hook is valid POSIX sh', () => {
    // These run under git's bundled sh.exe on Windows too, so a syntax error
    // would break git operations on every platform at once.
    for (const n of names) {
      writers[n](dir);
      expect(() => execFileSync('sh', ['-n', path.join(dir, n)], { stdio: 'pipe' }))
        .not.toThrow();
    }
  });

  it('leaves no unresolved template interpolation in the shim', () => {
    for (const n of names) {
      writers[n](dir);
      const body = fs.readFileSync(path.join(dir, n), 'utf-8');
      expect(body, `${n} has an unexpanded \${...}`).not.toMatch(/\$\{[a-zA-Z]/);
    }
  });
});
