/**
 * The built CLI entry point must be executable.
 *
 * `bin` points at dist/index.js and `build` is a bare `tsc`, which writes 0644.
 * npm sets the exec bit itself at install/pack time, so a PUBLISHED install was
 * always fine — a LOCAL build was not, and this repo's everyday setup is a
 * global install symlinked straight at dist/ (`pnpm cli:upgrade`).
 *
 * Every local rebuild therefore left the binary at 0644, and the next `origin`
 * in a shell died with `zsh: permission denied: origin` — which reads like a
 * broken PATH, not a missing mode bit. It went unnoticed only because a stale
 * second install shadowed it on the PATH; removing that one took the CLI out.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const cliRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(cliRoot, 'scripts', 'chmod-bin.cjs');

describe('build marks the bin executable', () => {
  it('is wired into the build, not just available', () => {
    // A script nothing calls fixes nothing.
    const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf-8'));
    expect(pkg.scripts.postbuild, 'postbuild is gone — the build no longer chmods').toContain('chmod-bin');
    expect(pkg.bin.origin).toBe('./dist/index.js');
  });

  it('adds +x to a 0644 bin without disturbing the read bits', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-chmod-'));
    fs.mkdirSync(path.join(fake, 'dist'));
    fs.mkdirSync(path.join(fake, 'scripts'));
    fs.writeFileSync(path.join(fake, 'dist', 'index.js'), '#!/usr/bin/env node\n', { mode: 0o644 });
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({
      name: '@origin/cli', bin: { origin: './dist/index.js' },
    }));
    fs.copyFileSync(script, path.join(fake, 'scripts', 'chmod-bin.cjs'));

    execFileSync('node', [path.join(fake, 'scripts', 'chmod-bin.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] });

    const mode = fs.statSync(path.join(fake, 'dist', 'index.js')).mode;
    expect(mode & 0o111, 'exec bit not set').toBeTruthy();
    expect(mode & 0o444, 'read bits were clobbered').toBeTruthy();
  });

  it('logs to stderr, never stdout', () => {
    // A lifecycle script writing to stdout corrupted `npm pack --json | jq` in
    // the release workflow once already (#417). Same class of script, same rule.
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-chmod-'));
    fs.mkdirSync(path.join(fake, 'dist'));
    fs.mkdirSync(path.join(fake, 'scripts'));
    fs.writeFileSync(path.join(fake, 'dist', 'index.js'), 'x', { mode: 0o644 });
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({
      name: '@origin/cli', bin: { origin: './dist/index.js' },
    }));
    fs.copyFileSync(script, path.join(fake, 'scripts', 'chmod-bin.cjs'));

    const stdout = execFileSync('node', [path.join(fake, 'scripts', 'chmod-bin.cjs')], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(stdout).toBe('');
  });

  it('does not fail the build when the bin is missing', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-chmod-'));
    fs.mkdirSync(path.join(fake, 'scripts'));
    fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({
      name: '@origin/cli', bin: { origin: './dist/index.js' },
    }));
    fs.copyFileSync(script, path.join(fake, 'scripts', 'chmod-bin.cjs'));
    expect(() => execFileSync('node', [path.join(fake, 'scripts', 'chmod-bin.cjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });
});
