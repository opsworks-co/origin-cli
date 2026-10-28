// Settings → Agents, CLI side (docs/AGENT_SIGN_IN.md): each agent's status
// output, recorded from the real CLIs on 2026-10-16, and the links.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseVersion, parseClaudeStatus, parseCodexStatus, parseCursorStatus, parseDevinStatus,
  geminiStatus, copilotStatus, lastRunProblem, probeAgent, loginSteps, parseAgentSetupUrl,
  type ProbeDeps, type RunResult,
} from '../agent-setup.js';
import { agentLoginScript } from '../url-handler.js';
import { runLoginSteps } from '../commands/agent-setup.js';

const ok = (stdout: string, stderr = '', code = 0): RunResult => ({ code, stdout, text: `${stdout}\n${stderr}` });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('status parsers', () => {
  it('reads versions the way each CLI prints them', () => {
    expect(parseVersion('2.1.292 (Claude Code)\n')).toBe('2.1.292');
    expect(parseVersion('codex-cli 0.145.0')).toBe('0.145.0');
    expect(parseVersion('2026.10.01-e373342')).toBe('2026.10.01-e373342');
    expect(parseVersion('GitHub Copilot CLI 1.0.98.\nRun \'copilot update\'')).toBe('1.0.98');
    expect(parseVersion('devin 3000.2.17 (2c489dfc)')).toBe('3000.2.17');
  });

  it('claude auth status --json', () => {
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.co', orgId: 'x', orgName: 'y', subscriptionType: 'max' })))
      .toEqual({ signedIn: true, account: 'a@b.co', plan: 'max', method: 'claude.ai' });
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: false }))).toEqual({ signedIn: false, account: null, plan: null, method: null });
    expect(parseClaudeStatus('garbage').signedIn).toBeNull();
  });

  it('codex: status on stderr, email and plan from the id_token payload only', () => {
    const idToken = `h.${b64({ email: 'a@b.co', 'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite', chatgpt_user_id: 'u-1' } })}.sig`;
    const auth = JSON.stringify({ tokens: { id_token: idToken, access_token: 'AT', refresh_token: 'RT' } });
    const s = parseCodexStatus(ok('', 'Logged in using ChatGPT'), auth);
    expect(s).toEqual({ signedIn: true, account: 'a@b.co', plan: 'prolite', method: 'ChatGPT' });
    expect(JSON.stringify(s)).not.toMatch(/AT|RT|u-1/);
    expect(parseCodexStatus(ok('', 'Not logged in', 1), null).signedIn).toBe(false);
  });

  it('cursor-agent status/about --format json', () => {
    expect(parseCursorStatus(JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }), JSON.stringify({ userEmail: null })))
      .toEqual({ signedIn: false, account: null, plan: null, method: null });
    expect(parseCursorStatus(JSON.stringify({ isAuthenticated: true }), JSON.stringify({ userEmail: 'a@b.co', subscriptionTier: 'Free' })))
      .toEqual({ signedIn: true, account: 'a@b.co', plan: 'Free', method: null });
  });

  it('devin auth status (text)', () => {
    const out = 'Logged in (via Devin).\n\nUser:\n  Name:              A\n  Email:             a@b.co\n  User ID:           user-1\n\nAccount:\n  Tier:              Devin Free\n  Plan:              Free\n';
    expect(parseDevinStatus(ok(out))).toEqual({ signedIn: true, account: 'a@b.co', plan: 'Free', method: null });
    expect(parseDevinStatus(ok('Not logged in.', '', 1)).signedIn).toBe(false);
  });

  it('gemini from its settings and accounts files', () => {
    const files: Record<string, string> = {
      [path.join('/h', '.gemini', 'settings.json')]: JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
      [path.join('/h', '.gemini', 'google_accounts.json')]: JSON.stringify({ active: 'a@b.co', old: ['x@y.co'] }),
      [path.join('/h', '.gemini', 'oauth_creds.json')]: '{}',
    };
    const deps = { home: '/h', env: {}, readFile: (f: string) => files[f] ?? null };
    expect(geminiStatus(deps)).toEqual({ signedIn: true, account: 'a@b.co', plan: null, method: 'oauth-personal' });
    expect(geminiStatus({ ...deps, readFile: () => null }).signedIn).toBe(false);
    expect(geminiStatus({ ...deps, env: { GEMINI_API_KEY: 'k' } })).toMatchObject({ signedIn: true, method: 'API key', account: null });
  });

  it('copilot: unknown unless a token is in the environment', () => {
    expect(copilotStatus({}).signedIn).toBeNull();
    expect(copilotStatus({ GH_TOKEN: 'x' })).toMatchObject({ signedIn: true, method: 'GH_TOKEN' });
  });
});

