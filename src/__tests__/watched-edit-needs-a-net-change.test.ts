/**
 * A watched write that leaves the file as the turn found it is not an edit.
 * Driven against real git.
 *
 * Session aec13f50 turn 10 ("merge PR, deploy and release CLI") committed
 * nothing and touched nothing, and its editsJson carried six `write_journal`
 * edits: five files rewritten in one second by `gh pr merge --delete-branch`
 * (a switch to main and the fast-forward that brought the same tree back),
 * plus a test suite's self-test golden, created and deleted inside the turn.
 * Every one ended the turn byte-identical to its start — or absent at both
 * ends — and the blame's per-prompt list read them as the turn's files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordProbedShellEdits } from '../commands/hooks/stop.js';

let repo: string;
let baseline: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-noop-watched-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  write('same.ts', 'unchanged\n'); write('edited.ts', 'before\n'); write('gone.ts', 'was here\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  baseline = git(['rev-parse', 'HEAD']);
  // What the turn's processes left on disk:
  write('same.ts', 'unchanged\n');          // rewritten with the same bytes (a checkout round-trip)
  write('edited.ts', 'before\nafter\n');    // really edited
  fs.rmSync(path.join(repo, 'gone.ts'));    // really deleted
  write('created.ts', 'new\n');             // really created
  // transient.json: created and deleted inside the turn — never on disk now, never at baseline
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

const state = () => ({ sessionId: '11111111-2222-4333-8444-555555555555', repoPath: repo, prompts: ['go'], liveEdits: [] }) as any;
const recorded = (s: any) => ((s.liveEdits || []) as any[]).flatMap((e) => e.edits).map((e: any) => [e.file, e.op]).sort();

describe('a watched write needs a net change to count', () => {
  it('records the edit, the delete and the create — not the round-trip or the transient file', () => {
    const s = state();
    const changed = recordProbedShellEdits(s, repo, baseline, 0,
      ['same.ts', 'edited.ts', 'gone.ts', 'created.ts', 'transient.json'],
      { toolLabel: 'origin:write-journal', evidence: 'write_journal' });
    expect(changed).toBe(true);
    expect(recorded(s)).toEqual([['created.ts', 'create'], ['edited.ts', 'write'], ['gone.ts', 'delete']]);
  });

  it('a turn whose only writes were round-trips records nothing', () => {
    const s = state();
    const changed = recordProbedShellEdits(s, repo, baseline, 0, ['same.ts', 'transient.json'],
      { toolLabel: 'origin:write-journal', evidence: 'write_journal' });
    expect(changed).toBe(false);
    expect(s.liveEdits).toEqual([]);
  });

  it('without a baseline sha nothing can be called a round-trip, so the write is kept', () => {
    const s = state();
    recordProbedShellEdits(s, repo, undefined, 0, ['same.ts'], { toolLabel: 'origin:write-journal', evidence: 'write_journal' });
    expect(recorded(s)).toEqual([['same.ts', 'create']]);
  });
});
