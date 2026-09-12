// Closing the loop on TODOs: an agent says it discharged a prior leftover, and
// the repo's default branch is what decides whether that is true.
//
// WHY THIS SHAPE. `openTodos` is append-only — session end writes each
// session's leftovers into the memory note and nothing ever edits them — so
// until now a leftover was re-read as open forever, however long ago it was
// dealt with. The obvious automation is to match merged PRs against TODO text
// and close what looks handled. That was tried on this repo's own 60 open items
// and it does not survive contact with them: most are of the form "I did NOT
// fix X while doing Y", so closing them when Y's PR merges closes them at
// exactly the moment they became relevant. `7a15598c` ("#1526 removes two of
// three spawns — worth re-measuring after this deploys") would be closed by
// #1526 merging, which is the event that STARTS it.
//
// So the link is asserted, not guessed: a session that fixes something emits
// `[Origin: Closes] <id or text>`, the same way it already emits
// `[Origin: Open]`. That claim is recorded as `pending` and hides nothing. It
// becomes `closed` only when the work carrying it reaches the default branch —
// which is the "close on merge" part, with the agent supplying the key instead
// of a regex inferring it.
import { gitDetailed, gitOrNull } from './utils/exec.js';
import {
  readTodoClosures, recordTodoClosures, todoClosureKey, type TodoClosure,
} from './memory.js';
import { debugLog } from './debug-log.js';

/** A claim can only reach so far back before re-checking it is pointless. */
const MAX_PENDING_CHECKED = 50;

/**
 * Where "merged" is measured from.
 *
 * `origin/HEAD` is the honest answer but is unset on plenty of clones (it is
 * written by `git clone`, not by `git init` + `git remote add`), so the usual
 * names follow, remote before local: a local `main` can sit behind or ahead of
 * what the team has actually taken, and the question here is what LANDED.
 */
export function defaultBranchRef(repoPath: string): string | null {
  const head = gitOrNull(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repoPath, timeoutMs: 5_000 });
  if (head) return head.trim();
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    if (gitOrNull(['rev-parse', '--verify', '--quiet', ref], { cwd: repoPath, timeoutMs: 5_000 })) return ref;
  }
  return null;
}

/**
 * Has this session's closing work landed on `branchRef`?
 *
 * Two readings, because a merge does not preserve shas. A rebase or a merge
 * commit keeps them, so `--is-ancestor` answers directly. A SQUASH does not —
 * GitHub writes a fresh commit — but this repo's squashes keep the
 * `Origin-Session` trailer (verified on `origin/main`: 90 trailer lines across
 * the last 60 commits, every one of them a squash merge), so the session id is
 * the thread that survives.
 *
 * The trailer search is bounded by the claim's own timestamp. Without that
 * bound a long-lived session whose EARLIER commits are already on main would
 * confirm a claim made after them — the trailer names the session, not the
 * piece of work, so an unbounded search answers "has this session ever landed
 * anything", which is not the question.
 */
function closingWorkHasLanded(repoPath: string, branchRef: string, closure: TodoClosure): boolean {
  for (const sha of (closure.shas || []).slice(0, 20)) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    // `--is-ancestor` answers in the EXIT CODE and prints nothing — 0 yes, 1 no,
    // 128 for a sha this repo does not have. Read the status directly rather
    // than inferring it from `gitOrNull` returning '' versus null, which is
    // true but is the kind of subtlety that gets "simplified" into a bug.
    try {
      if (gitDetailed(['merge-base', '--is-ancestor', sha, branchRef],
        { cwd: repoPath, timeoutMs: 5_000 }).status === 0) return true;
    } catch { /* absent sha, unreadable repo — not landed */ }
  }
  const sid = (closure.sessionId || '').split('-')[0];
  if (sid.length >= 8) {
    const found = gitOrNull(
      ['log', branchRef, '--grep', `Origin-Session: ${sid}`, '--since', closure.at, '--format=%H', '-1'],
      { cwd: repoPath, timeoutMs: 10_000 },
    );
    if (found) return true;
  }
  return false;
}

