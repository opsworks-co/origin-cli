/**
 * Tests for the prepare-commit-msg hook.
 *
 * Covers:
 *   • `buildOriginTrailers` — pure function that builds trailer lines
 *   • `handlePrepareCommitMsg` end-to-end in a real temp git repo:
 *       - Adds trailer when session is active, source = 'message'
 *       - No trailer when no active session
 *       - Skips merge / squash / commit sources
 *       - No duplicate when trailer already present
 *       - Preserves existing Co-Authored-By and Signed-off-by trailers
 *       - Never throws; commit always succeeds
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildOriginTrailers, handlePrepareCommitMsg } from '../commands/hooks.js';

// ─── Unit tests for buildOriginTrailers ─────────────────────────────────

describe('buildOriginTrailers', () => {
  it('produces a single Origin-Session trailer when no snapshot', () => {
    const out = buildOriginTrailers('abcdef1234567890', 'claude-sonnet-4', 3);
    expect(out).toEqual(['Origin-Session: abcdef123456 | Claude Code | 3 prompts']);
  });

  it('adds Origin-Snapshot trailer when snapshot id provided', () => {
    const out = buildOriginTrailers('abcdef1234567890', 'claude-opus-4', 1, 'chk-abc');
    expect(out).toEqual([
      'Origin-Session: abcdef123456 | Claude Code | 1 prompt',
      'Origin-Snapshot: chk-abc',
    ]);
  });

  it('omits prompt count when zero', () => {
    const out = buildOriginTrailers('abcdef1234567890', 'claude-sonnet-4', 0);
    expect(out[0]).toBe('Origin-Session: abcdef123456 | Claude Code');
  });

  it.each([
    ['claude-sonnet-4', 'Claude Code'],
    ['claude-opus-4-6', 'Claude Code'],
    ['gpt-4o', 'Cursor'],
    ['o1-preview', 'Cursor'],
    ['gemini-2.0-pro', 'Gemini CLI'],
    ['codex-mini', 'Codex'],
    ['windsurf-auto', 'Windsurf'],
    ['aider', 'Aider'],
    ['copilot-gpt4', 'Copilot'],
    ['amp-claude', 'Amp'],
    ['junie-jetbrains', 'Junie'],
    ['opencode-claude', 'Opencode'],
    ['some-unknown-model', 'some-unknown-model'],
  ])('maps model %s to agent name %s', (model, expectedAgent) => {
    const out = buildOriginTrailers('sess1234567890', model, 1);
    expect(out[0]).toContain(`| ${expectedAgent} |`);
  });
});

// ─── Integration tests: handlePrepareCommitMsg in a real git repo ──────

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-prep-hook-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@origin.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // Disable GPG signing for deterministic CI runs.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function writeMsgFile(repo: string, message: string): string {
  const msgPath = path.join(repo, '.git', 'COMMIT_EDITMSG');
  fs.writeFileSync(msgPath, message);
  return msgPath;
}

// Write a fake active session file that the hook's `listActiveSessions` will pick up.
// Origin's session state lives in `.git/origin-session-<tag>.json` per-repo.
function writeActiveSession(repo: string, opts: {
  sessionId: string;
  model: string;
  promptCount?: number;
  sessionTag?: string;
  claudeSessionId?: string;
}) {
  const tag = opts.sessionTag || opts.sessionId.slice(0, 12);
  const state = {
    sessionId: opts.sessionId,
    claudeSessionId: opts.claudeSessionId || opts.sessionId,
    transcriptPath: '',
    model: opts.model,
    startedAt: new Date().toISOString(),
    prompts: Array.from({ length: opts.promptCount ?? 0 }, (_, i) => `prompt ${i}`),
    repoPath: repo,
    headShaAtStart: null,
    headShaAtLastStop: null,
    prePromptSha: null,
    branch: null,
    sessionTag: tag,
  };
  fs.writeFileSync(
    path.join(repo, '.git', `origin-session-${tag}.json`),
    JSON.stringify(state),
    { mode: 0o600 },
  );
}

describe('handlePrepareCommitMsg', () => {
  let repo: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    repo = createTempGitRepo();
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(origCwd);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('adds Origin-Session trailer when session is active and source is "message"', async () => {
    writeActiveSession(repo, { sessionId: 'abcdef1234567890', model: 'claude-sonnet-4', promptCount: 2 });
    const msgFile = writeMsgFile(repo, 'Fix auth bug\n');

    await handlePrepareCommitMsg(msgFile, 'message');

    const out = fs.readFileSync(msgFile, 'utf-8');
    expect(out).toContain('Origin-Session: abcdef123456 | Claude Code | 2 prompts');
  });

  it('does nothing when there is no active session', async () => {
    const msgFile = writeMsgFile(repo, 'Initial commit\n');

    await handlePrepareCommitMsg(msgFile, 'message');

    const out = fs.readFileSync(msgFile, 'utf-8');
    expect(out).toBe('Initial commit\n');
  });

  it.each(['merge', 'squash', 'commit'])(
    'skips source = %s (preserves message exactly)',
    async (source) => {
      writeActiveSession(repo, { sessionId: 'abcdef1234567890', model: 'claude-sonnet-4' });
      const original = 'Merge branch feature\n';
      const msgFile = writeMsgFile(repo, original);

      await handlePrepareCommitMsg(msgFile, source);

      expect(fs.readFileSync(msgFile, 'utf-8')).toBe(original);
    },
  );

  it('does not duplicate when trailer is already present for the same session', async () => {
    writeActiveSession(repo, { sessionId: 'abcdef1234567890', model: 'claude-sonnet-4', promptCount: 1 });
    const existing = 'Fix bug\n\nOrigin-Session: abcdef123456 | Claude Code | 1 prompt\n';
    const msgFile = writeMsgFile(repo, existing);

    await handlePrepareCommitMsg(msgFile, 'message');

    const out = fs.readFileSync(msgFile, 'utf-8');
    const matches = out.match(/Origin-Session:/g) || [];
    expect(matches.length).toBe(1);
  });

  it('preserves existing Co-Authored-By and Signed-off-by trailers', async () => {
    writeActiveSession(repo, { sessionId: 'abcdef1234567890', model: 'claude-sonnet-4', promptCount: 1 });
    const msgFile = writeMsgFile(
      repo,
      'Add feature\n\nCo-Authored-By: Dev <dev@example.com>\nSigned-off-by: Dev <dev@example.com>\n',
    );

    await handlePrepareCommitMsg(msgFile, 'message');

    const out = fs.readFileSync(msgFile, 'utf-8');
    expect(out).toContain('Co-Authored-By: Dev <dev@example.com>');
    expect(out).toContain('Signed-off-by: Dev <dev@example.com>');
    expect(out).toContain('Origin-Session:');
    // Trailers should be in the same trailer block (no blank line separating them).
    const lines = out.split('\n').filter(Boolean);
    const ciIdx = lines.findIndex((l) => l.startsWith('Co-Authored-By:'));
    const soIdx = lines.findIndex((l) => l.startsWith('Signed-off-by:'));
    const osIdx = lines.findIndex((l) => l.startsWith('Origin-Session:'));
    expect(ciIdx).toBeGreaterThan(-1);
    expect(soIdx).toBeGreaterThan(-1);
    expect(osIdx).toBeGreaterThan(-1);
  });

  it('never throws even when msgFile does not exist', async () => {
    await expect(
      handlePrepareCommitMsg('/tmp/does-not-exist-' + Date.now(), 'message'),
    ).resolves.toBeUndefined();
  });

  it('produces a message file that git interpret-trailers considers valid', async () => {
    // Regression test against reintroducing --amend: after the hook runs,
    // `git interpret-trailers --only-trailers --parse` on the same message
    // file should successfully list Origin-Session as a trailer. If the hook
    // corrupted the format, this command errors.
    writeActiveSession(repo, { sessionId: 'abcdef1234567890', model: 'claude-sonnet-4', promptCount: 1 });
    const msgFile = writeMsgFile(repo, 'Seed commit\n\nFull body text here.\n');
    await handlePrepareCommitMsg(msgFile, 'message');

    const parsed = execFileSync(
      'git',
      ['interpret-trailers', '--only-trailers', '--parse', msgFile],
      { cwd: repo, encoding: 'utf-8' },
    );
    expect(parsed).toContain('Origin-Session: abcdef123456 | Claude Code | 1 prompt');
  });
});
