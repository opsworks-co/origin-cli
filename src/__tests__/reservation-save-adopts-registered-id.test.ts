// A hook that adopted a session-start reservation keeps writing the copy it
// READ. Prod 2026-09-09, one Cursor chat: user-prompt-submit read the
// reservation (`local-82aaa929`, pendingRegistration) 150ms before
// session-start saved the registered id `5431ff0f`, restamped its copy onto
// the worktree, and wrote `local-…` straight back over the registered row. Its
// migration then minted `e24477e2` for the same chat.
//
// saveSessionState is the one choke point every hook goes through, so the
// re-read lives there: a pending reservation is checked against the file
// before it is written, and a registered id on disk wins.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { saveSessionState, readStateAtTag, loadSessionState, type SessionState } from '../session-state.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const TAG = 'f9213cfd-349';
let repo: string;
const stateFile = () => path.join(repo, '.git', `origin-session-${TAG}.json`);
const mirror = (id: string) => path.join(os.homedir(), '.origin', 'sessions', `${id.slice(0, 12)}.json`);

/** Exactly what session-start writes before its network call. */
function reservation(over: Record<string, unknown> = {}): SessionState {
  return {
    sessionId: 'local-82aaa929-c103-40aa-8231-d9659ca432e7',
    sessionTag: TAG,
    claudeSessionId: '',
    agentSessionId: 'f9213cfd-3494-476f-9249-b18716835b7a',
    model: 'cursor-grok-4.6-high',
    agentSlug: 'cursor',
    repoPath: repo,
    canonicalRepoPath: repo,
    lastCwd: repo,
    branch: 'main',
    startedAt: new Date().toISOString(),
    prompts: [],
    status: 'RUNNING',
    pendingRegistration: true,
    ...over,
  } as unknown as SessionState;
}

const writeFile = (state: SessionState) => fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
const readFile = () => JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-reservation-save-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: ENV });
  repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env: ENV, encoding: 'utf-8' }).trim();
  fs.mkdirSync(path.join(os.homedir(), '.origin', 'sessions'), { recursive: true });
  for (const id of ['local-82aaa929-c103-40aa-8231-d9659ca432e7', 'srv-5431ff0f']) {
    try { fs.unlinkSync(mirror(id)); } catch { /* clean */ }
  }
});

describe('readStateAtTag', () => {
  it('reads a Cursor row, whose claudeSessionId is empty — loadSessionState does not', () => {
    writeFile(reservation());
    expect(loadSessionState(repo, TAG)).toBeNull();
    expect(readStateAtTag(repo, TAG)?.sessionId).toBe('local-82aaa929-c103-40aa-8231-d9659ca432e7');
  });
});

describe('saveSessionState on a pending reservation', () => {
  it('writes under the id session-start registered meanwhile, keeping the adopter\'s work', () => {
    // 1. session-start reserves; the prompt hook reads that.
    writeFile(reservation());
    const held = reservation();
    // 2. session-start's call returns and it saves its full row.
    writeFile(reservation({
      sessionId: 'srv-5431ff0f', pendingRegistration: undefined,
      headShaAtStart: 'main-head', sessionStartShadowSha: 'main-shadow',
      enforcementRules: [{ id: 'r1' }], agentSystemPrompt: 'be good', previousSessionId: 'srv-prev',
    }));
    // 3. The prompt hook, still holding the reservation, adopts it and saves.
    held.prompts = ['pull latest changes'];
    held.agentSessionId = 'da82f522-f0ad-4837-92ed-fb09dbf80390';
    held.branch = 'cursor/f9213cfd';
    saveSessionState(held, repo, TAG);

    const onDisk = readFile();
    expect(onDisk.sessionId, 'the registered id must survive the stale write').toBe('srv-5431ff0f');
    expect(onDisk.pendingRegistration).toBeUndefined();
    expect(onDisk.prompts).toEqual(['pull latest changes']);
    expect(onDisk.agentSessionId).toBe('da82f522-f0ad-4837-92ed-fb09dbf80390');
    expect(onDisk.branch).toBe('cursor/f9213cfd');
    // What only registration produced comes across from the row being replaced.
    expect(onDisk.enforcementRules).toEqual([{ id: 'r1' }]);
    expect(onDisk.agentSystemPrompt).toBe('be good');
    expect(onDisk.previousSessionId).toBe('srv-prev');
    expect(onDisk.headShaAtStart).toBe('main-head');
    expect(onDisk.sessionStartShadowSha).toBe('main-shadow');
    // The caller continues on the registered id too.
    expect(held.sessionId).toBe('srv-5431ff0f');
    expect((held as unknown as { pendingRegistration?: boolean }).pendingRegistration).toBeUndefined();
    // Mirror keyed by the registered id; the placeholder's mirror is gone.
    expect(fs.existsSync(mirror('srv-5431ff0f'))).toBe(true);
    expect(fs.existsSync(mirror('local-82aaa929-c103-40aa-8231-d9659ca432e7'))).toBe(false);
  });

  it('keeps the placeholder while session-start is still registering', () => {
    writeFile(reservation());
    const held = reservation({ prompts: ['hi'] });
    saveSessionState(held, repo, TAG);
    const onDisk = readFile();
    expect(onDisk.sessionId).toBe('local-82aaa929-c103-40aa-8231-d9659ca432e7');
    expect(onDisk.pendingRegistration).toBe(true);
    expect(onDisk.prompts).toEqual(['hi']);
  });

  it('drops the flag once session-start settled on local (its call failed)', () => {
    writeFile(reservation({ pendingRegistration: undefined }));
    const held = reservation({ prompts: ['hi'] });
    saveSessionState(held, repo, TAG);
    const onDisk = readFile();
    expect(onDisk.sessionId).toBe('local-82aaa929-c103-40aa-8231-d9659ca432e7');
    expect(onDisk.pendingRegistration, 'a stale copy must not re-arm a settled reservation').toBeUndefined();
  });

  it('never swaps a registered id for another (a row that is not a reservation is left alone)', () => {
    writeFile(reservation({ sessionId: 'srv-other', pendingRegistration: undefined }));
    const held = reservation({ sessionId: 'srv-mine', pendingRegistration: undefined });
    saveSessionState(held, repo, TAG);
    expect(readFile().sessionId).toBe('srv-mine');
  });
});
