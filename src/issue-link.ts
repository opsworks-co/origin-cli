// How a session finds the issue it was started for.
//
// `origin issue start` launches the agent, and the agent's own SessionStart
// hook registers the session — two processes, with nothing in between but the
// checkout. So `issue start` leaves a small file in THIS checkout's git dir
// (per worktree: `.git/` or `.git/worktrees/<name>/`), and the next
// session-start in that checkout takes it, links its new session to the issue
// on the API (POST /api/repos/:repoId/issues/:shortId/link), and deletes it.
//
// One-shot: the file is claimed by an atomic rename before it is read, so two
// sessions starting at once cannot both take it. It expires after an hour —
// a launch that never started a session must not pin the issue onto whatever
// session opens in this checkout tomorrow.
//
// Found with fs only (no git subprocess): session-start reads it on every
// start, and in the common case the answer is "no such file".
import fs from 'fs';
import path from 'path';

export const ISSUE_LINK_FILE = 'origin-issue-link.json';
export const ISSUE_LINK_TTL_MS = 60 * 60 * 1000;

export interface PendingIssueLink {
  shortId: string;
  /** The API repo the issue lives in; absent for an issue only in `.origin/issues`. */
  repoId?: string | null;
  title?: string;
  branch?: string | null;
  agent?: string;
  /** The API run (`IssueRun`) this launch reported, so the session lands on that run.
   *  null = it reported none; absent = written by a CLI from before runs were linked. */
  runId?: string | null;
  createdAt: string;
  expiresAt: string;
}

/** The checkout's own git dir: `<root>/.git`, or the worktree's gitdir. */
export function checkoutGitDir(checkoutRoot: string): string | null {
  const dotGit = path.join(checkoutRoot, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
      if (!m) return null;
      return path.resolve(checkoutRoot, m[1].trim());
    }
  } catch { /* not a checkout root */ }
  return null;
}

export function pendingIssueLinkPath(checkoutRoot: string): string | null {
  const dir = checkoutGitDir(checkoutRoot);
  return dir ? path.join(dir, ISSUE_LINK_FILE) : null;
}

export function writePendingIssueLink(
  checkoutRoot: string,
  link: Omit<PendingIssueLink, 'createdAt' | 'expiresAt'>,
  now: number = Date.now(),
): string | null {
  const file = pendingIssueLinkPath(checkoutRoot);
  if (!file) return null;
  const record: PendingIssueLink = {
    ...link,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ISSUE_LINK_TTL_MS).toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Claim the pending link, if any: it is gone from the checkout after this call
 * whether or not it was still fresh. Returns null when there was none, it had
 * expired, or another session claimed it first.
 */
export function takePendingIssueLink(checkoutRoot: string, now: number = Date.now()): PendingIssueLink | null {
  const file = pendingIssueLinkPath(checkoutRoot);
  if (!file || !fs.existsSync(file)) return null;
  const claimed = `${file}.claimed-${process.pid}-${now}`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return null; // someone else took it
  }
  try {
    const rec = JSON.parse(fs.readFileSync(claimed, 'utf-8')) as PendingIssueLink;
    if (!rec || typeof rec.shortId !== 'string' || !rec.shortId) return null;
    const expires = Date.parse(rec.expiresAt);
    if (!Number.isFinite(expires) || expires < now) return null;
    return rec;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(claimed); } catch { /* ignore */ }
  }
}

