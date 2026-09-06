// Five catch blocks sat within a few lines of a write and swallowed its
// failure. Two of them changed what the caller was told:
//
//   • markSessionEnded answered true whether or not the ENDED state reached
//     disk — so a session whose file could not be written was reported closed
//     while its file still said RUNNING, and kept being picked for commit
//     attribution: the zombie the function exists to end.
//   • syncNotesFromRemoteThrottled "proceeded once anyway" when it could not
//     write its stamp. Once per PROCESS — and every session start is its own
//     process, so a read-only home turned every concurrent agent into a
//     concurrent fetch, the stampede the stamp exists to prevent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { markSessionEnded, type SessionState } from '../session-state.js';
import { syncNotesFromRemoteThrottled } from '../git-notes.js';

let tmp = '';
beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'silent-writes-'))); });
afterEach(() => { try { fs.chmodSync(path.join(tmp, 'ro-home'), 0o700); } catch { /* none */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const state = (statePath: string): SessionState => ({
  sessionId: 'sess-1', claudeSessionId: 'c1', agentSlug: 'claude-code', repoPath: tmp, sessionTag: 'c1',
  startedAt: new Date().toISOString(), status: 'RUNNING', prompts: [], __statePath: statePath,
} as unknown as SessionState);

describe('markSessionEnded tells the truth about the write', () => {
  it('returns true when the ENDED state reached the file it was loaded from', () => {
    const p = path.join(tmp, 'origin-session-c1.json');
    fs.writeFileSync(p, '{}');
    const s = state(p);
    expect(markSessionEnded(s)).toBe(true);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).status).toBe('ENDED');
  });

  it('returns false when the file cannot be written — the session is NOT closed', () => {
    // A path whose directory does not exist: the atomic rename has nowhere to land.
    const s = state(path.join(tmp, 'no-such-dir', 'origin-session-c1.json'));
    expect(markSessionEnded(s)).toBe(false);
  });

  it('returns false when there is no file to persist to at all', () => {
    const s = state('');
    (s as unknown as { __statePath?: string }).__statePath = undefined;
    expect(markSessionEnded(s)).toBe(false);
  });
});

describe('syncNotesFromRemoteThrottled without a writable stamp', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips the fetch instead of fetching unthrottled', () => {
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const clone = path.join(tmp, 'clone');
    execFileSync('git', ['init', '-q', clone]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: clone });
    const roHome = path.join(tmp, 'ro-home');
    fs.mkdirSync(roHome);
    fs.chmodSync(roHome, 0o500); // the stamp lives under ~/.origin — unwritable here
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = roHome; process.env.USERPROFILE = roHome;
    try {
      expect(syncNotesFromRemoteThrottled(clone)).toBe(false);
      expect(fs.existsSync(path.join(roHome, '.origin'))).toBe(false);
    } finally {
      process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
    }
  });
});
