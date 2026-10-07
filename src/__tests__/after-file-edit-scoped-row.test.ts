/**
 * after-file-edit scopes its stored row to the files it has evidence for
 * (PR #1806). Driven through the real handler against a real git repo, and the
 * stored patches are checked with `git apply --check` — not by string match.
 *
 *   1. A scoped file ending in a blank line: its fullContext section ends in a
 *      lone-space context line. `trimEnd()` ate it, and the stored patch was
 *      one line short of its `@@` header ("corrupt patch").
 *   2. A big file edited earlier in the turn: the live ledger declines content
 *      over 96 KB, and scoping by the ledger alone dropped that file from diff,
 *      uncommittedDiff AND filesChanged once the turn edited a second file.
 *   3. This turn's own shell-probe evidence counts; another turn's, and a
 *      bare window probe on a turn that ran no write-shaped command, do not.
 *   4. A `diff --git "a/…" "b/…"` (quoted path) section is not dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterFileEditFilesForTurn,
  diffSectionsFor,
  handleAfterFileEdit,
  parseDiffGitHeader,
  unquoteGitPath,
} from '../commands/hooks/after-file-edit.js';
import { SHELL_PROBE_TOOL } from '../commands/hooks.js';
import { loadSessionState, saveSessionState, type SessionState } from '../session-state.js';

const CONV = 'c0ffee00-afe0-4444-5555-666677778888';
const TAG = 'afescope1';
let repo = '';
let home = '';
let prevHome: string | undefined;
let prevProfile: string | undefined;

const git = (...a: string[]): string =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim();
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};

/** `git apply --check` of `patch` against the index (still the turn's baseline). */
function applies(patch: string): string | true {
  try {
    execFileSync('git', ['apply', '--check', '--cached', '-'], {
      cwd: repo, input: patch.endsWith('\n') ? patch : `${patch}\n`, stdio: 'pipe', encoding: 'utf-8',
    });
    return true;
  } catch (e: any) {
    return String(e?.stderr || e?.message || e);
  }
}

function seedState(): void {
  const state = {
    sessionId: 'afe-scope-session-0001',
    claudeSessionId: CONV,
    sessionTag: TAG,
    agentSlug: 'cursor',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    repoPath: repo,
    prePromptSha: git('rev-parse', 'HEAD'),
    prompts: ['edit the files'],
    branch: 'main',
  } as unknown as SessionState;
  saveSessionState(state, repo, TAG);
}

async function edit(file: string): Promise<void> {
  await handleAfterFileEdit({ conversation_id: CONV, file_path: path.join(repo, file), workspace_roots: [repo] }, 'cursor');
}

function row(): { filesChanged: string[]; diff: string; uncommittedDiff: string; contentUnavailableFiles?: string[] } {
  const state = loadSessionState(repo, TAG);
  const m = (state?.completedPromptMappings || []).find((x) => x.promptIndex === 0) as any;
  expect(m, 'after-file-edit wrote no mapping for turn 0').toBeTruthy();
  return m;
}

beforeEach(() => {
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'afe-scope-home-')));
  process.env.HOME = home; process.env.USERPROFILE = home;
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'afe-scope-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(repo, '.git', 'no-hooks'));
});

