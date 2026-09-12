// One answer to "what did this session author".
//
// Session 51995e1c (2026-09-08) ran `git merge origin/main` mid-turn. The
// turn row credited the merge with what it resolved (2 files, +3/-3) and
// post-commit's session snapshot stored +895 across 16 files — both right.
// The session ACCUMULATOR then added the merge's first-parent delta (13
// files, +326/-71, another PR) and the dashboard header read +1218 across 27
// files. Same commit, three producers, two arithmetics.
//
// commitAuthoredDelta and sessionAuthoredSnapshot are what every producer now
// derives from; these pin that a merge contributes its resolution and nothing
// it absorbed, at the commit and at the session level, and that the totals
// the CLI keeps are SET from that snapshot.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { commitAuthoredDelta, renderAuthoredCommits } from '../history-backfill.js';
import { sessionAuthoredSnapshot, applyAuthoredTotals } from '../commands/hooks/post-commit.js';

let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();

let sessionStart = '';
let ourSha = '';
let cleanMergeSha = '';
let resolvedMergeSha = '';

beforeAll(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-authored-')));
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo });
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(repo, 'base.ts'), 'export const BASE = 1;\n');
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = 0;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  sessionStart = git('rev-parse', 'HEAD');

  // Their PR: 40 lines this session never wrote, committed by SOMEONE ELSE —
  // the range fallback owns an untrailered commit by committer identity, so a
  // single-identity fixture would claim their work for a different reason.
  const theirs = ['-c', 'user.email=them@example.com', '-c', 'user.name=Them'];
  git('checkout', '-q', '-b', 'theirs');
  fs.writeFileSync(
    path.join(repo, 'their-feature.ts'),
    Array.from({ length: 40 }, (_, i) => `export const THEIRS_${i} = ${i};`).join('\n') + '\n',
  );
  git('add', '-A'); git(...theirs, 'commit', '-q', '-m', 'their PR');

  // Our session: one line of its own, then a CLEAN merge of their PR.
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'ours.ts'), 'export const OURS = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'our work');
  ourSha = git('rev-parse', 'HEAD');
  git('merge', '-q', '--no-ff', '--no-edit', 'theirs');
  cleanMergeSha = git('rev-parse', 'HEAD');

  // A second branch that conflicts on shared.ts; the merge RESOLVES it. The
  // resolution is the one thing a merge authors.
  git('checkout', '-q', '-b', 'conflicting', sessionStart);
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = 100;\n');
  git('add', '-A'); git(...theirs, 'commit', '-q', '-m', 'their shared change');
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'our shared change');
  try { execFileSync('git', ['merge', '--no-edit', 'conflicting'], { cwd: repo, stdio: 'pipe' }); } catch { /* conflict expected */ }
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const SHARED = 101; // resolved\n');
  git('add', '-A'); git('commit', '-q', '-m', 'merge conflicting');
  resolvedMergeSha = git('rev-parse', 'HEAD');
});
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

// Captured at import, before the fixture commits: the session was running
// when they were made, which is what the no-recorded-shas case is about.
const STARTED_AT = new Date().toISOString();

const stateWith = (shas: string[]) => ({
  sessionId: 'sess-authored',
  sessionTag: 'authored',
  agentSlug: 'claude-code',
  repoPath: repo,
  headShaAtStart: sessionStart,
  startedAt: STARTED_AT,
  prompts: [],
  sessionCommitShas: shas,
}) as any;

describe('commitAuthoredDelta', () => {
  it('a plain commit contributes its patch', () => {
    const d = commitAuthoredDelta(repo, ourSha);
    expect(d.isMerge).toBe(false);
    expect(d.filesChanged).toEqual(['ours.ts']);
    expect([d.linesAdded, d.linesRemoved]).toEqual([1, 0]);
    expect(d.absorbed).toBeNull();
  });

  it('a clean merge contributes nothing, and says what it absorbed', () => {
    const d = commitAuthoredDelta(repo, cleanMergeSha);
    expect(d.isMerge).toBe(true);
    expect(d.diff).toBe('');
    expect(d.filesChanged).toEqual([]);
    expect([d.linesAdded, d.linesRemoved]).toEqual([0, 0]);
    // The first-parent view: 40 lines of their-feature.ts — the other branch.
    expect(d.absorbed).toEqual({ files: 1, linesAdded: 40, linesRemoved: 0 });
  });

  it('a resolved merge contributes its resolution only', () => {
    const d = commitAuthoredDelta(repo, resolvedMergeSha);
    expect(d.isMerge).toBe(true);
    expect(d.filesChanged).toEqual(['shared.ts']);
    expect(d.diff).toContain('+export const SHARED = 101; // resolved');
    expect(d.linesAdded).toBe(1);
  });
});