/** Add a session to an issue that lives only in this checkout's `.origin/issues`. */
export function linkLocalIssue(checkoutRoot: string, shortId: string, sessionId: string): boolean {
  const file = path.join(checkoutRoot, '.origin', 'issues', `${shortId}.json`);
  try {
    const issue = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const sessions: string[] = Array.isArray(issue.sessions) ? issue.sessions : [];
    if (!sessions.includes(sessionId)) sessions.push(sessionId);
    issue.sessions = sessions;
    issue.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(issue, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Session-start's half: take the pending link and attach `sessionId` to its
 * issue — on the API when the issue lives there, else in the local store.
 * Never throws; the session starts either way.
 */
export async function linkPendingIssue(
  checkoutRoot: string,
  sessionId: string,
  linkOnApi: (repoId: string, shortId: string, sessionId: string, runId: string | null | undefined) => Promise<any>,
  log: (msg: string, data?: Record<string, unknown>) => void = () => {},
): Promise<PendingIssueLink | null> {
  let link: PendingIssueLink | null = null;
  try {
    link = takePendingIssueLink(checkoutRoot);
    if (!link) return null;
    if (link.repoId && !sessionId.startsWith('local-')) {
      const r = await linkOnApi(link.repoId, link.shortId, sessionId, link.runId);
      log('linked session to issue', { shortId: link.shortId, sessionId });
      // The server also claimed the task for this session (live task queue):
      // keep the token where the agent's MCP server finds it (finish_task).
      const c = r?.claim;
      if (c?.claimed && typeof c.claimToken === 'string' && typeof c.shortId === 'string') {
        writeSessionClaim(checkoutRoot, sessionId, { repoId: link.repoId, shortId: c.shortId, claimToken: c.claimToken, leaseExpiresAt: String(c.leaseExpiresAt ?? '') });
        log('claimed issue for session', { shortId: c.shortId, sessionId });
      } else if (c && !c.claimed) {
        log('issue not claimed', { shortId: link.shortId, reason: c.reason });
      }
    } else if (linkLocalIssue(checkoutRoot, link.shortId, sessionId)) {
      log('linked session to local issue', { shortId: link.shortId, sessionId });
    }
  } catch (err) {
    log('issue link failed', { shortId: link?.shortId, message: err instanceof Error ? err.message : String(err) });
  }
  return link;
}

// ─── Claims a Start run took (the live task queue, docs/LIVE_TASK_QUEUE.md) ───
//
// Session-start links a Start run's session to its issue and, on the same call,
// claims the task for it. The token comes back to the hook, but the agent's MCP
// server (a different process) is what finishes the task — so the hook leaves
// it here, per session, in the checkout's git dir, and the MCP server adopts
// it. A secret, so 0600; tiny, and dropped once the claim is released or lost.

export const SESSION_CLAIMS_DIR = 'origin-task-claims';

export interface SessionClaim {
  repoId: string;
  shortId: string;
  claimToken: string;
  leaseExpiresAt: string;
}

function sessionClaimsPath(checkoutRoot: string, sessionId: string): string | null {
  const dir = checkoutGitDir(checkoutRoot);
  if (!dir || !/^[A-Za-z0-9_.-]{1,200}$/.test(sessionId)) return null;
  return path.join(dir, SESSION_CLAIMS_DIR, `${sessionId}.json`);
}

export function readSessionClaims(checkoutRoot: string, sessionId: string): SessionClaim[] {
  const p = sessionClaimsPath(checkoutRoot, sessionId);
  if (!p) return [];
  try {
    const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(list)
      ? list.filter((c) => c && typeof c.repoId === 'string' && typeof c.shortId === 'string' && typeof c.claimToken === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeSessionClaims(p: string, list: SessionClaim[]): void {
  if (list.length === 0) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function writeSessionClaim(checkoutRoot: string, sessionId: string, claim: SessionClaim): void {
  const p = sessionClaimsPath(checkoutRoot, sessionId);
  if (!p) return;
  try {
    const rest = readSessionClaims(checkoutRoot, sessionId).filter((c) => !(c.repoId === claim.repoId && c.shortId === claim.shortId));
    writeSessionClaims(p, [...rest, claim]);
  } catch { /* the claim still runs out on its own */ }
}

export function dropSessionClaim(checkoutRoot: string, sessionId: string, repoId: string, shortId: string): void {
  const p = sessionClaimsPath(checkoutRoot, sessionId);
  if (!p) return;
  try {
    writeSessionClaims(p, readSessionClaims(checkoutRoot, sessionId).filter((c) => !(c.repoId === repoId && c.shortId === shortId)));
  } catch { /* harmless: a stale token is answered `lost` */ }
}
