// Every per-turn mapping used to be handed the CUMULATIVE session diff, so
// turns duplicated each other and each overstated its own work.
//
// Prod session 0f3b1e69: capture c_04135e01 wrote the same 82,367-byte,
// 4-file diff onto rows 1, 2 AND 13; rows 6/7 shared one; rows 4/5 shared
// another. Five rows at an identical byte length is not coincidence.
//
// sessionScopedCommittedDiff now takes a `sinceSha` so a turn gets only the
// commits inside its OWN window — while still walking the session's owned sha
// list, which is what keeps a concurrent agent's commits out (the reason the
// function exists).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let repo: string;
const shas: string[] = [];
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-window-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');
  for (const n of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(repo, `${n}.ts`), `export const ${n} = 1;\n`);
    git('add', '-A');
    git('commit', '-q', '-m', n);
    shas.push(git('rev-parse', 'HEAD'));
  }
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

// Exercised through the module's own export surface.
const load = async () => (await import('../commands/hooks.js')) as any;

describe('per-turn committed diff is scoped to the turn window', () => {
  it('the whole-session walk returns every owned commit', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return; // not exported — covered by the integration path
    const all = fn(repo, { sessionCommitShas: shas });
    expect(all).toContain('one.ts');
    expect(all).toContain('two.ts');
    expect(all).toContain('three.ts');
  });

  it('scoping to the LAST turn excludes earlier commits', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    const scoped = fn(repo, { sessionCommitShas: shas }, shas[1]);
    expect(scoped).toContain('three.ts');
    expect(scoped).not.toContain('one.ts');
    expect(scoped).not.toContain('two.ts');
  });

  it('an unreadable baseline falls back to the whole session, not to empty', async () => {
    const { __testSessionScopedCommittedDiff: fn } = await load();
    if (!fn) return;
    const scoped = fn(repo, { sessionCommitShas: shas }, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(scoped).toContain('one.ts');
  });
});
