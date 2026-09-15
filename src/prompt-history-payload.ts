import { serverRowForLocalTurn } from './turn-index.js';

/** Write-ahead prompt history must include rows: the API's prompt string is
 * not the timeline. No capture fields belong here — replaying this after a
 * richer capture must only fill missing text/identity, never replace a diff
 * or call an unobserved turn chat-only. Callers pass already-redacted text.
 */
export function promptHistoryPayload(
  prompts: string[],
  state: { promptIndexBase?: number; promptTurnIds?: string[]; promptSubmittedAt?: string[] },
) {
  return {
    prompt: prompts.join('\n\n---\n\n') || undefined,
    promptChanges: prompts.map((promptText, localIndex) => ({
      promptIndex: serverRowForLocalTurn(localIndex, state.promptIndexBase),
      promptText: promptText.slice(0, 1000),
      ...(state.promptTurnIds?.[localIndex] ? { turnId: state.promptTurnIds[localIndex] } : {}),
      // Identity, not capture: when this replay is a row's first write, the row
      // starts at its submit time rather than the replay's.
      ...(state.promptSubmittedAt?.[localIndex] ? { createdAt: state.promptSubmittedAt[localIndex] } : {}),
    })),
  };
}
