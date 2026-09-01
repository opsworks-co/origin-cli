// Gemini had no TOOL-level hooks wired, so every file a Gemini session wrote
// was attributed by the turn window — i.e. by whatever happened to be dirty,
// which in a shared checkout is also a sibling agent's work. No per-command
// evidence was possible for it at all.
//
// The event names matter more than they look. Gemini's own `HookEventName`
// enum is BeforeTool / AfterTool / BeforeAgent / AfterAgent / SessionStart /
// SessionEnd / PreCompress / BeforeModel / AfterModel / BeforeToolSelection.
// `PreToolUse` exists ONLY inside `hooks migrate`'s EVENT_MAPPING as a
// Claude-Code alias it converts FROM — writing that spelling registers nothing
// and fails silently, which is exactly how the Antigravity schema bug behaved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installGeminiHooks } from '../commands/enable.js';

let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-gem-'))); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// Gemini keeps hooks inside `.gemini/settings.json` under `hooks`, gated by
// `hooksConfig.enabled` — not in a standalone hooks.json.
function readHooks(): any {
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.gemini', 'settings.json'), 'utf-8'));
  expect(settings.hooksConfig?.enabled, 'hooks must be enabled or none of them fire').toBe(true);
  return settings.hooks;
}

describe('installGeminiHooks — tool-level events', () => {
  it('registers BeforeTool and AfterTool', () => {
    installGeminiHooks(dir);
    const events = readHooks();
    expect(Array.isArray(events.BeforeTool)).toBe(true);
    expect(Array.isArray(events.AfterTool)).toBe(true);
  });

  it('routes them to the shared pre/post-tool-use handlers', () => {
    installGeminiHooks(dir);
    const events = readHooks();
    expect(events.BeforeTool[0].hooks[0].command).toContain('hooks gemini pre-tool-use');
    expect(events.AfterTool[0].hooks[0].command).toContain('hooks gemini post-tool-use');
  });

  it('does NOT use the Claude-Code spelling, which Gemini ignores', () => {
    installGeminiHooks(dir);
    const events = readHooks();
    expect(events.PreToolUse).toBeUndefined();
    expect(events.PostToolUse).toBeUndefined();
  });

  it('keeps the lifecycle hooks it already had', () => {
    installGeminiHooks(dir);
    const events = readHooks();
    for (const e of ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent']) {
      expect(events[e], `${e} must survive`).toBeDefined();
    }
  });
});