describe('last background run', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const runsDir = '/runs';
  const make = (logTail: string, startedAt = '2026-10-16T10:00:00Z') => {
    const files: Record<string, string> = {
      '/runs/i1-cursor-2026-10-16T10-00-00-000Z.json': JSON.stringify({ agent: 'cursor', log: '/runs/i1.log', startedAt }),
      '/runs/i1.log': logTail,
    };
    return { deps: { now, runsDir, readFile: (f: string) => files[f] ?? null }, list: () => Object.keys(files).map((f) => path.basename(f)) };
  };

  it('flags a usage limit in the newest failed run', () => {
    const { deps, list } = make('Error: You\'ve hit your usage limit. Upgrade to Pro.\n[origin] agent exited with code 1\n');
    expect(lastRunProblem('cursor', deps, list)).toMatch(/usage limit/);
  });

  it('ignores a run that succeeded, is still going, or is over a day old', () => {
    expect(lastRunProblem('cursor', make('usage limit mentioned\n[origin] agent exited with code 0\n').deps, make('').list)).toBeNull();
    const running = make('usage limit');
    expect(lastRunProblem('cursor', running.deps, running.list)).toBeNull();
    const old = make('usage limit\n[origin] agent exited with code 1\n', '2026-10-14T10:00:00Z');
    expect(lastRunProblem('cursor', old.deps, old.list)).toBeNull();
  });
});

describe('probeAgent', () => {
  const deps = (run: ProbeDeps['run']): ProbeDeps => ({ run, readFile: () => null, env: {}, home: '/h', now: Date.now(), runsDir: '/nonexistent' });

  it('an agent that is not on PATH is not installed', async () => {
    const s = await probeAgent('codex', deps(async () => null));
    expect(s).toMatchObject({ installed: false, usable: false, signedIn: null });
  });

  it('a signed-out agent is not usable', async () => {
    const s = await probeAgent('cursor', deps(async (_bin, args) => {
      if (args[0] === '--version') return ok('2026.10.01-e373342');
      if (args[0] === 'status') return ok(JSON.stringify({ isAuthenticated: false }));
      return ok(JSON.stringify({ userEmail: null }));
    }));
    expect(s).toMatchObject({ installed: true, version: '2026.10.01-e373342', signedIn: false, usable: false, problem: 'Signed out.' });
  });

  it('a sign-in failure in the last run is stale once the agent says it is signed in; a usage limit is not', async () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-runs-'));
    try {
      const write = (tail: string) => {
        fs.writeFileSync(path.join(runsDir, 'i1-claude-x.json'), JSON.stringify({ agent: 'claude', log: path.join(runsDir, 'i1.log'), startedAt: new Date(Date.now() - 60_000).toISOString() }));
        fs.writeFileSync(path.join(runsDir, 'i1.log'), tail);
      };
      const probe = (loggedIn: boolean) => probeAgent('claude', { ...deps(async (_bin, args) => {
        if (args[0] === '--version') return ok('2.1.292 (Claude Code)');
        return ok(JSON.stringify({ loggedIn, email: 'a@b.co' }));
      }), runsDir, readFile: (f) => { try { return fs.readFileSync(f, 'utf-8'); } catch { return null; } } });
      write('Not logged in · Please run /login\n[origin] agent exited with code 1\n');
      expect(await probe(true)).toMatchObject({ signedIn: true, usable: true, problem: null });
      expect(await probe(false)).toMatchObject({ signedIn: false, usable: false, problem: 'Signed out.' });
      write('You have hit your usage limit\n[origin] agent exited with code 1\n');
      expect(await probe(true)).toMatchObject({ signedIn: true, usable: false, problem: expect.stringMatching(/usage limit/) });
    } finally { fs.rmSync(runsDir, { recursive: true, force: true }); }
  });

  it('never runs `cursor agent` (it installs cursor-agent)', async () => {
    const bins: string[] = [];
    await probeAgent('cursor', deps(async (bin) => { bins.push(bin); return null; }));
    expect(bins).toEqual(['cursor-agent']);
  });
});

