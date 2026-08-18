// Regression for "Cursor captured nothing, especially on Multitask /
// background agents".
//
// Two independent defects conspired, both on the ONLY code path a forked
// Cursor subagent produces:
//
//  1. afterFileEdit resolved its repo as `input.cwd || process.cwd()`. Cursor's
//     afterFileEdit stdin has NO `cwd` key (only `file_path` +
//     `workspace_roots`), and Cursor runs hooks from `~/.cursor`, so every edit
//     resolved to `~/.cursor`, found no active session there and aborted with
//     "no session state" — 10/10 aborts on a real karamba session.
//
//  2. A forked subagent's transcript is written to a `subagents/` subdir that
//     the main `<id>/<id>.jsonl` never references, so its tool calls, edits and
//     tokens were never parsed.
//
// Together these mean a Multitask turn records nothing: the subagent runs under
// a fresh per-turn session_id and fires no stop hook, so afterFileEdit is the
// only live signal it emits, and the subagent transcript is the only durable
// record it leaves behind.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveAfterFileEditCwd } from '../commands/hooks.js';
import { findCursorSubagentJsonls } from '../agents/cursor.js';

let tmp: string;
let repo: string;

// Compare paths through realpathSync.NATIVE, not realpathSync. On Windows CI
// os.tmpdir() hands back an 8.3 short name (C:\Users\RUNNER~1\…) while git's
// `rev-parse --show-toplevel` reports the long form (C:\Users\runneradmin\…);
// plain realpathSync does not expand short names, so the two never compare
// equal. (On macOS this also collapses /var → /private/var.)
const real = (p: string) => fs.realpathSync.native(p);

beforeEach(() => {
  tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cursor-subagent-')));
  repo = path.join(tmp, 'karamba');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('resolveAfterFileEditCwd', () => {
  it('derives the repo from the edited file when the payload has no cwd', () => {
    const file = path.join(repo, 'scripts', 'pw.sh');
    fs.writeFileSync(file, '#!/bin/sh\n');

    // The exact shape Cursor sends: file_path + workspace_roots, NO cwd.
    const resolved = resolveAfterFileEditCwd({
      file_path: file,
      workspace_roots: [repo],
      session_id: '620d986f-0eae-4cf5-b23b-e81342ee1083',
      hook_event_name: 'afterFileEdit',
    });

    expect(real(resolved)).toBe(real(repo));
    // The bug: this used to be process.cwd() (~/.cursor), never the repo.
    expect(resolved).not.toBe(process.cwd());
  });

  it('prefers the edited file over workspace_roots[0] in a multi-root workspace', () => {
    // workspace_roots[0] is a DIFFERENT repo than the one being edited — only
    // the file path identifies the right one.
    const other = path.join(tmp, 'other-repo');
    fs.mkdirSync(other, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: other });

    const file = path.join(repo, 'scripts', 'pw.sh');
    fs.writeFileSync(file, '#!/bin/sh\n');

    const resolved = resolveAfterFileEditCwd({ file_path: file, workspace_roots: [other, repo] });

    expect(real(resolved)).toBe(real(repo));
  });

  it('falls back to the first git-rooted workspace_root when the file is not in a repo', () => {
    const loose = path.join(tmp, 'loose.txt');
    fs.writeFileSync(loose, 'x');

    const resolved = resolveAfterFileEditCwd({
      file_path: loose,
      workspace_roots: [path.join(tmp, 'does-not-exist'), repo],
    });

    expect(real(resolved)).toBe(real(repo));
  });

  it('keeps a linked worktree as itself instead of collapsing to the main repo', () => {
    // A session running in a worktree stores its state under the WORKTREE
    // path, so collapsing to the canonical repo here (what getGitRoot does)
    // would abort the hook all over again for that case.
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

    const wt = path.join(tmp, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: repo });

    const file = path.join(wt, 'seed.txt');
    const resolved = resolveAfterFileEditCwd({ file_path: file, workspace_roots: [repo] });

    expect(real(resolved)).toBe(real(wt));
    expect(real(resolved)).not.toBe(real(repo));
  });

  it('falls back to input.cwd, then process.cwd(), when nothing else resolves', () => {
    expect(resolveAfterFileEditCwd({ cwd: repo })).toBe(repo);
    expect(resolveAfterFileEditCwd({})).toBe(process.cwd());
  });
});

describe('findCursorSubagentJsonls', () => {
  const mainJsonl = (dir: string, id: string) => path.join(dir, id, `${id}.jsonl`);

  it('finds the forked subagent transcripts a Multitask turn writes', () => {
    // Cursor's real layout: agent-transcripts/<convId>/subagents/<subId>.jsonl
    const conv = 'eb7ae0db-cd06-46bf-a689-9462571d7b54';
    const sub = '620d986f-0eae-4cf5-b23b-e81342ee1083';
    const convDir = path.join(tmp, 'agent-transcripts', conv);
    fs.mkdirSync(path.join(convDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(convDir, `${conv}.jsonl`), '{"role":"user"}\n');
    fs.writeFileSync(path.join(convDir, 'subagents', `${sub}.jsonl`), '{"role":"assistant"}\n');

    const found = findCursorSubagentJsonls(mainJsonl(path.join(tmp, 'agent-transcripts'), conv));

    expect(found).toHaveLength(1);
    expect(found[0]).toBe(path.join(convDir, 'subagents', `${sub}.jsonl`));
  });

  it('returns [] for an ordinary single-agent conversation (no subagents dir)', () => {
    const conv = 'plain-conversation';
    const convDir = path.join(tmp, 'agent-transcripts', conv);
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, `${conv}.jsonl`), '{"role":"user"}\n');

    expect(findCursorSubagentJsonls(mainJsonl(path.join(tmp, 'agent-transcripts'), conv))).toEqual([]);
  });

  it('ignores non-jsonl files and never throws on a missing path', () => {
    const conv = 'conv';
    const convDir = path.join(tmp, 'agent-transcripts', conv);
    fs.mkdirSync(path.join(convDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(convDir, 'subagents', 'notes.txt'), 'x');

    expect(findCursorSubagentJsonls(mainJsonl(path.join(tmp, 'agent-transcripts'), conv))).toEqual([]);
    expect(findCursorSubagentJsonls('/nope/nope/nope.jsonl')).toEqual([]);
  });
});
