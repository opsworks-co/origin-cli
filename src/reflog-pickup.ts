/**
 * Attribution for commits Origin's per-commit hooks could not link, read back
 * from what git itself recorded: the worktree's HEAD reflog and SQUASH_MSG.
 *
 * Three shapes lose the link today:
 *
 *  1. `git merge --squash X && git commit` — no post-rewrite pair, no
 *     CHERRY_PICK_HEAD. git states the squashed commits once, in SQUASH_MSG,
 *     and only while prepare-commit-msg runs: `git commit` removes the file
 *     before post-commit starts (measured against git 2.50). So, as for a
 *     cherry-pick (cherry-pick-source.ts), prepare-commit-msg writes them down
 *     keyed by the parent, and post-commit carries their notes.
 *  2. `git reset --soft HEAD~N && git commit` (or a mixed reset and re-add) —
 *     the commits the reset dropped are in the reflog as the entry just before
 *     `reset: moving to …`. When the new commit's TREE is the dropped tip's
 *     tree, the new commit is those commits redone, and their notes carry.
 *  3. Commits the hooks never saw: another git client (an IDE's JGit,
 *     libgit2), `core.hooksPath` pointed elsewhere, `--no-verify` style
 *     wrappers, the upgrade window. Their `commit:` entries are still in the
 *     reflog. An amend carries from the commit it replaced (the reflog names
 *     it exactly), a reset-redo as in 2, and a plain commit is given to a
 *     session only when that session's own turn window proves it: for every
 *     file the commit changed, the turn window's START shadow holds the
 *     parent's content, its END shadow holds the commit's content, and the
 *     session's own edit ledger wrote the file. Exactly one session must
 *     match; anything else stays unattributed.
 *
 * Evidence only, as everywhere else that moves attribution between commits:
 * nothing is matched by subject, patch-id or path set alone, and a git read
 * that fails means "no", never a guess. Every git call is time-boxed and the
 * unseen-commit scan has a total budget, because it runs inside hooks.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { reflogSubjectThatCreated } from './commit-replay.js';
import { debugLog } from './debug-log.js';
import { preserveAttributionBatch, type RewriteBatchResult } from './history-preservation.js';
import { samePath } from './paths.js';
import { turnClosedByStop, turnWindowEndShadow } from './restored-from-history.js';
import type { SessionState } from './session-state.js';

const READ = { encoding: 'utf-8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** HEAD reflog entries read per scan — newest first. */
const REFLOG_WINDOW = 200;
/** A reset that dropped more commits than this is not carried. */
const MAX_DROPPED = 100;
/** Squash sources kept from one SQUASH_MSG. */
const MAX_SQUASHED = 200;
/** A commit changing more files than this is not matched to a turn. */
const MAX_FILES = 200;
/** Unseen commits looked at per scan, and how far back. */
const MAX_UNSEEN = 20;
const UNSEEN_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * An unseen commit younger than this is left for the next scan: its own
 * post-commit is backgrounded and may still be starting.
 */
const SETTLE_MS = 60 * 1000;
/** The capture e2e cannot wait a minute between two commits. */
function settleMs(): number {
  const raw = Number(process.env.ORIGIN_REFLOG_PICKUP_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SETTLE_MS;
}
/** Turns of one session compared per commit, newest first. */
const MAX_TURNS = 30;
const SEEN_FILE = 'origin-reflog-seen';
const SEEN_KEEP = 1_000;
const SQUASH_DIR = 'origin-squash-sources';
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { ...READ, cwd }).trim();
  } catch {
    return null;
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { ...READ, cwd });
    return true;
  } catch {
    return false;
  }
}

