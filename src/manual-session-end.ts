import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { SessionState } from './session-state.js';

interface ManualEnd {
  sessionId: string;
  agentSlug?: string;
  conversationIds: string[];
}

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

export function recordManualSessionEnd(state: Pick<SessionState, 'sessionId' | 'agentSlug' | 'claudeSessionId' | 'agentSessionId'>): void {
  const previous = readMarker(markerPath('session', state.sessionId));
  const marker: ManualEnd = {
    sessionId: state.sessionId,
    agentSlug: state.agentSlug || previous?.agentSlug,
    conversationIds: [...new Set([...(previous?.conversationIds || []), state.claudeSessionId, state.agentSessionId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0))],
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
