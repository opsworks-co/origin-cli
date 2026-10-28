// An agent started for an issue must not inherit another agent session's
// markers: Claude Code then runs as that session's child, with transcript
// saving off — the run's tokens and turns never reach Origin.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { spawn } from 'child_process';
import { HEADLESS_SESSION_END_BUDGET_MS, UNSET_AGENT_SESSION_ENV_SH, freshAgentEnv, headlessAgentEnv, isClaudeOneShotRun, isHeadlessRun, processArgs } from '../agent-env.js';
import { claudeHookEvents, CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC } from '../commands/enable.js';
import { sessionEndIsOnlyAStop } from '../commands/hooks/session-end.js';

const inherited = {
  CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk',
  CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_PID: '9', CODEX_THREAD_ID: 't',
};

describe('a fresh agent environment', () => {
  it('drops another session\'s markers and keeps everything else', () => {
    const env = freshAgentEnv({ ...inherited, PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' });
  });

  // POSIX-only: the line goes in the macOS/Linux launch script; Windows launches with windowsScript (url-handler.ts).
  it.skipIf(process.platform === 'win32')('the launch script line unsets them in a real shell', () => {
    const out = execFileSync('/bin/sh', ['-c', `${UNSET_AGENT_SESSION_ENV_SH}; env`], {
      encoding: 'utf-8', env: { ...inherited, PATH: process.env.PATH, KEEP_ME: 'yes' },
    });
    expect(out).toContain('KEEP_ME=yes');
    for (const k of Object.keys(inherited)) expect(out).not.toContain(`${k}=`);
  });
});

describe('a headless run', () => {
  it('is marked, gets room for SessionEnd, and still drops the caller\'s session', () => {
    const env = headlessAgentEnv({ ...inherited, PATH: '/bin' });
    expect(isHeadlessRun(env)).toBe(true);
    expect(env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS).toBe(String(HEADLESS_SESSION_END_BUDGET_MS));
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('its marker does not leak into a run started from inside it', () => {
    expect(isHeadlessRun(freshAgentEnv(headlessAgentEnv({})))).toBe(false);
  });

  it('ends the session at SessionEnd; anywhere else Claude Code\'s SessionEnd stays a Stop', () => {
    expect(sessionEndIsOnlyAStop('claude-code', {})).toBe(true);
    expect(sessionEndIsOnlyAStop('claude-code', { ORIGIN_HEADLESS_RUN: '1' })).toBe(false);
    // Codex's and Copilot's fire per turn even headless: the wrapper ends them.
    expect(sessionEndIsOnlyAStop('codex', { ORIGIN_HEADLESS_RUN: '1' })).toBe(true);
    expect(sessionEndIsOnlyAStop('copilot', { ORIGIN_HEADLESS_RUN: '1' })).toBe(true);
    expect(sessionEndIsOnlyAStop('gemini', {})).toBe(false);
  });
});

// 2026-10-16, Claude Code 2.1.292: `claude -p "echo hi"` printed "SessionEnd
// hook … failed: Hook cancelled" and its session stayed Running for ~3 h.
// Two causes: Claude cancels a SessionEnd hook with no timeout after 1.5 s,
// before ours had read its payload; and a SessionEnd it did finish was only a
// Stop, because the desktop app fires one on reconnect too.
describe('a claude -p someone runs by hand', () => {
  const args = (line: string | null) => () => line;
  const env = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };

  it('ends its session at SessionEnd, even when started inside a desktop session', () => {
    const line = 'claude -p echo hi --allowedTools Bash(echo:*)';
    expect(isClaudeOneShotRun(env, args(line))).toBe(true);
    expect(sessionEndIsOnlyAStop('claude-code', env, { reason: 'other' }, args(line))).toBe(false);
    expect(sessionEndIsOnlyAStop('claude-code', env, { reason: 'other' }, args('claude --print hi'))).toBe(false);
  });

  it('a long-lived Claude process keeps SessionEnd a Stop', () => {
    // The desktop app: stream-json input, restarted on reconnect.
    const desktop = '/Applications/Claude.app/claude --output-format stream-json --verbose --input-format stream-json --settings {}';
    expect(sessionEndIsOnlyAStop('claude-code', env, {}, args(desktop))).toBe(true);
    expect(isClaudeOneShotRun(env, args('claude -p --input-format stream-json'))).toBe(false);
    expect(isClaudeOneShotRun(env, args('claude -p --input-format=stream-json'))).toBe(false);
    // Interactive CLI, a process that is gone, no CLAUDE_PID at all.
    expect(isClaudeOneShotRun(env, args('claude --resume abc'))).toBe(false);
    expect(isClaudeOneShotRun(env, args(null))).toBe(false);
    expect(isClaudeOneShotRun({}, () => { throw new Error('must not read'); })).toBe(false);
    // Only Claude Code: Copilot's `-p` still fires sessionEnd per turn.
    expect(sessionEndIsOnlyAStop('copilot', env, {}, args('copilot -p hi'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reads a real process\'s command line', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', '--', '-p', 'x'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(processArgs(child.pid!)).toContain('-p x');
      expect(isClaudeOneShotRun({ CLAUDE_PID: String(child.pid) })).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('the hook registration gives SessionEnd room to finish', () => {
    const [entry] = claudeHookEvents().SessionEnd;
    expect(entry.hooks[0].timeout).toBe(CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC);
    expect(CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC * 1000).toBe(HEADLESS_SESSION_END_BUDGET_MS);
  });
});
