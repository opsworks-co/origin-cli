import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { readDevinDesktopSessions, findDevinStateDb } from '../devin-desktop.js';
import { api } from '../api.js';
import { loadAgentConfig, isConnectedMode } from '../config.js';

// Resolve a repo path's git remote once, cached, so the server can match the
// Desktop session to a registered repo by URL — exactly like session/start.
// Desktop paths are absolute local paths that rarely equal the registered
// repo's stored `path` (team repos are registered from other machines), so
// without the remote the import can't find the repo and silently drops it.
const _remoteCache = new Map<string, string>();
function gitRemoteFor(repoPath: string): string {
  if (_remoteCache.has(repoPath)) return _remoteCache.get(repoPath)!;
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* no remote / not a git dir — server falls back to path match */ }
  _remoteCache.set(repoPath, url);
  return url;
}

// Push Devin Desktop (GUI) session metadata to Origin so it appears in the
// dashboard. Desktop fires no hooks and encrypts its transcripts, so this is
// the ONLY way its sessions surface. devin-cli sessions are excluded — those
// are captured live by hooks (importing them would just be a no-op dedupe).
// The server upsert is idempotent on the Desktop sessionId, so re-running is
// always safe. Returns null when not connected / nothing to do.
export async function syncDevinDesktopSessions(
  opts: { quiet?: boolean } = {},
): Promise<{ imported: number; skipped: number } | null> {
  const log = (msg: string) => { if (!opts.quiet) console.log(msg); };
  if (!isConnectedMode()) {
    log(chalk.yellow('  Not connected to Origin — run `origin login` first.'));
    return null;
  }
  const machineId = loadAgentConfig()?.machineId;
  const all = readDevinDesktopSessions();
  // Desktop GUI sessions only. cascade / devin-local / devin-cloud are the GUI;
  // devin-cli is the terminal product, already captured by hooks.
  const desktop = all.filter((s) => s.provider !== 'devin-cli' && s.repoPath);
  if (desktop.length === 0) {
    log(chalk.gray('  No Devin Desktop sessions to sync.'));
    return { imported: 0, skipped: 0 };
  }
  const payload = desktop.slice(0, 500).map((s) => ({
    agentSessionId: s.sessionId,
    title: s.title,
    repoPath: s.repoPath,
    repoUrl: gitRemoteFor(s.repoPath) || undefined,
    provider: s.provider,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archived: s.archived,
  }));
  try {
    const res = await api.importDevinDesktopSessions(payload, machineId);
    if (res.disabled) {
      log(chalk.yellow('  Devin capture is disabled for this org (Agents tab) — nothing synced.'));
      return { imported: 0, skipped: payload.length };
    }
    const healed = res.healed || 0;
    const noRepo = res.noRepo || 0;
    log(chalk.green(
      `  Devin Desktop sync: ${res.imported || 0} new, ${res.skipped || 0} already present` +
      (healed ? `, ${healed} restored` : '') + '.',
    ));
    if (noRepo) {
      log(chalk.gray(`  (${noRepo} skipped — their repo isn't registered in Origin for this account)`));
    }
    return { imported: res.imported || 0, skipped: res.skipped || 0 };
  } catch (err: any) {
    log(chalk.yellow(`  Devin Desktop sync failed: ${err?.message || err}`));
    return null;
  }
}

// Throttled fire-and-forget sync, called opportunistically from the hook
// dispatcher so Desktop sessions appear shortly after any Origin activity
// (pure-Desktop users with no other agent still have `origin devin sync`).
export async function maybeSyncDevinDesktop(): Promise<void> {
  try {
    if (!isConnectedMode()) return;
    if (!findDevinStateDb()) return; // no Devin Desktop installed — skip entirely
    const stampFile = path.join(os.homedir(), '.origin', 'devin-desktop-sync.json');
    const THROTTLE_MS = 5 * 60 * 1000;
    try {
      const raw = JSON.parse(fs.readFileSync(stampFile, 'utf-8'));
      if (raw?.lastRunMs && Date.now() - raw.lastRunMs < THROTTLE_MS) return;
    } catch { /* no stamp yet — run */ }
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, JSON.stringify({ lastRunMs: Date.now() }));
    await syncDevinDesktopSessions({ quiet: true });
  } catch { /* best-effort background sync — never disrupt the hook */ }
}

// `origin devin sync` — manually push Devin Desktop sessions to the dashboard.
export async function devinSyncCommand(): Promise<void> {
  console.log(chalk.bold('\n  Syncing Devin Desktop sessions to Origin…\n'));
  await syncDevinDesktopSessions({ quiet: false });
  console.log('');
}

// `origin devin sessions` — surface what Origin can read from Devin Desktop.
// Devin Desktop (ex-Windsurf) exposes no hooks and encrypts its transcripts,
// but its VS Code state DB holds a plaintext session list. This proves the
// capture source and shows which Devin sessions are visible to Origin; the
// commit-time capture path enriches committed Devin work from the same source.
export async function devinSessionsCommand(): Promise<void> {
  const db = findDevinStateDb();
  if (!db) {
    console.log(chalk.yellow('No Devin Desktop state found.'));
    console.log(chalk.gray('  Looked for the VS Code state DB under ~/Library/Application Support/Devin (macOS),'));
    console.log(chalk.gray('  ~/.config/Devin (Linux), or %APPDATA%/Devin (Windows).'));
    return;
  }
  const sessions = readDevinDesktopSessions(db);
  console.log(chalk.bold(`\n  Devin Desktop sessions`) + chalk.gray(`  (${sessions.length} found)`));
  console.log(chalk.gray(`  source: ${db}\n`));
  if (sessions.length === 0) {
    console.log(chalk.gray('  No sessions in the local cache yet.\n'));
    return;
  }
  for (const s of sessions.slice(0, 40)) {
    const repo = s.repoPath.split('/').filter(Boolean).pop() || s.repoPath;
    const when = s.createdAt ? s.createdAt.slice(0, 16).replace('T', ' ') : '';
    console.log(
      '  ' + chalk.cyan((s.title || '(untitled)').slice(0, 40).padEnd(40)) +
      chalk.gray(`  ${s.provider.padEnd(8)}  ${repo.padEnd(16)}  ${when}`) +
      (s.archived ? chalk.gray('  archived') : ''),
    );
  }
  console.log(
    chalk.gray('\n  Note: titles/ids/repos/timestamps are readable; verbatim prompts are encrypted by Devin.') +
    chalk.gray('\n  Devin sessions that edit + commit code are captured at commit time, enriched from this list.\n'),
  );
}
