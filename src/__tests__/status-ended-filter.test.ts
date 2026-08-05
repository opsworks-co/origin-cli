// Regression: `origin status` listed sessions whose own state file says ENDED.
// User-reported: two `.openclaw/workspace` rows shown as "Active" at 291h/601h
// with 0 prompts — both marked status:ENDED on disk — while genuinely live
// sessions in other repos were invisible. listActiveSessions applied NO filter
// at all (no ENDED check, no staleness, no heartbeat).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { listActiveSessions } from '../session-state.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

describe('listActiveSessions — excludes ENDED sessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-status-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: ENV });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const writeState = (tag: string, state: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, '.git', `origin-session-${tag}.json`), JSON.stringify(state));

  it('omits a session marked ENDED and keeps a RUNNING one', () => {
    writeState('dead', { sessionId: 'dead-1', model: 'claude', status: 'ENDED', startedAt: new Date().toISOString(), prompts: [], repoPath: dir });
    writeState('live', { sessionId: 'live-1', model: 'claude', status: 'RUNNING', startedAt: new Date().toISOString(), prompts: [], repoPath: dir });

    const ids = listActiveSessions(dir).map((s) => s.sessionId);
    expect(ids).toContain('live-1');
    expect(ids).not.toContain('dead-1');
  });

  it('is case-insensitive about the ENDED marker', () => {
    writeState('dead', { sessionId: 'dead-2', model: 'claude', status: 'ended', startedAt: new Date().toISOString(), prompts: [], repoPath: dir });
    expect(listActiveSessions(dir).map((s) => s.sessionId)).not.toContain('dead-2');
  });

  it('keeps sessions with no status field (legacy state files)', () => {
    writeState('legacy', { sessionId: 'legacy-1', model: 'claude', startedAt: new Date().toISOString(), prompts: [], repoPath: dir });
    expect(listActiveSessions(dir).map((s) => s.sessionId)).toContain('legacy-1');
  });
});
