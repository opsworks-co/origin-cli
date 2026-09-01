// buildDiffFromEdits used to emit a placeholder `@@ @@` hunk header (no line
// numbers) and repeat the `---`/`+++` file markers before every hunk. Neither
// is a valid unified diff, and the consequences were real:
//
//  - the session-detail read path dropped such hunks outright (they parse as
//    "unparseable header"), rendering turns as "(no diff captured) +0/-0" —
//    fixed read-side in #1228, but only because the reader learned to tolerate
//    the malformed input;
//  - `git apply` / `patch` reject it, so no external tool could use it;
//  - compaction and hunk re-anchoring both skip it, so it rendered with full
//    file context and an un-anchored gutter.
//
// The line numbers are SYNTHETIC — the tool payload carries content, not
// position — so they start at the top of the file and advance monotonically,
// the same approach the server's synthesizePromptDiff takes. That is enough to
// be well-formed; it is not a claim about the file's true line positions.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDiffFromEdits } from '../transcript.js';

const HUNK = /^@@ -\d+,\d+ \+\d+,\d+ @@$/;

describe('buildDiffFromEdits emits a valid unified diff', () => {
  it('numbers a whole-file create the way git does', () => {
    const diff = buildDiffFromEdits([
      { file: '/repo/new.py', toolName: 'Write', input: { content: 'a\nb\nc\n' } },
    ]);
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('@@ -0,0 +1,3 @@');
    expect(diff).not.toContain('@@ @@');
  });

  it('emits ONE pair of file markers per file, not one per hunk', () => {
    const diff = buildDiffFromEdits([
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: 'one', new_string: 'ONE' } },
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: 'two', new_string: 'TWO' } },
    ]);
    expect(diff.split('\n').filter((l) => l.startsWith('--- '))).toHaveLength(1);
    expect(diff.split('\n').filter((l) => l.startsWith('+++ '))).toHaveLength(1);
    // …but still one hunk per edit.
    expect(diff.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(2);
  });

  it('gives every hunk a parseable header whose counts match its body', () => {
    const diff = buildDiffFromEdits([
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: 'x\nkeep', new_string: 'y\nkeep' } },
      { file: '/repo/b.py', toolName: 'Write', input: { content: 'p\nq\n' } },
    ]);
    const lines = diff.split('\n');
    let checked = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('@@')) continue;
      expect(lines[i]).toMatch(HUNK);
      const m = lines[i].match(/^@@ -\d+,(\d+) \+\d+,(\d+) @@$/)!;
      let oldCount = 0, newCount = 0;
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git '); j++) {
        if (lines[j].startsWith('+')) newCount++;
        else if (lines[j].startsWith('-')) oldCount++;
        else oldCount++, newCount++;
      }
      expect(oldCount).toBe(Number(m[1]));
      expect(newCount).toBe(Number(m[2]));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it('hunk line numbers advance monotonically within a file', () => {
    const diff = buildDiffFromEdits([
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: 'one', new_string: 'ONE' } },
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: 'two', new_string: 'TWO' } },
    ]);
    const starts = [...diff.matchAll(/^@@ -\d+,\d+ \+(\d+),\d+ @@$/gm)].map((m) => Number(m[1]));
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBeGreaterThan(starts[0]);
  });

  it('never emits an absolute path into the header', () => {
    // `a/` + an absolute path produced `diff --git a//abs/path b//abs/path` —
    // a double slash no diff parser accepts. And the old shortenFilePath turned
    // `/Users/me/Documents/repo/src/x.ts` into `Documents/repo/src/x.ts`, which
    // is neither absolute nor repo-relative, so the header disagreed with the
    // same turn's filesChanged for every caller that HAD scoped those.
    //
    // Making an absolute path truly repo-relative is not possible here — this
    // function is never told the repo root, and scoping is the caller's job
    // (extractPromptFileMappings already runs every edit through
    // scopeCapturedPath). What it must not do is emit something malformed.
    for (const abs of ['/repo/deep/x.ts', '/Users/me/Documents/repo/src/x.ts', 'C:\\work\\repo\\x.ts']) {
      const diff = buildDiffFromEdits([{ file: abs, toolName: 'Write', input: { content: 'a\n' } }]);
      const header = diff.split('\n')[0];
      expect(header).toMatch(/^diff --git a\/[^/].* b\/[^/].*$/);
      expect(header).not.toContain('a//');
      expect(header).not.toContain('\\');
    }
  });

  it('uses a repo-relative path verbatim, so the header matches filesChanged', () => {
    const diff = buildDiffFromEdits([
      { file: 'apps/api/src/routes/sessions.ts', toolName: 'Write', input: { content: 'x\n' } },
    ]);
    expect(diff.split('\n')[0]).toBe('diff --git a/apps/api/src/routes/sessions.ts b/apps/api/src/routes/sessions.ts');
  });

  it('produces a patch git apply actually accepts', () => {
    // The point of a well-formed diff: an external tool can consume it.
    // Uses a REPO-RELATIVE path — what a git patch requires, and what the
    // scoped callers pass.
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdfe-')));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
      const diff = buildDiffFromEdits([
        { file: 'created.py', toolName: 'Write', input: { content: 'import os\nprint(os.getcwd())\n' } },
      ]);
      fs.writeFileSync(path.join(repo, 'p.diff'), diff.endsWith('\n') ? diff : diff + '\n');
      execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: repo });
      execFileSync('git', ['apply', 'p.diff'], { cwd: repo });
      expect(fs.readFileSync(path.join(repo, 'created.py'), 'utf-8')).toBe('import os\nprint(os.getcwd())\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('emits nothing for an edit with no content, rather than a bare file header', () => {
    expect(buildDiffFromEdits([
      { file: '/repo/a.ts', toolName: 'Edit', input: { old_string: '', new_string: '' } },
    ])).toBe('');
    expect(buildDiffFromEdits([
      { file: '/repo/a.ts', toolName: 'SomeUnknownTool', input: {} },
    ])).toBe('');
  });
});
