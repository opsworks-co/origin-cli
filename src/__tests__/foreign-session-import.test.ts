/**
 * `origin sessions import` must only clear the dashboard banner + web intent
 * when the import ACTUALLY drains the foreign set. If the agent is disabled or
 * the server is unreachable, the un-uploaded sessions are reverted to their
 * original foreign owner so they stay claimable and the banner persists — the
 * regression from PR #421 where a blocked/offline import silently cleared the
 * intent and stranded the work with no signal.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// A temp HOME so ~/.origin/sessions points at a scratch dir. Hoisted so the
// os mock (also hoisted) can close over it. process.pid keeps it unique per run
// without Math.random (unavailable in this environment).
const { TEST_HOME } = vi.hoisted(() => {
  const base = process.env.TMPDIR || process.env.TMP || '/tmp';
  return { TEST_HOME: `${base.replace(/\/$/, '')}/origin-foreign-import-${process.pid}` };
});

vi.mock('os', async (orig) => {
  const actual = (await orig()) as typeof import('os');
  const homedir = () => TEST_HOME;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('../config.js', async (orig) => ({
  ...((await orig()) as object),
  isConnectedMode: () => true,
  loadAgentConfig: () => ({ machineId: 'm1', hostname: 'h1' }),
  // currentOwner() derives the active account from here.
  loadConfig: () => ({ apiKey: 'current-key', orgId: 'org-current' }),
}));

vi.mock('../api.js', async (orig) => ({
  ...((await orig()) as object),
  api: {
    startSession: vi.fn(),
    endSession: vi.fn(),
    reportUnimportedSessions: vi.fn(),
  },
}));

import { sessionsImportCommand, processPendingForeignAction } from '../commands/sessions.js';
import { api } from '../api.js';

const startSession = api.startSession as ReturnType<typeof vi.fn>;
const endSession = api.endSession as ReturnType<typeof vi.fn>;
const reportUnimported = api.reportUnimportedSessions as ReturnType<typeof vi.fn>;

const SESSIONS_DIR = path.join(TEST_HOME, '.origin', 'sessions');

// A queued local-* session owned by a DIFFERENT account (foreign to the
// active "org-current" owner).
function writeForeign(file: string): void {
  const state = {
    sessionId: `local-${file}`,
    model: 'claude-fable-5',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1000).toISOString(),
    prompts: [{ text: 'hello' }],
    repoPath: TEST_HOME,
    ownerOrgId: 'org-OLD',
    ownerKeyHash: 'oldhash0000000000',
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${file}.json`), JSON.stringify(state), { mode: 0o600 });
}

function readState(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${file}.json`), 'utf-8'));
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.origin'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  startSession.mockReset();
  endSession.mockReset().mockResolvedValue({});
  reportUnimported.mockReset().mockResolvedValue({ pendingAction: null });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('sessionsImportCommand', () => {
  it('drains and clears the intent when every session uploads', async () => {
    writeForeign('a');
    startSession.mockResolvedValue({ sessionId: 'real-a' });

    const res = await sessionsImportCommand();

    expect(res).toMatchObject({ synced: 1, blocked: 0, failed: 0, cleared: true });
    // File removed after a successful upload.
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(false);
    // Intent cleared (clearAction=true) with the drained count of 0.
    expect(reportUnimported).toHaveBeenLastCalledWith(0, true);
  });

  it('does NOT clear the intent when the agent is disabled, and reverts the session to foreign', async () => {
    writeForeign('a');
    startSession.mockRejectedValue({ code: 'AGENT_DISABLED' });

    const res = await sessionsImportCommand();

    expect(res).toMatchObject({ blocked: 1, cleared: false });
    // File kept on disk...
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(true);
    // ...and reverted to its ORIGINAL foreign owner so it stays claimable.
    expect(readState('a')).toMatchObject({ ownerOrgId: 'org-OLD', ownerKeyHash: 'oldhash0000000000' });
    // Intent NOT cleared; count reported reflects the still-foreign session.
    expect(reportUnimported).toHaveBeenLastCalledWith(1, false);
    expect(reportUnimported).not.toHaveBeenCalledWith(expect.anything(), true);
  });

  it('reverts only the un-uploaded session on a partial import', async () => {
    writeForeign('a');
    writeForeign('b');
    // 'a' uploads, 'b' is blocked.
    startSession
      .mockResolvedValueOnce({ sessionId: 'real-a' })
      .mockRejectedValueOnce({ code: 'AGENT_DISABLED' });

    const res = await sessionsImportCommand();

    expect(res).toMatchObject({ synced: 1, blocked: 1, cleared: false });
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(false); // uploaded
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'b.json'))).toBe(true);  // kept
    expect(readState('b')).toMatchObject({ ownerOrgId: 'org-OLD' });      // reverted to foreign
    expect(reportUnimported).toHaveBeenLastCalledWith(1, false);          // 1 foreign remains, no clear
  });

  it('clears the intent on the no-op case (nothing local to import)', async () => {
    // No foreign sessions on this machine (e.g. choice made on another machine).
    const res = await sessionsImportCommand();

    expect(res.cleared).toBe(true);
    expect(reportUnimported).toHaveBeenCalledWith(0, true);
  });
});

describe('processPendingForeignAction', () => {
  it('never clears the intent when a web-initiated import is blocked', async () => {
    writeForeign('a');
    startSession.mockRejectedValue({ code: 'AGENT_DISABLED' });
    // Probe returns the web intent; subsequent reports return null pendingAction.
    reportUnimported
      .mockResolvedValueOnce({ pendingAction: 'import' })
      .mockResolvedValue({ pendingAction: null });

    await processPendingForeignAction();

    // The session is still foreign and the intent was never cleared (no
    // clearAction=true), so the next status will retry.
    expect(fs.existsSync(path.join(SESSIONS_DIR, 'a.json'))).toBe(true);
    expect(readState('a')).toMatchObject({ ownerOrgId: 'org-OLD' });
    expect(reportUnimported).not.toHaveBeenCalledWith(expect.anything(), true);
  });
});
