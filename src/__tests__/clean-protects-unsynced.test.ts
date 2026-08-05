// `origin clean` deleted ANY ~/.origin/sessions file older than 24h on
// `startedAt` alone. That destroys work that exists nowhere else:
//   1. a session queued locally because the server was unreachable
//      (`local-*` id, no syncedSessionId) — the status banner tells the user to
//      run `origin sessions sync`; deleting it first loses those prompts;
//   2. a session still RUNNING for >24h — routine for a long agent run — was
//      treated as orphaned and removed out from under the live agent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const OLD = new Date(Date.now() - 72 * 3600 * 1000).toISOString();

describe('clean — never deletes unsynced or live sessions', () => {
  let home: string;
  let sessionsDir: string;
  let spy: any;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-clean-')));
    sessionsDir = path.join(home, '.origin', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  });
  afterEach(() => {
    spy?.mockRestore();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const write = (name: string, state: Record<string, unknown>, ageHours = 72) => {
    const p = path.join(sessionsDir, name);
    fs.writeFileSync(p, JSON.stringify(state));
    const t = Date.now() - ageHours * 3600 * 1000;
    fs.utimesSync(p, t / 1000, t / 1000);
    return p;
  };

  it('keeps an unsynced local-* session and deletes an old ENDED one', async () => {
    const keep = write('local-abc.json', { sessionId: 'local-abc', startedAt: OLD, status: 'RUNNING' });
    const drop = write('ended-1.json', { sessionId: 'ended-1', startedAt: OLD, status: 'ENDED' });
    const { cleanCommand } = await import('../commands/clean.js');
    await cleanCommand({ force: true } as any);
    expect(fs.existsSync(keep)).toBe(true);   // unsynced — never removed
    expect(fs.existsSync(drop)).toBe(false);  // ended + stale — removed
  });

  it('keeps a long-running session whose file was written recently', async () => {
    // started 72h ago but touched 1h ago → still live.
    const live = write('live-1.json', { sessionId: 'srv-live', startedAt: OLD, status: 'RUNNING' }, 1);
    const { cleanCommand } = await import('../commands/clean.js');
    await cleanCommand({ force: true } as any);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('still removes a RUNNING session that has been idle for days (true orphan)', async () => {
    const orphan = write('orphan-1.json', { sessionId: 'srv-orphan', startedAt: OLD, status: 'RUNNING' }, 72);
    const { cleanCommand } = await import('../commands/clean.js');
    await cleanCommand({ force: true } as any);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});