/**
 * Match one `[Origin: Closes]` marker to an open TODO.
 *
 * An id prefix is the exact form and is tried first. Prose is matched on the
 * normalized text — equal, or one containing the other — and the containment
 * arm requires the shorter side to be long enough that a coincidence is not
 * plausible. A marker that matches nothing is DROPPED, not recorded as a
 * closure of its own text: the point is to discharge a recorded leftover, and
 * an unmatched claim silently inventing one would suppress a future TODO that
 * happens to be phrased the same way.
 */
export function matchTodoForClosure(
  marker: string,
  open: { id: string; text: string }[],
): { id: string; text: string } | null {
  const raw = (marker || '').trim();
  if (!raw) return null;
  const idToken = raw.match(/^[`'"]?([0-9a-f]{4,16})[`'"]?\b/i)?.[1];
  if (idToken) {
    const byId = open.filter((t) => t.id.startsWith(idToken.toLowerCase()));
    if (byId.length === 1) return byId[0];
  }
  const key = todoClosureKey(raw);
  if (!key) return null;
  const exact = open.find((t) => todoClosureKey(t.text) === key);
  if (exact) return exact;
  const MIN_PROSE = 24;
  const contained = open.filter((t) => {
    const k = todoClosureKey(t.text);
    if (key.length >= MIN_PROSE && k.includes(key)) return true;
    if (k.length >= MIN_PROSE && key.includes(k)) return true;
    return false;
  });
  return contained.length === 1 ? contained[0] : null;
}

/**
 * Record a session's `[Origin: Closes]` claims as PENDING closures.
 *
 * Pending on purpose: at session end the work is in a working tree or on a
 * branch, and neither is an outcome. Nothing is hidden until it lands.
 */
export function recordPendingClosures(opts: {
  repoPath: string;
  sessionId: string;
  markers: string[];
  openTodos: { id: string; text: string }[];
  shas?: string[];
}): number {
  const { repoPath, sessionId, markers, openTodos } = opts;
  if (!markers?.length || !openTodos?.length) return 0;
  const at = new Date().toISOString();
  const closures: TodoClosure[] = [];
  const claimed = new Set<string>();
  for (const marker of markers) {
    const hit = matchTodoForClosure(marker, openTodos);
    if (!hit) {
      debugLog('todo-sweep', 'closes marker matched no open TODO', { sessionId, marker: marker.slice(0, 80) });
      continue;
    }
    const key = todoClosureKey(hit.text);
    if (claimed.has(key)) continue;
    claimed.add(key);
    closures.push({
      key, id: hit.id, text: hit.text,
      reason: marker.slice(0, 300),
      at, state: 'pending', sessionId,
      ...(opts.shas?.length ? { shas: opts.shas.slice(0, 20) } : {}),
    });
  }
  if (closures.length === 0) return 0;
  const n = recordTodoClosures(repoPath, closures);
  if (n > 0) debugLog('todo-sweep', 'recorded pending TODO closures', { sessionId, count: n });
  return n;
}

/**
 * Promote every pending closure whose work has reached the default branch.
 *
 * Cheap when there is nothing to do: one note read, and no git process at all
 * unless something is actually pending. Never throws — a TODO list must not
 * fail because a repo has no remote.
 */
export function sweepTodoClosures(repoPath: string): number {
  try {
    const pending = readTodoClosures(repoPath).filter((c) => c?.state === 'pending');
    if (pending.length === 0) return 0;
    const branchRef = defaultBranchRef(repoPath);
    if (!branchRef) return 0;
    const now = new Date().toISOString();
    const landed = pending
      .slice(0, MAX_PENDING_CHECKED)
      .filter((c) => closingWorkHasLanded(repoPath, branchRef, c))
      .map((c) => ({ ...c, state: 'closed' as const, confirmedAt: now }));
    if (landed.length === 0) return 0;
    const n = recordTodoClosures(repoPath, landed);
    if (n > 0) debugLog('todo-sweep', 'confirmed TODO closures on the default branch', { branchRef, count: n });
    return n;
  } catch {
    return 0;
  }
}
