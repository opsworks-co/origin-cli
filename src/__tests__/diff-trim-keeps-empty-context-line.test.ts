// `.trim()` cannot be used on a unified diff.
//
// An unchanged blank line is emitted as a single SPACE, so a file ending in a
// blank line produces a diff ending `…\n \n`. `.trim()` eats that last `" "`
// along with the newline, and the hunk body is then one line short of the count
// in its `@@` header — `git apply` rejects it, and `verify-capture` reports
// `diff_unparseable`.
//
// Found on session `593241fe` turn 9 (2026-09-11), a cursor session:
//
//     stored diff is not a well-formed unified diff:
//     hunk at line 6242 ends 1 old / 1 new lines short of its header
//
// The file was `packages/cli/src/transcript.ts`, which ends `}\n\n`; the stored
// header claimed `@@ -1,3186 +1,3228 @@` over a body of 3185/3227 lines. Nothing
// about it was Cursor-specific — `stripIgnoredSectionsFromDiff` is the funnel
// almost every stored diff passes through, and it ended with `.trim()`, so any
// agent committing a file that ends in a blank line stored a broken patch.
//
// Note which stripper is safe: `\n+$` removes the trailing newline and leaves
// the `" "` line, which is why the commit-patch path that already used it never
// produced this. `-`/`+` lines for blank lines were always safe — they are not
// whitespace-only, so only CONTEXT lines were ever at risk.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripIgnoredSectionsFromDiff, trimDiffText } from '../ignore-patterns.js';
import { parseUnifiedDiff } from '../capture-verify.js';

let repo: string;
const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

/** The verifier's own rule, which is what flagged the real row. */
function malformed(diff: string): string[] {
  const parsed = parseUnifiedDiff(diff);
  return parsed.malformed;
}

describe('trimming diff text never eats a trailing empty context line', () => {
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-difftrim-'));
    git(['init', '-q', '.']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
  });
  afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('a whole-file diff of a file ending in a blank line stays well-formed', () => {
    // The exact shape of the real file: content, then a trailing blank line.
    fs.writeFileSync(path.join(repo, 'f.ts'), 'a\nb\nc\n\n');
    git(['add', 'f.ts']);
    git(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'f.ts'), 'a\nB\nc\n\n');

    // Whole-file context is what the capture path asks for, and it is what puts
    // the trailing empty context line at the very end of the text.
    const raw = git(['diff', '--unified=1000', '--', 'f.ts']);
    expect(malformed(raw), 'git itself must emit a well-formed diff').toEqual([]);

    expect(malformed(stripIgnoredSectionsFromDiff(raw))).toEqual([]);
    expect(malformed(trimDiffText(raw))).toEqual([]);

    // And the guard that names the regression if it ever comes back.
    expect(malformed(raw.trim()).join(' '), '.trim() is what broke it').toMatch(/short of its header/);
  });

  it('the surviving last line IS the empty context line, not just a newline', () => {
    fs.writeFileSync(path.join(repo, 'f.ts'), 'x\n\n');
    git(['add', 'f.ts']);
    git(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'f.ts'), 'y\n\n');
    const kept = stripIgnoredSectionsFromDiff(git(['diff', '--unified=1000', '--', 'f.ts']));
    // A single space: the blank line, unchanged. `.trim()` would leave '+y'.
    expect(kept.split('\n').at(-1)).toBe(' ');
    expect(kept.endsWith('\n'), 'the trailing newline still goes').toBe(false);
  });

  it('git apply accepts what we store', () => {
    // The independent oracle. Run in an EMPTY temp dir holding only the file —
    // `git apply` from a subdirectory silently filters paths, which would make
    // this pass for the wrong reason.
    fs.writeFileSync(path.join(repo, 'f.ts'), 'a\nb\nc\n\n');
    git(['add', 'f.ts']);
    git(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(repo, 'f.ts'), 'a\nB\nc\n\n');
    const stored = stripIgnoredSectionsFromDiff(git(['diff', '--unified=1000', '--', 'f.ts']));

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-difftrim-apply-'));
    try {
      execFileSync('git', ['init', '-q', '.'], { cwd: target });
      fs.writeFileSync(path.join(target, 'f.ts'), 'a\nb\nc\n\n');
      const patch = path.join(target, 'p.diff');
      // git apply needs the terminating newline on the FILE; that is a property
      // of writing the patch out, not of the diff text we store.
      fs.writeFileSync(patch, `${stored}\n`);
      expect(() => execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: target, encoding: 'utf-8' })).not.toThrow();
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('is byte-identical to .trim() for any file ending in a single newline', () => {
    // The blast radius of this change, pinned. Every capture e2e fixture writes
    // files ending in exactly one newline, so swapping the stripper cannot move
    // them — which is what rules the change out as the cause when that (noisy,
    // real-binary) harness fails. Only a file ending in a BLANK line differs,
    // and that difference is the bug being fixed.
    const cases: Array<[string, string]> = [
      ['# demo\n', '# demo\n\nTheir readme.\n'],
      ['a\n', 'a\nb\n'],
      ['x\n', 'y\n'],
      ['a\nb\nc\n', 'a\nB\nc\n'],
    ];
    fs.writeFileSync(path.join(repo, 'f.md'), 'seed\n');
    git(['add', 'f.md']);
    git(['commit', '-qm', 'seed']);
    for (const [before, after] of cases) {
      fs.writeFileSync(path.join(repo, 'f.md'), before);
      git(['add', 'f.md']);
      git(['commit', '-qm', 'c']);
      fs.writeFileSync(path.join(repo, 'f.md'), after);
      for (const u of ['3', '1000']) {
        const raw = git(['diff', `--unified=${u}`, '--', 'f.md']);
        expect(trimDiffText(raw), `u=${u} ${JSON.stringify(after)}`).toBe(raw.trim());
      }
    }
  });

  it('trimDiffText still removes what .trim() was there for', () => {
    expect(trimDiffText('\n\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n\n\n'))
      .toBe('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b');
    expect(trimDiffText('')).toBe('');
    expect(trimDiffText(null as unknown as string)).toBe('');
  });
});
