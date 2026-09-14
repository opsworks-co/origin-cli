// Codex kills a hook at its timeout, and Origin gave Codex's Stop 10 seconds.
//
// Stop is the hook that sends the turn, and on a real repo it runs 30-80s.
// Codex session f53bd03d: 17 Stops reached `calling api.updateSession`, none
// logged `update sent` — every turn's capture was lost. The Stop hook now gets
// Codex's own default (600s).
//
// The timeout is also part of the identity Codex hashes to TRUST a hook, so
// changing it has a second half: the drift repair `origin upgrade` runs rewrites
// hooks.json, and must rewrite the trusted hash with it, or the repaired Stop
// hook shows as "Modified" and Codex does not run it at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installCodexHooks } from '../commands/enable.js';
import { checkHookConfigs, repairHookConfig } from '../hook-config-health.js';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevCwd: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-codex-stop-')));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try { process.chdir(prevCwd); } catch { /* ignore */ }
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const hooksPath = () => path.join(home, '.codex', 'hooks.json');
const tomlPath = () => path.join(home, '.codex', 'config.toml');

/** Codex's trusted_hash for a single-handler group, computed independently. */
function trustedHash(eventLabel: string, command: string, timeout: number): string {
  const identity = { event_name: eventLabel, hooks: [{ async: false, command, timeout, type: 'command' }] };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function originStop(doc: any): { command: string; timeout: number } {
  const handler = (doc.hooks.Stop as any[]).flatMap((g) => g.hooks).find((h: any) => String(h.command).includes('hooks codex stop'));
  expect(handler, 'no Origin Stop hook in hooks.json').toBeTruthy();
  return handler;
}

const trustLine = (event: string, hash: string) =>
  `[hooks.state."${hooksPath()}:${event}:0:0"]\ntrusted_hash = "sha256:${hash}"`;

// Codex hooks are never installed on Windows (the rollout watcher captures it).
describe.skipIf(process.platform === 'win32')('Codex Stop hook timeout', () => {
  it('installs Stop with a timeout long enough to send the turn, and trusts exactly that', () => {
    installCodexHooks(home);
    const stop = originStop(JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')));
    expect(stop.timeout).toBe(600);
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toContain(trustLine('stop', trustedHash('stop', stop.command, 600)));
  });

  it("a drift repair of a 10s install rewrites the trusted hash with the timeout, and leaves the user's feature flag alone", () => {
    installCodexHooks(home);
    // Recreate what an install from before this change left on disk: Stop at
    // 10s, trusted at 10s — and a user who has since turned hooks off.
    const doc = JSON.parse(fs.readFileSync(hooksPath(), 'utf-8'));
    const stop = originStop(doc);
    stop.timeout = 10;
    fs.writeFileSync(hooksPath(), JSON.stringify(doc, null, 2) + '\n');
    const oldHash = trustedHash('stop', stop.command, 10);
    const newHash = trustedHash('stop', stop.command, 600);
    let toml = fs.readFileSync(tomlPath(), 'utf-8');
    expect(toml).toContain(newHash);
    toml = toml.replace(newHash, oldHash).replace(/^hooks = true$/m, 'hooks = false');
    fs.writeFileSync(tomlPath(), toml);

    const report = checkHookConfigs(home).find((r) => r.agent === 'codex');
    expect(report?.state).toBe('stale');
    repairHookConfig(report!);

    expect(originStop(JSON.parse(fs.readFileSync(hooksPath(), 'utf-8'))).timeout).toBe(600);
    const repaired = fs.readFileSync(tomlPath(), 'utf-8');
    expect(repaired, 'hooks.json was repaired but its trusted hash was not: Codex would not run the Stop hook').toContain(trustLine('stop', newHash));
    expect(repaired).not.toContain(oldHash);
    expect(repaired).toMatch(/^hooks = false$/m);
    // The hooks that did not change keep the trust they had.
    const start = originStart(JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')));
    expect(repaired).toContain(trustLine('session_start', trustedHash('session_start', start.command, 10)));
  });
});

function originStart(doc: any): { command: string; timeout: number } {
  return (doc.hooks.SessionStart as any[]).flatMap((g) => g.hooks).find((h: any) => String(h.command).includes('hooks codex session-start'));
}
