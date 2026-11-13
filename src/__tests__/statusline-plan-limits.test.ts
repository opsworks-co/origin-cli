import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claudePlanLimits,
  claudePlanType,
  ensureStatusLine,
  isOriginStatusLineCommand,
  uninstallStatusLine,
} from '../commands/statusline.js';

describe('Claude Code plan limits from the status line', () => {
  const now = new Date('2026-10-28T12:00:00Z');

  it('reads the 5-hour and weekly windows', () => {
    const limits = claudePlanLimits({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1793232000 },
        seven_day: { used_percentage: 41.2, resets_at: 1793664000 },
      },
    }, now)!;
    expect(limits.capturedAt).toBe('2026-10-28T12:00:00.000Z');
    expect(limits.windows).toEqual([
      { usedPercent: 23.5, windowMinutes: 300, resetsAt: new Date(1793232000 * 1000).toISOString() },
      { usedPercent: 41.2, windowMinutes: 10080, resetsAt: new Date(1793664000 * 1000).toISOString() },
    ]);
  });

  it('keeps a window that is present when the other has gone', () => {
    expect(claudePlanLimits({ rate_limits: { seven_day: { used_percentage: 5 } } }, now)!.windows).toEqual([{ usedPercent: 5, windowMinutes: 10080 }]);
  });

  it('is undefined on an API-key login, which has no rate_limits', () => {
    expect(claudePlanLimits({ model: { id: 'claude-opus-5-5' } })).toBeUndefined();
    expect(claudePlanLimits(null)).toBeUndefined();
  });

  it('names the plan tier from the account record, best effort', () => {
    expect(claudePlanType({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x', organizationType: 'claude_max' } })).toBe('max_20x');
    expect(claudePlanType({ oauthAccount: { organizationType: 'claude_pro' } })).toBe('pro');
    expect(claudePlanType({})).toBeUndefined();
  });
});

describe('Claude Code status line setup', () => {
  let home: string;
  let prevHome: string | undefined;
  const settingsPath = () => path.join(home, '.claude', 'settings.json');
  const settings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  const CMD = 'origin statusline';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-statusline-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sets the status line, keeps the user\'s other settings, and is a no-op the second time', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ theme: 'dark' }));
    expect(ensureStatusLine(CMD)).toBe(true);
    expect(settings()).toEqual({ theme: 'dark', statusLine: { type: 'command', command: CMD } });
    expect(ensureStatusLine(CMD)).toBe(false);
  });

  it('chains the user\'s own status line and gives it back on uninstall', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const theirs = { type: 'command', command: 'my-line.sh', padding: 1 };
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: theirs }));
    ensureStatusLine(CMD);
    expect(settings().statusLine.command).toBe(CMD);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.origin', 'claude-statusline-chain.json'), 'utf-8'))).toEqual(theirs);
    uninstallStatusLine();
    expect(settings().statusLine).toEqual(theirs);
  });

  it('stays off after uninstall until --install', () => {
    ensureStatusLine(CMD);
    uninstallStatusLine();
    expect(settings().statusLine).toBeUndefined();
    expect(ensureStatusLine(CMD)).toBe(false);
    expect(ensureStatusLine(CMD, { force: true })).toBe(true);
    expect(settings().statusLine.command).toBe(CMD);
  });

  it('never rewrites a settings.json it cannot parse', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ broken');
    expect(ensureStatusLine(CMD)).toBe(false);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ broken');
  });

  it('knows its own Windows command, which has no "origin statusline"', () => {
    const win = 'C:\\PROGRA~1\\nodejs\\node.exe C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js statusline';
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command: win } }));
    expect(ensureStatusLine(win)).toBe(false);
  });

  // Every shape originCmd('origin statusline') writes, and nothing else.
  const OURS = [
    'origin statusline',
    'PATH="/opt/homebrew/bin:$PATH" origin statusline',
    'PATH="/Users/John Smith/.nvm/versions/node/v20.11.0/bin:$PATH" origin statusline',
    'PATH=/usr/local/bin:$PATH origin statusline',
    'C:\\PROGRA~1\\nodejs\\node.exe C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js statusline',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\AppData\\Roaming\\npm\\node_modules\\@origin\\cli\\dist\\index.js" statusline',
    'C:\\Users\\a\\AppData\\Roaming\\npm\\origin.cmd statusline',
    '"C:\\Users\\John Smith\\AppData\\Roaming\\npm\\origin.cmd" statusline',
  ];
  const FOREIGN = [
    'my-origin statusline',
    'echo origin statusline',
    'node /opt/foreign-origin-helper.js statusline',
    'C:\\nodejs\\node.exe C:\\tools\\origin-helper.js statusline',
    'origin statusline --other-tool',
    'my-status-line --short',
  ];

  it.each(OURS)('recognises its own status line: %s', (command) => {
    expect(isOriginStatusLineCommand(command)).toBe(true);
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command } }));
    expect(ensureStatusLine(CMD)).toBe(false);
    uninstallStatusLine();
    expect(settings().statusLine).toBeUndefined();
  });

  it.each(FOREIGN)('leaves a foreign status line byte-for-byte: %s', (command) => {
    expect(isOriginStatusLineCommand(command)).toBe(false);
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const raw = JSON.stringify({ statusLine: { type: 'command', command, padding: 2 } }, null, 2);
    fs.writeFileSync(settingsPath(), raw);
    uninstallStatusLine();
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(raw);
  });
});
