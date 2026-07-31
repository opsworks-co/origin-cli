/**
 * commitDiffScopedToPrompt — "prompt 3 added 5 lines but Origin showed +15".
 *
 * Reproduces the reported Codex session exactly:
 *   prompt 2: create ten-lines.txt with 10 lines  (untracked, uncommitted)
 *   prompt 3: add 5 more lines, then commit
 *
 * git reports that commit as +15, because the file is new to git — the whole
 * thing is an addition. Crediting the raw commit stat to prompt 3 therefore
 * claims it wrote 15 lines when it wrote 5. Prompt 3's baseline shadow already
 * holds the 10-line version, so baseline->commit is the correct +5.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createShadowCommit, commitDiffScopedToPrompt } from '../git-capture.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', windowsHide: true }).trim();
}

describe('commitDiffScopedToPrompt', () => {
  let repo: string;
  const FILE = 'ten-lines.txt';

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-scope-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@test.dev']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'seed']);
  });

  it('credits the prompt with 5 lines, not the commit-s 15', () => {
    // Prompt 2 created the file untracked with 10 lines.
    fs.writeFileSync(path.join(repo, FILE), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

    // Prompt 3 starts: baseline shadow snapshots the tree, untracked file included.
    const baseline = createShadowCommit(repo, 'prompt-3')!;
    expect(baseline).toBeTruthy();

    // Prompt 3 adds 5 lines and commits.
    fs.appendFileSync(path.join(repo, FILE), Array.from({ length: 5 }, (_, i) => `line ${i + 11}`).join('\n') + '\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'Add fifteen-line file']);
    const commitSha = git(repo, ['rev-parse', 'HEAD']);

    // What git says about the commit on its own — the number that was wrong.
    const commitStat = git(repo, ['show', '--numstat', '--format=', commitSha]);
    expect(commitStat).toMatch(/^15\t0\t/);

    // What the prompt actually contributed.
    const scoped = commitDiffScopedToPrompt(repo, baseline, commitSha, [FILE]);
    expect(scoped).not.toBeNull();
    expect(scoped!.linesAdded).toBe(5);
    expect(scoped!.linesRemoved).toBe(0);
    expect(scoped!.diff).toContain('+line 11');
    expect(scoped!.diff).not.toContain('+line 1\n'); // pre-existing lines excluded
  });

  it('still reports the full file when the prompt genuinely created it', () => {
    // Clean tree at prompt start → shadow returns null, so HEAD is the baseline.
    const headBaseline = git(repo, ['rev-parse', 'HEAD']);
    expect(createShadowCommit(repo, 'clean')).toBeNull();

    fs.writeFileSync(path.join(repo, FILE), Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'new file']);
    const commitSha = git(repo, ['rev-parse', 'HEAD']);

    const scoped = commitDiffScopedToPrompt(repo, headBaseline, commitSha, [FILE]);
    expect(scoped!.linesAdded).toBe(15);
  });

  it('reports zero when the commit only recorded what the baseline already had', () => {
    fs.writeFileSync(path.join(repo, FILE), 'a\nb\nc\n');
    const baseline = createShadowCommit(repo, 'same')!;
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'commit the pre-existing content']);
    const commitSha = git(repo, ['rev-parse', 'HEAD']);

    const scoped = commitDiffScopedToPrompt(repo, baseline, commitSha, [FILE]);
    expect(scoped!.linesAdded).toBe(0);
    expect(scoped!.linesRemoved).toBe(0);
  });

  it('returns null on unusable input so callers keep the commit stat', () => {
    const sha = git(repo, ['rev-parse', 'HEAD']);
    expect(commitDiffScopedToPrompt(repo, null, sha, [])).toBeNull();
    expect(commitDiffScopedToPrompt(repo, undefined, sha, [])).toBeNull();
    expect(commitDiffScopedToPrompt(repo, 'nope', sha, [])).toBeNull();
    expect(commitDiffScopedToPrompt(repo, sha, sha, [])).toBeNull();
    expect(commitDiffScopedToPrompt(repo, 'a'.repeat(40), sha, [])).toBeNull();
  });
});
