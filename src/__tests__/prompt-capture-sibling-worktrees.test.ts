import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capturePromptEdits, extractEditsFromToolCall } from '../prompt-capture/index.js';
import { fitEditsJsonForServer } from '../session-update-size.js';

let tmp: string, repo: string, first: string, second: string, foreign: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'origin-sibling-capture-'));
  repo = path.join(tmp, 'repo'); first = path.join(tmp, 'first'); second = path.join(tmp, 'second'); foreign = path.join(tmp, 'foreign');
  for (const dir of [repo, foreign]) {
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(tmp, 'no-hooks'));
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'seed');
  }
  for (const wt of [first, second]) git(repo, 'worktree', 'add', '-q', '--detach', wt);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const edit = (file: string, root: string) => extractEditsFromToolCall('Edit', {
  file_path: file, old_string: 'before', new_string: 'after',
}, root, 'claude', false)[0].file;

it('recognizes a sibling worktree when the session itself starts in a worktree', () => {
  expect(edit(path.join(second, 'src/file.ts'), first)).toBe('src/file.ts');
  expect(edit(path.join(repo, 'src/file.ts'), first)).toBe('src/file.ts');
});

it('does not reuse a positive membership result for another repository', () => {
  const file = path.join(second, 'src/file.ts');
  expect(edit(file, repo)).toBe('src/file.ts');
  expect(edit(file, foreign)).toBe(file.replace(/\\/g, '/'));
});

it('does not let a foreign-repo lookup poison a later matching lookup', () => {
  const file = path.join(second, 'src/file.ts');
  expect(edit(file, foreign)).toBe(file.replace(/\\/g, '/'));
  expect(edit(file, first)).toBe('src/file.ts');
});

it('keeps a Codex sibling-worktree patch as authored content, not outside-repo metadata', () => {
  const transcript = path.join(tmp, 'rollout.jsonl');
  const file = path.join(second, 'new.txt');
  fs.writeFileSync(transcript, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'implement the fix' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${file}\n+authored line\n*** End Patch` } },
  ].map(x => JSON.stringify(x)).join('\n'));
  const turns = capturePromptEdits({ agent: 'codex', repoPath: first, transcriptPath: transcript, sessionCommitShas: [] });
  expect(turns).toHaveLength(1);
  expect(turns[0].outOfRepoFiles || []).toEqual([]);
  expect(turns[0].edits.map(e => e.file)).toEqual(['new.txt']);
  expect(turns[0].edits[0].newContent).toContain('authored line');
  // Long-session upload compaction must retain the recovered first-hand patch.
  const wire = fitEditsJsonForServer(JSON.stringify({ ...turns[0], edits: [
    ...turns[0].edits,
    { file: 'large.txt', source: 'commit', op: 'edit', newContent: 'x'.repeat(500_000) },
  ] }));
  expect(JSON.parse(wire!).edits[0]).toMatchObject({ file: 'new.txt', source: 'tool_call', newContent: 'authored line' });
});

it('resolves relative gitdir pointers and commondir from either linked checkout', () => {
  for (const root of [first, second]) {
    const pointer = path.join(root, '.git');
    const gitDir = fs.readFileSync(pointer, 'utf8').trim().slice('gitdir: '.length);
    fs.writeFileSync(pointer, `gitdir: ${path.relative(root, gitDir)}\n`);
  }
  expect(edit(path.join(second, 'src/file.ts'), first)).toBe('src/file.ts');
});
