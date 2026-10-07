/**
 * A promoted session still owns the commits it made under its `local-` id.
 *
 * A standalone or failed start runs as `local-<uuid>`, and prepare-commit-msg
 * stamps `Origin-Session: local-<6 hex> | …` into every commit made meanwhile.
 * When the session later reaches the server it takes a server id. #2032 made
 * the SERVER keep the old id (`localSessionId`); the CLI's ownership checks
 * still compared trailers against the current id only, so after promotion the
 * session's own early commits read as another session's ('other') — refused
 * outright when the record was missing (a GitHub squash of the session's own
 * PR, a post-commit that stalled), and kept out of the claim walk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  commitBelongsToSession, commitTrailerBelongsToSession, trailerNamesAKnownSession, trailerNamesSessionTurn,
} from '../commands/hooks.js';
import { trailerNamesSession } from '../claim-commits-made-before-registration.js';
import { adoptRegisteredReservation, getStatePath, rememberLocalSessionId } from '../session-state.js';
import { carryForwardTurnState } from '../session-dedup.js';

const LOCAL_ID = 'local-3f9a1c42-7d1e-4b6a-9c0d-5e8f2a1b3c4d';
const SERVER_ID = '9b2c4e6a-1f3d-4a5b-8c7d-0e1f2a3b4c5d';
const SIBLING_LOCAL = 'local-77aa00bb-1111-4222-8333-444455556666';
const SIBLING_SERVER = 'a1a1a1a1-2222-4333-8444-555566667777';
// buildOriginTrailers: the id truncated to 12 characters.
const localTrailer = (id: string, extra = '') => `feat: early work\n\nOrigin-Session: ${id.slice(0, 12)} | Claude Code | 1 prompt${extra}\n`;

const promoted = { sessionId: SERVER_ID, localSessionId: LOCAL_ID };

describe('trailer matchers — a promoted session answers to its local id', () => {
  it("commitTrailerBelongsToSession: the session's own local trailer is 'self'", () => {
    expect(commitTrailerBelongsToSession(localTrailer(LOCAL_ID), promoted)).toBe('self');
  });

  it('matches the local id case-insensitively, like the server', () => {
    expect(commitTrailerBelongsToSession(localTrailer(LOCAL_ID.toUpperCase().replace('LOCAL-', 'local-')), promoted)).toBe('self');
    expect(commitTrailerBelongsToSession(localTrailer(LOCAL_ID), { sessionId: SERVER_ID, localSessionId: LOCAL_ID.toUpperCase() })).toBe('self');
  });

  it("a DIFFERENT session's local trailer is still 'other'", () => {
    expect(commitTrailerBelongsToSession(localTrailer(SIBLING_LOCAL), promoted)).toBe('other');
  });

  it("without a local id the old behaviour stands: a local trailer is 'other'", () => {
    expect(commitTrailerBelongsToSession(localTrailer(LOCAL_ID), { sessionId: SERVER_ID })).toBe('other');
  });

  it('trailerNamesSessionTurn reads the local id as this session', () => {
    expect(trailerNamesSessionTurn(localTrailer(LOCAL_ID, ' | turn 2'), promoted, 2)).toBe(true);
    expect(trailerNamesSessionTurn(localTrailer(SIBLING_LOCAL, ' | turn 2'), promoted, 2)).toBe(false);
  });

  it('trailerNamesSession (the claim walk) accepts every id the session answers to', () => {
    expect(trailerNamesSession(localTrailer(LOCAL_ID), [SERVER_ID, LOCAL_ID])).toBe(true);
    expect(trailerNamesSession(localTrailer(LOCAL_ID), [SERVER_ID, undefined])).toBe(false);
    expect(trailerNamesSession(localTrailer(SIBLING_LOCAL), [SERVER_ID, LOCAL_ID])).toBe(false);
    // The single-id form is unchanged.
    expect(trailerNamesSession(localTrailer(LOCAL_ID), LOCAL_ID)).toBe(true);
  });
});

describe('rememberLocalSessionId', () => {
  it('records the local id the session is leaving', () => {
    const s: { sessionId: string; localSessionId?: string } = { sessionId: SERVER_ID };
    rememberLocalSessionId(s, LOCAL_ID);
    expect(s.localSessionId).toBe(LOCAL_ID);
  });
  it('ignores a server id (a re-mint) and a no-op rename, and keeps the first local id', () => {
    const s: { sessionId: string; localSessionId?: string } = { sessionId: SERVER_ID };
    rememberLocalSessionId(s, 'ffffffff-0000-4000-8000-000000000000');
    expect(s.localSessionId).toBeUndefined();
    const stillLocal: { sessionId: string; localSessionId?: string } = { sessionId: LOCAL_ID };
    rememberLocalSessionId(stillLocal, LOCAL_ID);
    expect(stillLocal.localSessionId).toBeUndefined();
    const kept: { sessionId: string; localSessionId?: string } = { ...promoted };
    rememberLocalSessionId(kept, SIBLING_LOCAL);
    expect(kept.localSessionId).toBe(LOCAL_ID);
  });
  it('carryForwardTurnState keeps it when a duplicate state file is folded in', () => {
    const fresh: any = { sessionId: SERVER_ID, prompts: [] };
    carryForwardTurnState(fresh, { sessionId: SERVER_ID, localSessionId: LOCAL_ID, prompts: ['a'] });
    expect(fresh.localSessionId).toBe(LOCAL_ID);
  });
});

describe('commitBelongsToSession / trailerNamesAKnownSession on a real repo', () => {
  const ME = 't@origin.dev';
  let repo: string;
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
  function commit(message: string, committerEmail = ME): string {
    fs.appendFileSync(path.join(repo, 'f.txt'), `${message.split('\n')[0]}\n`);
    git(['add', '.']);
    git(['commit', '-q', '-m', message], { GIT_COMMITTER_EMAIL: committerEmail, GIT_COMMITTER_NAME: 'X' });
    return git(['rev-parse', 'HEAD']);
  }
  function writeState(state: Record<string, unknown>): void {
    const tag = String(state.sessionTag);
    fs.writeFileSync(path.join(repo, '.git', `origin-session-${tag}.json`), JSON.stringify({ repoPath: repo, ...state }));
  }

  beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-local-id-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', ME]);
    git(['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'seed\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("owns GitHub's squash of its own PR, trailered with its local id, though nothing recorded it", () => {
    // The squash keeps the PR commits' trailers in its body; GitHub commits it.
    const sha = commit(`feat: early work (#12)\n\n* feat: early work\n\nOrigin-Session: ${LOCAL_ID.slice(0, 12)} | Claude Code | 1 prompt`, 'noreply@github.com');
    const state: any = { sessionId: SERVER_ID, localSessionId: LOCAL_ID, repoPath: repo, sessionCommitShas: [] };
    expect(commitBelongsToSession(repo, sha, state, ME)).toBe(true);
    // The same commit is still refused by a session that never had that id.
    expect(commitBelongsToSession(repo, sha, { ...state, localSessionId: undefined }, ME)).toBe(false);
  });

  it("owns its own local-trailered commit that post-commit never recorded", () => {
    const sha = commit(localTrailer(LOCAL_ID).trim());
    const state: any = { sessionId: SERVER_ID, localSessionId: LOCAL_ID, repoPath: repo, sessionCommitShas: [] };
    expect(commitBelongsToSession(repo, sha, state, ME)).toBe(true);
  });

  it("a promoted SIBLING's local trailer is that sibling's commit, not a stale one", () => {
    writeState({ sessionId: SIBLING_SERVER, sessionTag: 'sibling-tag-1', localSessionId: SIBLING_LOCAL, status: 'RUNNING' });
    const body = localTrailer(SIBLING_LOCAL);
    expect(trailerNamesAKnownSession(repo, body, { sessionId: SERVER_ID, localSessionId: LOCAL_ID } as any)).toBe(true);
    const sha = commit(body.trim());
    // Recorded by us (a wrong post-commit guess) — the sibling's trailer wins.
    const state: any = { sessionId: SERVER_ID, localSessionId: LOCAL_ID, repoPath: repo, sessionCommitShas: [sha] };
    expect(commitBelongsToSession(repo, sha, state, ME)).toBe(false);
  });

  it('a hook that adopts the id session-start registered keeps the provisional one', () => {
    fs.writeFileSync(getStatePath(repo, 'conv-tag-1'), JSON.stringify({ sessionId: SERVER_ID, sessionTag: 'conv-tag-1', repoPath: repo }));
    const held: any = { sessionId: LOCAL_ID, sessionTag: 'conv-tag-1', repoPath: repo, pendingRegistration: true };
    expect(adoptRegisteredReservation(held, repo, 'conv-tag-1')).toEqual({ from: LOCAL_ID, to: SERVER_ID });
    expect(held.localSessionId).toBe(LOCAL_ID);
  });

  it('a leftover row still holding OUR local id is not a sibling', () => {
    writeState({ sessionId: LOCAL_ID, sessionTag: 'reservation-1', status: 'RUNNING' });
    expect(trailerNamesAKnownSession(repo, localTrailer(LOCAL_ID), { sessionId: SERVER_ID, localSessionId: LOCAL_ID } as any)).toBe(false);
  });
});
