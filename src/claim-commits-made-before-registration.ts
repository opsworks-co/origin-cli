/**
 * A commit made before Origin managed to register the session is nobody's.
 *
 * `user-prompt-submit` auto-creates a session when SessionStart did not, or
 * when it did and the API was unreachable. Until that moment there is no
 * session state in the tree, so `post-commit` takes the only safe branch it
 * has — "no session state for this commit" — and records nothing. That branch
 * is correct: writing a note for an unknown session put 32 bogus AI-authored
 * rows on prod in one week.
 *
 * What was missing is the other half. When the session finally registers, the
 * commit it made a minute earlier is still sitting there unowned, and nothing
 * goes back for it. Two things then go wrong, and the second is the loud one:
 *
 *   1. the turn that made the commit shows no commit at all;
 *   2. when that commit is later rewritten — a rebase, an amend — the
 *      post-rewrite hook refuses the pair, because `owns()` asks whether this
 *      session holds the OLD sha and it never did. The rewritten copy lands
 *      as a brand-new commit inside whichever turn was running, and that turn
 *      is billed for work it did not do.
 *
 * Session d74b8927 (2026-09-21) is the worked example. Origin's API was
 * unreachable at the first turn, so the session was auto-created 69s after
 * that turn's commit. The rebase two turns later rewrote both commits; git
 * handed over both pairs and only the second was recorded, because only the
 * second commit had ever been owned. The page then showed turn 1 with no
 * commit, and turn 3 holding three commits and +722 lines against the +351 it
 * actually wrote.
 *
 * The claim below is deliberately timid, because the failure mode of being
 * greedy here is stealing another agent's commit and billing a stranger's
 * work — worse than the gap it closes. It only runs on a LATE registration (a
 * session auto-created when the conversation already had turns), it never
 * looks past the first commit it cannot positively account for, and every
 * commit it takes has to be unowned on all four of the independent signals
 * below.
 */

import { execFileSync } from 'child_process';
import { listSessionsForGitHookUnscoped } from './commands/hooks/post-commit.js';
import { LIVE_NOTES_REFS, STAGED_NOTES } from './git-notes.js';

/** One candidate commit, already probed against git and the live sessions. */
export interface CommitClaimCandidate {
  sha: string;
  /** Committer date in epoch ms; null when git could not be read. */
  committedAtMs: number | null;
  /** True when an Origin git note already names a session for this commit. */
  hasOriginNote: boolean;
  /** Session id from the commit's `Origin-Session:` trailer, if any. */
  trailerSessionId: string | null;
  /** True when any OTHER live session in this tree records this sha. */
  ownedByAnotherLiveSession: boolean;
  /**
   * The commit's committer and author emails, lowercased; null when git could
   * not be read.
   *
   * The first signal here that asks "is this OURS?" rather than "has anyone
   * recorded it?". A commit that arrived by `git pull` during the blind window
   * is unrecorded, untrailered and unowned — indistinguishable from the orphan
   * this feature exists for on every other signal — but somebody else
   * committed it, on another machine.
   *
   * BOTH have to be ours, because a rebase or a cherry-pick makes the replayer
   * the committer while preserving the original author. Replaying a teammate's
   * commit during the blind window would otherwise pass the committer check by
   * construction, which is the one case that check exists to catch.
   */
  committerEmail: string | null;
  authorEmail: string | null;
  /**
   * Repo-relative paths the commit touched; null when git could not be read.
   * Checked against what the transcript says this conversation edited.
   */
  touchedFiles: ReadonlyArray<string> | null;
}

