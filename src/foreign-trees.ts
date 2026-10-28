/**
 * A session that commits in a repository other than the one it started in.
 *
 * Session state lives in the COMMON git dir of the session's own repo. A git
 * hook in another repository reads that repository's .git, finds nothing, and
 * the commit goes out with no trailer, no note and no session update.
 *
 * Prod 2026-10-15: Claude Code session bd2aa0d7 was registered in
 * `rhodecode-new.com/.claude/worktrees/django-website-bugs-9451fc` (GitHub). It
 * ran `cd ~/Documents/new-rhodecode-com-case-studies && … git commit` — a
 * linked worktree of `new-rhodecode-com-prod`, whose remote is a RhodeCode
 * repo — and hooks.log read "no unambiguous active session", "no git note — no
 * session state for this commit", "no active sessions, skipped API update".
 * 0 of that repo's 382 commits had a session.
 *
 * Two halves:
 *   • pre-tool-use records, on the session, every working tree of ANOTHER
 *     repository a tool call reaches, with that repository's common git dir
 *     (`recordForeignTrees`). Saved like any state, so it reaches the
 *     ~/.origin/sessions mirror, which is global.
 *   • the commit hooks, when nothing registered for the committing checkout
 *     answers, read the mirror for a live session that recorded THIS checkout
 *     or a worktree of its repository during the turn still open
 *     (`findSessionWorkingInForeignTree`). Exactly one, or none: two sessions
 *     that both reached the checkout are not guessed between — and that
 *     refusal is reported as `ambiguous`, not as "no session", so the commit
 *     hooks do not fall through to a weaker process-detection guess.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { debugLog } from './debug-log.js';
import { isInsideRepo, samePath } from './paths.js';
import { getGitCommonDir, getWorkingGitRoot, gitCommonDirFilePath, isSessionAlive } from './session-state.js';
import type { SessionState } from './session-state.js';
import { candidateDirsFromCommand } from './session-worktree.js';
import { fitDiffToBudget } from './diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, commitLineCounts } from './git-capture.js';
import { extractCommitDiff } from './history-backfill.js';
import { turnIdForServerRow } from './turn-index.js';

/** Entries kept per session — the newest. */
export const FOREIGN_TREES_MAX = 12;
/** Candidates a single tool call may spend git calls on. */
const CANDIDATES_PER_CALL = 4;
/** A commit claim this old no longer says a commit is running. */
const COMMIT_CLAIM_FRESH_MS = 10 * 60_000;
/** Mirror files untouched this long belong to no live session; not parsed. */
const MIRROR_FRESH_MS = 3 * 60 * 60_000;

/** The turn a tool call belongs to, read and not opened (same rule as the commit claim). */
function turnOf(state: SessionState): number {
  return Number.isInteger(state.activeTurn?.index)
    ? state.activeTurn!.index
    : (Number.isInteger(state.lastClosedTurnIndex) ? (state.lastClosedTurnIndex as number) : -1) + 1;
}

/** Trees the session already lives in: their paths never cost a git call. */
function ownTrees(state: SessionState): string[] {
  const trees = new Set<string>();
  for (const p of [state.repoPath, state.canonicalRepoPath, ...(state.repoPaths || [])]) if (p) trees.add(p);
  for (const w of state.discoveredWorkTrees || []) if (w?.path) trees.add(w.path);
  return [...trees];
}

