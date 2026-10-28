/**
 * A session's snapshot chain is read with ONE git call, whatever the history.
 *
 * The shadow branch is not an orphan: its first snapshot sits on the repo's
 * HEAD, so `git log <branch>` is the repo's whole history. listSnapshots read
 * each of those commits with its own `git log -1` — 3186 processes, 56 s at
 * session-end on this repo (supervised `claude -p` run 3a552f34, 2026-10-14) —
 * and every headless Claude run waited out its 60 s SessionEnd budget for it.
 * Driven against real git.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as exec from '../utils/exec.js';
import { createSnapshot, listSnapshots } from '../commands/snapshot.js';

let repo: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-snap-chain-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  // Ordinary history under the session — including a message that merely
  // mentions JSON, which must not read as a snapshot.
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(repo, 'f.txt'), `v${i}\n`);
    git(['add', '-A']);
    git(['commit', '-qm', i === 7 ? 'docs: the meta looks like {"id":"x"} in logs' : `commit ${i}`]);
  }
});
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('listSnapshots on a session chain', () => {
  it('returns only the session\'s snapshots, oldest first, without one git call per commit of history', () => {
    const tag = 'abcd1234-ef0';
    // As in a real session: the shadow branch starts on the repo's HEAD, so
    // its log is the whole history (prod: 2 snapshot commits over 3186).
    git(['branch', `origin/shadow/${tag}`, 'HEAD']);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repo, 'f.txt'), `work ${i}\n`);
      const id = createSnapshot(repo, { sessionTag: tag, prompt: `turn ${i}`, promptIndex: i });
      expect(id, `snapshot ${i} was not created`).toBeTruthy();
      ids.push(id!);
    }

    const gitCalls = vi.spyOn(exec, 'git');
    const metas = listSnapshots(repo, tag);
    expect(metas.map((m) => m.id)).toEqual(ids);
    // Bounded by the chain, not by the 40 commits of history beneath it.
    expect(gitCalls.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
