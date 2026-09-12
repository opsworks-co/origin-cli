// Tests for the capture self-consistency verifier.
//
// Two layers. The unit tests pin each violation to a hand-built row so the rule
// is readable. The property test pins `parseUnifiedDiff` to `git apply
// --numstat` — the only way to know a diff parser is right is to agree with the
// implementation everyone else's tooling uses.
//
// That property test caught two real bugs while this module was being written:
// a `--- /dev/null` read at the wrong moment, and a combined (`--cc`) merge
// diff silently counted as zero lines.
//
// NOTE on running git here: `git apply` invoked from inside a repository
// SILENTLY IGNORES patch paths that fall outside the current directory. Running
// the oracle from the package directory therefore made it report a subset and
// look like a parser disagreement. Every git call below runs in an empty temp
// dir with no repo, which is the only place `git apply --numstat` behaves as a
// pure parser.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseUnifiedDiff,
  verifyTurn,
  verifySession,
  summarize,
  diffPathKey,
  type VerifiableTurn,
} from '../capture-verify.js';

// ─── fixtures ───────────────────────────────────────────────────────────────

const MODIFY = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  ' export { x };',
  '',
].join('\n');

const CREATE = [
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  '',
].join('\n');

const DELETE = [
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const a = 1;',
  '-export const b = 2;',
  '',
].join('\n');

// What `git show` prints for a merge. No unified-diff reader can apply it.
const COMBINED = [
  'diff --cc packages/cli/package.json',
  'index 077d2ed4d,21f38bd08..6b0f2c870',
  '--- a/packages/cli/package.json',
  '+++ b/packages/cli/package.json',
  '@@@ -1,5 -1,5 +1,5 @@@',
  '  {',
  '    "name": "@origin/cli",',
  '-   "version": "0.20260827.1617",',
  ' -  "version": "0.20260827.1620",',
  '++  "version": "0.20260827.1635",',
  '    "license": "MIT",',
  '',
].join('\n');

// ─── parser ─────────────────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('counts a modification', () => {
    const d = parseUnifiedDiff(MODIFY);
    expect(d.malformed).toEqual([]);
    expect(d.files).toHaveLength(1);
    expect(d.files[0]).toMatchObject({ file: 'src/a.ts', added: 2, removed: 1, contentless: false });
  });

  it('marks a created file and counts only additions', () => {
    const d = parseUnifiedDiff(CREATE);
    expect(d.malformed).toEqual([]);
    expect(d.files[0]).toMatchObject({ file: 'src/new.ts', added: 2, removed: 0, isNew: true });
  });

  it('names a deleted file by its a-side, since the b-side is /dev/null', () => {
    const d = parseUnifiedDiff(DELETE);
    expect(d.malformed).toEqual([]);
    expect(d.files[0]).toMatchObject({ file: 'src/gone.ts', added: 0, removed: 2 });
  });

  it('reports a hunk whose body is shorter than its header — the truncation shape', () => {
    // The 200 KB cap slices mid-hunk, leaving a valid header over a short body.
    const truncated = MODIFY.split('\n').slice(0, 7).join('\n') + '\n';
    const d = parseUnifiedDiff(truncated);
    expect(d.malformed.join(' ')).toMatch(/short of its header/);
  });

  it('refuses to count a combined (--cc) merge diff rather than reporting zeros', () => {
    const d = parseUnifiedDiff(COMBINED);
    expect(d.malformed.join(' ')).toMatch(/combined \(--cc\) merge diff/);
  });

  it('flags a created file whose diff removes lines — a write with no before-image', () => {
    const impossible = CREATE.replace('@@ -0,0 +1,2 @@', '@@ -1,1 +1,2 @@')
      .replace('+export const a = 1;', '-export const a = 0;\n+export const a = 1;');
    const d = parseUnifiedDiff(impossible);
    expect(d.malformed.join(' ')).toMatch(/new file but its diff removes/);
  });

  it('reports a file appearing in two sections without calling the diff malformed', () => {
    const d = parseUnifiedDiff(MODIFY + MODIFY);
    // Legitimate for a two-commit turn, so it is counted, not condemned.
    expect(d.malformed).toEqual([]);
    expect(d.duplicateFiles).toEqual(['src/a.ts']);
  });

  it('treats an empty context line as context, not as the end of the hunk', () => {
    const withBlank = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,4 @@',
      ' a',
      '',
      '+b',
      ' c',
      '',
    ].join('\n');
    const d = parseUnifiedDiff(withBlank);
    expect(d.malformed).toEqual([]);
    expect(d.files[0]).toMatchObject({ added: 1, removed: 0 });
  });

  it('is empty, not malformed, for empty input', () => {
    for (const v of ['', '   ', null, undefined]) {
      const d = parseUnifiedDiff(v as string);
      expect(d.files).toEqual([]);
      expect(d.malformed).toEqual([]);
    }
  });
});

