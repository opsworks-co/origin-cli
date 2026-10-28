// A background Codex run ended its session at 18:25:32 (2026-10-12), but its
// heartbeat kept pinging until the handler's last step stopped it at 18:26:42.
// The server keeps a session that pings, so the pings after the end revived it
// and the dashboard showed it Running. The heartbeat must stop before the end
// is sent.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('SessionEnd', () => {
  it('stops the heartbeat before it calls api.endSession', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'hooks', 'session-end.ts'), 'utf-8');
    const start = src.indexOf('export async function handleSessionEnd');
    const stop = src.indexOf('stopHeartbeat(state.sessionId)', start);
    const end = src.indexOf('await api.endSession(', start);
    expect(start).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(stop);
  });
});
