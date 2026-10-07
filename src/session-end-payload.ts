import { newCaptureStamp, stampReplayedMapping } from './capture-stamp.js';
import { serverRowForLocalTurn, turnIdForServerRow, turnStartFields } from './turn-index.js';

/**
 * The per-turn rows the heartbeat daemon sends when it ends a session.
 *
 * The saved mappings (from Stop) are used when there are any; otherwise an
 * empty row per prompt so the prompts at least appear. Either way each row
 * carries its turn id: the saved mappings never round-tripped one, so this
 * payload was the one writer left that addressed rows by POSITION alone —
 * and the server's cross-turn guard keys on the payload's id, so a row sent
 * without one lands on whatever turn holds that index. Prod 8a626742: the
 * resumed launch's mappings sat at local 0..2 (a separate defect) and this
 * payload put its turn 2 — one file, +26, its commit's patch — onto row 2, a
 * chat-only turn from the day before.
 *
 * Mappings are numbered by SERVER row and ids by local turn; the fallback
 * rows are built from the local prompt list and lifted onto their rows.
 * Lives outside heartbeat.ts because that module is the daemon's entrypoint
 * and runs on import.
 */
export function promptChangesForSessionEnd(stateData: {
  prompts?: string[];
  completedPromptMappings?: Array<Record<string, unknown> & { promptIndex: number; turnId?: string }>;
  promptTurnIds?: string[];
  promptSubmittedAt?: string[];
  promptIndexBase?: number | null;
} | null | undefined): Array<Record<string, unknown>> | null {
  if (!stateData) return null;
  const prompts: string[] = Array.isArray(stateData.prompts) ? stateData.prompts : [];
  const saved = stateData.completedPromptMappings;
  if (Array.isArray(saved) && saved.length > 0) {
    const replayStamp = newCaptureStamp('hb');
    return saved.map((m) => {
      if (!m || typeof m !== 'object') return m;
      // The row's start time travels with it, so this replay cannot leave a
      // turn's createdAt at the time of its first write (see promptSubmittedAt).
      // A mapping that already carries a createdAt keeps it. It is flagged as
      // the submit time only when it IS that time — otherwise this final replay
      // would send it unflagged and the server would clear the flag Stop set.
      const start = turnStartFields(stateData, m.promptIndex);
      const withStart = !m.createdAt
        ? (start.createdAt ? { ...m, ...start } : m)
        : (start.createdAt && Date.parse(String(m.createdAt)) === Date.parse(start.createdAt)
          ? { ...m, createdAtIsTurnStart: true }
          : m);
      // Persisted mappings use an ISO timestamp so the release gate can grade
      // them. The API ordering contract uses epoch milliseconds. Preserve the
      // time the content was actually captured; only an unstamped legacy row
      // falls back to the time of this final replay.
      const withStamp = stampReplayedMapping(withStart, replayStamp);
      if (typeof m.turnId === 'string' && m.turnId) return withStamp;
      const turnId = turnIdForServerRow(stateData, m.promptIndex);
      return turnId ? { ...withStamp, turnId } : withStamp;
    });
  }
  if (prompts.length === 0) return null;
  return prompts.map((p: string, i: number) => ({
    ...newCaptureStamp('hb'),
    promptIndex: serverRowForLocalTurn(i, stateData.promptIndexBase),
    ...(stateData.promptTurnIds?.[i] ? { turnId: stateData.promptTurnIds[i] } : {}),
    ...(stateData.promptSubmittedAt?.[i] ? { createdAt: stateData.promptSubmittedAt[i], createdAtIsTurnStart: true } : {}),
    promptText: (p || '').slice(0, 1000),
    filesChanged: [],
    diff: '',
  }));
}
