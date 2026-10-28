// ---------------------------------------------------------------------------
// Origin CLI — which captured edits a commit's line claims are projected from
// ---------------------------------------------------------------------------
// The one preparation path every note writer (post-commit, Stop, SessionEnd)
// shares, so the three cannot disagree about a commit's lines:
//
//   session edit captures ─┐
//   commitTurns binding ───┼─▶ turns bound to the commit ─▶ projectCommitLineClaims
//   attested iteration ────┘                                   (attribution-line-ranges.ts)
//
// What it decides, and nothing else:
//   • the commit's binding AND its turn, both from the strongest `commitTurns`
//     sightings of it (post-commit > trailer > transcript); a weaker sighting
//     never moves the turn. A commit with none, or whose strongest sightings
//     do not name exactly one numbered turn, gets no claims;
//   • the turns whose edits may have landed in it: from just after the turn of
//     the session's previous commit up to the commit's own turn. Earlier edits
//     are already in the parent and would only fail the replay;
//   • which turn's lines may carry `iteration_index`: only the one turn the
//     post-commit hook attested (iterationIndexByShaFromState). Lines of the
//     other turns in the window are the session's, prompt unknown.
//
// Evidence admission, replay and coordinates stay in the projector. Each
// commit gets an explicit decision (LineClaimDecision): `proven` lines,
// `degraded` (evaluated, nothing provable — authoritative commit-level), or
// `not_evaluated` (this writer had nothing to look at). Failure is never
// fatal: whatever goes wrong, the writer still writes a commit-level note.
//
// One wall-clock budget covers the whole call, every commit and every git
// subprocess in it (LINE_CLAIM_BUDGET_MS); running out degrades the commits
// left, it never delays the hook.
// ---------------------------------------------------------------------------

import {
  ProjectionTimeout,
  checkDeadline,
  createProjectionDeadline,
  gitTimeoutMs,
  projectCommitLineClaims,
  type CapturedTurn,
  type CommitBindingSource,
  type ProjectionDeadline,
} from './attribution-line-ranges.js';
import {
  iterationIndexByShaFromState,
  noteIsLineUpgradeCandidate,
  publishableLineFiles,
  type LineClaimDecision,
  type LineClaimDecisions,
} from './attribution-note.js';
import { buildCapturesFromLedger } from './prompt-capture/index.js';
import type { PromptEdit } from './prompt-capture/types.js';
import type { SessionState } from './session-state.js';
import { rebaseToServerRows, serverRowForLocalTurn } from './turn-index.js';
import { EDITS_TRUNCATED_MARKER } from './note-scrub.js';
import { gitOrNull } from './utils/exec.js';
import { debugLog } from './debug-log.js';

/** One turn's edits, numbered by SERVER row (the index space of iterations). */
export interface SessionEditCapture {
  promptIndex: number;
  edits: PromptEdit[];
  /** The serialized capture was cut or unreadable. */
  truncated?: boolean;
}

const VIA_RANK: Record<string, number> = { 'post-commit': 3, trailer: 2, transcript: 1 };

/**
 * Agents whose captures may open line claims today, and which of each agent's
 * captured edits count as its proof. The others stay commit-level.
 *
 * Cursor (OR-45 checkpoint 3A): its transcript records a tool call but no
 * result — no id, no `tool_result`, no `is_error` — so a rejected StrReplace
 * reads exactly like one that landed. What afterFileEdit read back from disk
 * AFTER Cursor wrote the file (`edit_hook`) is the only edit whose success is
 * proven. Its binding still has to be attested: the transcript-only sightings
 * Cursor usually produces open nothing (see admitEditForLineClaim).
 *
 * Gemini (OR-45 checkpoint 3B, G3): only an edit EXPLICITLY stamped
 * `tool_call` — a transcript call whose status is 'success', or an AfterTool
 * whose ToolResult carries no error. Failed and cancelled calls never reach
 * the capture; a call of unknown outcome is kept unstamped, and the admission
 * default that reads an unstamped tool_call as proof must not apply to it.
 * Shell-probe edits stay out too: G3 closes the tool calls, nothing else.
 *
 * Copilot (OR-45 checkpoints 3C/3C.1): G1 — its extractor stamps `tool_call`
 * only on an edit whose tool.execution_complete said `success: true`. G2 —
 * with no tool hook, post-commit attests its running turn from the events log
 * instead (copilot-turn-proof.ts: a successful edit of an exact committed path,
 * or the open `git commit` call). Its edits reach the projector only from the
 * Stop / SessionEnd extractor; a commit nothing attested, a path-only watcher
 * record and back-filled content open nothing.
 */
