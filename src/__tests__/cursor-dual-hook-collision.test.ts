// Regression: Cursor ⇄ claude-code dual-hook collision.
//
// Cursor fires Claude-Code-compatible hooks from ~/.claude/settings.json IN
// ADDITION to its own ~/.cursor/hooks.json, so ONE Cursor turn runs BOTH
// `origin hooks cursor <event>` and `origin hooks claude-code <event>` with the
// SAME stdin payload. Observed live in ~/.origin/hooks.log, ~113ms apart:
//
//   [session-start] begin {"agentSlug":"cursor",     "inputKeys":[…,"cursor_version",…]}
//   [session-start] begin {"agentSlug":"claude-code","inputKeys":[…,"cursor_version",…]}
//
// The claude-code twin can never resolve the Cursor session state (wrong slug,
// plus a forced exact match on Cursor's per-turn-rotating session_id), so
// pre/post-tool-use ABORT with "no session state" and Stop MINTS A WHOLE NEW
// session tagged agentSlug "claude-code" carrying a Cursor model. Six such files
// existed in ~/.origin/sessions on the reporting machine (e.g. local-6baa9c with
// 4 prompts) — `local-` there only because that machine's session/start was
// falling back; connected, the twin syncs a mislabeled duplicate chat.
//
// detectForeignHookPayload drops that twin at the hook entry point, keyed on
// `cursor_version` — Cursor stamps it on every payload, Claude Code never sends
// it. Deliberately a BAIL, not the re-tag the Devin/Windsurf collision uses
// (retagDevinFromProcess): Devin CLI has no hook of its own, whereas Cursor's
// own hook already captured this turn correctly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectForeignHookPayload, hooksCommand } from '../commands/hooks.js';

// Verbatim key set from a real Cursor hook payload (hooks.log, v1.7.x).
const cursorPayload = (event: string) => ({
  conversation_id: 'c0ffee00-1111-2222-3333-444455556666',
  generation_id: 'gen-abc123',
  model: 'cursor-grok-4.6-high-fast',
  model_id: 'grok-4.6-high-fast',
  model_params: {},
  is_background_agent: false,
  composer_mode: 'agent',
  session_id: 'edfce93d-fc5f-4e14-82c7-a59033d4cd12',
  hook_event_name: event,
  cursor_version: '1.7.60',
  workspace_roots: ['/tmp/some-repo'],
  user_email: 'dev@example.com',
  transcript_path: '/tmp/does-not-exist.jsonl',
});

describe('detectForeignHookPayload', () => {
  it('flags a Cursor payload arriving on the claude-code hook', () => {
    expect(detectForeignHookPayload('claude-code', cursorPayload('stop'))).toEqual({
      foreignSlug: 'cursor',
      discriminator: 'cursor_version',
    });
    // The bare `claude` alias is hijacked the same way.
    expect(detectForeignHookPayload('claude', cursorPayload('session-start'))?.foreignSlug).toBe('cursor');
  });

  it('leaves the REAL Cursor hook alone — it is the fire that must capture the turn', () => {
    expect(detectForeignHookPayload('cursor', cursorPayload('stop'))).toBeNull();
  });

  it('never second-guesses any other slug, even on a Cursor-shaped payload', () => {
    for (const slug of ['codex', 'gemini', 'devin', 'copilot', 'antigravity', undefined]) {
      expect(detectForeignHookPayload(slug, cursorPayload('stop'))).toBeNull();
    }
  });

  it('passes a genuine Claude Code payload through (no cursor_version)', () => {
    const claudePayload = {
      session_id: 'b1f2c3d4-0000-1111-2222-333344445555',
      transcript_path: '/home/dev/.claude/projects/x/y.jsonl',
      cwd: '/home/dev/repo',
      hook_event_name: 'Stop',
      prompt_id: 'p-1',
    };
    expect(detectForeignHookPayload('claude-code', claudePayload)).toBeNull();
  });

  it('is not fooled by a non-string or empty cursor_version, or a missing payload', () => {
    expect(detectForeignHookPayload('claude-code', { cursor_version: 1.7 })).toBeNull();
    expect(detectForeignHookPayload('claude-code', { cursor_version: '' })).toBeNull();
    expect(detectForeignHookPayload('claude-code', {})).toBeNull();
    expect(detectForeignHookPayload('claude-code', null)).toBeNull();
    expect(detectForeignHookPayload('claude-code', undefined)).toBeNull();
  });
});

// End-to-end through the real hook entry point: the payload is delivered via
// ORIGIN_HOOK_INPUT_FILE (readHookInput's file seam, used by the background
// dispatcher) so no stdin plumbing is needed. HOME is redirected per worker by
// setup/isolate-home.ts, so ~/.origin here is a scratch dir.
describe('hooksCommand — claude-code hook fired by Cursor', () => {
  const logPath = path.join(os.homedir(), '.origin', 'hooks.log');
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  let inputFile: string;

  beforeEach(() => {
    try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }
    fs.mkdirSync(path.join(os.homedir(), '.origin'), { recursive: true });
    inputFile = path.join(os.tmpdir(), `origin-dual-hook-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    delete process.env.ORIGIN_HOOK_INPUT_FILE;
    try { fs.rmSync(inputFile, { force: true }); } catch { /* ignore */ }
  });

  it('bails before handleStop runs, so no duplicate session is minted', async () => {
    const before = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];

    fs.writeFileSync(inputFile, JSON.stringify(cursorPayload('stop')));
    process.env.ORIGIN_HOOK_INPUT_FILE = inputFile;
    await hooksCommand('stop', 'claude-code');

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('ABORT: cursor payload on the claude-code hook (dual-hook collision)');
    // The exact line from the bug report must NOT appear — handleStop is the
    // handler that mints the mislabeled local-*.json session.
    expect(log).not.toContain('[stop] begin');

    const after = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
    expect(after).toEqual(before);
  });

  it('bails on the tool-use events too (the "ABORT: no session state" noise)', async () => {
    fs.writeFileSync(inputFile, JSON.stringify(cursorPayload('pre-tool-use')));
    process.env.ORIGIN_HOOK_INPUT_FILE = inputFile;
    await hooksCommand('pre-tool-use', 'claude-code');

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('dual-hook collision');
    expect(log).not.toContain('ABORT: no session state');
  });
});