describe('diffPathKey', () => {
  it('normalises separators and leading markers', () => {
    expect(diffPathKey('src\\a.ts')).toBe('src/a.ts');
    expect(diffPathKey('./src/a.ts')).toBe('src/a.ts');
    expect(diffPathKey('"src/a b.ts"')).toBe('src/a b.ts');
  });

  it('preserves case — two files differing only in case are two files', () => {
    expect(diffPathKey('src/A.ts')).not.toBe(diffPathKey('src/a.ts'));
  });
});

// ─── turn rules ─────────────────────────────────────────────────────────────

const codes = (t: VerifiableTurn) => verifyTurn(t).map((v) => v.code).sort();

describe('verifyTurn', () => {
  it('passes a coherent row', () => {
    expect(codes({ promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY })).toEqual([]);
  });

  it('says nothing about a genuinely empty turn', () => {
    // A chat-only turn is a legitimate state, not a defect.
    expect(codes({ promptIndex: 0, filesChanged: [], diff: '' })).toEqual([]);
  });

  it('catches a row claiming files while storing no diff', () => {
    expect(codes({ promptIndex: 0, filesChanged: ['src/a.ts'], diff: '' }))
      .toContain('files_without_content');
  });

  it('catches a row storing a diff while claiming no files', () => {
    expect(codes({ promptIndex: 0, filesChanged: [], diff: MODIFY }))
      .toContain('content_without_files');
  });

  it('catches the mosaic: a claimed file the diff never mentions', () => {
    const v = verifyTurn({ promptIndex: 3, filesChanged: ['src/a.ts', 'src/ghost.ts'], diff: MODIFY });
    const hit = v.find((x) => x.code === 'claimed_file_absent_from_diff');
    expect(hit?.files).toEqual(['src/ghost.ts']);
  });

  it('catches a diff file missing from filesChanged', () => {
    const v = verifyTurn({ promptIndex: 0, filesChanged: ['src/other.ts'], diff: MODIFY });
    expect(v.map((x) => x.code)).toContain('diff_file_unclaimed');
  });

  it('accepts a file carried in uncommittedDiff rather than diff', () => {
    // Both fields are the row's content; checking only one reports a false miss.
    expect(codes({ promptIndex: 0, filesChanged: ['src/a.ts'], diff: '', uncommittedDiff: MODIFY }))
      .toEqual([]);
  });

  it('does not count an out-of-repo write as a missing file', () => {
    expect(codes({
      promptIndex: 0,
      filesChanged: ['src/a.ts', '~/.claude/notes.md'],
      outOfRepoFiles: ['~/.claude/notes.md'],
      diff: MODIFY,
    })).toEqual([]);
  });

  it('catches line counts that disagree with the stored diff', () => {
    const v = verifyTurn({ promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY, linesAdded: 99, linesRemoved: 0 });
    const hit = v.find((x) => x.code === 'line_counts_disagree_with_diff');
    expect(hit?.detail).toMatch(/\+99\/-0.*\+2\/-1/);
  });

  it('accepts line counts that match', () => {
    expect(codes({ promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY, linesAdded: 2, linesRemoved: 1 }))
      .toEqual([]);
  });

  it('counts the diff carried in uncommittedDiff when `diff` is empty', () => {
    // The transcript watcher — the producer for every agent that fires no
    // hooks — sends its per-turn text as `uncommittedDiff` and counts
    // linesAdded from that SAME text. Reading `diff` alone graded every one of
    // those rows as contradicting itself, inflating the contradiction rate this
    // command exists to measure.
    expect(codes({
      promptIndex: 0, filesChanged: ['src/a.ts'],
      diff: '', uncommittedDiff: MODIFY, linesAdded: 2, linesRemoved: 1,
    })).toEqual([]);
  });

  it('still catches a disagreement when the content is in uncommittedDiff', () => {
    // The fix must not become a blanket exemption: the check has to keep
    // working on the field it newly reads.
    const v = verifyTurn({
      promptIndex: 0, filesChanged: ['src/a.ts'],
      diff: '', uncommittedDiff: MODIFY, linesAdded: 0, linesRemoved: 0,
    });
    const hit = v.find((x) => x.code === 'line_counts_disagree_with_diff');
    expect(hit?.detail).toMatch(/\+0\/-0.*\+2\/-1/);
  });

  it('does not double-count a row whose uncommittedDiff repeats its diff', () => {
    // The hook path stores the COMBINED committed+uncommitted text in `diff`
    // and repeats the uncommitted half in `uncommittedDiff`. Summing the two
    // would report +4/-2 against a row that honestly recorded +2/-1.
    expect(codes({
      promptIndex: 0, filesChanged: ['src/a.ts'],
      diff: MODIFY, uncommittedDiff: MODIFY, linesAdded: 2, linesRemoved: 1,
    })).toEqual([]);
  });

  it('tolerates an absolute path against a repo-relative diff', () => {
    expect(codes({ promptIndex: 0, filesChanged: ['/repo/src/a.ts'], diff: MODIFY })).toEqual([]);
  });

  it('does not match different files that share a basename', () => {
    const v = verifyTurn({ promptIndex: 0, filesChanged: ['lib/a.ts'], diff: MODIFY });
    expect(v.map((x) => x.code)).toContain('claimed_file_absent_from_diff');
  });
});