export interface CommitClaimInput {
  /**
   * Newest first — a HEAD-first walk, as `git log` hands them over.
   *
   * An ITERABLE, not an array, so the adapter can probe one commit at a time.
   * The walk stops at the first candidate it cannot account for, which is the
   * overwhelmingly common outcome, and probing all twenty up front cost four
   * git processes each for nineteen answers nobody reads — on the
   * prompt-submit hook's critical path.
   */
  candidates: Iterable<CommitClaimCandidate>;
  /**
   * When the agent's conversation began, epoch ms. A commit older than this
   * predates the whole chat and cannot be ours however unowned it looks.
   * `null` disables claiming entirely: with no lower bound the walk would be
   * free to reach back into the repo's history.
   */
  conversationStartedAtMs: number | null;
  /** When the session registered, epoch ms — the upper bound. */
  registeredAtMs: number;
  /**
   * This session's own id, so a commit already trailered to us (a re-register
   * after a crash) is claimable rather than read as a stranger's.
   */
  sessionId?: string;
  /** Hard ceiling on how far back a claim may reach. Default 6h. */
  maxAgeMs?: number;
  /**
   * The repo-relative files this conversation's transcript says it edited,
   * across the turns that ran while Origin was blind.
   *
   * This is the gate that separates "unrecorded" from "ours". Everything else
   * here answers *has Origin already attributed this commit*, and in the blind
   * window that answer is no for our commit and for a stranger's alike. A
   * commit we made is a commit over files we were seen to edit.
   *
   * EMPTY DISABLES CLAIMING. A transcript that records no edits is a
   * conversation with no committable work in it, and with no file evidence
   * every remaining signal is an absence.
   */
  editedFiles: ReadonlyArray<string>;
  /**
   * The emails this machine commits under — in practice the one `user.email`
   * resolves to in this repo. Null or empty disables claiming: it means we
   * could not read who we are, and a claim then rests on nothing. Note that
   * `GIT_COMMITTER_EMAIL` in the agent's environment, or no `user.email` at
   * all, lands here as "unknown" and silently claims nothing.
   */
  localCommitterEmails: ReadonlyArray<string> | null;
}

export const DEFAULT_CLAIM_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Wall-clock budget for the whole walk, inside the prompt-submit hook. */
export const DEFAULT_CLAIM_BUDGET_MS = 2_000;

/** Floor for any one git call's timeout, so a nearly-spent budget still gives
 *  the call a chance to answer instead of killing it on arrival. */
export const MIN_GIT_CALL_TIMEOUT_MS = 250;

/**
 * How long one git call may take: what is LEFT of the walk's budget.
 *
 * A flat per-call timeout bounds the wrong thing. The budget is checked
 * between candidates, so with four 30s calls per candidate one stuck commit
 * could still hold the prompt-submit hook for two minutes — and a hook that
 * overruns loses the user's prompt. Extracted so the arithmetic is testable
 * without spawning a git that hangs.
 */
export function gitCallTimeoutMs(deadlineMs: number, nowMs: number = Date.now()): number {
  return Math.max(MIN_GIT_CALL_TIMEOUT_MS, deadlineMs - nowMs);
}

/**
 * Which of `candidates` this newly-registered session should record as its
 * own, oldest first.
 *
 * The walk STOPS at the first candidate it cannot account for rather than
 * skipping it. A commit that is demonstrably someone else's is a floor:
 * anything below it belongs to whatever produced it, and hopping over it to
 * grab an older unowned commit is how a session ends up owning a stranger's
 * history. Skipping would have made this function greedier in exactly the
 * cases where it is least sure.
 */
export function commitsToClaimOnLateRegistration(input: CommitClaimInput): string[] {
  const { candidates, conversationStartedAtMs, registeredAtMs, sessionId } = input;
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_CLAIM_MAX_AGE_MS;
  // No lower bound, no claim. This is the difference between "the commits
  // this conversation made while we were blind" and "the top of the repo".
  if (conversationStartedAtMs == null) return [];
  // No file evidence, no claim — see `editedFiles`. The time bounds alone are
  // a window, not a proof of authorship, and the window can be hours wide when
  // the transcript reaches back to a resumed conversation.
  const edited = new Set((input.editedFiles || []).map(normalizeRepoPath).filter(Boolean));
  if (edited.size === 0) return [];
  // No identity, no claim. Without knowing who we commit as, "somebody else
  // committed this" is a question we cannot ask.
  const mine = new Set((input.localCommitterEmails || []).map((e) => (e || '').trim().toLowerCase()).filter(Boolean));
  if (mine.size === 0) return [];
  const floor = Math.max(conversationStartedAtMs, registeredAtMs - maxAgeMs);

  const claimed: string[] = [];
  for (const c of candidates) {
    if (!c || !c.sha) break;
    // Unreadable date — cannot be bounded, so cannot be claimed, and we stop:
    // we no longer know where in time the walk is.
    if (c.committedAtMs == null) break;
    if (c.committedAtMs < floor) break;
    // Committed after we registered: not part of the blind window. post-commit
    // owns these itself, so there is nothing to repair and claiming them here
    // would race that hook.
    if (c.committedAtMs > registeredAtMs) break;
    // Already accounted for by any of the independent signals.
    if (c.hasOriginNote) break;
    if (c.ownedByAnotherLiveSession) break;
    if (c.trailerSessionId && c.trailerSessionId !== sessionId) break;
    // Committed by somebody else — a teammate's commit pulled in during the
    // window, or a machine that is not this one. Unreadable is also a stop:
    // an identity we could not check is not an identity that matched.
    if (!c.committerEmail || !mine.has(c.committerEmail)) break;
    // The author too: a rebase or cherry-pick of somebody else's commit makes
    // US the committer and leaves THEM the author.
    if (!c.authorEmail || !mine.has(c.authorEmail)) break;
    // And over files we were seen to edit. Unreadable is a stop for the same
    // reason; so is a commit that touched nothing we know about, which is what
    // a human's own commit in the same window looks like.
    if (!c.touchedFiles || c.touchedFiles.length === 0) break;
    if (!c.touchedFiles.some((f) => edited.has(normalizeRepoPath(f)))) break;
    claimed.push(c.sha);
  }
  return claimed.reverse();
}

