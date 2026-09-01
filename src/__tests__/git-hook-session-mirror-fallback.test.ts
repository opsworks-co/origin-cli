// `.git` is not a safe home for session state: it belongs to the agents being
// captured, and they delete it.
//
// Prod a5c2570c — an Antigravity turn decided the worktree's git config was
// broken (it was not; the pointer resolved and `git status` worked), ran
// `git init` in the work tree ROOT, and the fresh `.git` took the session's
// state file with it:
//
//   13:19:12  post-commit  "no active sessions, skipped API update"
//   13:19:19  session state (re)created — seven seconds too late
//
// The commit fired every hook correctly and was ingested as a NEW repo row
// instead of onto the session. The worktree fallback could not help either:
// after the re-init the tree IS its own main repo, so it collapses to itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listMirroredSessionsForTree } from '../session-state.js';

let dir: string;
let tree: string;

const write = (id: string, body: Record<string, unknown>) =>
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    sessionId: id, claudeSessionId: id, ...body,
  }));

beforeEach(() => {
  dir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-mirror-tree-'));
});
afterEach(() => {
  for (const f of ['t-live', 't-other', 't-ended', 't-bycwd']) {
    try { fs.rmSync(path.join(dir, `${f}.json`)); } catch { /* ignore */ }
  }
  try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('listMirroredSessionsForTree', () => {
  it('finds a running session for this tree when .git holds nothing', () => {
    write('t-live', { repoPath: tree, status: 'RUNNING' });
    expect(listMirroredSessionsForTree(tree).map((s) => s.sessionId)).toEqual(['t-live']);
  });

  it('matches on lastCwd too — agy records the work root there', () => {
    write('t-bycwd', { repoPath: '/somewhere/else', lastCwd: tree, status: 'RUNNING' });
    expect(listMirroredSessionsForTree(tree).map((s) => s.sessionId)).toEqual(['t-bycwd']);
  });

  it('never claims a session belonging to a DIFFERENT tree', () => {
    // The mirror is global. Matching "any running session" would hand this
    // commit to whatever else happened to be running.
    write('t-other', { repoPath: '/some/other/repo', status: 'RUNNING' });
    expect(listMirroredSessionsForTree(tree)).toEqual([]);
  });

  it('ignores ended sessions', () => {
    write('t-ended', { repoPath: tree, status: 'ENDED', endedAt: new Date().toISOString() });
    expect(listMirroredSessionsForTree(tree)).toEqual([]);
  });

  it('attaches __statePath so the zombie filter can see it is alive', () => {
    // isSessionAlive's FIRST signal is the `.git` state file's mtime — exactly
    // what the wipe destroys — so without this the fallback recovers the
    // session and the zombie filter discards it one line later. Caught by
    // running the real lookup end-to-end; the helper test alone passed.
    write('t-live', { repoPath: tree, status: 'RUNNING', sessionTag: 'x' });
    const found = listMirroredSessionsForTree(tree);
    expect(found).toHaveLength(1);
    const at = (found[0] as unknown as { __statePath?: string }).__statePath;
    expect(at).toBeTruthy();
    expect(fs.existsSync(at as string)).toBe(true);
  });

  it('returns nothing for an empty tree argument rather than everything', () => {
    write('t-live', { repoPath: tree, status: 'RUNNING' });
    expect(listMirroredSessionsForTree('')).toEqual([]);
  });
});

// Both halves are required and neither works alone: without the early
// registration there is no mirror to fall back TO, and without the fallback the
// mirror is never consulted. #1346 shipped a fix wired into one path while the
// bug was on another, so the wiring gets a guard.
describe('the two halves are wired', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'commands', 'hooks.ts'),
    'utf-8',
  );

  it('git hooks consult the mirror after the in-repo lookups', () => {
    const active = src.indexOf('let sessions = listActiveSessions(hookCwd);');
    const mirror = src.indexOf('listMirroredSessionsForTree(hookCwd)');
    expect(active).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(active);
  });

  it('agy registers its session as soon as the id is known, not at the end', () => {
    const resolved = src.indexOf('sessionId = (startRes as any)?.sessionId;');
    const early = src.indexOf('registerAgySessionState({', resolved);
    const payload = src.indexOf('api.updateSession', resolved);
    expect(early).toBeGreaterThan(resolved);
    expect(early).toBeLessThan(payload); // before the network payload, not after
  });
});