const LINE_CLAIM_EDITS: Readonly<Record<string, (edit: PromptEdit) => boolean>> = {
  'claude-code': () => true,
  codex: () => true,
  cursor: (edit) => edit.evidence === 'edit_hook',
  gemini: (edit) => edit.evidence === 'tool_call',
  copilot: (edit) => edit.evidence === 'tool_call',
};

export const LINE_CLAIM_AGENTS: ReadonlySet<string> = new Set(Object.keys(LINE_CLAIM_EDITS));

/**
 * Captures from the Stop / SessionEnd edit map (server row → serialized
 * PromptCapture, ledger already merged). A cut or unparseable entry is kept as
 * a truncated turn, so a commit it may touch degrades instead of half-replaying.
 */
export function editCapturesFromEditsJson(byIndex: ReadonlyMap<number, string> | null | undefined): SessionEditCapture[] {
  const out: SessionEditCapture[] = [];
  for (const [promptIndex, raw] of byIndex ?? []) {
    if (!Number.isInteger(promptIndex) || typeof raw !== 'string') continue;
    if (raw.includes(EDITS_TRUNCATED_MARKER)) { out.push({ promptIndex, edits: [], truncated: true }); continue; }
    try {
      const cap = JSON.parse(raw);
      out.push({ promptIndex, edits: Array.isArray(cap?.edits) ? cap.edits : [] });
    } catch {
      out.push({ promptIndex, edits: [], truncated: true });
    }
  }
  return out.sort((a, b) => a.promptIndex - b.promptIndex);
}

/**
 * Captures from the live PostToolUse ledger — all post-commit has, since it
 * runs before any transcript is parsed. Entries written in another worktree
 * (a sub-agent's) are relative to that tree, not this repo, and are left out.
 */
export function editCapturesFromLiveLedger(state: Pick<SessionState, 'liveEdits' | 'promptIndexBase'>): SessionEditCapture[] {
  const entries = (state.liveEdits ?? []).filter((e) => e && !e.tree);
  const caps = rebaseToServerRows(buildCapturesFromLedger(entries as any), state.promptIndexBase);
  return caps.map((c) => ({ promptIndex: c.promptIndex, edits: c.edits }));
}

interface CommitSighting {
  /** The one turn the strongest sightings agree on, as a server row; null when they do not name exactly one. */
  row: number | null;
  via: CommitBindingSource;
  at: number;
}

/**
 * Each sighted commit → its strongest binding, and the turn THAT binding names.
 *
 * Strength, turn and time are never taken from different sightings: a weaker
 * sighting (a transcript mention in a later turn, or with an earlier
 * timestamp) neither moves the bound turn, nor reorders the commit against
 * the session's others, nor widens the window past the attested turn. Sightings
 * of the strongest rank that name different turns, or a turn this launch never
 * numbered, leave the commit without a bound turn. Independent of the order of
 * `commitTurns`.
 */
function commitSightings(state: Pick<SessionState, 'commitTurns' | 'promptTurnIds' | 'promptIndexBase'>): Map<string, CommitSighting> {
  const ids = state.promptTurnIds || [];
  const grouped = new Map<string, Array<{ via: CommitBindingSource; row: number | null; at: number }>>();
  for (const ct of state.commitTurns || []) {
    if (!ct || typeof ct.sha !== 'string' || !VIA_RANK[ct.via]) continue;
    const local = ct.turnId ? ids.indexOf(ct.turnId) : -1;
    // A turn id this launch numbered twice, or never, names no row.
    const row = local >= 0 && ids.lastIndexOf(ct.turnId) === local ? serverRowForLocalTurn(local, state.promptIndexBase) : null;
    const at = Date.parse(ct.at);
    const sha = ct.sha.toLowerCase();
    if (!grouped.has(sha)) grouped.set(sha, []);
    grouped.get(sha)!.push({ via: ct.via, row, at: Number.isFinite(at) ? at : Infinity });
  }
  const out = new Map<string, CommitSighting>();
  for (const [sha, all] of grouped) {
    const best = Math.max(...all.map((s) => VIA_RANK[s.via]));
    const strongest = all.filter((s) => VIA_RANK[s.via] === best);
    const rows = new Set(strongest.map((s) => s.row));
    out.set(sha, {
      row: rows.size === 1 && !rows.has(null) ? [...rows][0] : null,
      via: strongest[0].via,
      at: Math.min(...strongest.map((s) => s.at)),
    });
  }
  return out;
}