function gitDirOf(cwd: string): string | null {
  const dir = gitOut(cwd, ['rev-parse', '--git-dir']);
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

function fullCommit(cwd: string, rev: string): string | null {
  const out = (gitOut(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) || '').toLowerCase();
  return FULL_SHA.test(out) ? out : null;
}

/** The commit's parents, or null when git could not say. */
function parentsOf(cwd: string, sha: string): string[] | null {
  const out = gitOut(cwd, ['rev-list', '--parents', '-n1', sha, '--']);
  if (!out) return null;
  const [self, ...parents] = out.split(/\s+/).map((s) => s.toLowerCase());
  return self && FULL_SHA.test(self) ? parents.filter((p) => FULL_SHA.test(p)) : null;
}

// ─── The HEAD reflog ───────────────────────────────────────────────────────

export interface ReflogEntry {
  /** The commit HEAD pointed at after this entry. */
  sha: string;
  /** git's subject for the entry: `commit: …`, `reset: moving to …`, … */
  subject: string;
  /** Epoch seconds. */
  at: number;
}

/** This worktree's HEAD reflog, newest first; null when it could not be read. */
export function readHeadReflog(cwd: string, limit = REFLOG_WINDOW): ReflogEntry[] | null {
  const out = gitOut(cwd, ['reflog', 'show', `-n${limit}`, '--date=unix', '--format=%H%x00%gd%x00%gs', 'HEAD', '--']);
  if (out === null) return null;
  const entries: ReflogEntry[] = [];
  for (const line of out.split('\n')) {
    const [sha, selector, subject] = line.split('\0');
    const at = Number((/@\{(\d+)\}$/.exec(selector || '') || [])[1]);
    if (!sha || !FULL_SHA.test(sha.toLowerCase()) || subject === undefined) continue;
    entries.push({ sha: sha.toLowerCase(), subject, at: Number.isFinite(at) ? at : 0 });
  }
  return entries;
}

/** Index of the OLDEST entry for `sha` — the one that created it — or -1. */
function creatingEntry(entries: ReadonlyArray<ReflogEntry>, sha: string): number {
  const want = sha.toLowerCase();
  let idx = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i].sha === want) idx = i;
  return idx;
}

const PLAIN_COMMIT = /^commit: /;
const AMEND_COMMIT = /^commit \(amend\): /;

/**
 * The tip a reset dropped right before `commit` was made on `parent`, or null.
 *
 * The reflog must read, newest first: the `commit:` entry that created
 * `commit`; then entries that all leave HEAD at `parent`, one of which is a
 * `reset:` whose own previous HEAD (the next older entry) was elsewhere. That
 * previous HEAD is the dropped tip. No-op entries at `parent` in between (a
 * `git stash`'s `reset: moving to HEAD`) are stepped over; anything that moved
 * HEAD elsewhere ends the search.
 */
export function resetRedoDroppedTip(entries: ReadonlyArray<ReflogEntry>, commit: string, parent: string): string | null {
  const idx = creatingEntry(entries, commit);
  if (idx < 0 || !PLAIN_COMMIT.test(entries[idx].subject)) return null;
  const p = parent.toLowerCase();
  for (let j = idx + 1; j < entries.length && entries[j].sha === p; j++) {
    const before = entries[j + 1];
    if (/^reset: /.test(entries[j].subject) && before && before.sha !== p) return before.sha;
  }
  return null;
}

/** The commit an amend replaced: the HEAD just before the `commit (amend):` entry that created `commit`. */
export function amendedAway(entries: ReadonlyArray<ReflogEntry>, commit: string): string | null {
  const idx = creatingEntry(entries, commit);
  if (idx < 0 || !AMEND_COMMIT.test(entries[idx].subject)) return null;
  const before = entries[idx + 1];
  return before && before.sha !== commit.toLowerCase() ? before.sha : null;
}

// ─── 2. reset, then commit again ───────────────────────────────────────────

/**
 * The commits `commit` redoes after a reset, oldest first, or null. Proved by
 * git alone: the reflog says which tip the reset dropped, the dropped tip's
 * tree is exactly `commit`'s tree, and the dropped range sits on `commit`'s
 * parent.
 */
