/**
 * Stop re-sends every turn it has saved, and used to re-derive each of them on
 * every call: the ledger capture, the shadow window, the inherited-files drop
 * and the commit patch, per turn. On a long session that is the bulk of a Stop
 * that takes 30-60 s (2026-09-28: 55 Stops, median 31 s, p75 55 s, max 154 s —
 * TODO 4a6c17ce), and nearly all of it re-derives turns nothing has touched.
 *
 * A turn before the one the LAST Stop closed is settled when none of what can
 * change its row has moved since that Stop:
 *   - HEAD then is an ancestor of HEAD now — no checkout, reset or rebase;
 *   - the settled turns' inputs hash the same: their prompts and ids, their
 *     start and end shadows, the commits attested to them, and the session's
 *     rewrites, squash records and replays.
 * Then those rows go out exactly as the last Stop saved them, and only the
 * turns from the last closed one on are re-derived. The turn the last Stop
 * closed stays live, so a pass comparing a turn with its neighbour still sees
 * both.
 *
 * Anything else — no mark, a moved history, a changed input — re-derives every
 * turn, as before. So does a Stop 30 minutes after the last full one, as a
 * floor under whatever the fingerprint misses. ORIGIN_STOP_REUSE=0 turns reuse
 * off.
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';

export const STOP_REUSE_FULL_EVERY_MS = 30 * 60 * 1000;

export interface StopReuseMark {
  /** HEAD when the mark was taken. */
  head: string;
  /** LOCAL index of the turn that Stop closed. Turns before it are reuse candidates. */
  closedLocal: number;
  /** settledTurnsKey(state, closedLocal) when the mark was taken. */
  key: string;
  /** When a Stop last re-derived every turn. */
  fullAt: number;
}

interface ReuseState {
  prompts?: string[];
  promptTurnIds?: string[];
  promptIndexBase?: number | null;
  promptShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  turnEndShadows?: Array<{ promptIndex: number; shadowSha: string }>;
  commitTurns?: Array<{ sha: string; turnId: string }>;
  rewrittenCommits?: Array<{ from: string; to: string }> | null;
  preSquashCommitTurns?: Array<{ sha: string; turnId: string; squash: string }>;
  replayedCommits?: string[];
  completedPromptMappings?: Array<{ promptIndex: number } & Record<string, unknown>>;
  stopReuse?: StopReuseMark;
}

/** Everything that can change the row of a turn with a local index below `cut`. */
export function settledTurnsKey(state: ReuseState, cut: number): string {
  const ids = (state.promptTurnIds || []).slice(0, cut);
  const idSet = new Set(ids.filter(Boolean));
  const below = <T extends { promptIndex: number }>(rows: T[] | undefined) =>
    (rows || []).filter((r) => r.promptIndex < cut).map((r) => [r.promptIndex, (r as any).shadowSha]);
  const payload = {
    base: state.promptIndexBase ?? 0,
    prompts: (state.prompts || []).slice(0, cut),
    ids,
    starts: below(state.promptShadows),
    ends: below(state.turnEndShadows),
    commits: (state.commitTurns || []).filter((c) => idSet.has(c.turnId)).map((c) => [c.sha, c.turnId]),
    rewrites: (state.rewrittenCommits || []).map((r) => [r.from, r.to]),
    squashes: (state.preSquashCommitTurns || []).map((c) => [c.sha, c.turnId, c.squash]),
    replayed: state.replayedCommits || [],
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function isAncestor(repoPath: string, a: string, b: string): boolean {
  if (a === b) return true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repoPath, stdio: 'ignore', timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved rows this Stop may send as they are, keyed by SERVER row. Empty
 * with a reason whenever every turn has to be re-derived.
 */
export function settledRowsToReuse(input: {
  state: ReuseState;
  head: string | null;
  repoPath: string;
  now: number;
  env?: NodeJS.ProcessEnv;
  ancestor?: (a: string, b: string) => boolean;
}): { rows: Map<number, Record<string, unknown>>; reason: string } {
  const none = (reason: string) => ({ rows: new Map<number, Record<string, unknown>>(), reason });
  const { state, head, now } = input;
  if ((input.env ?? process.env).ORIGIN_STOP_REUSE === '0') return none('disabled');
  const mark = state.stopReuse;
  if (!mark) return none('no mark');
  if (now - mark.fullAt > STOP_REUSE_FULL_EVERY_MS) return none('periodic full rebuild');
  if (!head || !mark.head) return none('no HEAD');
  const ancestor = input.ancestor ?? ((a, b) => isAncestor(input.repoPath, a, b));
  if (!ancestor(mark.head, head)) return none('history moved');
  if (mark.closedLocal <= 0) return none('nothing settled');
  if (settledTurnsKey(state, mark.closedLocal) !== mark.key) return none('a settled turn changed');
  const base = state.promptIndexBase ?? 0;
  const rows = new Map<number, Record<string, unknown>>();
  for (const saved of state.completedPromptMappings || []) {
    const local = saved.promptIndex - base;
    if (local >= 0 && local < mark.closedLocal) rows.set(saved.promptIndex, saved);
  }
  // Every settled turn must have its saved row, or the reused list has a hole.
  if (rows.size < mark.closedLocal) return none('a settled turn has no saved row');
  return { rows, reason: 'reused' };
}

/** Put a saved row's content back on the mapping, keeping the mapping's own identity. */
export function applySavedRow(pm: Record<string, unknown>, saved: Record<string, unknown>): void {
  for (const key of Object.keys(pm)) {
    if (key === 'promptIndex' || key === 'promptText' || key === 'turnId') continue;
    if (!(key in saved)) delete pm[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'promptIndex' || key === 'promptText' || key === 'capturedAt') continue;
    pm[key] = value;
  }
}

/** The mark this Stop leaves for the next one. */
export function nextStopReuseMark(state: ReuseState, input: { head: string | null; closedLocal: number; reused: boolean; now: number }): StopReuseMark | undefined {
  if (!input.head || input.closedLocal < 0) return undefined;
  return {
    head: input.head,
    closedLocal: input.closedLocal,
    key: settledTurnsKey(state, input.closedLocal),
    fullAt: input.reused && state.stopReuse ? state.stopReuse.fullAt : input.now,
  };
}
