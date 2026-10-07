import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import type { SessionState } from './session-state.js';

interface ManualEnd {
  sessionId: string;
  agentSlug?: string;
  conversationIds: string[];
  /** The working tree the session was in, so a commit made there after the end can still be stamped. */
  repoPath?: string;
  lastCwd?: string;
  endedAt?: string;
  model?: string;
  promptCount?: number;
  startedAt?: string;
}

/**
 * How long after a manual end a commit in the same tree still belongs to the
 * ended session. The marker is removed by the conversation's NEXT prompt, so
 * while it stands the turn that ran `sessions end` is still the running one;
 * the age cap only guards a conversation that never came back.
 */
export const MANUAL_END_STAMP_WINDOW_MS = 3 * 60 * 60 * 1000;

// Separate from capture state: a hook that loaded RUNNING before `sessions end`
// must not erase the end by saving its stale copy afterwards.
function markerPath(kind: 'session' | 'conversation', id: string): string {
  const key = createHash('sha256').update(id).digest('hex');
  return path.join(os.homedir(), '.origin', 'manual-session-ends', `${kind}-${key}.json`);
}

function readMarker(file: string): ManualEnd | null {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof marker?.sessionId === 'string' && Array.isArray(marker.conversationIds)
      && marker.conversationIds.every((id: unknown) => typeof id === 'string') ? marker : null;
  }
  catch { return null; }
}

