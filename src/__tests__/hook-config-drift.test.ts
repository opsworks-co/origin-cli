/**
 * A hook config Origin wrote once and never revisited is the whole bug class
 * here. #1143 fixed the Antigravity schema in the installer, but `installHooks`
 * only ever runs from `origin enable` — so every machine that had already run
 * it kept the file agy silently discards, capturing nothing, with no error on
 * either side and no way to self-heal (the hook that could rewrite the file is
 * the hook the broken file stops from running).
 *
 * These tests cover the generic machinery that closes that: detect an on-disk
 * config that is no longer what the current code writes, and rewrite it —
 * without touching agents the user never enabled, and without eating the hooks
 * they wrote themselves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HOOK_CONFIG_SPECS,
  installAntigravityHooks,
  installClaudeHooks,
  installCursorHooks,
  installGeminiHooks,
  installDevinHooks,
  installCopilotHooks,
  installCodexHooks,
  type HookConfigSpec,
} from '../commands/enable.js';
import {
  checkHookConfig,
  checkHookConfigs,
  repairHookConfig,
  repairHookConfigs,
  isRepairable,
} from '../hook-config-health.js';
import { recordEnabledRepo, listEnabledRepos, forgetEnabledRepo } from '../enabled-repos.js';

// ─── Isolation ────────────────────────────────────────────────────────────
// The installers resolve their global paths through os.homedir() at call time
// and (for Claude) sweep sibling settings layers relative to cwd. Point both at
// throwaway dirs so a test run can never touch the developer's real
// ~/.claude, ~/.codex or ~/.gemini config.

let home: string;
let base: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevCwd: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hookcfg-home-')));
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hookcfg-base-')));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(base);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try { process.chdir(prevCwd); } catch { /* ignore */ }
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  for (const dir of [home, base]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function specFor(agent: string, match?: (s: HookConfigSpec) => boolean): HookConfigSpec {
  const spec = HOOK_CONFIG_SPECS.find((s) => s.agent === agent && (!match || match(s)));
  if (!spec) throw new Error(`no spec for ${agent}`);
  return spec;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// ─── The regression that started this ─────────────────────────────────────

describe('a config left behind by an older CLI', () => {
  const agySpec = () => specFor('antigravity');

  // Exactly what Origin wrote before #1143: no `matcher` on the tool-scoped
  // events, and `Stop` wrapped in a { hooks: [...] } group — which leaves a
  // handler with no `command`. agy rejects the WHOLE file over either one.
  function writePre1143Config(): string {
    const file = agySpec().filePath(base);
    writeJson(file, {
      origin: {
        enabled: true,
        PostToolUse: [{ hooks: [{ type: 'command', command: 'origin hooks antigravity post-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'origin hooks antigravity stop' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'origin hooks antigravity pre-tool-use' }] }],
      },
    });
    return file;
  }

  it('is detected as stale rather than passing as installed', () => {
    writePre1143Config();
    expect(checkHookConfig(agySpec(), base).state).toBe('stale');
  });

  it('is rewritten into the shape agy accepts', () => {
    const file = writePre1143Config();
    repairHookConfig(checkHookConfig(agySpec(), base));

    const cfg = readJson(file);
    // Tool-scoped events are grouped and REQUIRE a matcher.
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      expect(cfg.origin[ev][0].matcher).toBe('*');
      expect(typeof cfg.origin[ev][0].hooks[0].command).toBe('string');
    }
    // Stop is flat — a wrapper here is the bug.
    expect(typeof cfg.origin.Stop[0].command).toBe('string');
    expect(cfg.origin.Stop[0].hooks).toBeUndefined();
  });

  it('reads as ok once repaired, and repairing again is a no-op', () => {
    const file = writePre1143Config();
    repairHookConfig(checkHookConfig(agySpec(), base));
    expect(checkHookConfig(agySpec(), base).state).toBe('ok');

    const after = fs.readFileSync(file, 'utf-8');
    expect(repairHookConfigs(base)).toEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(after);
  });
});

// ─── The link that keeps checker and installer from drifting apart ────────

describe('what the installers write reads back as current', () => {
  // Both sides come from HOOK_CONFIG_SPECS[].expected(), so this fails the
  // moment someone changes a hook payload in only one of the two places.
  // Claude Code is exercised via its own installer too — it sweeps sibling
  // settings layers, which the cwd/HOME isolation above contains.
  function assertAllOk(installBase: string, agents: string[]) {
    for (const spec of HOOK_CONFIG_SPECS) {
      if (spec.skip?.()) continue;
      if (!agents.includes(spec.agent)) continue;
      const report = checkHookConfig(spec, installBase);
      expect(`${spec.agent} ${spec.label(installBase)}: ${report.state}`)
        .toBe(`${spec.agent} ${spec.label(installBase)}: ok`);
    }
  }

  it('for a repo-local install', () => {
    installClaudeHooks(base);
    installCursorHooks(base);
    installGeminiHooks(base);
    installDevinHooks(base);
    installAntigravityHooks(base);
    installCopilotHooks(base);
    if (!HOOK_CONFIG_SPECS.find((s) => s.agent === 'codex')!.skip?.()) installCodexHooks(base);
    assertAllOk(base, ['claude-code', 'cursor', 'gemini', 'devin', 'antigravity', 'copilot', 'codex']);
  });

  it('for a global install', () => {
    // base === homedir flips several specs onto their global paths
    // (~/.gemini/config/hooks.json, ~/.copilot/hooks/origin.json).
    installClaudeHooks(home);
    installCursorHooks(home);
    installGeminiHooks(home);
    installDevinHooks(home);
    installAntigravityHooks(home);
    installCopilotHooks(home);
    assertAllOk(home, ['claude-code', 'cursor', 'gemini', 'devin', 'antigravity', 'copilot']);
  });
});

// ─── Not ours to touch ────────────────────────────────────────────────────

describe('agents the user never enabled', () => {
  it('are absent, not stale', () => {
    for (const report of checkHookConfigs(base)) {
      expect(report.state).toBe('absent');
    }
  });

  it('are not installed as a side effect of a repair', () => {
    expect(repairHookConfigs(base)).toEqual([]);
    // Nothing may be conjured into existence — a repair that enabled capture
    // the user never asked for would be worse than the drift it fixes.
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('leaves a malformed config alone when it carries no Origin hooks', () => {
    const file = specFor('cursor').filePath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    expect(checkHookConfig(specFor('cursor'), base).state).toBe('absent');
    repairHookConfigs(base);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ this is not json');
  });

  it('does repair a malformed config that does carry Origin hooks', () => {
    const file = specFor('cursor').filePath(base);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"hooks": {"stop": [{"command": "origin hooks cursor stop"}]');

    expect(checkHookConfig(specFor('cursor'), base).state).toBe('unreadable');
    expect(repairHookConfigs(base)).toHaveLength(1);
    expect(checkHookConfig(specFor('cursor'), base).state).toBe('ok');
  });
});

// ─── The user's own config survives ───────────────────────────────────────

describe('a repair rewrites only Origin s region', () => {
  it('keeps the user hooks and unrelated keys', () => {
    const spec = specFor('cursor');
    const file = spec.filePath(base);
    writeJson(file, {
      version: 1,
      somethingElse: { keepMe: true },
      hooks: {
        stop: [
          { command: './my-own-hook.sh' },
          { command: 'origin hooks cursor stop' },
        ],
        beforeShellExecution: [{ command: './audit.sh' }],
      },
    });

    expect(checkHookConfig(spec, base).state).toBe('stale');
    repairHookConfig(checkHookConfig(spec, base));

    const cfg = readJson(file);
    expect(cfg.somethingElse).toEqual({ keepMe: true });
    expect(cfg.hooks.beforeShellExecution).toEqual([{ command: './audit.sh' }]);
    expect(cfg.hooks.stop.map((h: any) => h.command)).toContain('./my-own-hook.sh');
    expect(checkHookConfig(spec, base).state).toBe('ok');
  });
});

// ─── Drift classes beyond a changed schema ────────────────────────────────

describe('other ways a config goes out of date', () => {
  it('sweeps Origin entries out of event names this CLI no longer writes', () => {
    // Cursor 1.7's `agentSessionStart` is the real case: Cursor 2.6 rejects the
    // whole hooks.json over an unknown event name, so a leftover registration
    // is not merely dead weight.
    const spec = specFor('cursor');
    const file = spec.filePath(base);
    installCursorHooks(base);
    const cfg = readJson(file);
    cfg.hooks.agentSessionStart = [{ command: 'origin hooks cursor session-start' }];
    writeJson(file, cfg);

    expect(checkHookConfig(spec, base).state).toBe('stale');
    repairHookConfig(checkHookConfig(spec, base));
    expect(readJson(file).hooks.agentSessionStart).toBeUndefined();
  });

  it('does not delete an empty array the user left in the file', () => {
    // The sweep above removes an event key it empties. At the document root
    // (Devin's hooks.v1.json has no container key) that would otherwise reach
    // any top-level list the user happens to keep there.
    const spec = specFor('devin', (s) => s.filePath('/x').includes('.devin'));
    const file = spec.filePath(base);
    installDevinHooks(base);
    const cfg = readJson(file);
    cfg.MyOwnEmptyList = [];
    delete cfg.SessionEnd;
    writeJson(file, cfg);

    expect(checkHookConfig(spec, base).state).toBe('stale');
    repairHookConfig(checkHookConfig(spec, base));
    const after = readJson(file);
    expect(after.MyOwnEmptyList).toEqual([]);
    expect(after.SessionEnd).toHaveLength(1);
  });

  it('collapses a doubled Origin registration', () => {
    const spec = specFor('cursor');
    const file = spec.filePath(base);
    installCursorHooks(base);
    const cfg = readJson(file);
    cfg.hooks.stop = [...cfg.hooks.stop, ...cfg.hooks.stop];
    writeJson(file, cfg);

    expect(checkHookConfig(spec, base).state).toBe('stale');
    repairHookConfig(checkHookConfig(spec, base));
    expect(readJson(file).hooks.stop).toHaveLength(1);
  });

  it('calls a moved launcher path relocated, not stale', () => {
    // A Node/nvm move or a reinstall to a different prefix leaves the SHAPE
    // right and only the embedded path wrong. Still repaired, but it does not
    // mean the agent is rejecting the file, so it must not be reported as if
    // capture were down.
    const spec = specFor('antigravity');
    const file = spec.filePath(base);
    installAntigravityHooks(base);
    const cfg = readJson(file);
    const relocate = (cmd: string) => `PATH=/nonexistent/bin:$PATH origin ${cmd.slice(cmd.indexOf('hooks antigravity'))}`;
    cfg.origin.Stop[0].command = relocate(cfg.origin.Stop[0].command);
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      cfg.origin[ev][0].hooks[0].command = relocate(cfg.origin[ev][0].hooks[0].command);
    }
    writeJson(file, cfg);

    const report = checkHookConfig(spec, base);
    expect(report.state).toBe('relocated');
    expect(isRepairable(report.state)).toBe(true);
    repairHookConfig(report);
    expect(checkHookConfig(spec, base).state).toBe('ok');
  });

  it('checks the legacy Cascade file as its own config, not just .devin', () => {
    const cascade = specFor('devin', (s) => s.filePath('/x').includes('.windsurf'));
    installDevinHooks(base);
    expect(checkHookConfig(cascade, base).state).toBe('ok');

    const file = cascade.filePath(base);
    const cfg = readJson(file);
    delete cfg.hooks.sessionEnd;
    writeJson(file, cfg);
    expect(checkHookConfig(cascade, base).state).toBe('stale');
  });
});

// ─── The registry that lets `origin upgrade` find repo-local installs ─────

describe('enabled-repo registry', () => {
  it('records, lists and forgets a repo', () => {
    expect(listEnabledRepos()).toEqual([]);
    recordEnabledRepo(base);
    expect(listEnabledRepos()).toEqual([base]);
    recordEnabledRepo(base);
    expect(listEnabledRepos()).toEqual([base]); // idempotent
    forgetEnabledRepo(base);
    expect(listEnabledRepos()).toEqual([]);
  });

  it('prunes repos that no longer exist on disk', () => {
    const gone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-hookcfg-gone-')));
    recordEnabledRepo(base);
    recordEnabledRepo(gone);
    fs.rmSync(gone, { recursive: true, force: true });
    expect(listEnabledRepos()).toEqual([base]);
  });

  it('never records the home directory as a repo-local install', () => {
    recordEnabledRepo(os.homedir());
    expect(listEnabledRepos()).toEqual([]);
  });
});