/** Repo-relative, slash-separated, no leading `./`. Compared EXACTLY after
 *  this: a suffix or basename match is how a hot file like `index.ts` lets a
 *  stranger's commit look like ours. A path that fails to line up costs us a
 *  claim we could have made, which is the side to err on. */
export function normalizeRepoPath(p: string): string {
  return (p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Everything the probe needs from git and from the other live sessions.
 *  Injected so the walk can be tested without a repo. */
export interface ClaimProbeDeps {
  /** Newest-first shas from HEAD, at most `limit`. */
  listRecentShas: (limit: number) => string[];
  /** Committer date as an ISO string, or null when git could not be read. */
  commitDateIso: (sha: string) => string | null;
  /** True when an Origin git note already names a session for this sha. */
  hasOriginNote: (sha: string) => boolean;
  /** Full commit message, for the `Origin-Session:` trailer. */
  commitBody: (sha: string) => string;
  /** Shas recorded by every OTHER live session in this tree. */
  shasOwnedByOtherLiveSessions: () => ReadonlyArray<string>;
  /** Committer email, or null when git could not be read. */
  committerEmail: (sha: string) => string | null;
  /** Author email, or null when git could not be read. */
  authorEmail: (sha: string) => string | null;
  /** Repo-relative paths the commit touched, or null when git could not be read. */
  filesInCommit: (sha: string) => ReadonlyArray<string> | null;
}

/** Every ref that can hold an Origin attribution note for a commit: the live
 *  one, and the staging refs a fetch lands on before the fold moves them. */
export const ATTRIBUTION_NOTE_REFS = [
  LIVE_NOTES_REFS.attribution,
  STAGED_NOTES.attribution.staging,
].map((r) => r.replace(/^refs\/notes\//, ''));

/** How far back the HEAD walk looks. The claim window is a registration gap
 *  measured in seconds; twenty commits is already far more than it can need,
 *  and every one of them still has to pass the checks above. */
export const CLAIM_WALK_LIMIT = 20;

/**
 * The trailer carries a TRUNCATED id — `Origin-Session: d74b8927-38a | …` —
 * so a plain equality check against a full uuid never matches and every one
 * of our own commits would read as a stranger's. Compare on the prefix, the
 * way post-rewrite's `owns()` does for abbreviated shas.
 */
export function trailerNamesSession(
  body: string,
  /** The session's id, or every id it answers to — its current id and the
   *  `local-` id it ran under before promotion, whose commits name that one. */
  sessionId?: string | ReadonlyArray<string | null | undefined>,
): boolean {
  const named = (body || '').match(/^Origin-Session:\s*([^\s|]+)/mi)?.[1];
  const ids = (typeof sessionId === 'string' ? [sessionId] : (sessionId || []))
    .filter((id): id is string => typeof id === 'string' && !!id);
  if (!named || ids.length === 0) return false;
  const a = named.toLowerCase();
  return ids.some((id) => {
    const b = id.toLowerCase();
    return a === b || b.startsWith(a) || a.startsWith(b);
  });
}

/** Probe the HEAD walk into candidates, ONE COMMIT AT A TIME.
 *
 *  Lazy on purpose: the consumer breaks at the first commit it cannot account
 *  for, so an eager probe paid four git spawns per candidate for answers that
 *  were never read. `stopAtMs` is a wall-clock budget for the whole stream —
 *  past it the stream simply ends, which claims less rather than more. */
export function* streamClaimCandidates(
  deps: ClaimProbeDeps,
  sessionId?: string | ReadonlyArray<string | null | undefined>,
  limit: number = CLAIM_WALK_LIMIT,
  stopAtMs?: number,
  /** Injectable so a test can prove the budget is checked PER CANDIDATE and
   *  not merely once on entry — a check hoisted out of the loop passes any
   *  test whose budget was already spent before the first probe. */
  now: () => number = Date.now,
): Generator<CommitClaimCandidate> {
  const foreign = new Set(
    deps.shasOwnedByOtherLiveSessions().map((s) => (s || '').toLowerCase()).filter(Boolean),
  );
  const ownedByOther = (sha: string) => {
    const s = sha.toLowerCase();
    for (const f of foreign) if (f === s || f.startsWith(s) || s.startsWith(f)) return true;
    return false;
  };
  for (const sha of deps.listRecentShas(limit)) {
    if (stopAtMs != null && now() > stopAtMs) return;
    const iso = deps.commitDateIso(sha);
    const ms = iso ? Date.parse(iso) : NaN;
    const body = deps.commitBody(sha) || '';
    // Only record a trailer id when it is NOT ours: the pure walk treats any
    // foreign trailer as a stop, and ours as claimable.
    const mine = trailerNamesSession(body, sessionId);
    const named = mine ? null : (body.match(/^Origin-Session:\s*([^\s|]+)/mi)?.[1] || null);
    const email = deps.committerEmail(sha);
    const author = deps.authorEmail(sha);
    yield {
      sha,
      committedAtMs: Number.isFinite(ms) ? ms : null,
      hasOriginNote: deps.hasOriginNote(sha),
      trailerSessionId: named,
      ownedByAnotherLiveSession: ownedByOther(sha),
      committerEmail: email ? email.trim().toLowerCase() : null,
      authorEmail: author ? author.trim().toLowerCase() : null,
      touchedFiles: deps.filesInCommit(sha),
    };
  }
}

/** The eager form, for tests and for any caller that wants the whole list. */
export function buildClaimCandidates(
  deps: ClaimProbeDeps,
  sessionId?: string,
  limit: number = CLAIM_WALK_LIMIT,
): CommitClaimCandidate[] {
  return Array.from(streamClaimCandidates(deps, sessionId, limit));
}

/**
 * The git-backed adapter: probe this tree, then apply the walk.
 *
 * Kept beside the pure half rather than inlined at the call site so the hook
 * reads as one call and the decision stays reviewable in one place.
 */
/** One git invocation. `ok: false` means git could not be RUN — not that it
 *  answered "no". Injectable so a test can fail one command and not others,
 *  which is the shape that actually bit this: `log` fine, `notes` timed out. */
export type GitRunner = (args: string[]) => { ok: boolean; out: string };

/**
 * Did git ANSWER, or could it not be run?
 *
 * A clean non-zero exit is an answer: `git notes show` exits 1 when the object
 * has no note, and that is the "no" every probe here depends on. A signal, a
 * timeout or a spawn failure is not an answer — execFileSync leaves `status`
 * null and may set `signal`, and treating that as "no" is what let the walk
 * claim an already-recorded commit under parallel load.
 */
export function gitErrorIsAnAnswer(err: { status?: unknown; signal?: unknown } | null | undefined): boolean {
  return typeof err?.status === 'number' && !err?.signal;
}

export function claimCommitsMadeBeforeRegistration(
  /** The hook's cwd — a LINKED WORKTREE has its own HEAD and its own branch,
   *  so the walk must run here and not at the main checkout's repo root. */
  hookCwd: string,
  state: { startedAt?: string; sessionCommitShas?: string[]; localSessionId?: string },
  sessionId: string,
  /** Repo-relative files the transcript says this conversation edited. Empty
   *  means no claim at all — see `CommitClaimInput.editedFiles`. */
  editedFiles: ReadonlyArray<string> = [],
  gitRunner?: GitRunner,
  /** Wall-clock budget for the whole walk. This runs inside the prompt-submit
   *  hook, which has already spent time on the conversation lock, and a hook
   *  that overruns loses the user's prompt. Past the budget the stream ends
   *  and we claim nothing more. */
  budgetMs: number = DEFAULT_CLAIM_BUDGET_MS,
): string[] {
  const startedMs = state?.startedAt ? Date.parse(state.startedAt) : NaN;
  if (!Number.isFinite(startedMs)) return [];
  if (!editedFiles || editedFiles.length === 0) return [];
  const deadline = Date.now() + budgetMs;

  // `ok` separates "git answered" from "git could not be run". Collapsing the
  // two — returning '' for both — is a fail-OPEN on every probe below: an
  // unreadable note reads as "no note", and the walk then takes a commit that
  // is already recorded. Under a parallel test run or on a loaded machine that
  // is not hypothetical; git calls here are slow enough that this suite raises
  // its own timeout to 30s for exactly that reason.
  const git: GitRunner = gitRunner ?? ((args: string[]) => {
    try {
      // The timeout is what is LEFT of the walk's budget, not a flat 30s. The
      // budget is checked between candidates, so with a flat per-call timeout
      // one stuck candidate could still hold the hook for four times 30s —
      // inside a hook whose overrun loses the user's prompt.
      const remaining = gitCallTimeoutMs(deadline);
      const out = execFileSync('git', args, {
        cwd: hookCwd, encoding: 'utf-8', windowsHide: true, timeout: remaining,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      return { ok: true, out };
    } catch (err: any) {
      // A clean non-zero exit is an ANSWER: `git notes show` exits 1 when the
      // object has no note. A signal, a timeout or a spawn failure is not —
      // those leave `status` null (or set `err.signal`), and the caller has to
      // treat them as "unknown", not as "no".
      return { ok: gitErrorIsAnAnswer(err), out: '' };
    }
  });

  // Peers FIRST, and a failure to read them aborts the whole claim. Treating
  // an unreadable peer list as "nobody else owns anything" is the one wrong
  // answer that takes another session's commit.
  let peerShas: string[];
  try {
    peerShas = [];
    for (const peer of listSessionsForGitHookUnscoped(hookCwd, { failOnReadError: true }) || []) {
      if (!peer || peer.sessionId === sessionId || (state.localSessionId && peer.sessionId === state.localSessionId)) continue;
      for (const sha of peer.sessionCommitShas || []) peerShas.push(sha);
      for (const c of peer.commitTurns || []) if (c?.sha) peerShas.push(c.sha);
    }
  } catch {
    return [];
  }

  const already = new Set((state.sessionCommitShas || []).map((s) => s.toLowerCase()));

  // Who do we commit as? Read once. Unreadable leaves the set empty, and the
  // walk refuses to claim anything on an unknown identity.
  const localEmails: string[] = [];
  const configured = git(['config', '--get', 'user.email']);
  if (configured.ok && configured.out.trim()) localEmails.push(configured.out.trim());

  // ONE `git log -1` per commit carries the date, the committer and the body.
  // Three separate spawns for three fields of the same object was most of this
  // walk's cost.
  //
  // Separated by 0x1f (ASCII unit separator), emitted by git's own `%x1f`, so
  // a body containing newlines cannot be read as the next field. NOT a NUL: a
  // NUL byte inside an argv string terminates it before it reaches git, so
  // `--format=%cI\0%ce\0%B` arrives as `--format=%cI` and the other two fields
  // come back empty — which this walk reads as "unreadable" and refuses on.
  const SEP = '\x1f';
  const metaCache = new Map<string, { date: string | null; email: string | null; author: string | null; body: string | null }>();
  const meta = (sha: string) => {
    const hit = metaCache.get(sha);
    if (hit) return hit;
    const r = git(['log', '-1', '--format=%cI%x1f%ce%x1f%ae%x1f%B', sha]);
    let out: { date: string | null; email: string | null; author: string | null; body: string | null };
    if (!r.ok) {
      out = { date: null, email: null, author: null, body: null };
    } else {
      const [date, email, author, ...rest] = r.out.split(SEP);
      const iso = (date || '').trim();
      out = {
        date: iso && Number.isFinite(Date.parse(iso)) ? iso : null,
        email: (email || '').trim() || null,
        author: (author || '').trim() || null,
        body: rest.join(SEP),
      };
    }
    metaCache.set(sha, out);
    return out;
  };

  const candidates = streamClaimCandidates({
    listRecentShas: (limit) =>
      // `--no-merges`: a merge commit is not something a turn authored, and
      // its `--name-only` output is empty anyway, so it could only ever stop
      // the walk. Dropping it from the list keeps a merge made during the
      // blind window from hiding the orphan underneath it.
      git(['log', `-${limit}`, '--no-merges', '--format=%H']).out
        .split('\n').map((l) => l.trim()).filter(Boolean)
        // A sha we already hold is accounted for — skip it rather than let it
        // stop the walk, since "ours" is the opposite of a foreign floor.
        .filter((sha) => !already.has(sha.toLowerCase())),
    commitDateIso: (sha) => meta(sha).date,
    committerEmail: (sha) => meta(sha).email,
    authorEmail: (sha) => meta(sha).author,
    // Repo-relative paths, so they line up with the transcript's scoped
    // `filesChanged`. Unreadable is null, which the walk treats as a stop —
    // an empty list would read as "touched nothing" and stop too, but null
    // says why.
    filesInCommit: (sha) => {
      // `-c core.quotePath=false`: a non-ASCII path comes back as
      // `"caf\303\251.ts"` otherwise and never matches the transcript's.
      // `--no-relative`: with `diff.relative` set and the hook running in a
      // subdirectory, git prints cwd-relative paths while the transcript's are
      // repo-relative. Both mangle the comparison into a silent decline.
      const r = git(['-c', 'core.quotePath=false', 'show', '--no-renames', '--no-relative', '--format=', '--name-only', sha]);
      if (!r.ok) return null;
      return r.out.split('\n').map((l) => l.trim()).filter(Boolean);
    },
    // Both the live attribution ref AND its staging ref. A note fetched from
    // another machine only reaches the live ref when the fold runs, so a
    // commit someone else already recorded can be sitting in staging right
    // now — reading only the live ref would call it unowned and take it.
    //
    // `git notes show` exits non-zero when there is no note, which `git()`
    // turns into ''. An empty note body and no note are the same answer here.
    hasOriginNote: (sha) => ATTRIBUTION_NOTE_REFS.some((ref) => {
      const r = git(['notes', `--ref=${ref}`, 'show', sha]);
      // Could not ask => answer "it has a note", which stops the walk. Saying
      // "no note" here is how an unowned-looking commit gets taken.
      if (!r.ok) return true;
      return r.out.trim().length > 0;
    }),
    // An unreadable body would drop the trailer and read as untrailered, so an
    // unreadable one claims to name a stranger and stops the walk.
    commitBody: (sha) => {
      const body = meta(sha).body;
      return body == null ? 'Origin-Session: unreadable-commit-body' : body;
    },
    shasOwnedByOtherLiveSessions: () => peerShas,
  }, [sessionId, state.localSessionId], CLAIM_WALK_LIMIT, deadline, Date.now);

  return commitsToClaimOnLateRegistration({
    candidates,
    conversationStartedAtMs: startedMs,
    registeredAtMs: Date.now(),
    sessionId,
    editedFiles,
    localCommitterEmails: localEmails,
  });
}

/**
 * The gate and the bookkeeping, in one call the hook can make.
 *
 * It lives here rather than inline at the call site because the gate IS the
 * safety property — "only on a late attach" — and a property that exists only
 * as an `if` around a call in a 2000-line hook is a property nothing tests.
 *
 * Returns the shas claimed, having already recorded them on `state`.
 */
export function applyLateRegistrationClaim(
  hookCwd: string,
  state: { startedAt?: string; sessionCommitShas?: string[] },
  sessionId: string,
  ctx: {
    /** True when this registration is repairing a conversation that already
     *  had turns. A session whose first prompt is its first prompt has no
     *  blind window to repair, and running the walk there would only be an
     *  opportunity to take something. */
    isLateAttach: boolean;
    /** Repo-relative files the recovered transcript says those turns edited. */
    editedFiles: ReadonlyArray<string>;
    /** Called when the walk is skipped for want of file evidence. */
    onNoEvidence?: () => void;
  },
  claim: typeof claimCommitsMadeBeforeRegistration = claimCommitsMadeBeforeRegistration,
): string[] {
  if (!ctx.isLateAttach) return [];
  // No file evidence, no claim — and say so, because the commonest reason is
  // not "there was nothing to claim". A turn that wrote through the SHELL (a
  // heredoc, `sed -i`, a script) records no `filesChanged` at all: the
  // transcript marks it `wroteViaShell` and the edits are reconstructed later
  // from the git window, which is long after this hook runs. Those turns are
  // out of scope for the claim, and they are silent about it unless this logs.
  if (!ctx.editedFiles || ctx.editedFiles.length === 0) {
    ctx.onNoEvidence?.();
    return [];
  }
  let claimed: string[] = [];
  try {
    claimed = claim(hookCwd, state, sessionId, ctx.editedFiles) || [];
  } catch {
    // Best-effort — the rescue rungs still get their chance.
    return [];
  }
  if (claimed.length === 0) return [];
  state.sessionCommitShas = [...(state.sessionCommitShas || []), ...claimed];
  return claimed;
}