describe('links and login', () => {
  it('parses only known agents', () => {
    expect(parseAgentSetupUrl('getorigin://agents/check')).toEqual({ action: 'check' });
    expect(parseAgentSetupUrl('getorigin://agents/login?agent=cursor&switch=1')).toEqual({ action: 'login', agent: 'cursor', switchAccount: true });
    expect(parseAgentSetupUrl('getorigin://agents/login?agent=cursor;rm%20-rf')).toBeNull();
    expect(parseAgentSetupUrl('getorigin://agents/login?agent=bash')).toBeNull();
    expect(parseAgentSetupUrl('getorigin://issue/start?repo=r&issue=i&agent=claude')).toBeNull();
  });

  it('switching signs out first where the agent can', () => {
    expect(loginSteps('cursor', true).steps).toEqual([['cursor-agent', 'logout'], ['cursor-agent', 'login']]);
    expect(loginSteps('claude').steps).toEqual([['claude', 'auth', 'login']]);
    expect(loginSteps('gemini', true)).toMatchObject({ steps: [['gemini']], note: expect.stringMatching(/\/auth/) });
  });

  it('says how many leading steps sign out', () => {
    expect(loginSteps('claude', true).signOut).toBe(1);
    expect(loginSteps('claude').signOut).toBe(0);
    expect(loginSteps('copilot', true).signOut).toBe(0);
  });

  it('Switch account reports straight after the sign-out, before the sign-in can be abandoned', async () => {
    const events: string[] = [];
    const deps = {
      run: (argv: string[]) => { events.push(`run ${argv.slice(1).join(' ')}`); return { ok: true }; },
      checkAndReport: async () => { events.push('report'); return { sent: true, line: null }; },
      log: () => {},
    };
    const { steps, signOut } = loginSteps('claude', true);
    expect(await runLoginSteps(steps, signOut, deps)).toEqual({ failed: false });
    // The caller reports once more after the sign-in.
    expect(events).toEqual(['run auth logout', 'report', 'run auth login']);

    // A plain sign-in has nothing to report midway.
    events.length = 0;
    const plain = loginSteps('claude');
    await runLoginSteps(plain.steps, plain.signOut, deps);
    expect(events).toEqual(['run auth login']);
  });

  it('a sign-in that cannot run after the sign-out still leaves the signed-out state reported', async () => {
    const events: string[] = [];
    const { steps, signOut } = loginSteps('codex', true);
    const r = await runLoginSteps(steps, signOut, {
      run: (argv) => { events.push(`run ${argv[1]}`); return argv[1] === 'login' ? { ok: false, error: 'not installed' } : { ok: true }; },
      checkAndReport: async () => { events.push('report'); return { sent: true, line: null }; },
      log: () => {},
    });
    expect(r).toEqual({ failed: true });
    expect(events).toEqual(['run logout', 'report', 'run login', 'report']);
  });

  it('the terminal script runs `origin agents login`, then leaves a shell', () => {
    const script = agentLoginScript({ action: 'login', agent: 'codex', switchAccount: true }, ['/usr/bin/node', '/x/bin/origin']);
    expect(script).toContain(`'\\''/x/bin/origin'\\'' agents login '\\''codex'\\'' --switch; exec`);
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });
});
