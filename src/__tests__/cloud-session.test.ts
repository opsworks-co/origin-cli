/**
 * `origin enable --cloud`: repo hooks for Claude Code cloud sessions.
 *
 * Pinned here:
 *   - the committed script exits silently unless CLAUDE_CODE_REMOTE=true, so a
 *     laptop that also has the machine-wide hooks never captures twice;
 *   - in the cloud it bootstraps on SessionStart and hands every event to
 *     `origin hooks claude-code <event>`, keeping bootstrap output off stdout
 *     (SessionStart stdout becomes Claude's context);
 *   - the settings merge is idempotent and keeps the user's own hooks;
 *   - the layer sweepers don't recognise these entries as Origin's
 *     claude-code hooks, or they would delete them from the repo;
 *   - bootstrap writes a config only for a key the server accepts.
 *
 * Runs in mkdtemp repos with HOME pointed at a temp dir; never touches the
 * real ~/.claude or ~/.origin.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cloud-home-'));
let mod: typeof import('../cloud-session.js');
let enable: typeof import('../commands/enable.js');

beforeAll(async () => {
  process.env.HOME = home;
  vi.resetModules();
  mod = await import('../cloud-session.js');
  enable = await import('../commands/enable.js');
});
afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cloud-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

/** A fake `origin` that records its argv, one line per call. */
function fakeOriginBin(): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cloud-bin-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'origin'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = cloud ] && echo bootstrap-says-hi\nexit 0\n`);
  fs.chmodSync(path.join(dir, 'origin'), 0o755);
  return { dir, log };
}

/**
 * /usr/bin and /bin as a PATH that has no `origin`, whatever this machine has
 * installed. The script adds `$(npm prefix -g)/bin` to PATH, which is /usr/bin
 * where npm itself lives there (and /bin if npm fails), so `npm` answers with a
 * prefix that holds no CLI.
 */
function systemPathWithoutOrigin(): string {
  const dir = fs.mkdtempSync(path.join(home, 'system-bin-'));
  for (const from of ['/usr/bin', '/bin']) {
    for (const tool of fs.readdirSync(from)) {
      if (tool === 'origin' || tool === 'npm' || fs.existsSync(path.join(dir, tool))) continue;
      fs.symlinkSync(path.join(from, tool), path.join(dir, tool));
    }
  }
  fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho "$HOME"\n', { mode: 0o755 });
  return dir;
}

function runScript(repo: string, event: string, env: Record<string, string>) {
  return spawnSync('sh', [path.join(repo, mod.CLOUD_HOOK_SCRIPT), event], {
    cwd: repo, encoding: 'utf-8', input: '{}',
    env: { PATH: process.env.PATH!, HOME: home, CLAUDE_PROJECT_DIR: repo, ...env },
  });
}

describe('cloud hook script', () => {
  it('does nothing outside a cloud session', () => {
    const repo = tempRepo();
    mod.installCloudHooks(repo);
    const bin = fakeOriginBin();
    const r = runScript(repo, 'stop', { PATH: `${bin.dir}:${process.env.PATH}` });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(bin.log)).toBe(false);
  });

  it('in a cloud session, bootstraps on session-start and hands each event to origin hooks', () => {
    const repo = tempRepo();
    mod.installCloudHooks(repo, 'https://origin.example');
    const bin = fakeOriginBin();
    const env = { CLAUDE_CODE_REMOTE: 'true', PATH: `${bin.dir}:${process.env.PATH}` };
    const start = runScript(repo, 'session-start', env);
    expect(start.status).toBe(0);
    // bootstrap's own output goes to stderr, not into Claude's context
    expect(start.stdout).not.toContain('bootstrap-says-hi');
    expect(start.stderr).toContain('bootstrap-says-hi');
    runScript(repo, 'stop', env);
    expect(fs.readFileSync(bin.log, 'utf-8').trim().split('\n')).toEqual([
      'cloud bootstrap --api-url https://origin.example',
      'hooks claude-code session-start',
      'hooks claude-code stop',
    ]);
  });

  it('skips, not fails, an event after session-start when the CLI is missing', () => {
    const repo = tempRepo();
    mod.installCloudHooks(repo);
    // Not /usr/bin itself: a machine with Origin installed has the CLI there.
    const r = runScript(repo, 'user-prompt-submit', { CLAUDE_CODE_REMOTE: 'true', PATH: systemPathWithoutOrigin() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('installCloudHooks', () => {
  it('registers every machine-wide Claude event, through the script', () => {
    const events = mod.cloudClaudeHookEvents();
    expect(Object.keys(events).sort()).toEqual(Object.keys(enable.claudeHookEvents()).sort());
    expect(events.Stop[0].hooks[0].command).toBe('sh "$CLAUDE_PROJECT_DIR/.claude/hooks/origin-cloud.sh" stop');
    expect(events.SessionEnd[0].hooks[0].timeout).toBe(enable.CLAUDE_SESSION_END_HOOK_TIMEOUT_SEC);
    expect(events.SessionStart[0].hooks[0].timeout).toBeGreaterThan(60);
  });

  it('is idempotent and keeps the repo’s own hooks and settings', () => {
    const repo = tempRepo();
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const mine = { hooks: [{ type: 'command', command: 'npm run lint' }] };
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { Stop: [mine] } }));
    mod.installCloudHooks(repo);
    const once = fs.readFileSync(settingsPath, 'utf-8');
    mod.installCloudHooks(repo);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(once);
    const parsed = JSON.parse(once);
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0]).toEqual(mine);
    // nothing beside the committed file that could get committed by accident
    expect(fs.readdirSync(path.dirname(settingsPath)).sort()).toEqual(['hooks', 'settings.json']);
  });

  it('origin enable --cloud in a linked worktree writes there, not into the main checkout', () => {
    const repo = tempRepo();
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const wt = path.join(repo, '.claude', 'worktrees', 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: repo });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mod.enableCloudCommand({ apiUrl: 'https://origin.example', cwd: wt });
    } finally {
      log.mockRestore();
    }
    expect(fs.existsSync(path.join(wt, mod.CLOUD_HOOK_SCRIPT))).toBe(true);
    expect(fs.existsSync(path.join(wt, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, mod.CLOUD_HOOK_SCRIPT))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.json'))).toBe(false);
  });

  it('is invisible to the sweepers that strip Origin claude-code hooks from project settings', () => {
    for (const entries of Object.values(mod.cloudClaudeHookEvents())) {
      const cmd = entries[0].hooks[0].command;
      expect(enable.isOriginHookCommand(cmd)).toBe(false);
      expect(enable.isOriginHookCommand(cmd, 'claude-code')).toBe(false);
      // dedupeOriginHookLayers in hooks.ts matches this literal
      expect(cmd).not.toContain('origin hooks claude-code');
    }
  });
});

describe('cloud bootstrap', () => {
  const okFetch = (seen: any[]) => (async (url: any, init: any) => {
    seen.push({ url, key: init?.headers?.['X-API-Key'] });
    return new Response(JSON.stringify({ orgId: 'org_1', orgName: 'Acme', keyType: 'solo' }), { status: 200 });
  }) as typeof fetch;

  it('does nothing outside a cloud session', async () => {
    const logs: string[] = [];
    const seen: any[] = [];
    await mod.cloudBootstrapCommand({}, { env: {}, fetch: okFetch(seen), log: (m) => logs.push(m), cwd: home });
    expect(seen).toEqual([]);
    expect(fs.existsSync(path.join(home, '.origin', 'config.json'))).toBe(false);
  });

  it('a rejected key writes no config and says what to set up', async () => {
    const logs: string[] = [];
    const ok = await mod.writeCloudConfig('https://origin.example', {
      env: {}, log: (m) => logs.push(m),
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(logs.join('\n')).toContain('X-Origin-Proxy-Key');
    expect(fs.existsSync(path.join(home, '.origin', 'config.json'))).toBe(false);
  });

  it('with no key in the VM, keeps the proxy placeholder once the server accepts it', async () => {
    const seen: any[] = [];
    expect(mod.CLOUD_PROXY_KEY_PLACEHOLDER).toBe('origin-cloud-proxy');
    const ok = await mod.writeCloudConfig('https://origin.example', { env: {}, fetch: okFetch(seen), log: () => {} });
    expect(ok).toBe(true);
    expect(seen).toEqual([{ url: 'https://origin.example/api/mcp/whoami', key: 'origin-cloud-proxy' }]);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.origin', 'config.json'), 'utf-8'));
    expect(cfg).toMatchObject({ apiUrl: 'https://origin.example', apiKey: 'origin-cloud-proxy', orgId: 'org_1' });
    fs.rmSync(path.join(home, '.origin'), { recursive: true, force: true });
  });
});
