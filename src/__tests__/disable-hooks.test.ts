/**
 * `origin disable` must remove the hooks `origin enable` wrote.
 *
 * enable writes every agent hook as `PATH="<binDir>:$PATH" origin hooks <agent> …`
 * (posixPathShim), but disable's filters kept only entries that did NOT
 * `startsWith('origin hooks')` — so the prefixed form survived, disable printed
 * "No Origin hooks found", and the hooks went on firing. Claude Code's status
 * line (`origin statusline`) was left behind too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// disable archives the session state of the cwd's repo; under test that would
// be this checkout, so keep it away from the real state.
vi.mock('../session-state.js', async (orig) => ({
  ...(await orig<typeof import('../session-state.js')>()),
  clearSessionState: vi.fn(),
}));

import { disableCommand } from '../commands/disable.js';

const PREFIXED = 'PATH="/opt/homebrew/bin:$PATH" origin hooks claude-code session-start';
const SPACED = 'PATH="/Users/John Smith/.nvm/versions/node/v22/bin:$PATH" origin hooks claude-code stop';
const BARE = 'origin hooks claude-code user-prompt-submit';
const FOREIGN_HOOK = 'my-linter --on-stop';
const FOREIGN_STATUSLINE = { type: 'command', command: 'my-status-line --short' };

describe('origin disable --global removes the hooks enable wrote', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  let log: string[];

  const file = (...p: string[]) => path.join(home, ...p);
  const readJson = (...p: string[]) => JSON.parse(fs.readFileSync(file(...p), 'utf-8'));
  const writeJson = (rel: string[], value: unknown) => {
    fs.mkdirSync(path.dirname(file(...rel)), { recursive: true });
    fs.writeFileSync(file(...rel), JSON.stringify(value, null, 2) + '\n');
  };
  const nested = (...commands: string[]) => commands.map((command) => ({ hooks: [{ type: 'command', command }] }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-disable-'));
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL']) saved[k] = process.env[k];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = file('.config');
    process.env.GIT_CONFIG_GLOBAL = file('.gitconfig');
    log = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { log.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removes prefixed, space-quoted and bare Origin hooks and keeps a foreign hook', async () => {
    writeJson(['.claude', 'settings.json'], {
      hooks: {
        SessionStart: nested(PREFIXED),
        Stop: [{ hooks: [{ type: 'command', command: SPACED }, { type: 'command', command: FOREIGN_HOOK }] }],
        UserPromptSubmit: nested(BARE),
      },
    });

    await disableCommand({ global: true });

    expect(readJson('.claude', 'settings.json')).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: FOREIGN_HOOK }] }] },
    });
    expect(log.join('\n')).toContain('Removed Origin hooks from ~/.claude/settings.json');
    expect(log.join('\n')).not.toContain('No Origin hooks found');
  });

  it('cleans every agent config enable writes to, in the prefixed form', async () => {
    const shim = (agent: string, event: string) => `PATH="/opt/homebrew/bin:$PATH" origin hooks ${agent} ${event}`;
    writeJson(['.gemini', 'settings.json'], { hooks: { SessionStart: nested(shim('gemini', 'session-start')) }, theme: 'x' });
    writeJson(['.codex', 'hooks.json'], { hooks: { Stop: nested(shim('codex', 'stop')) } });
    writeJson(['.cursor', 'hooks.json'], { version: 1, hooks: { stop: [{ command: shim('cursor', 'stop') }] } });
    writeJson(['.devin', 'hooks.v1.json'], { SessionStart: nested(shim('devin', 'session-start')) });

    await disableCommand({ global: true });

    expect(readJson('.gemini', 'settings.json')).toEqual({ theme: 'x' });
    expect(readJson('.codex', 'hooks.json')).toEqual({});
    expect(readJson('.cursor', 'hooks.json')).toEqual({ version: 1 });
    expect(readJson('.devin', 'hooks.v1.json')).toEqual({});
  });

  it("keeps other tools' `<tool> hooks <agent>` entries — only Origin's launcher counts", async () => {
    const foreign = [
      'entire hooks claude-code stop',
      '/usr/local/bin/mytool hooks cursor stop',
      'my-origin hooks claude-code x',
    ];
    writeJson(['.claude', 'settings.json'], { hooks: { Stop: nested(PREFIXED, ...foreign) } });
    writeJson(['.gemini', 'settings.json'], { hooks: { Stop: nested(...foreign) } });
    writeJson(['.codex', 'hooks.json'], { hooks: { Stop: nested(...foreign) } });
    writeJson(['.cursor', 'hooks.json'], { version: 1, hooks: { stop: foreign.map((command) => ({ command })) } });

    await disableCommand({ global: true });

    expect(readJson('.claude', 'settings.json')).toEqual({ hooks: { Stop: nested(...foreign) } });
    expect(readJson('.gemini', 'settings.json')).toEqual({ hooks: { Stop: nested(...foreign) } });
    expect(readJson('.codex', 'hooks.json')).toEqual({ hooks: { Stop: nested(...foreign) } });
    expect(readJson('.cursor', 'hooks.json')).toEqual({ version: 1, hooks: { stop: foreign.map((command) => ({ command })) } });
  });

  it("removes Origin's status line and puts back the one it chained", async () => {
    writeJson(['.claude', 'settings.json'], {
      statusLine: { type: 'command', command: 'PATH="/opt/homebrew/bin:$PATH" origin statusline' },
    });
    writeJson(['.origin', 'claude-statusline-chain.json'], FOREIGN_STATUSLINE);

    await disableCommand({ global: true });

    expect(readJson('.claude', 'settings.json')).toEqual({ statusLine: FOREIGN_STATUSLINE });
    expect(fs.existsSync(file('.origin', 'claude-statusline-chain.json'))).toBe(false);
    // disable is not a permanent opt-out: a later enable installs it again.
    expect(fs.existsSync(file('.origin', 'claude-statusline-off'))).toBe(false);
    expect(log.join('\n')).not.toContain('No Origin hooks found');
  });

  it('leaves a status line that is not Origin\'s alone', async () => {
    writeJson(['.claude', 'settings.json'], { statusLine: FOREIGN_STATUSLINE });

    await disableCommand({ global: true });

    expect(readJson('.claude', 'settings.json')).toEqual({ statusLine: FOREIGN_STATUSLINE });
  });

  it.each([
    'my-origin statusline',
    'echo origin statusline',
    'node /opt/foreign-origin-helper.js statusline',
  ])('leaves a foreign status line that only looks like Origin\'s alone: %s', async (command) => {
    const theirs = { type: 'command', command, padding: 0, refreshInterval: 5 };
    writeJson(['.claude', 'settings.json'], { statusLine: theirs });
    writeJson(['.origin', 'claude-statusline-chain.json'], FOREIGN_STATUSLINE);
    const before = fs.readFileSync(file('.claude', 'settings.json'), 'utf-8');

    await disableCommand({ global: true });

    expect(fs.readFileSync(file('.claude', 'settings.json'), 'utf-8')).toBe(before);
    expect(readJson('.origin', 'claude-statusline-chain.json')).toEqual(FOREIGN_STATUSLINE);
  });

  it('a second disable is a no-op', async () => {
    writeJson(['.claude', 'settings.json'], {
      statusLine: { type: 'command', command: 'origin statusline' },
      hooks: { SessionStart: nested(PREFIXED, FOREIGN_HOOK) },
    });

    await disableCommand({ global: true });
    const after = fs.readFileSync(file('.claude', 'settings.json'), 'utf-8');
    log = [];
    await disableCommand({ global: true });

    expect(fs.readFileSync(file('.claude', 'settings.json'), 'utf-8')).toBe(after);
    expect(JSON.parse(after)).toEqual({ hooks: { SessionStart: nested(FOREIGN_HOOK) } });
    expect(log.join('\n')).toContain('No Origin hooks found');
  });
});