// ─── session rules ──────────────────────────────────────────────────────────

describe('verifySession', () => {
  it('flags a byte-identical change repeated across turns — the cumulative-diff shape', () => {
    const turns: VerifiableTurn[] = [
      { promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY },
      { promptIndex: 1, filesChanged: ['src/a.ts'], diff: MODIFY },
    ];
    const hit = verifySession(turns).find((v) => v.code === 'identical_change_in_two_turns');
    expect(hit?.detail).toMatch(/turns 0, 1/);
  });

  it('does not flag the same file changed differently in two turns', () => {
    const second = MODIFY.replace('+const z = 4;', '+const z = 5;');
    const turns: VerifiableTurn[] = [
      { promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY },
      { promptIndex: 1, filesChanged: ['src/a.ts'], diff: second },
    ];
    expect(verifySession(turns).some((v) => v.code === 'identical_change_in_two_turns')).toBe(false);
  });

  it('does not report a file duplicated inside ONE turn as a cross-turn repeat', () => {
    const v = verifySession([{ promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY + MODIFY }]);
    expect(v.some((x) => x.code === 'identical_change_in_two_turns')).toBe(false);
    expect(v.some((x) => x.code === 'duplicate_file_section')).toBe(true);
  });

  it('summarises contradictions and suspects separately', () => {
    const turns: VerifiableTurn[] = [
      { promptIndex: 0, filesChanged: ['src/a.ts'], diff: MODIFY },
      { promptIndex: 1, filesChanged: ['src/ghost.ts'], diff: MODIFY },
    ];
    const s = summarize(turns, verifySession(turns));
    expect(s.turns).toBe(2);
    expect(s.contradictions).toBeGreaterThan(0);
    expect(s.cleanTurns).toBe(1);
  });

  it('survives malformed input without throwing', () => {
    expect(() => verifySession([] as VerifiableTurn[])).not.toThrow();
    expect(verifySession(null as unknown as VerifiableTurn[])).toEqual([]);
    expect(() => verifySession([{ promptIndex: 0 } as VerifiableTurn])).not.toThrow();
  });
});

// ─── the oracle ─────────────────────────────────────────────────────────────

describe('parseUnifiedDiff agrees with git apply --numstat', () => {
  let dir = '';
  let haveGit = true;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-diff-oracle-'));
    try {
      execFileSync('git', ['--version'], { cwd: dir, stdio: 'pipe' });
    } catch {
      haveGit = false;
    }
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  /** git's own numstat, run OUTSIDE any repository — see the note at the top. */
  const oracle = (diff: string): Record<string, [number, number]> | null => {
    const text = diff.endsWith('\n') ? diff : `${diff}\n`;
    try {
      const out = execFileSync('git', ['apply', '--numstat', '--allow-empty', '-'], {
        cwd: dir, input: text, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      const r: Record<string, [number, number]> = {};
      for (const line of out.trim().split('\n')) {
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
        const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
        r[parts.slice(2).join('\t')] = [added, removed];
      }
      return r;
    } catch {
      return null;
    }
  };

  for (const [name, diff] of Object.entries({ MODIFY, CREATE, DELETE, 'two files': MODIFY + CREATE })) {
    it(`matches git on ${name}`, () => {
      if (!haveGit) return;
      const theirs = oracle(diff);
      expect(theirs, 'git should accept this fixture').not.toBeNull();
      const mine = parseUnifiedDiff(diff);
      expect(mine.malformed).toEqual([]);
      const got: Record<string, [number, number]> = {};
      for (const f of mine.files) got[f.file] = [f.added, f.removed];
      expect(got).toEqual(theirs);
    });
  }
});
