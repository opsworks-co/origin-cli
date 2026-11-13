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
 *
 * A person may commit that work later, by hand, with the turn long closed. Prod
 * 08705ba (PR #3076): session db727022 wrote a patch in a sibling checkout, and
 * an hour on it was committed from PyCharm. So a closed turn still answers when
 * nothing running does, on evidence: the commit's feature branch is one this
 * checkout was on when the session reached it (or the session's own), and the
 * session touched most of the commit's files. A session that has ended answers
 * through prepare-commit-msg's trailer (pickEndedForeignSessionByFiles).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { debugLog } from './debug-log.js';
import { isInsideRepo, samePath, toRepoRelativePath } from './paths.js';
import { getBranch, getGitCommonDir, getWorkingGitRoot, gitCommonDirFilePath, isSessionAlive } from './session-state.js';
import type { SessionState } from './session-state.js';
import { candidateDirsFromCommand } from './session-worktree.js';
import { fitDiffToBudget } from './diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, commitLineCounts } from './git-capture.js';
import { extractCommitDiff } from './history-backfill.js';
import { localTurnForServerRow, turnIdForServerRow } from './turn-index.js';
import { probeTree, touchedSince } from './shell-command-probe.js';
import type { ProbeDeps } from './shell-command-probe.js';
import { commandWritesFiles } from './shell-write-capture.js';
import type { EndedSessionOwner } from './ended-session-commit-owner.js';

/** Entries kept per session — the newest. */
export const FOREIGN_TREES_MAX = 12;
/** Branches kept per checkout — the newest. */
const BRANCHES_PER_TREE_MAX = 12;
/** Files kept per checkout — the newest. */
const FILES_PER_TREE_MAX = 500;
/** Commands that may be running at once in one checkout. */
const PROBES_PER_TREE_MAX = 4;
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

/** Add what `tree` is on now to the entry. Returns whether it was new. */
function noteTreeBranch(entry: { path: string; branches?: string[] }): boolean {
  const branch = getBranch(entry.path);
  if (!branch || branch === 'HEAD' || entry.branches?.includes(branch)) return false;
  entry.branches = [...(entry.branches || []), branch].slice(-BRANCHES_PER_TREE_MAX);
  return true;
}

/** `~/x` → `<home>/x`, so a command written with a tilde names its directory too. */
function expandTildes(command: string): string {
  const home = os.homedir();
  return command.replace(/(^|[\s=:"'])~(?=\/)/g, (_m, lead: string) => `${lead}${home}`);
}

/** The directories and files a tool call names. */
function pathsThisCallNames(input: { command?: string; filePaths?: string[]; cwd?: string }): string[] {
  const raw: string[] = [];
  if (input.cwd) raw.push(input.cwd);
  if (input.command) raw.push(...candidateDirsFromCommand(expandTildes(input.command)));
  for (const f of input.filePaths || []) {
    const p = f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f;
    if (path.isAbsolute(p)) raw.push(p);
  }
  return raw;
}

/**
 * Fingerprint each recorded checkout a write-shaped command reaches, just before
 * it runs. What changes by the time it returns is what the command did
 * (shell-command-probe.ts). A shell write leaves no file record otherwise: prod
 * session 2419a3eb made 53 Bash calls and 2 Writes in a sibling checkout, and
 * its commit had nothing to match. Never throws.
 */
export function armForeignTreeProbes(
  state: SessionState,
  input: { command?: string; cwd?: string; toolCallId?: string },
  deps: ProbeDeps,
): void {
  try {
    if (!input.command || !commandWritesFiles(input.command)) return;
    const named = pathsThisCallNames(input);
    for (const entry of state.foreignTrees || []) {
      if (!named.some((c) => isInsideRepo(entry.path, c))) continue;
      const before = probeTree(entry.path, deps);
      if (before.skipped) continue;
      entry.probes = [...(entry.probes || []), { toolCallId: input.toolCallId, stamps: before.stamps }].slice(-PROBES_PER_TREE_MAX);
    }
  } catch (err: unknown) {
    debugLog('pre-tool-use', 'foreign tree probe failed (non-fatal)', { message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Close this call's probes: record what it changed in each checkout. Returns
 * those files as absolute paths. Never throws.
 */
export function settleForeignTreeProbes(state: SessionState, toolCallId: string | undefined, deps: ProbeDeps): string[] {
  const changed: string[] = [];
  try {
    for (const entry of state.foreignTrees || []) {
      const mine = (entry.probes || []).find((p) => p.toolCallId === toolCallId);
      if (!mine) continue;
      const rest = (entry.probes || []).filter((p) => p !== mine);
      if (rest.length > 0) entry.probes = rest;
      else delete entry.probes;
      const after = probeTree(entry.path, deps);
      const touched = touchedSince({ tree: entry.path, stamps: mine.stamps }, after);
      if (touched.length === 0) continue;
      const turn = turnOf(state);
      const kept = (entry.files || []).filter((f) => !touched.includes(f.file));
      entry.files = [...kept, ...touched.map((file) => ({ file, turn }))].slice(-FILES_PER_TREE_MAX);
      changed.push(...touched.map((f) => path.join(entry.path, f)));
    }
  } catch (err: unknown) {
    debugLog('post-tool-use', 'foreign tree probe failed (non-fatal)', { message: err instanceof Error ? err.message : String(err) });
  }
  return changed;
}

/**
 * The files a session is recorded writing in `tree`, a checkout of another
 * repository, relative to it: an edit tool's write, kept per turn with the home
 * collapsed to `~`, and what its commands were seen changing. `turn` is local,
 * null for a row from before this launch.
 */
export function filesWrittenInTree(
  state: {
    completedPromptMappings?: Array<{ promptIndex?: number; outOfRepoFiles?: string[] }>;
    foreignTrees?: SessionState['foreignTrees'];
    promptIndexBase?: number | null;
  },
  tree: string,
): Array<{ file: string; turn: number | null }> {
  const out: Array<{ file: string; turn: number | null }> = [];
  for (const m of state.completedPromptMappings || []) {
    for (const stored of m.outOfRepoFiles || []) {
      const f = stored === '~' || stored.startsWith('~/') ? path.join(os.homedir(), stored.slice(1)) : stored;
      if (!path.isAbsolute(f) || !isInsideRepo(tree, f)) continue;
      const turn = Number.isInteger(m.promptIndex) ? localTurnForServerRow(m.promptIndex as number, state.promptIndexBase) : null;
      out.push({ file: toRepoRelativePath(tree, f), turn });
    }
  }
  for (const entry of state.foreignTrees || []) {
    if (samePath(entry.path, tree)) out.push(...(entry.files || []));
  }
  return out;
}

/** main and master are on every clone, so sharing one says nothing. */
function isSharedBranch(branch: string): boolean {
  return /^(main|master)$/.test(branch);
}

/**
 * The ended session from another repository whose recorded writes in `tree` are
 * most of this commit, on a feature branch it saw that checkout on — or null when
 * none is, or two tie. The trailer names one session for the whole commit, so it
 * must hold more than half of the files. Prod fa5c0f8b: session 2419a3eb wrote them
 * in a sibling checkout, ended, and a person committed them two hours later.
 */
export function pickEndedForeignSessionByFiles(
  candidates: SessionState[],
  tree: string,
  branch: string | null,
  commitFiles: string[],
): EndedSessionOwner | null {
  if (!branch || isSharedBranch(branch) || commitFiles.length === 0) return null;
  const wanted = new Set(commitFiles);
  const scored: EndedSessionOwner[] = [];
  for (const state of candidates) {
    if (!(state.foreignTrees || []).some((e) => samePath(e.path, tree) && e.branches?.includes(branch))) continue;
    const hits = filesWrittenInTree(state, tree).filter((w) => wanted.has(w.file));
    const files = new Set(hits.map((w) => w.file));
    const promptIndexes = [...new Set(hits.map((w) => w.turn).filter((t): t is number => Number.isInteger(t)))].sort((a, b) => a - b);
    if (files.size * 2 > wanted.size && promptIndexes.length > 0) {
      scored.push({ state, promptIndexes, matchedLines: files.size });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.matchedLines - a.matchedLines);
  if (scored.length > 1 && scored[0].matchedLines === scored[1].matchedLines) return null;
  return scored[0];
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
    const raw = pathsThisCallNames(input);
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
      // Inside a tree already recorded: refresh it. One git call, for the branch.
      const known = kept.find((e) => isInsideRepo(e.path, c));
      if (known) {
        if (known.turn !== turn || known.at !== now) { known.turn = turn; known.at = now; changed = true; }
        if (noteTreeBranch(known)) changed = true;
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
      if (existing) { existing.turn = turn; existing.at = now; noteTreeBranch(existing); changed = true; continue; }
      const entry: NonNullable<SessionState['foreignTrees']>[number] = { path: tree, commonDir, at: now, turn };
      noteTreeBranch(entry);
      kept.push(entry);
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
 *
 * With no such session, one whose turn in that checkout has closed answers
 * instead when it saw this checkout on this feature branch, or is on it itself,
 * and `touchedCommitFiles` says it holds most of the commit. A caller that knows no commit files passes
 * nothing: no evidence.
 */
export function findSessionWorkingInForeignTree(
  hookCwd: string,
  nowMs: number = Date.now(),
  touchedCommitFiles?: (state: SessionState) => boolean,
): ForeignSessionLookup {
  const hookTree = getWorkingGitRoot(hookCwd) || hookCwd;
  const hookCommon = getGitCommonDir(hookTree);
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return { outcome: 'none' }; }
  const running: Array<{ state: SessionState; exact: boolean }> = [];
  const closed: Array<{ state: SessionState; exact: boolean }> = [];
  const hookBranch = touchedCommitFiles ? getBranch(hookTree) : null;
  const featureBranch = hookBranch && !isSharedBranch(hookBranch) ? hookBranch : null;
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
    const turnNow = runningTurn(state);
    const atWork = turnNow === match.turn || commitClaimLive(state, nowMs);
    const onThisBranch = !!featureBranch && (state.branch === featureBranch
      || (state.foreignTrees || []).some((e) => samePath(e.path, hookTree) && e.branches?.includes(featureBranch)));
    if (!atWork && !(onThisBranch && touchedCommitFiles?.(state))) {
      passOver(`reached it in turn ${match.turn}; running turn ${turnNow ?? 'none'}`);
      continue;
    }
    Object.defineProperty(state, '__statePath', { value: statePath, enumerable: false });
    (atWork ? running : closed).push({ state, exact: samePath(match.path, hookTree) });
  }
  const found = running.length > 0 ? running : closed;
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
