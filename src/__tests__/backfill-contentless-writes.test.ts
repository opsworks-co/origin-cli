// Cursor's `Write` tool logs only the file path in the transcript, not the
// written content, so editsJson lands `op:'write', newContent:''`. The turn's
// created files then render blank. backfillContentLessWrites recovers the
// content from git (the commit the file landed in) or, when still uncommitted,
// from the working-tree file — leaving already-content-ful edits untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { backfillContentLessWrites } from '../prompt-capture/index.js';
import type { PromptCapture } from '../prompt-capture/types.js';

let repo: string;
const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-backfill-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.co']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
});
afterEach(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const turn = (edits: any[], commits: string[] = []): PromptCapture => ({
  promptIndex: 0, promptText: 'create some files', agent: 'cursor', edits, commits,
});

describe('backfillContentLessWrites', () => {
  it('fills a content-less write from the committed blob (git show <sha>:<file>)', () => {
    fs.writeFileSync(path.join(repo, 'config.yaml'), 'project: korop\nversion: 0.1.0\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add config']);
    const sha = git(['rev-parse', 'HEAD']).trim();
    // Simulate the working tree having moved on (a later edit) so disk would be
    // WRONG — the git path must win and return the committed bytes.
    fs.writeFileSync(path.join(repo, 'config.yaml'), 'totally different working-tree content\n');

    const t = turn([{ file: 'config.yaml', op: 'write', newContent: '', source: 'tool_call', commitSha: sha }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });

    expect(t.edits[0].newContent).toBe('project: korop\nversion: 0.1.0\n');
  });

  it('falls back to turn.commits when the edit itself carries no sha', () => {
    fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'notes', 'ideas.md'), '# Ideas\n- ship it\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add notes']);
    const sha = git(['rev-parse', 'HEAD']).trim();

    const t = turn([{ file: 'notes/ideas.md', op: 'write', newContent: '', source: 'tool_call' }], [sha]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });

    expect(t.edits[0].newContent).toBe('# Ideas\n- ship it\n');
  });

  it('falls back to the working-tree file for an uncommitted write', () => {
    fs.writeFileSync(path.join(repo, 'main.py'), 'print("hi")\n');
    const t = turn([{ file: 'main.py', op: 'write', newContent: '', source: 'tool_call' }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });
    expect(t.edits[0].newContent).toBe('print("hi")\n');
  });

  it('never overwrites an edit that already has content', () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'ON DISK\n');
    const t = turn([{ file: 'a.ts', op: 'write', newContent: 'FROM TOOL\n', source: 'tool_call' }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });
    expect(t.edits[0].newContent).toBe('FROM TOOL\n');
  });

  it('leaves the edit content-less when the file is nowhere to be found', () => {
    const t = turn([{ file: 'ghost.txt', op: 'write', newContent: '', source: 'tool_call' }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });
    expect(t.edits[0].newContent).toBe('');
  });

  it('ignores non-write ops (edits carry their own old/new content)', () => {
    fs.writeFileSync(path.join(repo, 'a.ts'), 'ON DISK\n');
    const t = turn([{ file: 'a.ts', op: 'edit', oldContent: 'x', newContent: '', source: 'tool_call' }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });
    expect(t.edits[0].newContent).toBe(''); // unchanged — not a write/create
  });

  // ── The petrushka contamination (prod session 8661b904) ────────────────
  // Turn 1's content-less write is backfilled AFTER turn 2 extended the
  // file and committed everything in one commit. attributeCommitsToPrompts
  // stamps that commit on BOTH turns (file overlap), so the blob — and the
  // live file — both show turn 2's 6-row state. The backfill must
  // reverse-apply turn 2's own edit to recover turn 1's 4-row version.
  it('reverse-applies later turns\' edits so a swept commit blob does not credit this turn with their lines', () => {
    const four = 'falcon-8821 | blue | 47.3\nmaple-0042 | green | 12.8\nstorm-7710 | gray | 93.1\norbit-3399 | red | 6.5\n';
    const six = four + 'delta-5512 | yellow | 28.4\nnova-1188 | purple | 61.0\n';
    fs.writeFileSync(path.join(repo, 'random_rows.txt'), six);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add 2 more lines']);
    const sha = git(['rev-parse', 'HEAD']).trim();

    const t1: PromptCapture = {
      promptIndex: 0, promptText: 'Create 1 file and write 4 random raws', agent: 'cursor',
      edits: [{ file: 'random_rows.txt', op: 'write', newContent: '', source: 'tool_call', commitSha: sha }],
      commits: [sha],
    };
    const t2: PromptCapture = {
      promptIndex: 1, promptText: 'now add 2 more lines and commit', agent: 'cursor',
      edits: [{
        file: 'random_rows.txt', op: 'edit',
        oldContent: 'orbit-3399 | red | 6.5\n',
        newContent: 'orbit-3399 | red | 6.5\ndelta-5512 | yellow | 28.4\nnova-1188 | purple | 61.0\n',
        source: 'tool_call', commitSha: sha,
      }],
      commits: [sha],
    };
    backfillContentLessWrites([t1, t2], { agent: 'cursor', repoPath: repo });

    expect(t1.edits[0].newContent).toBe(four);
    expect(t1.edits[0].backfillSource).toBe('commit-blob+reversed-1');
    // Turn 2's own edit is untouched — it always carried its content.
    expect(t2.edits[0].newContent).toContain('nova-1188');
  });

  it('skips the backfill entirely when a later turn rewrote the whole file', () => {
    fs.writeFileSync(path.join(repo, 'notes.md'), 'REWRITTEN BY TURN 2\n');
    const t1: PromptCapture = {
      promptIndex: 0, promptText: 'write notes', agent: 'cursor',
      edits: [{ file: 'notes.md', op: 'write', newContent: '', source: 'tool_call' }],
      commits: [],
    };
    const t2: PromptCapture = {
      promptIndex: 1, promptText: 'rewrite notes', agent: 'cursor',
      edits: [{ file: 'notes.md', op: 'write', newContent: 'REWRITTEN BY TURN 2\n', source: 'tool_call' }],
      commits: [],
    };
    backfillContentLessWrites([t1, t2], { agent: 'cursor', repoPath: repo });

    // Turn 1's version is unrecoverable — better content-less than a lie.
    expect(t1.edits[0].newContent).toBe('');
    expect(t1.edits[0].backfillSource).toBe('skipped-later-rewrite');
  });

  it('records the source on plain backfills', () => {
    fs.writeFileSync(path.join(repo, 'main.py'), 'print("hi")\n');
    const t = turn([{ file: 'main.py', op: 'write', newContent: '', source: 'tool_call' }]);
    backfillContentLessWrites([t], { agent: 'cursor', repoPath: repo });
    expect(t.edits[0].newContent).toBe('print("hi")\n');
    expect(t.edits[0].backfillSource).toBe('live-file');
  });
});
