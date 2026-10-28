// Which Claude Code session started this one?
//
// The Claude desktop app lets a session start other sessions (start_session:
// "side sessions", shown nested under their parent in the app's sidebar). The
// CLI transcript carries no trace of it. The app keeps one metadata file per
// session:
//
//   <app data>/Claude/claude-code-sessions/<account>/<org>/local_<id>.json
//     { "cliSessionId": "<transcript uuid>",
//       "spawnedFrom": { "sessionId": "local_<parent id>", "taskId": … } }
//
// and gives every CLI it launches (and so every hook) its own app id in
// CLAUDE_CODE_HOST_SESSION_ID. Child file → spawnedFrom.sessionId → parent
// file → parent's cliSessionId, which is the parent's agentSessionId in Origin.
//
// Best-effort and silent: any missing piece is "no parent".
import fs from 'fs';
import os from 'os';
import path from 'path';

const LOCAL_ID = /^local_[0-9a-f-]{8,64}$/i;

function desktopDataDirs(): string[] {
  const override = process.env.ORIGIN_CLAUDE_DESKTOP_DIR;
  if (override) return [override];
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude')];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'Claude')];
  }
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')];
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** The metadata file of desktop session `localId`, or null. */
function findSessionFile(localId: string): string | null {
  if (!LOCAL_ID.test(localId)) return null;
  const file = `${localId}.json`;
  const account = process.env.CLAUDE_CODE_ACCOUNT_UUID;
  const org = process.env.CLAUDE_CODE_ORGANIZATION_UUID;
  for (const base of desktopDataDirs()) {
    const root = path.join(base, 'claude-code-sessions');
    // The app's own account/org ids, when it passed them, name the folder.
    if (account && org) {
      const direct = path.join(root, account, org, file);
      if (fs.existsSync(direct)) return direct;
    }
    let accounts: string[];
    try { accounts = fs.readdirSync(root); } catch { continue; }
    for (const a of accounts) {
      let orgs: string[];
      try { orgs = fs.readdirSync(path.join(root, a)); } catch { continue; }
      for (const o of orgs) {
        const p = path.join(root, a, o, file);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * The agentSessionId (Claude transcript uuid) of the session that started
 * this one, or undefined when this is not a desktop subsession.
 */
export function claudeDesktopSpawnedFrom(
  hostSessionId: string | undefined = process.env.CLAUDE_CODE_HOST_SESSION_ID,
): string | undefined {
  if (!hostSessionId) return undefined;
  const own = findSessionFile(hostSessionId);
  if (!own) return undefined;
  const parentLocalId = readJson(own)?.spawnedFrom?.sessionId;
  if (typeof parentLocalId !== 'string' || parentLocalId === hostSessionId) return undefined;
  const parentFile = findSessionFile(parentLocalId);
  if (!parentFile) return undefined;
  const parentCli = readJson(parentFile)?.cliSessionId;
  return typeof parentCli === 'string' && parentCli ? parentCli : undefined;
}