export function resetRedoSources(cwd: string, commit: string, entries?: ReadonlyArray<ReflogEntry> | null): string[] | null {
  const c = (commit || '').toLowerCase();
  if (!FULL_SHA.test(c)) return null;
  const parents = parentsOf(cwd, c);
  if (!parents || parents.length !== 1) return null;
  const [parent] = parents;
  const log = entries ?? readHeadReflog(cwd);
  if (!log) return null;
  const dropped = resetRedoDroppedTip(log, c, parent);
  if (!dropped || dropped === c) return null;
  const trees = gitOut(cwd, ['rev-parse', `${c}^{tree}`, `${dropped}^{tree}`]);
  const [treeC, treeD] = (trees || '').split('\n');
  if (!treeC || treeC !== treeD) return null;
  // The reset went BACK from the dropped tip to the parent — not sideways to
  // an unrelated history, and not forward.
  if (!gitOk(cwd, ['merge-base', '--is-ancestor', parent, dropped])) return null;
  if (gitOk(cwd, ['merge-base', '--is-ancestor', dropped, c])) return null;
  const range = gitOut(cwd, ['rev-list', '--reverse', `--max-count=${MAX_DROPPED + 1}`, dropped, `^${parent}`, '--']);
  const sources = (range || '').split('\n').map((s) => s.trim().toLowerCase()).filter((s) => FULL_SHA.test(s));
  if (sources.length === 0 || sources.length > MAX_DROPPED) return null;
  return sources;
}

/**
 * post-commit: when `commitSha` redoes commits a reset dropped, carry their
 * attribution to it (the commit's own note kept). Never throws.
 */
export function carryResetRedoAttribution(hookCwd: string, commitSha: string, entries?: ReadonlyArray<ReflogEntry> | null): RewriteBatchResult | null {
  try {
    const sources = resetRedoSources(hookCwd, commitSha, entries);
    if (!sources) return null;
    const result = preserveAttributionBatch(hookCwd, sources.map((oldSha) => ({ oldSha, newSha: commitSha })));
    debugLog('reflog-pickup', 'reset-redo attribution carried', {
      commit: commitSha.slice(0, 12), dropped: sources.map((s) => s.slice(0, 12)),
      written: result.written, unchanged: result.unchanged, skipped: result.skipped, failed: result.failed,
    });
    return result;
  } catch {
    return null;
  }
}

// ─── 1. git merge --squash ─────────────────────────────────────────────────

/** The commits a SQUASH_MSG lists — git writes each as an unindented `commit <sha>` line. */
export function parseSquashMsg(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^commit ([0-9a-f]{40}|[0-9a-f]{64})$/gm)) {
    const sha = m[1].toLowerCase();
    if (!out.includes(sha)) out.push(sha);
    if (out.length >= MAX_SQUASHED) break;
  }
  return out;
}

/**
 * prepare-commit-msg: remember the commits a pending `git merge --squash`
 * squashed, for the commit about to be made on HEAD; clear a stale marker when
 * this commit is not a squash. Never throws; returns what it recorded.
 */
export function rememberSquashSources(hookCwd: string): string[] | null {
  try {
    const gitDir = gitDirOf(hookCwd);
    if (!gitDir) return null;
    const dir = path.join(gitDir, SQUASH_DIR);
    const squashMsg = path.join(gitDir, 'SQUASH_MSG');
    const squashing = fs.existsSync(squashMsg);
    // The common case — no squash pending and no marker — costs no more git calls.
    if (!squashing && !fs.existsSync(dir)) return null;
    const head = fullCommit(hookCwd, 'HEAD');
    if (!head) return null;
    const file = path.join(dir, head);
    if (!squashing) {
      try { fs.unlinkSync(file); } catch { /* none */ }
      pruneMarkers(dir);
      removeIfEmpty(dir);
      return null;
    }
    const sources = parseSquashMsg(fs.readFileSync(squashMsg, 'utf-8')).filter((s) => s !== head);
    if (sources.length === 0) return null;
    const body = JSON.stringify({ sources, at: new Date().toISOString() });
    for (let attempt = 0; ; attempt++) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.writeFileSync(file, body);
        break;
      } catch (err: any) {
        if (err?.code !== 'ENOENT' || attempt >= 2) throw err;
      }
    }
    pruneMarkers(dir);
    return sources;
  } catch {
    return null;
  }
}

/**
 * post-commit: the commits `commitSha` squashed when a `git merge --squash`
 * made it, consumed; null for every other commit. The reflog must say a plain
 * `commit:` created it on the marker's parent, and every source must be a
 * commit the parent does not already contain.
 */
