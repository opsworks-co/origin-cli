// Wiring test for the Antigravity CLI integration: installAntigravityHooks
// writes the right `.agents/hooks.json` shape (named "origin" group, Claude-
// Code-style event names routed to `origin hooks antigravity <event>`), is
// idempotent, and preserves unrelated hook groups.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installAntigravityHooks } from '../commands/enable.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-agy-')));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readHooks(): any {
  return JSON.parse(fs.readFileSync(path.join(dir, '.agents', 'hooks.json'), 'utf-8'));
}

describe('installAntigravityHooks', () => {
  it('writes the three events agy actually fires under an "origin" group', () => {
    installAntigravityHooks(dir);
    const cfg = readHooks();

    expect(cfg.origin.enabled).toBe(true);
    // agy only fires Stop / PreToolUse / PostToolUse.
    //
    // Command assertions below match the SUBCOMMAND, not a literal "origin …"
    // prefix: originCmd emits an absolute `"C:\…\node.exe" "…\index.js" hooks …`
    // invocation on Windows (npm's origin.cmd shim spawns a visible console
    // window under GUI agents) and `origin hooks …` on POSIX. Pinning the POSIX
    // spelling made these Windows-failing tests that only ever ran on Linux.
    // Tool-scoped events are GROUPED: { matcher, hooks: [...] }.
    for (const ev of ['PostToolUse', 'PreToolUse']) {
      expect(Array.isArray(cfg.origin[ev])).toBe(true);
      expect(cfg.origin[ev][0].hooks[0].type).toBe('command');
      expect(cfg.origin[ev][0].hooks[0].command as string).toContain('hooks antigravity');
    }
    // Stop is FLAT: handler objects sit directly in the array.
    expect(Array.isArray(cfg.origin.Stop)).toBe(true);
    expect(cfg.origin.Stop[0].type).toBe('command');
    expect(cfg.origin.Stop[0].command as string).toContain('hooks antigravity');

    expect(cfg.origin.PostToolUse[0].hooks[0].command).toContain('antigravity post-tool-use');
    expect(cfg.origin.Stop[0].command).toContain('antigravity stop');
    expect(cfg.origin.PreToolUse[0].hooks[0].command).toContain('antigravity pre-tool-use');
    // The events agy doesn't support must NOT be written.
    expect(cfg.origin.SessionStart).toBeUndefined();
    expect(cfg.origin.UserPromptSubmit).toBeUndefined();
  });

  it('is idempotent — re-running does not duplicate hooks', () => {
    installAntigravityHooks(dir);
    installAntigravityHooks(dir);
    const cfg = readHooks();
    // The origin group is replaced wholesale, so still exactly one hook each.
    expect(cfg.origin.PostToolUse).toHaveLength(1);
    expect(cfg.origin.PostToolUse[0].hooks).toHaveLength(1);
  });

  // Regression: agy validates hooks.json as a whole. A PreToolUse/PostToolUse
  // group with no `matcher`, or a Stop entry wrapped in { hooks: [...] } (which
  // leaves the handler with no `command` — a required field), makes agy discard
  // the ENTIRE file and run no hooks at all. The failure is silent: no error
  // surfaces anywhere, Origin's hook binary is simply never executed, and every
  // Antigravity session goes uncaptured.
  it('gives the tool-scoped events a matcher so agy accepts the file', () => {
    installAntigravityHooks(dir);
    const cfg = readHooks();
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      expect(cfg.origin[ev][0].matcher).toBe('*');
      expect(Array.isArray(cfg.origin[ev][0].hooks)).toBe(true);
    }
  });

  it('writes Stop FLAT — no matcher/hooks wrapper', () => {
    installAntigravityHooks(dir);
    const cfg = readHooks();
    const stop = cfg.origin.Stop[0];
    // The wrapped shape is the bug: `command` would be undefined here.
    expect(typeof stop.command).toBe('string');
    expect(stop.hooks).toBeUndefined();
    expect(stop.matcher).toBeUndefined();
  });

  it('every handler agy will run carries a command string', () => {
    installAntigravityHooks(dir);
    const cfg = readHooks();
    const handlers = [
      ...cfg.origin.PreToolUse.flatMap((g: any) => g.hooks),
      ...cfg.origin.PostToolUse.flatMap((g: any) => g.hooks),
      ...cfg.origin.Stop,
    ];
    expect(handlers).toHaveLength(3);
    for (const h of handlers) expect(typeof h.command).toBe('string');
  });

  it('preserves a pre-existing unrelated hook group', () => {
    fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agents', 'hooks.json'),
      JSON.stringify({ 'safety-gate': { enabled: true, PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './block.sh' }] }] } }, null, 2),
    );
    installAntigravityHooks(dir);
    const cfg = readHooks();
    expect(cfg['safety-gate']).toBeDefined();
    expect(cfg['safety-gate'].PreToolUse[0].hooks[0].command).toBe('./block.sh');
    expect(cfg.origin).toBeDefined();
  });
});