afterEach(() => {
  process.env.HOME = prevHome; process.env.USERPROFILE = prevProfile;
  for (const d of [repo, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

describe('after-file-edit stored patches apply', () => {
  it('a scoped file ending in a blank line still yields a patch git accepts', async () => {
    write('a.ts', 'one\nTWO\nthree\n\n');
    write('b.ts', 'alpha\nbeta\n');
    git('add', '.'); git('commit', '-q', '-m', 'base');
    seedState();

    write('a.ts', 'one\ntwo\nthree\n\n');
    await edit('a.ts');
    write('b.ts', 'alpha\nBETA\n');
    await edit('b.ts');

    const r = row();
    expect(r.filesChanged.sort()).toEqual(['a.ts', 'b.ts']);
    expect(r.diff).toContain('a/a.ts');
    expect(r.diff).toContain('a/b.ts');
    expect(applies(r.diff)).toBe(true);
    expect(applies(r.uncommittedDiff)).toBe(true);
  });
});

describe('after-file-edit keeps a big file edited earlier in the turn', () => {
  it('big.ts (~90 KB, over the ledger cap) survives a later edit of small.ts', async () => {
    // A big file with a SMALL change is trimmed to its changed region and
    // kept by the ledger since eea76ca6 (big-file-evidence-keeps-its-change);
    // this test is about the file the ledger genuinely cannot carry, so the
    // CHANGE itself is over the 96 KB cap — the first 1300 lines rewritten,
    // ~106 KB old + new — while the diff (~107 KB) still fits the row's
    // 200 KB blob budget, so the path list is what has to carry it.
    const filler = (tag: (i: number) => string) => Array.from({ length: 3000 }, (_, i) => `// ${tag(i)} line ${i} ${'x'.repeat(20)}`).join('\n');
    write('big.ts', `export const V = 'before';\n${filler(() => 'filler')}\n`);
    write('small.ts', 'export const s = 1;\n');
    git('add', '.'); git('commit', '-q', '-m', 'base');
    seedState();

    write('big.ts', `export const V = 'after';\n${filler((i) => (i < 1300 ? 'rewritten' : 'filler'))}\n`);
    expect(fs.statSync(path.join(repo, 'big.ts')).size).toBeGreaterThan(80_000);
    await edit('big.ts');
    write('small.ts', 'export const s = 2;\n');
    await edit('small.ts');

    const r = row();
    expect(r.filesChanged.sort()).toEqual(['big.ts', 'small.ts']);
    for (const blob of [r.diff, r.uncommittedDiff]) {
      expect(blob).toContain('diff --git a/big.ts b/big.ts');
      expect(blob).toContain('diff --git a/small.ts b/small.ts');
    }
    // The ledger really did decline it — this is the path-list's job alone.
    const state = loadSessionState(repo, TAG)!;
    const ledgerFiles = (state.liveEdits || []).flatMap((e) => (e.edits || []).map((x) => x.file));
    expect(ledgerFiles).not.toContain('big.ts');
  });
});

const section = (file: string) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

describe('afterFileEditFilesForTurn — shell-probe evidence', () => {
  const probe = (promptIndex: number, file: string, evidence: 'command_named' | 'command_probe') => ({
    promptIndex, toolName: SHELL_PROBE_TOOL, capturedAt: new Date().toISOString(),
    edits: [{ file, op: 'write' as const, source: 'uncommitted' as const, evidence }],
  });

  it("includes this turn's own named shell write (sed, codegen, git mv)", () => {
    const files = afterFileEditFilesForTurn({ liveEdits: [probe(2, 'gen.ts', 'command_named')] }, 2, ['cur.ts']);
    expect([...files].sort()).toEqual(['cur.ts', 'gen.ts']);
  });

  it("includes this turn's window probe when the turn ran a write-shaped command", () => {
    const files = afterFileEditFilesForTurn(
      { liveEdits: [probe(2, 'sed.ts', 'command_probe')], shellWriteTurns: [2] }, 2, ['cur.ts'],
    );
    expect([...files].sort()).toEqual(['cur.ts', 'sed.ts']);
  });

  it("excludes another turn's probe, and a bare window probe on a read-only turn", () => {
    const files = afterFileEditFilesForTurn({
      liveEdits: [probe(1, 'other-turn.ts', 'command_named'), probe(2, 'sibling.ts', 'command_probe')],
      shellWriteTurns: [1],
    }, 2, ['cur.ts']);
    expect([...files]).toEqual(['cur.ts']);
  });

  it('excludes the inferred slots (write journal) even for this turn', () => {
    const files = afterFileEditFilesForTurn({
      liveEdits: [{ ...probe(2, 'journal.ts', 'command_named'), toolName: 'origin:write-journal' }],
    }, 2, ['cur.ts']);
    expect([...files]).toEqual(['cur.ts']);
  });
});

describe('quoted git paths', () => {
  it('unquotes C-style escapes, octal bytes decoded as UTF-8', () => {
    expect(unquoteGitPath('"a/caf\\303\\251.ts"')).toBe('a/café.ts');
    expect(unquoteGitPath('"a/tab\\there \\"q\\" \\\\"')).toBe('a/tab\there "q" \\');
    expect(unquoteGitPath('a/plain.ts')).toBe('a/plain.ts');
  });

  it('parses quoted, mixed and bare headers', () => {
    expect(parseDiffGitHeader('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"')).toEqual({ a: 'café.ts', b: 'café.ts' });
    expect(parseDiffGitHeader('diff --git a/old.ts "b/n\\303\\251w.ts"')).toEqual({ a: 'old.ts', b: 'néw.ts' });
    expect(parseDiffGitHeader('diff --git a/x y.ts b/x y.ts')).toEqual({ a: 'x y.ts', b: 'x y.ts' });
    expect(parseDiffGitHeader('not a header')).toBeNull();
  });

  it('keeps a quoted-path section for its file and drops it for others', () => {
    const quoted = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const blob = [section('other.ts'), quoted].join('\n');
    expect(diffSectionsFor(blob, new Set(['café.ts']))).toBe(quoted);
    expect(diffSectionsFor(blob, new Set(['other.ts']))).toBe(section('other.ts'));
  });

  it('a real non-ASCII file edited through the hook reaches the row', async () => {
    write('café.ts', 'x = 1\n');
    write('other.ts', 'y = 1\n');
    git('add', '.'); git('commit', '-q', '-m', 'base');
    seedState();
    write('café.ts', 'x = 2\n');
    write('other.ts', 'y = 2\n');
    await edit('café.ts');
    const r = row();
    expect(r.filesChanged).toEqual(['café.ts']);
    expect(r.diff).toContain('caf\\303\\251.ts');
    expect(r.diff).not.toContain('other.ts');
    expect(applies(r.diff)).toBe(true);
  });
});