export function takeSquashSources(hookCwd: string, commitSha: string): string[] | null {
  try {
    const commit = (commitSha || '').toLowerCase();
    if (!FULL_SHA.test(commit)) return null;
    const gitDir = gitDirOf(hookCwd);
    if (!gitDir) return null;
    const dir = path.join(gitDir, SQUASH_DIR);
    if (!fs.existsSync(dir)) return null;
    const parents = parentsOf(hookCwd, commit);
    if (!parents || parents.length !== 1) return null;
    const file = path.join(dir, parents[0]);
    let marker: { sources?: unknown };
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
    const subject = reflogSubjectThatCreated(hookCwd, commit) || '';
    if (!PLAIN_COMMIT.test(subject)) return null;
    try { fs.unlinkSync(file); } catch { /* another hook took it */ }
    pruneMarkers(dir);
    removeIfEmpty(dir);
    const out: string[] = [];
    for (const raw of Array.isArray(marker.sources) ? marker.sources : []) {
      if (typeof raw !== 'string') continue;
      const sha = fullCommit(hookCwd, raw);
      if (!sha || sha === commit || out.includes(sha)) continue;
      if (gitOk(hookCwd, ['merge-base', '--is-ancestor', sha, parents[0]])) continue;
      out.push(sha);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * post-commit: when a local `git merge --squash` made `commitSha`, carry the
 * squashed commits' attribution to it — one rebuild for all of them, as for a
 * forge squash. Never throws.
 */
export function carryLocalSquashAttribution(hookCwd: string, commitSha: string): RewriteBatchResult | null {
  const sources = takeSquashSources(hookCwd, commitSha);
  if (!sources) return null;
  try {
    const result = preserveAttributionBatch(hookCwd, sources.map((oldSha) => ({ oldSha, newSha: commitSha })));
    debugLog('reflog-pickup', 'local squash attribution carried', {
      commit: commitSha.slice(0, 12), squashed: sources.length,
      written: result.written, unchanged: result.unchanged, skipped: result.skipped, failed: result.failed,
    });
    return result;
  } catch {
    return null;
  }
}

function removeIfEmpty(dir: string): void {
  try { fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
}

function pruneMarkers(dir: string): void {
  try {
    const cutoff = Date.now() - MARKER_MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* gone */ }
    }
  } catch { /* best-effort */ }
}

// ─── 3. commits the hooks never saw ────────────────────────────────────────

function seenFile(cwd: string): string | null {
  const gitDir = gitDirOf(cwd);
  return gitDir ? path.join(gitDir, SEEN_FILE) : null;
}

function readSeen(file: string): Set<string> | null {
  try {
    return new Set(fs.readFileSync(file, 'utf-8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean));
  } catch {
    return null;
  }
}

function appendSeen(file: string, shas: ReadonlyArray<string>): void {
  if (shas.length === 0) return;
  try {
    fs.appendFileSync(file, shas.map((s) => `${s.toLowerCase()}\n`).join(''));
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > SEEN_KEEP * 2) fs.writeFileSync(file, `${lines.slice(-SEEN_KEEP).join('\n')}\n`);
  } catch { /* best-effort: a commit not marked is only looked at again */ }
}

/**
 * post-commit, first thing: this commit's hook ran. The unseen-commit scan
 * leaves it to the hook, which may have decided on purpose to write no note.
 */
export function markCommitSeen(hookCwd: string, commitSha: string): void {
  const sha = (commitSha || '').toLowerCase();
  if (!FULL_SHA.test(sha)) return;
  const file = seenFile(hookCwd);
  // Only the scan creates the file: its first run seeds every commit already
  // in the reflog, this one included. Created here, that seed would be skipped
  // and the last day's commits would all read as unseen.
  if (file && fs.existsSync(file)) appendSeen(file, [sha]);
}

function hasOriginNote(cwd: string, sha: string): boolean | null {
  try {
    execFileSync('git', ['notes', '--ref=origin', 'list', sha], { ...READ, cwd });
    return true;
  } catch (err: any) {
    // `git notes list <sha>` exits 1 with "no note found"; anything else is unreadable.
    return err?.status === 1 ? false : null;
  }
}

/** path → blob id at `rev` for `files`; a file absent at `rev` is absent from the map. */
function blobsAt(cwd: string, rev: string, files: ReadonlyArray<string>): Map<string, string> | null {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...files], { ...READ, cwd });
    const map = new Map<string, string>();
    for (const rec of out.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [, , blob] = rec.slice(0, tab).split(' ');
      map.set(rec.slice(tab + 1), blob);
    }
    return map;
  } catch {
    return null;
  }
}