export function recordManualSessionEnd(
  state: Pick<SessionState, 'sessionId' | 'agentSlug' | 'claudeSessionId' | 'agentSessionId'>
    & Partial<Pick<SessionState, 'repoPath' | 'lastCwd' | 'model' | 'prompts' | 'startedAt'>>,
): void {
  const previous = readMarker(markerPath('session', state.sessionId));
  const marker: ManualEnd = {
    sessionId: state.sessionId,
    agentSlug: state.agentSlug || previous?.agentSlug,
    conversationIds: [...new Set([...(previous?.conversationIds || []), state.claudeSessionId, state.agentSessionId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0))],
    ...(typeof state.repoPath === 'string' && state.repoPath ? { repoPath: state.repoPath } : previous?.repoPath ? { repoPath: previous.repoPath } : {}),
    ...(typeof state.lastCwd === 'string' && state.lastCwd ? { lastCwd: state.lastCwd } : previous?.lastCwd ? { lastCwd: previous.lastCwd } : {}),
    ...(typeof state.model === 'string' && state.model ? { model: state.model } : previous?.model ? { model: previous.model } : {}),
    ...(Array.isArray(state.prompts) ? { promptCount: state.prompts.length } : previous?.promptCount != null ? { promptCount: previous.promptCount } : {}),
    ...(typeof state.startedAt === 'string' && state.startedAt ? { startedAt: state.startedAt } : previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    endedAt: new Date().toISOString(),
  };
  const files = [markerPath('session', marker.sessionId),
    ...marker.conversationIds.map(id => markerPath('conversation', id))];
  fs.mkdirSync(path.dirname(files[0]), { recursive: true, mode: 0o700 });
  for (const file of files) {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

export function isManuallyEnded(sessionId: string): boolean {
  return fs.existsSync(markerPath('session', sessionId));
}

/**
 * Every session ended by hand within the window, whatever tree it worked in.
 * This is the population prepare-commit-msg may still name in a trailer
 * (manuallyEndedSessionForTree), so a hook reading that trailer must count
 * these as sessions that exist — `sessions end` deletes the `.git` state file
 * and archives it to ~/.origin/sessions, so the `.git` scan alone no longer
 * finds them. Markers without `endedAt` (older CLI) or outside the window are
 * not listed, on the same terms as manuallyEndedSessionForTree.
 */
export function manuallyEndedSessionIds(opts: { maxAgeMs?: number; now?: number } = {}): string[] {
  const dir = path.join(os.homedir(), '.origin', 'manual-session-ends');
  let entries: string[];
  try { entries = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json')); } catch { return []; }
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MANUAL_END_STAMP_WINDOW_MS;
  const out: string[] = [];
  for (const entry of entries) {
    const marker = readMarker(path.join(dir, entry));
    if (!marker || !marker.endedAt) continue;
    const endedAt = Date.parse(marker.endedAt);
    if (!Number.isFinite(endedAt) || now - endedAt > maxAge || endedAt > now + 60_000) continue;
    out.push(marker.sessionId);
  }
  return out;
}

/** Tool/Stop/compact hooks are continuations, not permission to resume capture. */
export function skipManuallyEndedHook(event: string, input: Record<string, unknown>, agentSlug?: string): boolean {
  const ids = new Set([input.conversation_id, input.session_id, input.sessionId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  for (const id of ids) {
    const marker = readMarker(markerPath('conversation', id));
    if (!marker || (marker.agentSlug && agentSlug && marker.agentSlug !== agentSlug)) continue;
    if (event !== 'user-prompt-submit') return true;
    // Only a new prompt resumes this conversation. Do not remove a pointer
    // that a newer session has since replaced.
    for (const conversationId of marker.conversationIds) {
      const file = markerPath('conversation', conversationId);
      if (readMarker(file)?.sessionId === marker.sessionId) fs.rmSync(file, { force: true });
    }
    fs.rmSync(markerPath('session', marker.sessionId), { force: true });
  }
  return false;
}

/** `git rev-parse --show-toplevel`, normalized; null outside a repository. */
function workingRootOf(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      windowsHide: true, encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!top) return null;
    let real = top;
    try { real = fs.realpathSync.native(top); } catch { /* keep as given */ }
    return process.platform === 'win32' ? path.resolve(real).toLowerCase() : path.resolve(real);
  } catch {
    return null;
  }
}

/**
 * The session ended by hand in this working tree whose conversation has not
 * sent another prompt — so the turn that ran `origin sessions end` is still
 * the one running, and a commit it makes now is that session's work.
 *
 * Prod PR #1911 (2026-09-26 15:18Z): the release recipe ended session
 * c085f0af, the same turn then committed 12b4e4eaa; prepare-commit-msg found
 * no live session in the tree, so the commit carried no `Origin-Session`
 * trailer and the PR board showed 0 sessions for an AI-authored PR (TODO
 * 25b883e8). #1900 closes the OPEN turn at the end; this covers the work the
 * turn does afterwards.
 *
 * The marker is what makes this safe: the conversation's next prompt removes
 * it (skipManuallyEndedHook), so this never outlives the turn — and the age
 * cap guards a conversation that never returns. Returns the ended session's
 * mirrored state when it is still on disk (the trailer's prompt count and
 * model come from it), else the little the marker recorded.
 */
export function manuallyEndedSessionForTree(
  hookCwd: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): SessionState | null {
  const dir = path.join(os.homedir(), '.origin', 'manual-session-ends');
  let entries: string[];
  try { entries = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json')); } catch { return null; }
  if (entries.length === 0) return null;
  const tree = workingRootOf(hookCwd);
  if (!tree) return null;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? MANUAL_END_STAMP_WINDOW_MS;
  let best: { marker: ManualEnd; endedAt: number } | null = null;
  for (const entry of entries) {
    const marker = readMarker(path.join(dir, entry));
    if (!marker || !marker.endedAt) continue;
    const endedAt = Date.parse(marker.endedAt);
    if (!Number.isFinite(endedAt) || now - endedAt > maxAge || endedAt > now + 60_000) continue;
    const inTree = [marker.lastCwd, marker.repoPath].some((p) => workingRootOf(p) === tree);
    if (!inTree) continue;
    if (!best || endedAt > best.endedAt) best = { marker, endedAt };
  }
  if (!best) return null;
  const { marker } = best;
  try {
    const mirror = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.origin', 'sessions', `${marker.sessionId.slice(0, 12)}.json`), 'utf8'));
    if (mirror && typeof mirror === 'object' && mirror.sessionId === marker.sessionId) return mirror as SessionState;
  } catch { /* mirror gone — the marker still knows enough for a trailer */ }
  return {
    sessionId: marker.sessionId,
    agentSlug: marker.agentSlug,
    model: marker.model,
    prompts: Array.from({ length: marker.promptCount || 0 }, () => ''),
    startedAt: marker.startedAt || marker.endedAt,
    repoPath: marker.repoPath || hookCwd,
    lastCwd: marker.lastCwd,
    status: 'ENDED',
  } as unknown as SessionState;
}
