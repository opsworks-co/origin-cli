// A whole-file write carries only the NEW content, so a rewrite of an existing
// file was indistinguishable from creating it: the turn reported the whole file
// as additions and recorded ZERO deletions.
//
// Prod session fc4eb13c (Cursor, repo `baton`): turn 3 rewrote a 141-line
// src/index.js and reported +155/-0 where `git show` says +74/-59. Six of the
// turn's seven files reconciled with git exactly — that one file is the entire
// reason the session's per-turn totals (+396/-5) exceeded the commit they
// produced (+314/-63). The error only ever runs one way: phantom additions in,
// real deletions lost.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { backfillWriteBaselines } from '../prompt-capture/index.js';
import type { PromptEdit } from '../prompt-capture/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('backfillWriteBaselines', () => {
  let repo: string;
  let baseline: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-writebase-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@origin.dev');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    // The dev machine's global core.hooksPath points at Origin's real hooks;
    // every fixture commit would otherwise fire the network-calling one.
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/index.js'), 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    baseline = git(repo, 'rev-parse', 'HEAD');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const write = (file: string, newContent: string): PromptEdit =>
    ({ file, op: 'write', newContent } as PromptEdit);

  it('recovers the before-state of a rewritten file from the baseline', () => {
    const edits = [write('src/index.js', 'one\nTWO\nthree\nfour\n')];
    backfillWriteBaselines(edits, repo, baseline);
    // Without this the edit reads as a 4-line insertion into nothing.
    expect(edits[0].oldContent).toBe('one\ntwo\nthree\n');
  });

  it('leaves a genuine create alone — it really is a whole-file add', () => {
    const edits = [write('src/brand-new.js', 'a\nb\n')];
    backfillWriteBaselines(edits, repo, baseline);
    expect(edits[0].oldContent).toBeUndefined();
  });

  it('never overwrites a before-state the agent already supplied', () => {
    const edits = [{ file: 'src/index.js', op: 'write', oldContent: 'agent said this', newContent: 'x\n' } as PromptEdit];
    backfillWriteBaselines(edits, repo, baseline);
    expect(edits[0].oldContent).toBe('agent said this');
  });

  it('resolves an absolute edit path against the repo root', () => {
    const edits = [write(path.join(repo, 'src/index.js'), 'one\nTWO\nthree\n')];
    backfillWriteBaselines(edits, repo, baseline);
    expect(edits[0].oldContent).toBe('one\ntwo\nthree\n');
  });

  it('is a no-op without a baseline, and never throws on a bad one', () => {
    const a = [write('src/index.js', 'x\n')];
    backfillWriteBaselines(a, repo, null);
    expect(a[0].oldContent).toBeUndefined();

    const b = [write('src/index.js', 'x\n')];
    expect(() => backfillWriteBaselines(b, repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).not.toThrow();
    expect(b[0].oldContent).toBeUndefined();
  });

  it('leaves non-write ops untouched', () => {
    const edits = [{ file: 'src/index.js', op: 'edit', oldContent: '', newContent: 'two\n' } as PromptEdit];
    backfillWriteBaselines(edits, repo, baseline);
    expect(edits[0].oldContent).toBe('');
  });

  it('the prod shape: a rewrite nets out to git, instead of the whole file', () => {
    // 141 lines in, 156 out, the way baton's src/index.js actually moved.
    const before = Array.from({ length: 141 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(repo, 'src/big.js'), before);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'big');
    const sha = git(repo, 'rev-parse', 'HEAD');

    // Rewrite: keep the first 82, replace the remaining 59 with 74 new ones.
    const after = [
      ...Array.from({ length: 82 }, (_, i) => `line ${i + 1}`),
      ...Array.from({ length: 74 }, (_, i) => `rewritten ${i + 1}`),
    ].join('\n') + '\n';

    const edits = [write('src/big.js', after)];
    backfillWriteBaselines(edits, repo, sha);

    const oldLines = (edits[0].oldContent || '').split('\n').filter(Boolean);
    const newLines = (edits[0].newContent || '').split('\n').filter(Boolean);
    expect(oldLines).toHaveLength(141);
    expect(newLines).toHaveLength(156);
    // The deletions are now representable at all — the whole point. Before the
    // backfill oldContent was empty, so no diff over these edits could yield a
    // single removal.
    expect(oldLines.filter((l) => !newLines.includes(l))).toHaveLength(59);
  });
});
