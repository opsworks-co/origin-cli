// Readers must agree with what the writer actually writes.
//
// Two commands drifted off the real metadata.json shape and failed silently,
// because every read is wrapped in a try/catch that degrades to empty:
//
//   show.ts     read a prompts.json that NOTHING has ever written, so the
//               prompt list was always empty.
//   backfill.ts read meta.commitSha / meta.headShaAtStart (a FLAT shape the
//               writer never produced) and then a commits.json that nothing
//               writes, so every session looked commit-less.
//
// The writer (buildMetadataJson in local-entrypoint.ts) emits a NESTED shape:
// cost.usd, tokens.total, lines.added, git.commitShas. These tests pin the two
// readers against a file set produced by the real writer, so the next drift
// fails loudly instead of quietly returning nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

describe('session file readers match the writer’s shape', () => {
  let repo: string;
  let home: string;
  let headSha: string;

  beforeEach(async () => {
    const tmp = fs.realpathSync(os.tmpdir());
    repo = fs.mkdtempSync(path.join(tmp, 'origin-shape-'));
    home = fs.mkdtempSync(path.join(tmp, 'origin-home-'));
    fs.mkdirSync(path.join(home, '.origin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.origin', 'config.json'), JSON.stringify({ pushStrategy: 'false' }));

    git(repo, 'init', '-q', '-b', 'main', '.');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.py'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'c1');
    headSha = git(repo, 'rev-parse', 'HEAD');

    // Write a session with the REAL writer, so the fixture can't drift from
    // production the way a hand-rolled JSON blob would.
    vi.resetModules();
    const { writeSessionFiles } = await import('../local-entrypoint.js');
    writeSessionFiles(repo, {
      sessionId: 'shape01',
      model: 'claude-opus-4-8',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 5000,
      status: 'ended',
      costUsd: 4.25,
      tokensUsed: 12345,
      inputTokens: 5000,
      outputTokens: 7345,
      toolCalls: 9,
      linesAdded: 42,
      linesRemoved: 7,
      prompts: [
        { index: 1, text: 'make the thing work', filesChanged: ['a.py'] },
        { index: 2, text: 'now add tests', filesChanged: ['a.py', 'b.py'] },
      ],
      filesChanged: ['a.py'],
      git: { branch: 'main', headBefore: '', headAfter: headSha, commitShas: [headSha] },
      summary: '',
      originUrl: '',
      changes: [],
    } as any);
  });

  afterEach(() => {
    for (const d of [repo, home]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    vi.resetModules();
  });

  it('the writer really does emit the NESTED shape these readers must speak', () => {
    // If this ever fails, the two tests below are testing a fiction.
    const raw = git(repo, 'show', 'refs/origin/sessions/shape01:metadata.json');
    const meta = JSON.parse(raw);
    expect(meta.cost.usd).toBe(4.25);
    expect(meta.tokens.total).toBe(12345);
    expect(meta.lines).toEqual({ added: 42, removed: 7 });
    expect(meta.git.commitShas).toEqual([headSha]);
    // The flat keys the broken readers looked for do not exist.
    expect(meta.costUsd).toBeUndefined();
    expect(meta.tokensUsed).toBeUndefined();
    expect(meta.commitSha).toBeUndefined();
  });

  it('show: recovers the prompts (previously always empty — it read a prompts.json nobody writes)', async () => {
    const { __testing } = await import('../commands/show.js');
    const session = __testing.loadLocalSession('shape01', repo);
    expect(session, 'session not found').toBeTruthy();

    // The actual regression: prompts were always [].
    expect(session!.prompts.map((p) => p.text)).toEqual([
      'make the thing work',
      'now add tests',
    ]);
    // 1-based, matching "## Prompt N" — the renderer prints these verbatim, so
    // an off-by-one here shows up as prompts numbered 2,3,4…
    expect(session!.prompts.map((p) => p.index)).toEqual([1, 2]);
    expect(session!.prompts[1].filesChanged).toEqual(['a.py', 'b.py']);
    expect(session!.promptCount).toBe(2);

    // Nested-shape reads (not rendered today, but returned to callers).
    expect(session!.cost).toBe('$4.25');
    expect(session!.tokensUsed).toBe(12345);
    expect(session!.linesAdded).toBe(42);
    expect(session!.linesRemoved).toBe(7);
  });

  it('backfill: finds the session’s commits (previously always empty)', async () => {
    const { __testing } = await import('../commands/backfill.js');
    const found = __testing.scanOriginSessionsBranch(repo);
    const session = found.find((s) => s.sessionId === 'shape01');
    expect(session, 'session not scanned').toBeTruthy();

    // The regression: commits was ALWAYS [] because it read a flat shape and a
    // commits.json that nothing writes.
    expect(session!.commits).toContain(headSha);
    expect(session!.agent).toBe('claude');
    expect(session!.model).toBe('claude-opus-4-8');
  });

  it('backfill: does not duplicate a sha present in both commitShas and headAfter', async () => {
    const { __testing } = await import('../commands/backfill.js');
    const session = __testing.scanOriginSessionsBranch(repo).find((s) => s.sessionId === 'shape01');
    expect(session!.commits.filter((c) => c === headSha)).toHaveLength(1);
  });
});
