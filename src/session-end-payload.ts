import { newCaptureStamp } from './capture-stamp.js';
import { serverRowForLocalTurn, turnIdForServerRow } from './turn-index.js';

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
  promptIndexBase?: number | null;
} | null | undefined): Array<Record<string, unknown>> | null {
  if (!stateData) return null;
  const prompts: string[] = Array.isArray(stateData.prompts) ? stateData.prompts : [];
  const saved = stateData.completedPromptMappings;
  if (Array.isArray(saved) && saved.length > 0) {
    return saved.map((m) => {
      if (!m || typeof m !== 'object') return m;
      if (typeof m.turnId === 'string' && m.turnId) return m;
      const turnId = turnIdForServerRow(stateData, m.promptIndex);
      return turnId ? { ...m, turnId } : m;
    });
  }
  if (prompts.length === 0) return null;
  return prompts.map((p: string, i: number) => ({
    ...newCaptureStamp('hb'),
    promptIndex: serverRowForLocalTurn(i, stateData.promptIndexBase),
    ...(stateData.promptTurnIds?.[i] ? { turnId: stateData.promptTurnIds[i] } : {}),
    promptText: (p || '').slice(0, 1000),
    filesChanged: [],
    diff: '',
  }));
}