/**
 * The full lowercase sha `sha` names in `repoPath`, or null. Abbreviated input
 * is resolved, within what is left of `deadline` when one is given.
 */
export function canonicalCommitSha(repoPath: string, sha: string, deadline?: ProjectionDeadline): string | null {
  const s = (sha || '').toLowerCase();
  if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) return s;
  if (!/^[0-9a-f]{4,64}$/.test(s)) return null;
  let timeoutMs: number;
  try { timeoutMs = gitTimeoutMs(deadline, 5_000); } catch { return null; }
  const resolved = gitOrNull(['rev-parse', '--verify', '--quiet', `${s}^{commit}`], { cwd: repoPath, timeoutMs });
  return resolved ? resolved.toLowerCase() : null;
}

/**
 * The wall-clock budget of one lineClaimsForCommits call — all of its commits
 * and git subprocesses together. Line claims are best effort inside hooks
 * whose own budget is a few seconds; a commit the budget does not reach is
 * `degraded` and gets a commit-level note.
 */
export const LINE_CLAIM_BUDGET_MS = 500;

export interface LineClaimOptions {
  /** Default LINE_CLAIM_BUDGET_MS. */
  budgetMs?: number;
  /** The clock the budget is measured on (tests inject one). */
  now?: () => number;
}

const degraded = (reason: string): LineClaimDecision => ({ status: 'degraded', reason });

/**
 * This session's line-claim decision for each of `shas`, keyed by full
 * lowercase sha (see LineClaimDecision):
 *
 *   • not_evaluated — an agent without line claims, no capture at all, a
 *     commit with no bound turn, or no countable edit in its window. Also
 *     every commit when `captures` (a thunk, so post-commit's preparation runs
 *     inside this guard) throws;
 *   • degraded — the window had edits (or a truncated capture) and nothing
 *     publishable came out: the projector proved nothing, the budget ran out,
 *     or the claims failed publishableLineFiles;
 *   • proven — publishable files.
 *
 * Never throws. An abbreviated sha the budget leaves no time to resolve gets
 * no key, which reads as not_evaluated.
 */
export function lineClaimsForCommits(
  repoPath: string,
  agentSlug: string | undefined,
  state: Pick<SessionState, 'commitTurns' | 'promptTurnIds' | 'promptIndexBase'>,
  shas: readonly string[],
  captures: readonly SessionEditCapture[] | (() => readonly SessionEditCapture[]),
  opts: LineClaimOptions = {},
): LineClaimDecisions {
  const out: Record<string, LineClaimDecision> = {};
  try {
    const deadline = createProjectionDeadline(opts.budgetMs ?? LINE_CLAIM_BUDGET_MS, opts.now);
    const agent = (agentSlug || '').toLowerCase();
    const counts = Object.hasOwn(LINE_CLAIM_EDITS, agent) ? LINE_CLAIM_EDITS[agent] : undefined;
    if (!counts || !repoPath || shas.length === 0) return out;
    let caps: readonly SessionEditCapture[];
    let sightings: Map<string, CommitSighting>;
    let iterationBySha: Record<string, number>;
    try {
      caps = typeof captures === 'function' ? captures() : captures;
      if (!Array.isArray(caps) || caps.length === 0) return out;
      sightings = commitSightings(state);
      iterationBySha = iterationIndexByShaFromState(state);
    } catch (err) {
      debugLog('line-claims', 'capture preparation failed; lines not evaluated', { message: err instanceof Error ? err.message : String(err) });
      return out;
    }
    for (const raw of shas) {
      const sha = canonicalCommitSha(repoPath, raw, deadline);
      if (!sha || Object.hasOwn(out, sha)) continue;
      try {
        out[sha] = decideCommit(repoPath, sha, counts, sightings, iterationBySha, caps, deadline);
      } catch (err) {
        // One commit's failure never costs another its claims.
        out[sha] = degraded(err instanceof ProjectionTimeout ? 'timeout' : 'error');
      }
    }
  } catch {
    // Nothing above is expected to throw; what was decided stands.
  }
  return out;
}