function sameBlobs(files: ReadonlyArray<string>, a: Map<string, string>, b: Map<string, string>): boolean {
  return files.every((f) => a.get(f) === b.get(f));
}

/** Where LOCAL turn `i` ended: the next turn's start or its own Stop's tree; undefined while open. */
function turnEndShadow(state: SessionState, i: number): string | undefined {
  const end = turnWindowEndShadow(state, i)?.shadowSha;
  if (end) return end;
  if (!turnClosedByStop(state, i)) return undefined;
  return (state.turnEndShadows || []).find((s) => s.promptIndex === i)?.shadowSha;
}

/** Files the session's own ledger says it wrote in `tree`, per LOCAL turn. */
function ledgerFilesByTurn(state: SessionState, tree: string): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const entry of state.liveEdits || []) {
    if (!entry || !Number.isInteger(entry.promptIndex)) continue;
    const inTree = entry.tree ? samePath(entry.tree, tree) : samePath(state.repoPath, tree);
    if (!inTree) continue;
    const files = out.get(entry.promptIndex) ?? new Set<string>();
    for (const ed of entry.edits || []) {
      if (ed?.file) files.add(ed.file.replace(/\\/g, '/'));
      if (ed?.oldPath) files.add(ed.oldPath.replace(/\\/g, '/'));
    }
    out.set(entry.promptIndex, files);
  }
  return out;
}

export interface TurnWindowMatch {
  /** LOCAL turn indexes, inclusive: the window's first and last turn. */
  from: number;
  to: number;
}

/**
 * The turns of `state` whose window turns `parent` into `commit`, file by file:
 * the latest turn `to` whose END shadow holds the commit's content for every
 * changed file, then the latest turn `from` ≤ `to` whose START shadow holds the
 * parent's content for every one of them — and the session's own ledger wrote
 * each file in some turn of that window. Null when no window does.
 */
export function matchTurnWindow(
  cwd: string,
  state: SessionState,
  tree: string,
  files: ReadonlyArray<string>,
  atParent: Map<string, string>,
  atCommit: Map<string, string>,
  blobs: (rev: string) => Map<string, string> | null,
): TurnWindowMatch | null {
  const starts = new Map<number, string>();
  const noBaseline = new Set(state.promptsWithoutBaseline || []);
  for (const s of state.promptShadows || []) {
    if (!s?.shadowSha || s.cutAfterTurnStart || noBaseline.has(s.promptIndex)) continue;
    starts.set(s.promptIndex, s.shadowSha);
  }
  const turns = [...starts.keys()].sort((a, b) => b - a).slice(0, MAX_TURNS);
  if (turns.length === 0) return null;
  const ledger = ledgerFilesByTurn(state, tree);
  for (const to of turns) {
    const end = turnEndShadow(state, to);
    const atEnd = end ? blobs(end) : null;
    if (!atEnd || !sameBlobs(files, atEnd, atCommit)) continue;
    for (const from of turns.filter((t) => t <= to)) {
      const atStart = blobs(starts.get(from)!);
      if (!atStart || !sameBlobs(files, atStart, atParent)) continue;
      const wrote = new Set<string>();
      for (const [turn, turnFiles] of ledger) if (turn >= from && turn <= to) for (const f of turnFiles) wrote.add(f);
      if (files.every((f) => wrote.has(f))) return { from, to };
    }
  }
  return null;
}

export interface UnseenCommitEvidence {
  state: SessionState;
  window: TurnWindowMatch;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
}

