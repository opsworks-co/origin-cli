// `origin doctor --fix` DELETES. It writes a zeroed `ended` record over a
// session and clears its state, and it permanently unlinks session files.
//
// It decided both from AGE alone. A doctor run listed the very session that was
// running it — 19 prompts in, transcript touched seconds earlier — as "stuck,
// 5.9h", next to a second live agent at 16 prompts. Nothing about an hour
// elapsed says a conversation is over; long sessions are the normal shape of
// this work.
//
// These tests pin the direction that costs something. A zombie surviving an
// extra sweep is a stale row the server's own no-ping sweep clears; a live
// session deleted is a conversation's history gone, so every ambiguous signal
// must resolve to "keep".
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { doctorLivenessInputs, isNeverUploaded, looksActiveNow } from '../commands/doctor.js';
import { parentLooksDead, HOOK_DRIVEN_IDLE_MS } from '../heartbeat-liveness.js';

function transcriptAged(minutesOld: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-doctor-live-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, '{}\n');
  const when = new Date(Date.now() - minutesOld * 60_000);
  fs.utimesSync(p, when, when);
  return p;
}

const session = (over: Record<string, any> = {}): any => ({
  agentSlug: 'claude-code',
  repoPath: '/nonexistent/repo',
  sessionTag: 'deadbeef-000',
  transcriptPath: undefined,
  ...over,
});

describe('doctor liveness — a live session is never "stuck"', () => {
  it('treats a warm transcript as proof of life, however old the session', () => {
    // The exact case that was misfiring: hours old, actively writing.
    const st = session({ transcriptPath: transcriptAged(0) });
    expect(parentLooksDead(doctorLivenessInputs(st))).toBe(false);
  });

  it('still counts a genuinely idle session as dead', () => {
    // The other direction — the guard must not be so cautious it never fires,
    // or `doctor` reports issues it can never clean.
    const st = session({ transcriptPath: transcriptAged(HOOK_DRIVEN_IDLE_MS / 60_000 + 30) });
    expect(parentLooksDead(doctorLivenessInputs(st))).toBe(true);
  });

  it('does not read a MISSING transcript as death', () => {
    // An unstattable path is no signal at all. Letting it mean "dead" is how a
    // live conversation gets deleted for a reason unrelated to whether it's live.
    const st = session({ transcriptPath: '/does/not/exist/transcript.jsonl' });
    const inputs = doctorLivenessInputs(st);
    expect(inputs.transcriptStale).toBe(false);
    expect(parentLooksDead(inputs)).toBe(false);
  });

  it('does not read an absent transcript path as death either', () => {
    expect(parentLooksDead(doctorLivenessInputs(session()))).toBe(false);
  });

  it('never reports a live-process signal it does not have', () => {
    // Doctor has no recorded pid. Passing 0 must mean "unknown", not "dead" —
    // if this ever became `recordedParentAlive: false` with a pid > 0, the
    // predicate's first clause would fire on every session unconditionally.
    const inputs = doctorLivenessInputs(session({ transcriptPath: transcriptAged(0) }));
    expect(inputs.recordedParentPid).toBe(0);
  });
});

describe('isNeverUploaded — the file is the only copy', () => {
  it('flags a local-* session the server has never seen', () => {
    // Age is exactly what such a session accumulates while the sync queue is
    // blocked (an outage, a bad key, an offline machine), so an age-only sweep
    // deleted precisely the backlog it existed to survive. 33 of 294 files on
    // the machine where this was found.
    expect(isNeverUploaded({ sessionId: 'local-1724800000000-ab12' })).toBe(true);
  });

  it('does not flag one that has since synced', () => {
    expect(isNeverUploaded({ sessionId: 'local-1724800000000-ab12', syncedSessionId: 'srv-9' })).toBe(false);
  });

  it('does not flag an ordinary server session', () => {
    expect(isNeverUploaded({ sessionId: '0f3b1e69-1111-2222-3333-444444444444' })).toBe(false);
    expect(isNeverUploaded({})).toBe(false);
  });
});

describe('looksActiveNow — the file-deletion question has the opposite default', () => {
  // `parentLooksDead` answers "may I END this session?" and defaults to NO on no
  // evidence, because ending destroys state a live agent is still writing.
  // Reused for "may I DELETE this file?" that default inverts into a bug: a
  // session whose transcript and state file are both long gone offers no
  // evidence either way, reads as alive, and is preserved forever — a sweep that
  // reports 128 of 294 files it will never clean.
  const tmpFile = (minutesOld: number): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-doctor-file-'));
    const p = path.join(dir, 'session.json');
    fs.writeFileSync(p, '{}');
    const when = new Date(Date.now() - minutesOld * 60_000);
    fs.utimesSync(p, when, when);
    return p;
  };

  it('keeps a session whose own file is warm', () => {
    expect(looksActiveNow(session() as any, tmpFile(0))).toBe(true);
  });

  it('keeps a session whose transcript is warm even if the file is cold', () => {
    const st = session({ transcriptPath: transcriptAged(0) });
    expect(looksActiveNow(st, tmpFile(600))).toBe(true);
  });

  it('does NOT keep one with no warm surface anywhere', () => {
    // The case that made the sweep inert: both signals long gone.
    const st = session({ transcriptPath: '/does/not/exist/transcript.jsonl' });
    expect(looksActiveNow(st, tmpFile(600))).toBe(false);
  });

  it('does not treat an unstattable path as warm', () => {
    expect(looksActiveNow(session() as any, '/does/not/exist/session.json')).toBe(false);
  });
});