function decideCommit(
  repoPath: string,
  sha: string,
  counts: (edit: PromptEdit) => boolean,
  sightings: Map<string, CommitSighting>,
  iterationBySha: Record<string, number>,
  captures: readonly SessionEditCapture[],
  deadline: ProjectionDeadline,
): LineClaimDecision {
  const own = sightings.get(sha);
  if (!own || own.row === null) return { status: 'not_evaluated' };
  const top = own.row;
  // The turn of this session's previous commit bounds the window from below.
  let prev = -Infinity;
  for (const [other, s] of sightings) {
    if (other === sha || !(s.at < own.at) || s.row === null) continue;
    if (s.row <= top && s.row > prev) prev = s.row;
  }
  const from = prev === -Infinity ? -Infinity : prev < top ? prev + 1 : top;
  const iteration = iterationBySha[sha];
  const turns: CapturedTurn[] = captures
    .filter((c) => c.promptIndex >= from && c.promptIndex <= top)
    .map((c) => ({ ...c, edits: c.edits.filter(counts) }))
    .filter((c) => c.truncated || c.edits.length > 0)
    .map((c) => ({
      promptIndex: c.promptIndex,
      edits: c.edits,
      ...(c.truncated && { truncated: true }),
      ...(c.promptIndex === iteration && { iterationIndex: iteration }),
    }));
  if (turns.length === 0) return { status: 'not_evaluated' };
  checkDeadline(deadline);
  const projection = projectCommitLineClaims({ repoPath, commitSha: sha, turns, binding: own.via, deadline });
  if (projection.diagnostics.length > 0) {
    // Reasons only: never a path's content, never prompt text.
    const reasons: Record<string, number> = {};
    for (const d of projection.diagnostics) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
    debugLog('line-claims', 'projection dropped claims', { sha: sha.slice(0, 8), files: projection.files.length, reasons });
  }
  if (projection.diagnostics.some((d) => d.reason === 'timeout')) return degraded('timeout');
  if (projection.files.length === 0) return degraded(projection.diagnostics[0]?.reason ?? 'no_claims');
  // The builder's own acceptance step, with the iteration it will name.
  if (!publishableLineFiles(projection.files, iteration)) return degraded('unpublishable');
  return { status: 'proven', files: projection.files };
}

export interface StopNotePlan {
  /** The commits Stop writes, in the order given. */
  write: string[];
  /** The projection of exactly the candidates, for the record builder. */
  lineClaims: LineClaimDecisions;
}

/**
 * Which of a session's commits a Stop writes, in two steps:
 *
 *   1. read every note once and pick the candidates — commits with no note,
 *      and commits whose note is a valid record with this session's
 *      contribution still commit-level (noteIsLineUpgradeCandidate). Line
 *      notes, other sessions' notes and invalid or legacy-only notes are
 *      neither projected nor written;
 *   2. project only the candidates (`project`), then write every missing note
 *      whatever the projection said, and an existing one only for a `proven`
 *      decision — which already passed publishableLineFiles, so a set the
 *      builder would refuse never draws a rewrite on every Stop.
 *
 * Decisions are looked up under the commit's canonical full sha; `shas` may be
 * abbreviated.
 */
export function planStopNoteWrites(input: {
  repoPath: string;
  sessionId: string;
  shas: readonly string[];
  readNote: (sha: string) => string | null;
  project: (shas: string[]) => LineClaimDecisions;
}): StopNotePlan {
  const missing = new Set<string>();
  const upgrade = new Map<string, string>(); // given sha → full sha
  for (const sha of input.shas) {
    const existing = input.readNote(sha);
    if (existing === null) { missing.add(sha); continue; }
    const full = canonicalCommitSha(input.repoPath, sha);
    if (full && noteIsLineUpgradeCandidate(existing, full, input.sessionId)) upgrade.set(sha, full);
  }
  const candidates = input.shas.filter((sha) => missing.has(sha) || upgrade.has(sha));
  let lineClaims: LineClaimDecisions = {};
  if (candidates.length > 0) {
    try { lineClaims = input.project(candidates); } catch { lineClaims = {}; }
  }
  const write = candidates.filter((sha) => missing.has(sha) || lineClaims[upgrade.get(sha)!]?.status === 'proven');
  return { write, lineClaims };
}