/**
 * The one live session whose turn window proves `sha` (see matchTurnWindow),
 * or null — no window, two sessions, a merge or root commit, a commit that
 * already names a session in its trailer, or anything git could not read.
 */
export function evidenceForUnseenCommit(cwd: string, sha: string, sessions: ReadonlyArray<SessionState>): UnseenCommitEvidence | null {
  const parents = parentsOf(cwd, sha);
  if (!parents || parents.length !== 1) return null;
  const [parent] = parents;
  // A trailer means prepare-commit-msg ran: the commit is the hooks' to decide.
  const body = gitOut(cwd, ['show', '-s', '--format=%B', sha]);
  if (body === null || /^Origin-Session:/mi.test(body)) return null;
  const tree = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!tree) return null;
  const numstat = gitOut(cwd, ['diff-tree', '--no-commit-id', '-r', '--numstat', '--no-renames', '-z', parent, sha]);
  if (!numstat) return null;
  const files: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const rec of numstat.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    files.push(m[3]);
    linesAdded += m[1] === '-' ? 0 : Number(m[1]);
    linesRemoved += m[2] === '-' ? 0 : Number(m[2]);
  }
  if (files.length === 0 || files.length > MAX_FILES) return null;
  const cache = new Map<string, Map<string, string> | null>();
  const blobs = (rev: string) => {
    if (!cache.has(rev)) cache.set(rev, blobsAt(cwd, rev, files));
    return cache.get(rev)!;
  };
  const atParent = blobs(parent);
  const atCommit = blobs(sha);
  if (!atParent || !atCommit) return null;
  const matches: Array<{ state: SessionState; window: TurnWindowMatch }> = [];
  for (const state of sessions) {
    if (!state?.sessionId || !state.repoPath || !samePath(state.repoPath, tree)) continue;
    const window = matchTurnWindow(cwd, state, tree, files, atParent, atCommit, blobs);
    if (window) matches.push({ state, window });
  }
  if (matches.length !== 1) {
    if (matches.length > 1) {
      debugLog('reflog-pickup', 'unseen commit matches more than one session — left unattributed', {
        sha: sha.slice(0, 12), sessions: matches.map((m) => m.state.sessionId.slice(0, 8)),
      });
    }
    return null;
  }
  return { ...matches[0], files, linesAdded, linesRemoved };
}

/** Write the proving session's note on an unseen commit — commit-level, with the session's own line claims when they prove out. */
async function writeUnseenCommitNote(cwd: string, sha: string, ev: UnseenCommitEvidence): Promise<boolean> {
  const { writeGitNotes } = await import('./git-notes.js');
  const { attributionSourceFromState } = await import('./attribution-note.js');
  const { editCapturesFromLiveLedger, lineClaimsForCommits } = await import('./attribution-line-claims.js');
  const { buildPromptNoteEntries } = await import('./commands/hooks/session-end.js');
  const { isConnectedMode, loadConfig } = await import('./config.js');
  const { state } = ev;
  const connected = isConnectedMode();
  const apiUrl = loadConfig()?.apiUrl || 'https://getorigin.io';
  const prompts = state.prompts || [];
  writeGitNotes(cwd, [sha], {
    sessionId: state.sessionId,
    model: state.model || 'unknown',
    agentSlug: state.agentSlug,
    promptCount: prompts.length,
    promptSummary: prompts[ev.window.to] || prompts[prompts.length - 1] || '',
    fullPrompt: prompts[ev.window.to] || undefined,
    previousSessionId: state.previousSessionId,
    filesRead: state.filesRead,
    prompts: buildPromptNoteEntries(state, state.agentSlug, state.model),
    originUrl: `${apiUrl}/sessions/${state.sessionId}`,
    linesAdded: ev.linesAdded,
    linesRemoved: ev.linesRemoved,
    filesChanged: ev.files,
    attribution: attributionSourceFromState(state, {
      agentSlug: state.agentSlug, model: state.model, connected, apiUrl,
      lineClaims: lineClaimsForCommits(cwd, state.agentSlug, state, [sha], () => editCapturesFromLiveLedger(state)),
    }),
  });
  return hasOriginNote(cwd, sha) === true;
}