/** `~/x` → `<home>/x`, so a command written with a tilde names its directory too. */
function expandTildes(command: string): string {
  const home = os.homedir();
  return command.replace(/(^|[\s=:"'])~(?=\/)/g, (_m, lead: string) => `${lead}${home}`);
}

/**
 * Record the working trees of other repositories this tool call reaches.
 * Mutates `state`; returns whether anything changed. Never throws.
 */
export function recordForeignTrees(
  state: SessionState,
  input: { command?: string; filePaths?: string[]; cwd?: string },
): boolean {
  try {
    if (!state.repoPath) return false;
    const raw: string[] = [];
    if (input.cwd) raw.push(input.cwd);
    if (input.command) raw.push(...candidateDirsFromCommand(expandTildes(input.command)));
    for (const f of input.filePaths || []) {
      const p = f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f;
      if (path.isAbsolute(p)) raw.push(p);
    }
    const own = ownTrees(state);
    const kept = state.foreignTrees || [];
    const now = new Date().toISOString();
    const turn = turnOf(state);
    let changed = false;
    let spent = 0;
    let ownCommon: string | null | undefined;
    const seen = new Set<string>();
    for (const c of raw) {
      if (seen.has(c)) continue;
      seen.add(c);
      // Inside the session's own trees: the common case, settled for free.
      if (own.some((t) => isInsideRepo(t, c))) continue;
      // Inside a tree already recorded: refresh it, no git call.
      const known = kept.find((e) => isInsideRepo(e.path, c));
      if (known) {
        if (known.turn !== turn || known.at !== now) { known.turn = turn; known.at = now; changed = true; }
        continue;
      }
      if (spent >= CANDIDATES_PER_CALL) continue;
      spent++;
      // Walk up to a directory that exists: a candidate is as often a file
      // (or one about to be created) as a directory.
      let dir = c;
      for (let hops = 0; hops < 6 && dir && !fs.existsSync(dir); hops++) dir = path.dirname(dir);
      if (!dir || !fs.existsSync(dir)) continue;
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
      const tree = getWorkingGitRoot(dir);
      if (!tree || own.some((t) => samePath(t, tree))) continue;
      const commonDir = getGitCommonDir(tree);
      if (!commonDir) continue;
      // A worktree of the session's own repository is not another repository —
      // discoveredWorkTrees and the worktree rules handle it.
      if (ownCommon === undefined) ownCommon = getGitCommonDir(state.repoPath);
      if (ownCommon && samePath(ownCommon, commonDir)) continue;
      const existing = kept.find((e) => samePath(e.path, tree));
      if (existing) { existing.turn = turn; existing.at = now; changed = true; continue; }
      kept.push({ path: tree, commonDir, at: now, turn });
      changed = true;
      debugLog('pre-tool-use', 'tree of another repository reached', { tree, commonDir, turn });
    }
    if (changed) {
      kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      state.foreignTrees = kept.slice(-FOREIGN_TREES_MAX);
    }
    return changed;
  } catch (err: unknown) {
    debugLog('pre-tool-use', 'foreign tree record failed (non-fatal)', { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * The turn running now, or null between turns. `activeTurn` alone is not it:
 * a turn that has only read (`cd /other && ls`) has not opened one, and its
 * prompt is still running — the same rule post-commit opens a turn by.
 */
function runningTurn(state: SessionState): number | null {
  if (Number.isInteger(state.activeTurn?.index)) return state.activeTurn!.index;
  const lastClosed = Number.isInteger(state.lastClosedTurnIndex) ? (state.lastClosedTurnIndex as number) : -1;
  return (state.prompts?.length ?? 0) - 1 > lastClosed ? lastClosed + 1 : null;
}

/** Is this session's commit claim live right now? */
function commitClaimLive(state: SessionState, nowMs: number): boolean {
  const claim = state.commitCommandInFlight;
  if (!claim || claim.endedAt) return false;
  const at = Date.parse(claim.at || '');
  return Number.isFinite(at) && nowMs - at <= COMMIT_CLAIM_FRESH_MS;
}

/** The repo's own state file for a mirrored session — fresher than the mirror, which always reads RUNNING. */
function authoritativeState(mirrored: SessionState, mirrorPath: string): { state: SessionState; statePath: string } {
  if (mirrored.repoPath && mirrored.sessionTag && fs.existsSync(mirrored.repoPath)) {
    const p = gitCommonDirFilePath(mirrored.repoPath, `origin-session-${mirrored.sessionTag}.json`);
    try {
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionState;
      if (onDisk?.sessionId === mirrored.sessionId) return { state: onDisk, statePath: p };
    } catch { /* gone: the mirror is what is left */ }
  }
  return { state: mirrored, statePath: mirrorPath };
}

/**
 * What the search for a session from another repository found:
 *  - `none`: no live session recorded this checkout during its running turn;
 *  - `unique`: exactly one did (or exactly one recorded THIS working tree);
 *  - `ambiguous`: several did and nothing tells them apart.
 *
 * `none` and `ambiguous` both leave the commit without a session, but they
 * are different answers. After `none` a caller may still look for an agent by
 * other means; after `ambiguous` it must not, because a candidate set exists
 * and was deliberately not guessed between — a lone matching agent process is
 * weaker evidence than that refusal.
 */
export type ForeignSessionLookup =
  | { outcome: 'none' }
  | { outcome: 'unique'; session: SessionState }
  | { outcome: 'ambiguous'; sessionIds: string[] };

/**
 * The live session that worked in `hookCwd`'s checkout from another
 * repository, during the turn that is still open (or with its commit command
 * running). At most one: when two qualify, the one that recorded THIS working
 * tree wins over one that recorded only a sibling worktree; otherwise the
 * outcome is `ambiguous`.
 */
export function findSessionWorkingInForeignTree(hookCwd: string, nowMs: number = Date.now()): ForeignSessionLookup {
  const hookTree = getWorkingGitRoot(hookCwd) || hookCwd;
  const hookCommon = getGitCommonDir(hookTree);
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return { outcome: 'none' }; }
  const found: Array<{ state: SessionState; exact: boolean }> = [];
  const seen = new Set<string>();
  const matchIn = (st: SessionState) => (st.foreignTrees || []).find((e) =>
    samePath(e.path, hookTree) || (!!hookCommon && samePath(e.commonDir, hookCommon)));
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    let mirrored: SessionState;
    try {
      if (nowMs - fs.statSync(file).mtimeMs > MIRROR_FRESH_MS) continue;
      mirrored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { continue; }
    if (!mirrored?.sessionId || seen.has(mirrored.sessionId) || !matchIn(mirrored)) continue;
    seen.add(mirrored.sessionId);
    const { state, statePath } = authoritativeState(mirrored, file);
    const match = matchIn(state);
    const passOver = (why: string) => debugLog('git-hook-sessions', 'session from another repository passed over', {
      hookCwd, session: state.sessionId.slice(0, 12), why,
    });
    if (!match) { passOver('its own state names no tree here'); continue; }
    if (!isSessionAlive(state, statePath)) { passOver('not alive'); continue; }
    // The work in that checkout belongs to the turn running now, or the
    // session's own shell is running a commit. A session that was there an
    // hour ago and has since closed its turn says nothing about this commit.
    const running = runningTurn(state);
    if (running !== match.turn && !commitClaimLive(state, nowMs)) {
      passOver(`reached it in turn ${match.turn}; running turn ${running ?? 'none'}`);
      continue;
    }
    Object.defineProperty(state, '__statePath', { value: statePath, enumerable: false });
    found.push({ state, exact: samePath(match.path, hookTree) });
  }
  if (found.length === 0) return { outcome: 'none' };
  if (found.length === 1) {
    debugLog('git-hook-sessions', 'session from another repository worked in this checkout', {
      hookCwd, session: found[0].state.sessionId.slice(0, 12), home: found[0].state.repoPath,
    });
    return { outcome: 'unique', session: found[0].state };
  }
  const exact = found.filter((f) => f.exact);
  if (exact.length === 1) return { outcome: 'unique', session: exact[0].state };
  const sessionIds = found.map((f) => f.state.sessionId);
  debugLog('git-hook-sessions', 'several sessions from other repositories worked in this checkout — not guessing', {
    hookCwd, sessions: sessionIds.map((id) => id.slice(0, 12)),
  });
  return { outcome: 'ambiguous', sessionIds };
}

/** Does this commit land in a repository other than the session's own? */
export function commitIsInAnotherRepo(state: SessionState, hookCwd: string): boolean {
  if (!state.repoPath) return false;
  const here = getGitCommonDir(hookCwd);
  const home = fs.existsSync(state.repoPath) ? getGitCommonDir(state.repoPath) : null;
  return !!here && !!home && !samePath(here, home);
}

type CrossRepoTurnRow = {
  promptIndex: number;
  filesChanged?: string[];
  diff?: string;
  uncommittedDiff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  commitSha?: string | null;
  chatOnly?: boolean;
  commitPatch?: boolean;
  patchCommits?: string[];
  contentAuthoritative?: boolean;
  contentUnavailableFiles?: string[];
};

/**
 * The turn rows Stop and session end build come from the session's OWN repo,
 * where a commit made in another repository leaves no trace: the committing
 * turn reads as chat-only, `commitSha: null`, and goes out authoritative over
 * the commit post-commit stamped on it. For each such commit, a row with no
 * content of its own carries the commit's patch instead — read in the
 * commit's repository, which is still on disk. A row with content of its own
 * keeps it and only gains the sha when it names none.
 *
 * Mutates the rows; returns how many it filled. Never throws.
 */
export function applyCrossRepoCommits(
  state: Pick<SessionState, 'crossRepoCommits' | 'promptTurnIds' | 'promptIndexBase'>,
  rows: CrossRepoTurnRow[],
  log?: (event: string, data: Record<string, unknown>) => void,
): number {
  const commits = (state.crossRepoCommits || []).filter((c) => c?.turnId && c.sha && c.repoPath);
  if (commits.length === 0) return 0;
  let filled = 0;
  for (const pm of rows || []) {
    if (!pm) continue;
    const turnId = turnIdForServerRow(state, pm.promptIndex);
    if (!turnId) continue;
    // The turn's newest commit there, as post-commit stamped it last.
    const mine = commits.filter((c) => c.turnId === turnId);
    if (mine.length === 0) continue;
    const commit = mine[mine.length - 1];
    const empty = (pm.filesChanged || []).length === 0 && !(pm.diff || '').trim() && !(pm.uncommittedDiff || '').trim();
    if (!empty) {
      if (!pm.commitSha) pm.commitSha = commit.sha;
      continue;
    }
    try {
      if (!fs.existsSync(commit.repoPath)) continue;
      const { diff, filesChanged } = extractCommitDiff(commit.repoPath, commit.sha);
      if (filesChanged.length === 0 && !diff) continue;
      const budget = fitDiffToBudget(diff, MAX_PROMPT_DIFF_LEN);
      const counts = commitLineCounts(commit.repoPath, commit.sha);
      pm.filesChanged = filesChanged;
      pm.diff = budget.diff;
      pm.uncommittedDiff = '';
      if (counts) { pm.linesAdded = counts.added; pm.linesRemoved = counts.removed; }
      pm.commitSha = commit.sha;
      pm.commitPatch = true;
      pm.patchCommits = [commit.sha];
      pm.contentAuthoritative = true;
      delete pm.chatOnly;
      const cut = [...budget.omittedFiles, ...budget.partialFiles];
      if (cut.length > 0) pm.contentUnavailableFiles = [...new Set(cut)];
      filled++;
      log?.('turn carries its commit made in another repository', {
        promptIndex: pm.promptIndex, turnId, commitSha: commit.sha.slice(0, 8), repoPath: commit.repoPath, files: filesChanged.length,
      });
    } catch { /* the row stays as it was */ }
  }
  return filled;
}
