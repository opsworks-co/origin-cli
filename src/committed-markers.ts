// The markers a session's memory may carry: only those written in a turn that
// made a commit.
//
// The repo's memory is what was committed plus the context behind it. A turn
// whose work was thrown away — a design tried on localhost and rejected, a test
// run nobody kept — left its markers in the transcript all the same, and every
// writer used to parse the whole transcript and stamp the lot on the session
// and on each of its commits. See the per-turn section of origin-markers.ts.
import { readAllCommitMemory, type CommitMemoryEntry } from './memory.js';
import {
  markersOfCommitTurns, mergeMarkers, readMarkerTurns, significantLine,
  type CommitEvidence, type MarkerTurn, type OriginMarkers,
} from './origin-markers.js';
import { turnStartForServerRow } from './turn-index.js';
import { gitOrNull } from './utils/exec.js';

const MAX_SHAS_RESOLVED = 50;

/**
 * When each commit was made and the lines it added (normalized as the turns'
 * written lines are), in one git call. A sha git does not know is absent.
 */
export function commitEvidence(repoPath: string, shas: string[]): Map<string, CommitEvidence> {
  const out = new Map<string, CommitEvidence>();
  const want = [...new Set(shas.filter((s) => /^[0-9a-f]{4,40}$/i.test(s || '')))].slice(-MAX_SHAS_RESOLVED);
  if (want.length === 0) return out;
  const log = gitOrNull(
    ['log', '--no-walk=unsorted', '--ignore-missing', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=%x00%H %cI', ...want],
    { cwd: repoPath, timeoutMs: 15_000 },
  );
  if (!log) return out;
  let cur: { sha: string; at: number; added: Set<string> } | null = null;
  const flush = () => {
    if (!cur) return;
    // Keyed by the full sha and by however the caller spelled it.
    const ev = { at: cur.at, added: cur.added };
    out.set(cur.sha, ev);
    for (const s of want) if (cur.sha.startsWith(s.toLowerCase())) out.set(s, ev);
  };
  for (const line of log.split('\n')) {
    if (line.startsWith('\0')) {
      flush();
      const [sha, at] = line.slice(1).split(' ');
      cur = { sha, at: Date.parse(at), added: new Set() };
      continue;
    }
    if (cur && line.startsWith('+') && !line.startsWith('+++')) {
      const l = significantLine(line.slice(1));
      if (l) cur.added.add(l);
    }
  }
  flush();
  return out;
}

/**
 * The decisions written in the turns that made one commit — what a commit
 * record carries. With `added`, an earlier turn whose work is in the commit
 * counts too (markersOfCommitTurns).
 */
export function commitTurnDecisions(
  turns: MarkerTurn[],
  committedAt: string | number | null | undefined,
  opts: { currentTurnStartedAt?: number | null; added?: ReadonlySet<string>; turn?: number } = {},
): string[] {
  const at = typeof committedAt === 'number' ? committedAt : Date.parse(committedAt || '');
  return markersOfCommitTurns(turns, [{ at, added: opts.added, turn: opts.turn }], opts)?.decision || [];
}

/**
 * Per sha, the markers written in the turns that made it — what a commit's
 * attribution note carries.
 */
export function commitTurnMarkersFor(
  repoPath: string,
  turns: MarkerTurn[],
  opts: { currentTurnStartedAt?: number | null } = {},
): (sha: string) => OriginMarkers | undefined {
  return (sha) => {
    if (turns.length === 0) return undefined;
    const ev = commitEvidence(repoPath, [sha]).get(sha);
    return ev ? markersOfCommitTurns(turns, [ev], opts) : undefined;
  };
}

/**
 * Per commit record, the decisions of the turns that made it — for
 * enrichDecisionsForSession. Reads the session's commits from git once.
 */
export function commitDecisionsFor(
  repoPath: string,
  sessionId: string,
  turns: MarkerTurn[],
  opts: { currentTurnStartedAt?: number | null; turnOf?: (sha: string) => number | undefined } = {},
): (commit: CommitMemoryEntry) => string[] {
  if (turns.length === 0) return () => [];
  const shas = readAllCommitMemory(repoPath)
    .filter((c) => c.sessionId === sessionId && (!c.decisions || c.decisions.length === 0))
    .map((c) => c.commitSha);
  const evidence = commitEvidence(repoPath, shas);
  return (c) => commitTurnDecisions(turns, evidence.get(c.commitSha)?.at ?? c.committedAt, {
    currentTurnStartedAt: opts.currentTurnStartedAt,
    added: evidence.get(c.commitSha)?.added,
    turn: opts.turnOf?.(c.commitSha),
  });
}

/**
 * The markers of every turn that made one of this session's commits, plus the
 * decisions its commit records already hold (a transcript with no times can
 * place only the running turn's commit, so earlier ones survive only in their
 * records).
 *
 * Commits come from the memory note's records for the session and from
 * `commitShas`, so a config that writes no commit records still finds them.
 */
export function committedSessionMarkers(opts: {
  repoPath: string;
  sessionId: string;
  transcriptPath?: string | null;
  commitShas?: string[];
  /** A commit whose record is not written yet. */
  commits?: CommitEvidence[];
  currentTurnStartedAt?: number | null;
  turns?: MarkerTurn[];
}): OriginMarkers | undefined {
  const records: CommitMemoryEntry[] = readAllCommitMemory(opts.repoPath).filter((c) => c.sessionId === opts.sessionId);
  const turns = opts.turns || readMarkerTurns(opts.transcriptPath);
  const recorded = records.flatMap((c) => c.decisions || []);
  const recordedMarkers = recorded.length ? { decision: recorded } : undefined;
  if (turns.length === 0) return mergeMarkers(recordedMarkers);
  const shas = [...records.map((c) => c.commitSha), ...(opts.commitShas || [])];
  const evidence = commitEvidence(opts.repoPath, shas);
  const commits: CommitEvidence[] = [...(opts.commits || [])];
  const seen = new Set<CommitEvidence>();
  for (const c of records) {
    const ev = evidence.get(c.commitSha);
    if (ev) { if (!seen.has(ev)) { seen.add(ev); commits.push(ev); } }
    else commits.push({ at: Date.parse(c.committedAt || '') });
  }
  for (const sha of opts.commitShas || []) {
    const ev = evidence.get(sha);
    if (ev && !seen.has(ev)) { seen.add(ev); commits.push(ev); }
  }
  return mergeMarkers(
    markersOfCommitTurns(turns, commits, { currentTurnStartedAt: opts.currentTurnStartedAt }),
    recordedMarkers,
  );
}

// How far apart the hook's record of a prompt and the transcript's may be and
// still be the same prompt. They are written moments apart by the same machine.
const SAME_PROMPT_MS = 60_000;

type PromptClock = { promptSubmittedAt?: string[]; promptIndexBase?: number | null };

// How many prompts the transcript should hold by the state's count: the turns
// before this launch adopted the conversation, then the ones it recorded.
function promptsByState(state: PromptClock): number {
  const base = Number.isFinite(state.promptIndexBase as number) && (state.promptIndexBase as number) > 0
    ? state.promptIndexBase as number : 0;
  return base + (state.promptSubmittedAt || []).length;
}

/**
 * Give a transcript with no times (Cursor) the hook's own record of when each
 * prompt was sent, so its commits can be placed by time like every other
 * agent's — the running turn's, and an earlier turn whose work a later one
 * committed. Prompt k of the transcript is the state's server row k.
 *
 * Only when the transcript holds exactly the prompts the state counts: a
 * prompt one side has and the other lacks (a queued Cursor prompt, a turn the
 * transcript has not written yet) shifts every position after it, and a time
 * on the wrong turn hands its decision to a commit it had no part in. A
 * transcript that has times of its own keeps them.
 */
export function withPromptTimes(turns: MarkerTurn[], state: PromptClock): MarkerTurn[] {
  if (turns.length < 2 || turns.some((t) => t.startedAt !== null)) return turns;
  if (turns.length - 1 !== promptsByState(state)) return turns;
  let any = false;
  const out = turns.map((t, i) => {
    if (i === 0) return t;
    const at = Date.parse(turnStartForServerRow(state, i - 1) || '');
    if (!Number.isFinite(at)) return t;
    any = true;
    return { ...t, startedAt: at };
  });
  return any ? out : turns;
}

/**
 * Add what each finished turn changed, as Origin captured it, to the lines the
 * transcript says it wrote. The transcript only sees edit tools; a turn that
 * wrote through the shell (a heredoc, a script) shows nothing there, but its
 * captured diff has it.
 *
 * A diff is filed under the transcript turn whose prompt matches the turn's
 * submit time. A transcript with no times first gets the state's
 * (withPromptTimes); one that still has none is matched by position — server
 * row k is transcript prompt k — when the transcript holds exactly the prompts
 * the state counts, and otherwise left as is.
 */
export function withTurnDiffs(
  turns: MarkerTurn[],
  state: {
    completedPromptMappings?: Array<{ promptIndex: number; diff?: string | null; uncommittedDiff?: string | null }>;
    promptSubmittedAt?: string[];
    promptIndexBase?: number | null;
  },
): MarkerTurn[] {
  turns = withPromptTimes(turns, state);
  const mappings = state.completedPromptMappings || [];
  const timed = turns.some((t) => t.startedAt !== null);
  const byPosition = !timed && turns.length > 1 && turns.length - 1 === promptsByState(state);
  if (turns.length === 0 || mappings.length === 0 || (!timed && !byPosition)) return turns;
  const out = turns.map((t) => ({ ...t, written: [...(t.written || [])] }));
  for (const m of mappings) {
    const text = [m.diff, m.uncommittedDiff].filter(Boolean).join('\n');
    if (!text) continue;
    let best = -1;
    if (byPosition) {
      if (Number.isInteger(m.promptIndex) && m.promptIndex >= 0 && m.promptIndex + 1 < out.length) best = m.promptIndex + 1;
    } else {
      const at = Date.parse(turnStartForServerRow(state, m.promptIndex) || '');
      if (!Number.isFinite(at)) continue;
      let gap = Infinity;
      out.forEach((t, i) => {
        if (t.startedAt === null) return;
        const d = Math.abs(t.startedAt - at);
        if (d < gap) { gap = d; best = i; }
      });
      if (gap > SAME_PROMPT_MS) best = -1;
    }
    if (best < 0) continue;
    const have = new Set(out[best].written);
    for (const line of text.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const l = significantLine(line.slice(1));
      if (l && !have.has(l)) { have.add(l); out[best].written.push(l); }
    }
  }
  return out;
}

/**
 * The start (ms) of the turn a hook is running in: the hook's own record of
 * the latest prompt. Lets a transcript with no times place the running turn's
 * commit.
 */
export function currentTurnStart(state: { currentTurnStartedAt?: number; promptSubmittedAt?: string[] }): number | null {
  if (typeof state.currentTurnStartedAt === 'number' && Number.isFinite(state.currentTurnStartedAt)) return state.currentTurnStartedAt;
  const last = (state.promptSubmittedAt || []).filter(Boolean).pop();
  const t = last ? Date.parse(last) : NaN;
  return Number.isFinite(t) ? t : null;
}