export interface UnseenScanResult {
  /** First scan in this worktree: the window was recorded as seen, nothing attributed. */
  seeded?: boolean;
  candidates: number;
  carried: number;
  attributed: number;
}

export interface UnseenScanOptions {
  /** Total time the scan may take; checked between commits. Default 3 s. */
  budgetMs?: number;
  now?: number;
  /** Live sessions to match against; default: the ones the git hooks see in this tree. */
  sessions?: ReadonlyArray<SessionState>;
}

/**
 * Look through this worktree's HEAD reflog for commits no Origin hook saw and
 * attribute the ones git or a turn window proves. Run from post-commit (after
 * the commit's own handling) and from Stop. Never throws.
 *
 * The first scan in a worktree only records what is already there — a commit
 * made before this build existed is not "unseen", its hooks may have run.
 * A commit is marked seen once it has a note or was given one; one with no
 * evidence yet is looked at again until it leaves the 24 h window, because a
 * turn's end shadow can arrive after the commit (an IDE commit mid-turn).
 */
export async function pickUpUnseenCommits(cwd: string, opts: UnseenScanOptions = {}): Promise<UnseenScanResult> {
  const result: UnseenScanResult = { candidates: 0, carried: 0, attributed: 0 };
  try {
    const started = Date.now();
    const budget = opts.budgetMs ?? 3_000;
    const now = opts.now ?? started;
    const file = seenFile(cwd);
    if (!file) return result;
    const entries = readHeadReflog(cwd);
    if (!entries) return result;
    const recent = entries.filter((e) => e.at * 1000 >= now - UNSEEN_WINDOW_MS);
    const commitShas = (pred: (e: ReflogEntry) => boolean) => [...new Set(recent.filter(pred).map((e) => e.sha))];
    const isCommit = (e: ReflogEntry) => PLAIN_COMMIT.test(e.subject) || AMEND_COMMIT.test(e.subject);
    const seen = readSeen(file);
    if (!seen) {
      fs.writeFileSync(file, commitShas(isCommit).map((s) => `${s}\n`).join(''));
      result.seeded = true;
      return result;
    }
    // Oldest first, so an amend's source is settled before the amend.
    const candidates = commitShas((e) => isCommit(e) && !seen.has(e.sha) && e.at * 1000 <= now - settleMs()
      && creatingEntry(entries, e.sha) === entries.indexOf(e)).reverse().slice(0, MAX_UNSEEN);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;
    let sessions = opts.sessions;
    const done: string[] = [];
    for (const sha of candidates) {
      if (Date.now() - started > budget) break;
      const noted = hasOriginNote(cwd, sha);
      if (noted === null) continue;
      if (noted) { done.push(sha); continue; }
      const away = amendedAway(entries, sha);
      if (away) {
        const r = preserveAttributionBatch(cwd, [{ oldSha: away, newSha: sha }]);
        if (r.written > 0) result.carried++;
        // The amend's only possible source is decided: done either way.
        if (r.failed === 0) done.push(sha);
        continue;
      }
      const redo = carryResetRedoAttribution(cwd, sha, entries);
      if (redo && redo.written > 0) { result.carried++; done.push(sha); continue; }
      if (!sessions) {
        const { listSessionsForGitHookUnscoped } = await import('./commands/hooks/post-commit.js');
        sessions = listSessionsForGitHookUnscoped(cwd);
      }
      const ev = evidenceForUnseenCommit(cwd, sha, sessions);
      if (!ev) continue;
      if (await writeUnseenCommitNote(cwd, sha, ev)) {
        result.attributed++;
        done.push(sha);
        debugLog('reflog-pickup', 'unseen commit attributed by its turn window', {
          sha: sha.slice(0, 12), sessionId: ev.state.sessionId.slice(0, 8), turns: `${ev.window.from}..${ev.window.to}`, files: ev.files.length,
        });
      }
    }
    appendSeen(file, done);
  } catch (err: any) {
    debugLog('reflog-pickup', 'unseen-commit scan failed (non-fatal)', { message: err?.message });
  }
  return result;
}
