/**
 * A message absorbed mid-turn whose submit hook never ran still gets its turn
 * (TODO e840ccd5).
 *
 * The user types while a turn runs; Claude Code absorbs the message into the
 * running turn. Its submit hook is what gives it a turn id, a submit time and a
 * journal mark — the boundary every later write and commit is filed by. When
 * that hook is killed (prod c085f0af turn 7/8, 2026-09-26, under load), Stop
 * pulls the prompt out of the transcript and nothing else: no id, no mark, so
 * the ledger billed the interrupted turn for all the new prompt's work (+378)
 * and the new prompt's row was empty. #1938 recovers such a prompt at the NEXT
 * submit, which is too late for the turn it was absorbed into.
 *
 * The transcript records when the message was absorbed. That is where the turn
 * began: mint its id, mark the journal there, and move the commits the running
 * turn attested after that moment.
 *
 * The same holds for a prompt sent BETWEEN turns whose hook never ran (session
 * 1476cd52 row 1, 2026-09-27: `origin: command not found` while a sibling's
 * `origin upgrade` had the bin removed). The list still ended at the previous
 * prompt, so its first tool call re-opened that turn, and the commit made
 * half an hour later was attested to it (+327/-12 on row 0, row 1 empty).
 * The transcript's own timestamp on the prompt is where its turn began.
 */
import { mintTurnId, promptKey, recordPromptSubmittedAt } from './session-state.js';

export interface AbsorbedTurn {
  /** Local index of the prompt. */
  promptIndex: number;
  turnId: string;
  /** Epoch ms its turn began: when it was absorbed, or when it was sent. */
  at: number;
  /** The turn it was split from. */
  splitFrom: string;
  /** Absorbed into a running turn, rather than sent between turns. */
  midTurn: boolean;
  /** Whether the journal now marks it. */
  marked: boolean;
  /** Commits re-attested from `splitFrom` to it. */
  commits: string[];
}

interface AbsorbState {
  prompts?: string[];
  promptTurnIds?: string[];
  promptSubmittedAt?: string[];
  activeTurn?: { index: number } | null;
  lastClosedTurnIndex?: number;
  commitTurns?: Array<{ sha: string; turnId: string; at: string }>;
}

interface AbsorbParsed {
  prompts?: string[];
  midTurnPrompts?: number[];
  midTurnPromptAt?: Array<number | null>;
  promptAt?: Array<number | undefined>;
}

function samePrompt(a: string, b: string): boolean {
  const x = promptKey(a || '');
  const y = promptKey(b || '');
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}

export function giveAbsorbedPromptsTheirTurns(
  state: AbsorbState,
  parsed: AbsorbParsed | null | undefined,
  opts: {
    /** Put `turnId`'s mark in the journal at `at`, after `afterTurnId`'s. */
    markAt: (turnId: string, at: number, afterTurnId: string) => boolean;
    newId?: () => string;
  },
): AbsorbedTurn[] {
  const out: AbsorbedTurn[] = [];
  const prompts = Array.isArray(state.prompts) ? state.prompts : [];
  const seen = Array.isArray(parsed?.prompts) ? parsed!.prompts! : [];
  if (prompts.length === 0 || seen.length === 0) return out;
  // Only prompts after the turn that could have taken their work: the one
  // running now, or with none open, the last one a Stop closed. Older prompts
  // were settled by their own Stops.
  const lastClosed = Number.isInteger(state.lastClosedTurnIndex) ? (state.lastClosedTurnIndex as number) : 0;
  const running = state.activeTurn && Number.isInteger(state.activeTurn.index) ? state.activeTurn.index : Math.max(lastClosed, 0);
  if (running < 0 || running >= prompts.length - 1) return out;
  // When each transcript prompt began. An absorbed one began when it was
  // absorbed; any other when it was sent.
  const began = new Map<number, number>();
  (parsed?.promptAt || []).forEach((t, pos) => { if (typeof t === 'number' && Number.isFinite(t)) began.set(pos, t); });
  const midTurn = new Set<number>();
  (parsed?.midTurnPrompts || []).forEach((pos, k) => {
    midTurn.add(pos);
    const t = parsed?.midTurnPromptAt?.[k];
    if (typeof t === 'number' && Number.isFinite(t)) began.set(pos, t);
    else began.delete(pos);
  });
  if (!state.promptTurnIds) state.promptTurnIds = [];
  const ids = state.promptTurnIds;
  const newId = opts.newId || mintTurnId;
  // The stored list and the transcript share their tail (Stop just appended
  // the transcript's new prompts), so align from the end. Matching text from
  // the front would pair a repeated prompt ("next task from the list") with
  // an older copy of itself and split at the wrong time.
  const offset = seen.length - prompts.length;
  for (let index = running + 1; index < prompts.length; index++) {
    // Its hook ran: it already has everything.
    if (ids[index]) continue;
    const pos = index + offset;
    if (pos < 0 || !samePrompt(prompts[index], seen[pos])) continue;
    const at = began.get(pos);
    if (typeof at !== 'number') continue;
    let prev = index - 1;
    while (prev >= 0 && !ids[prev]) prev--;
    if (prev < running) continue;
    const splitFrom = ids[prev];
    // Began before the turn it would split: not that turn's successor.
    const prevBegan = Date.parse(state.promptSubmittedAt?.[prev] || '');
    if (Number.isFinite(prevBegan) && at < prevBegan) continue;

    const turnId = newId();
    ids[index] = turnId;
    recordPromptSubmittedAt(state, index, at);
    const marked = opts.markAt(turnId, at, splitFrom);
    const commits: string[] = [];
    for (const ct of state.commitTurns || []) {
      if (ct.turnId !== splitFrom) continue;
      const t = Date.parse(ct.at || '');
      if (Number.isFinite(t) && t >= at) {
        ct.turnId = turnId;
        commits.push(ct.sha);
      }
    }
    out.push({ promptIndex: index, turnId, at, splitFrom, midTurn: midTurn.has(pos), marked, commits });
  }
  return out;
}
