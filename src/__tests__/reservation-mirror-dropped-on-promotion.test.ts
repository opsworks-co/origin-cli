// A session-start reservation left its mirror behind forever.
//
// session-start saves a provisional `local-<uuid>` row before calling
// `session/start` so a concurrent hook adopts it instead of minting a second
// session. `saveSessionState` mirrors every save to ~/.origin/sessions under
// the SESSION ID, so the reservation lands as `local-…json`; the registered id
// is then saved under its own name, and nothing ever removed the first file.
// This machine had 40 of them beside 95 real sessions — every one RUNNING with
// `pendingRegistration: true`, listed by `origin sessions --all` as live.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveSessionState, dropSessionMirror, type SessionState } from '../session-state.js';

const mirrorDir = () => path.join(os.homedir(), '.origin', 'sessions');

function state(sessionId: string): SessionState {
  return {
    sessionId,
    sessionTag: 'tag-abc',
    prompts: [],
    startedAt: new Date().toISOString(),
    repoPath: '/tmp/nowhere',
    status: 'RUNNING',
  } as unknown as SessionState;
}

describe('the reservation mirror is dropped once the session is registered', () => {
  it('a promotion leaves exactly one mirror, under the registered id', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mirror-'));
    fs.mkdirSync(path.join(repo, '.git'));
    const reserved = 'local-11111111-2222-3333-4444-555555555555';
    const registered = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    saveSessionState(state(reserved), repo, 'tag-abc');
    expect(fs.existsSync(path.join(mirrorDir(), `${reserved.slice(0, 12)}.json`))).toBe(true);

    // What session-start does after `session/start` answers.
    saveSessionState(state(registered), repo, 'tag-abc');
    dropSessionMirror(reserved);

    const mirrors = fs.readdirSync(mirrorDir()).filter((f) => f.endsWith('.json'));
    expect(mirrors).toContain(`${registered.slice(0, 12)}.json`);
    expect(mirrors).not.toContain(`${reserved.slice(0, 12)}.json`);
  });

  it('is a no-op for an id that was never mirrored', () => {
    expect(() => dropSessionMirror('local-never-existed')).not.toThrow();
    expect(() => dropSessionMirror(undefined)).not.toThrow();
  });
});
