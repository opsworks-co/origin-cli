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
    const events = ['PostToolUse', 'Stop', 'PreToolUse'];
    for (const ev of events) {
      expect(Array.isArray(cfg.origin[ev])).toBe(true);
      const cmd = cfg.origin[ev][0].hooks[0].command as string;
      expect(cfg.origin[ev][0].hooks[0].type).toBe('command');
      expect(cmd).toContain('origin hooks antigravity');
    }
    expect(cfg.origin.PostToolUse[0].hooks[0].command).toContain('antigravity post-tool-use');
    expect(cfg.origin.Stop[0].hooks[0].command).toContain('antigravity stop');
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
