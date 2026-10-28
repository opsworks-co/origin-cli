/**
 * A session's memory entry is written when it ends, and memory keeps only the
 * decisions of turns that made a commit. A person who tells the agent not to
 * commit and commits its work by hand afterwards got an entry with no
 * decisions: at the end there was no commit to show, and the commit that came
 * later never revisited the entry. Prod 2026-10-27, a RhodeCode repo: session
 * 4346757a ended at 12:36 with two decisions, its user committed the work at
 * 15:55 (OR-24) with the session's trailer — memory kept neither.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePrepareCommitMsg } from '../commands/hooks.js';
import { handlePostCommit } from '../commands/hooks/post-commit.js';
import { readAllSessionMemory } from '../memory.js';
import { commitsAfterEnd, writeFinalSessionMemory } from '../session-memory-final.js';

const iso = (ms: number) => new Date(ms).toISOString();
const user = (ms: number, text: string) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } });
const said = (ms: number, text: string) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } });

const KEPT = 'Consecutive lines sharing one record collapse into a single badge';
const DROPPED = 'The badge uses a purple gradient';

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-afterend-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const turnA = t0 + 60_000;
  const turnB = t0 + 20 * 60_000;
  const transcriptPath = path.join(dir, '.git', 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, [
    user(turnA, 'collapse consecutive lines that share a record, do not commit'),
    said(turnA + 30_000, `Done.\n[Origin: Decision] ${KEPT}`),
    user(turnB, 'try a purple badge'),
    said(turnB + 30_000, `Tried it.\n[Origin: Decision] ${DROPPED}`),
  ].join('\n'));

  const state = {
    sessionId: '4346757a-0697-46fc-9885-d7cd646a1fee',
    repoPath: dir,
    startedAt: iso(t0),
    agentSlug: 'claude-code',
    model: 'claude-opus-5-5',
    branch: 'OR-24',
    prompts: ['p1', 'p2'],
    transcriptPath,
    promptSubmittedAt: [iso(turnA), iso(turnB)],
    completedPromptMappings: [
      { promptIndex: 0, filesChanged: ['codeblocks.py'], diff: '+def collapse_runs(lines):\n+    return merge_adjacent_records(lines)\n+BADGE_CLASS = "run-badge"' },
      { promptIndex: 1, filesChanged: ['code-block.less'], diff: '+.run-badge { background: linear-gradient(purple, violet); }\n+.run-badge-border { color: purple; }' },
    ],
    sessionCommitShas: [] as string[],
  };
  return { dir, git, state };
}

describe('a session committed by hand after it ended', () => {
  it('its memory entry gets back the decisions of the turns whose work the commit holds', () => {
    const { dir, git, state } = setup();
    try {
      // At the end: no commit, so no decision is kept.
      writeFinalSessionMemory(state);
      const before = readAllSessionMemory(dir).find((e) => e.sessionId === state.sessionId);
      expect(before?.decisions || []).toEqual([]);

      // The person commits turn A's work (not turn B's purple design); the
      // trailer is the one prepare-commit-msg stamps on an ended session.
      fs.writeFileSync(path.join(dir, 'codeblocks.py'),
        'def collapse_runs(lines):\n    return merge_adjacent_records(lines)\nBADGE_CLASS = "run-badge"\n');
      git('add', 'codeblocks.py');
      git('commit', '-qm', 'OR-24 Collapse consecutive lines sharing one record v1\n\nOrigin-Session: 4346757a-069 | Claude Code');
      expect(commitsAfterEnd(dir, state)).toHaveLength(1);

      expect(writeFinalSessionMemory(state)).toBe(true);
      const after = readAllSessionMemory(dir).find((e) => e.sessionId === state.sessionId)!;
      expect(after.decisions).toEqual([KEPT]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a commit with another session\'s trailer, or the session\'s own recorded commit, is not one', () => {
    const { dir, git, state } = setup();
    try {
      fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
      git('add', 'a.py');
      git('commit', '-qm', 'other\n\nOrigin-Session: 9ea2787c-5ae | Claude Code');
      fs.writeFileSync(path.join(dir, 'b.py'), 'y = 2\n');
      git('add', 'b.py');
      git('commit', '-qm', 'own\n\nOrigin-Session: 4346757a-069 | Claude Code');
      const own = git('rev-parse', 'HEAD').trim();
      expect(commitsAfterEnd(dir, { ...state, sessionCommitShas: [own] })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('through the git hooks', () => {
  it('prepare-commit-msg stamps the ended session, post-commit rewrites its memory', async () => {
    const { dir, git, state } = setup();
    const mirror = path.join(os.homedir(), '.origin', 'sessions');
    const origCwd = process.cwd();
    try {
      // What the heartbeat leaves when it ends the session: the mirror file,
      // and the entry written with no commit to show.
      const ended = {
        ...state, sessionTag: '4346757a', lastCwd: dir, status: 'ENDED', endedAt: iso(Date.now() - 60 * 60_000),
        completedPromptMappings: state.completedPromptMappings.map((m) => ({ ...m, promptText: '', uncommittedDiff: m.diff, diff: '' })),
      };
      fs.mkdirSync(mirror, { recursive: true });
      fs.writeFileSync(path.join(mirror, `${state.sessionId.slice(0, 12)}.json`), JSON.stringify(ended));
      writeFinalSessionMemory(ended);

      process.chdir(dir);
      fs.writeFileSync(path.join(dir, 'codeblocks.py'),
        'def collapse_runs(lines):\n    return merge_adjacent_records(lines)\nBADGE_CLASS = "run-badge"\n');
      git('add', 'codeblocks.py');
      const msgFile = path.join(dir, '.git', 'COMMIT_EDITMSG');
      fs.writeFileSync(msgFile, 'OR-24 Collapse consecutive lines sharing one record v1\n');
      await handlePrepareCommitMsg(msgFile, 'message');
      expect(fs.readFileSync(msgFile, 'utf-8')).toContain('Origin-Session: 4346757a-069');
      git('commit', '-q', '--no-verify', '-F', msgFile);
      await handlePostCommit();

      const entry = readAllSessionMemory(dir).find((e) => e.sessionId === state.sessionId)!;
      expect(entry.decisions).toEqual([KEPT]);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(path.join(mirror, `${state.sessionId.slice(0, 12)}.json`), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
