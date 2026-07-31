import fs from 'fs';
import os from 'os';
import path from 'path';
import { querySqlite } from './utils/sqlite.js';

// ── Devin Desktop capture ────────────────────────────────────────────────
// Devin Desktop (Cognition; formerly Windsurf) is a VS Code fork with NO
// third-party hooks, and its Cascade transcripts (~/.codeium/windsurf/cascade/
// *.pb) are encrypted. But — like Cursor — it stores a plaintext session list
// in the VS Code global state DB. `windsurf.acp.metadataCache` gives us every
// session's id, provider, title (Devin's own summary of the work), repo, and
// timestamps. That's the only capturable surface for the desktop GUI; we read
// it here and materialize Origin sessions from it.

export interface DevinDesktopSession {
  sessionId: string;
  provider: string;   // cascade | devin-local | devin-cloud
  title: string;
  repoPath: string;   // absolute path of the session's workspace
  createdAt: string;  // ISO
  updatedAt: string;
  archived: boolean;
}

// The VS Code global-state DB, per platform. Devin Desktop uses the app name
// "Devin" (older Windsurf builds used "Windsurf" — checked as a fallback).
export function findDevinStateDb(): string | null {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const bases: string[] = [
    path.join(home, 'Library', 'Application Support'),  // macOS
    path.join(home, '.config'),                          // Linux
    appData,                                             // Windows
  ];
  for (const appName of ['Devin', 'Windsurf']) {
    for (const base of bases) {
      const p = path.join(base, appName, 'User', 'globalStorage', 'state.vscdb');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function readDevinDesktopSessions(dbPath?: string | null): DevinDesktopSession[] {
  const db = dbPath || findDevinStateDb();
  if (!db || !fs.existsSync(db)) return [];

  let raw = '';
  try {
    raw = querySqlite(
      db,
      "SELECT value FROM ItemTable WHERE key='windsurf.acp.metadataCache'",
      { timeoutMs: 4000 },
    ).trim();
  } catch {
    return []; // sqlite3 unavailable / DB locked — non-fatal
  }
  if (!raw) return [];

  return parseDevinMetadataCache(raw);
}

// Pick the Devin session that most recently touched `repoPath`, within
// `windowMs` of `nowMs`. Pure (takes the already-read session list) so the
// commit-time attribution logic is unit-testable without a DB. Repo match is
// path-equality OR same folder name, so a commit made in a git worktree still
// links to the Devin workspace dir. Returns null on any miss.
export function selectDevinSessionForRepo(
  sessions: DevinDesktopSession[],
  repoPath: string,
  nowMs: number,
  windowMs = 30 * 60 * 1000,
): DevinDesktopSession | null {
  const norm = (p: string) => (p || '').replace(/\/+$/, '');
  const target = norm(repoPath);
  if (!target) return null;
  const targetBase = target.split('/').pop() || '';
  const matches = sessions.filter((s) => {
    const sp = norm(s.repoPath);
    const spBase = sp.split('/').pop() || '';
    const repoMatch = !!sp && (
      sp === target ||
      target.startsWith(sp + '/') ||  // commit in a subdir of the Devin workspace
      sp.startsWith(target + '/') ||  // Devin workspace under the commit root
      spBase === targetBase           // same repo folder name (moved/worktree)
    );
    const t = Date.parse(s.updatedAt || s.createdAt || '');
    return repoMatch && Number.isFinite(t) && (nowMs - t) < windowMs && (nowMs - t) > -60_000;
  });
  matches.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''));
  return matches[0] || null;
}

// Pure parse of the `windsurf.acp.metadataCache` JSON value → session records.
// Split out from the DB read so it can be unit-tested without sqlite.
export function parseDevinMetadataCache(raw: string): DevinDesktopSession[] {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const sessions: any[] = Array.isArray(parsed?.sessions) ? parsed.sessions : [];

  return sessions
    .map((s): DevinDesktopSession => {
      const wd = Array.isArray(s.workspaceDirs) && s.workspaceDirs.length
        ? String(s.workspaceDirs[0])
        : String(s.cwd || '').replace(/^file:\/\//, '');
      const meta = s._meta || {};
      return {
        sessionId: String(s.sessionId || ''),
        provider: String(s.providerId || 'cascade'),
        title: String(s.title || ''),
        repoPath: decodeURIComponent(wd).replace(/\/+$/, ''),
        createdAt: String(meta['cognition.ai/createdAt'] || s.updatedAt || ''),
        updatedAt: String(s.updatedAt || ''),
        archived: !!meta['cognition.ai/isArchived'],
      };
    })
    .filter((s) => s.sessionId && s.repoPath);
}
