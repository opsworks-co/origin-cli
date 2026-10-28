/**
 * `origin backfill` tags a commit only on evidence that names its agent:
 * Origin's own session records, the agent's transcript showing the commit,
 * the commit's trailer / co-author / author. Style guesses are gone — they
 * labelled ordinary human commits as Claude, Codex or Gemini — and the note it
 * writes is one the server reads (a v1 record with `inferred` evidence).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectFromCommitMessage, agentNamedBy, claudeProjectSlug, __testing } from '../commands/backfill.js';

const commit = (over: Partial<Record<string, any>> = {}) => ({
  sha: 'abc1234def5678900000000000000000000000ab',
  date: '2026-10-01T00:00:00Z',
  timestamp: Date.parse('2026-10-01T00:00:00Z') / 1000,
  subject: 'feat: update the parser — handle edge cases properly here',
  authorName: 'Ann Dev',
  authorEmail: 'ann@example.com',
  committerName: 'Ann Dev',
  committerEmail: 'ann@example.com',
  ...over,
});

describe('what a commit says about itself', () => {
  it('a human commit written in an "AI style" is not an agent commit', () => {
    const msg = 'feat: update the parser — handle edge cases\n\nAs requested, implement the thing.\nMore.\nMore.\nMore.';
    expect(detectFromCommitMessage(commit(), msg)).toBeNull();
    expect(detectFromCommitMessage(commit({ subject: 'fix small typo' }), 'fix small typo')).toBeNull();
    expect(detectFromCommitMessage(commit(), 'chore: tidy ✨')).toBeNull();
  });

  it('a GitHub noreply co-author is a person, not Copilot', () => {
    expect(agentNamedBy('Alice <123+alice@users.noreply.github.com>')).toBeNull();
    expect(detectFromCommitMessage(commit(), 'x\n\nCo-authored-by: Alice <123+alice@users.noreply.github.com>')).toBeNull();
    expect(agentNamedBy('Kai Aidan <kai@ai.example>')).toBeNull();
  });

  it('names its agent through the trailer, a co-author or the author', () => {
    expect(detectFromCommitMessage(commit(), 'x\n\nOrigin-Session: 1234abcd-567 | Claude Code | 3 prompts'))
      .toMatchObject({ agent: 'claude', confidence: 'high', source: 'backfill-trailer' });
    expect(detectFromCommitMessage(commit(), 'x\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>'))
      .toMatchObject({ agent: 'copilot', confidence: 'high' });
    expect(detectFromCommitMessage(commit(), 'x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>'))
      .toMatchObject({ agent: 'claude' });
    expect(detectFromCommitMessage(commit({ authorName: 'Cursor Agent', authorEmail: 'cursoragent@cursor.com' }), 'x'))
      .toMatchObject({ agent: 'cursor', source: 'backfill-author-match' });
  });
});

describe('the agent transcript shows the commit', () => {
  let home: string;
  const repo = '/work/acme/app';
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-home-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads ~/.claude/projects/<slug> for this repo (and its worktrees), not other repos', () => {
    const write = (dir: string, body: string) => {
      fs.mkdirSync(path.join(home, '.claude', 'projects', dir), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'projects', dir, 's.jsonl'), body);
    };
    const slug = claudeProjectSlug(repo);
    // Claude Code dashes every non-alphanumeric, the drive's colon included:
    // on Windows `/work/acme/app` resolves to `D:\work\acme\app` → `D--work-acme-app`.
    expect(slug).toBe(process.platform === 'win32' ? `${path.resolve(repo)[0]}--work-acme-app` : '-work-acme-app');
    write(slug, JSON.stringify({ toolUseResult: { stdout: '[main abc1234] feat: thing\n 1 file changed' }, cmd: 'git commit -m x' }));
    write(`${slug}--claude-worktrees-w1`, JSON.stringify({ out: '[claude/x 9999999] wip', cmd: 'git commit' }));
    write('-work-acme-other', JSON.stringify({ out: '[main 7777777] theirs', cmd: 'git commit' }));

    const found = __testing.scanClaudeTranscripts(repo, home, 0);
    expect(found.map((f) => f.short).sort()).toEqual(['9999999', 'abc1234']);
    expect(__testing.matchTranscriptCommit(commit() as any, found)?.agent).toBe('claude');
    expect(__testing.matchTranscriptCommit(commit({ sha: '7777777'.padEnd(40, '0') }) as any, found)).toBeNull();
  });

  it('reads Codex rollouts only for sessions that ran in this repo', () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '01');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = (name: string, cwd: string, out: string) => fs.writeFileSync(path.join(dir, name),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n${JSON.stringify({ output: out, cmd: 'git commit' })}\n`);
    rollout('rollout-a.jsonl', repo, '[main abc1234] feat');
    rollout('rollout-b.jsonl', '/work/acme/other', '[main 7777777] theirs');
    expect(__testing.scanCodexTranscripts(repo, home, 0).map((f) => [f.short, f.agent])).toEqual([['abc1234', 'codex']]);
  });
});

describe("Origin's own session records", () => {
  const session = (over: Record<string, any> = {}) => ({
    sessionId: 's1', agent: 'claude', model: 'claude', repoPath: '/r',
    startedAt: Date.parse('2026-09-30T23:00:00Z'), endedAt: Date.parse('2026-10-01T01:00:00Z'), commits: [] as string[], ...over,
  });

  it('a recorded sha matches whoever made it; a time window only for this machine\'s git user and one session', () => {
    const c = commit();
    expect(__testing.matchOriginSession(c as any, [session({ commits: [c.sha] })], '')?.bySha).toBe(true);
    expect(__testing.matchOriginSession(c as any, [session()], 'someone@else.io')).toBeNull();
    expect(__testing.matchOriginSession(c as any, [session()], 'ann@example.com')?.bySha).toBe(false);
    expect(__testing.matchOriginSession(c as any, [session(), session({ sessionId: 's2' })], 'ann@example.com')).toBeNull();
  });
});

describe('the note it writes', () => {
  let repo: string;
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-note-'));
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-q', '-m', 'one');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('carries an inferred v1 record the server reads, and never replaces an existing note', () => {
    const sha = g('rev-parse', 'HEAD');
    const result = { sha, date: '2026-10-01', subject: 'one', agent: 'claude', confidence: 'high' as const, source: 'backfill-transcript', authorName: 'T', authorEmail: 't@example.com' };
    expect(__testing.applyBackfillNote(repo, result)).toBe(true);
    const note = JSON.parse(g('notes', '--ref=origin', 'show', sha));
    expect(note.origin).toMatchObject({ agent: 'claude', backfill: true });
    expect(note.origin.sessionId).toBeUndefined();
    expect(note.attribution_record).toMatchObject({
      revision: { vcs: 'git', id: sha },
      attribution_level: 'commit',
      contributions: [{ evidence: 'inferred', agent: { id: 'claude-code' } }],
    });

    // A second write is refused, and the note is untouched.
    expect(__testing.applyBackfillNote(repo, { ...result, agent: 'codex' })).toBe(false);
    expect(JSON.parse(g('notes', '--ref=origin', 'show', sha)).origin.agent).toBe('claude');
  });
});

describe('the history upload', () => {
  it('sends the author email with each commit', async () => {
    const { buildCommitPayload, prefetchCommitPayloads } = await import('../history-backfill.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-email-'));
    try {
      const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
      g('init', '-q');
      g('config', 'user.email', 'Ann@Example.com');
      g('config', 'user.name', 'Ann');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      g('add', '.');
      g('commit', '-q', '-m', 'one');
      const sha = g('rev-parse', 'HEAD');
      expect(buildCommitPayload(repo, sha, prefetchCommitPayloads(repo, [sha]))).toMatchObject({ author: 'Ann', authorEmail: 'Ann@Example.com', message: 'one' });
      expect(buildCommitPayload(repo, sha)).toMatchObject({ author: 'Ann', authorEmail: 'Ann@Example.com', message: 'one' });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