describe('sessionAuthoredSnapshot', () => {
  it('renders owned commits by their authored contribution — a merge adds none of the branch it absorbed', () => {
    const snap = sessionAuthoredSnapshot(repo, stateWith([ourSha, cleanMergeSha]));
    expect(snap.source).toBe('owned');
    expect(snap.filesChanged).toEqual(['ours.ts']);
    expect([snap.linesAdded, snap.linesRemoved]).toEqual([1, 0]);
    expect(snap.commitShas).toEqual([ourSha, cleanMergeSha]);
    expect(snap.diff).not.toContain('THEIRS_');
  });

  it('counts the uncommitted side from the same text', () => {
    const uncommitted = [
      'diff --git a/notes.md b/notes.md',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/notes.md',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n');
    const snap = sessionAuthoredSnapshot(repo, stateWith([ourSha]), { uncommittedDiff: uncommitted });
    expect(snap.filesChanged).toEqual(['ours.ts', 'notes.md']);
    expect(snap.linesAdded).toBe(3);
    expect(snap.uncommittedDiff).toBe(uncommitted);
  });

  it('with no recorded commits it renders what the range lets it own — never the raw range', () => {
    // A hook was missed (sandboxed Codex): the sha list is empty but the
    // session did commit. The trailer walk owns the local-identity commits in
    // range and renders each by its authored contribution; their commits,
    // committed by someone else, stay out — and so does everything the merges
    // absorbed.
    const snap = sessionAuthoredSnapshot(repo, stateWith([]));
    expect(snap.source).toBe('trailer');
    expect(snap.diff).not.toContain('THEIRS_');
    expect(snap.diff).not.toContain('SHARED = 100');
    expect([...snap.filesChanged].sort()).toEqual(['ours.ts', 'shared.ts']);
    expect(snap.commitShas.length).toBeGreaterThan(0);
  });

  it('a session with nothing committed at all reports none', () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-authored-empty-')));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: empty });
      execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: empty });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: empty });
      fs.writeFileSync(path.join(empty, 'a.txt'), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: empty });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: empty });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: empty, encoding: 'utf-8' }).trim();
      const snap = sessionAuthoredSnapshot(empty, { ...stateWith([]), repoPath: empty, headShaAtStart: head });
      expect(snap.source).toBe('none');
      expect(snap.diff).toBe('');
      expect(snap.commitShas).toEqual([]);
    } finally {
      try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('applyAuthoredTotals', () => {
  it('SETS the session totals from the snapshot — the accumulator is gone', () => {
    const state = stateWith([ourSha, cleanMergeSha]);
    // What the old accumulator would have left behind after adding the
    // merge's first-parent delta.
    state.filesChanged = ['ours.ts', 'their-feature.ts'];
    state.linesAdded = 41;
    state.linesRemoved = 0;
    state.commitCount = 2;

    applyAuthoredTotals(state, sessionAuthoredSnapshot(repo, state));

    expect(state.filesChanged).toEqual(['ours.ts']);
    expect([state.linesAdded, state.linesRemoved, state.commitCount]).toEqual([1, 0, 2]);
    expect(state.authoredSource).toBe('owned');
  });
});

describe('renderAuthoredCommits', () => {
  it('renders a sha list the same way, for the watcher', () => {
    const own = renderAuthoredCommits(repo, [ourSha, cleanMergeSha, resolvedMergeSha]);
    expect(own.filesChanged.sort()).toEqual(['ours.ts', 'shared.ts']);
    expect(own.diff).not.toContain('THEIRS_');
    expect(own.linesAdded).toBe(2);
  });
});

describe('the header drops what the turn rows never count', () => {
  // The e2e (real binary, turn 5) found the header at +22 against turns
  // summing to +6: session-start had written Origin's own CLAUDE.md block and
  // turn 2's `git add -A` committed it. Lockfiles take the same door.
  it('a commit that swept in CLAUDE.md and a lockfile is credited with its real file only', () => {
    git('checkout', '-q', '-b', 'bookkeeping', sessionStart);
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '<!-- origin-managed -->\nOrigin: tracking\n<!-- origin-managed -->\n');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), Array.from({ length: 50 }, (_, i) => `"dep${i}": "1"`).join('\n') + '\n');
    fs.writeFileSync(path.join(repo, 'real.ts'), 'export const REAL = 1;\nexport const ALSO = 2;\n');
    git('add', '-A'); git('commit', '-q', '-m', 'work plus bookkeeping');
    const sha = git('rev-parse', 'HEAD');
    try {
      const snap = sessionAuthoredSnapshot(repo, stateWith([sha]));
      expect(snap.source).toBe('owned');
      expect(snap.filesChanged).toEqual(['real.ts']);
      expect([snap.linesAdded, snap.linesRemoved]).toEqual([2, 0]);
      expect(snap.diff).not.toContain('origin-managed');
      expect(snap.diff).not.toContain('dep0');
    } finally {
      git('checkout', '-q', 'main');
    }
  });
});
