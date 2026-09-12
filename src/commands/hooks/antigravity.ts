// Antigravity (agy): its own event set and payload shape, on a dedicated path.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { agyArgs, estimateAntigravityUsage, parseAntigravityTranscript } from '../../antigravity-transcript.js';
import { api } from '../../api.js';
import { applyLedgerToMappings } from '../../capture-from-ledger.js';
import { isConnectedMode, loadAgentConfig } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { capDiff } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, captureAgyDiff, createShadowCommit, gitIgnoredFiles, readFileAtRev } from '../../git-capture.js';
import { extractCommitDiff } from '../../history-backfill.js';
import { memoryUpdateTrigger, shouldWriteMemoryOnCommit, summarizeFromCommitSubjects, writeCommitMemory, writeSessionMemory } from '../../memory.js';
import { parseMarkersFromTranscriptPath } from '../../origin-markers.js';
import type { OriginMarkers } from '../../origin-markers.js';
import { isInsideRepo as isInsideRepoNormalized, outOfRepoWrites, samePath as samePathNormalized } from '../../paths.js';
import { getBranch, getHeadSha, loadSessionState, saveSessionState } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { synthesizeSessionSummary } from '../../session-summary.js';
import { samePath } from '../../session-worktree.js';
import { estimateCost } from '../../transcript.js';
import { journalPathsForTag, markTurn, readJournalEntries } from '../../write-journal-watch.js';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { agyWatchDonePath, agyWatchLockPath, buildMemoryEntry, deriveAgyRoots, ensureDetachedJournalWatcher, nestedRepoFilesWritten, scheduleMemoryBriefRefresh, scopeAgyDiffToSessionEdits } from '../hooks.js';
import { newCaptureStamp } from '../../capture-stamp.js';


/**
 * Lift `outOfRepoFiles` off the stringified PromptCapture onto the
 * PromptChange wire field. MCP reads `pc.outOfRepoFiles`, not a field
 * buried inside editsJson — without this copy a Cursor canvas write is
 * peeled from edits (so it doesn't become a fake +N diff) and then the
 * explanation never reaches the server.
 */
/**
 * Deletions that are an artifact of `git init`, not of anything being deleted.
 *
 * Files created loose in the work tree are ordinary untracked files — git sees
 * them, and the capture counts them. The moment a `git init` runs in a
 * directory ABOVE them, that directory becomes a submodule boundary and every
 * file under it disappears from the parent's view. The next diff renders that
 * as a deletion of every line.
 *
 * Prod b6f3cc59: turn 2 created five files inside `inventory/` at 17:27:40-45
 * and was correctly captured as +192. Turn 3 ran `git init` in `inventory/`
 * at 17:31:18 — nine seconds before its Stop — and rendered "+0 -192". Nothing
 * moved and nothing was deleted; all five files are still on disk. The turn
 * read as destroying its predecessor's work.
 *
 * A deletion is phantom when the file is STILL THERE and the nested repo that
 * hid it appeared during this turn. Both halves matter: without the
 * still-on-disk check a real `rm` inside a nested repo would be swallowed, and
 * without the window check a turn would stop reporting real deletions under a
 * nested repo that has existed for months.
 */
export function dropPhantomNestedRepoDeletions(
  workRoot: string,
  filesChanged: string[],
  diff: string,
  sinceMs: number,
): { filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number; dropped: string[] } {
  const count = (d: string) => {
    let a = 0; let r = 0;
    for (const l of d.split('\n')) {
      if (l[0] === '+' && !l.startsWith('+++')) a++;
      else if (l[0] === '-' && !l.startsWith('---')) r++;
    }
    return { linesAdded: a, linesRemoved: r };
  };
  const unchanged = () => ({ filesChanged, diff, ...count(diff), dropped: [] as string[] });
  if (!diff.trim() || !workRoot || !Number.isFinite(sinceMs)) return unchanged();

  // The nested repo that hides `file`, if one appeared during this turn.
  const hiddenByFreshNestedRepo = (file: string): boolean => {
    const abs = path.join(workRoot, file);
    try { if (!fs.existsSync(abs)) return false; } catch { return false; }
    // `samePath`/`isInsideRepo`, never raw string identity — see paths.ts and
    // the path-comparison guard. On Windows git answers with forward slashes
    // and node with backslashes, so `===` here is silently always false.
    let dir = path.dirname(abs);
    // Bound EXPLICITLY to paths.ts: hooks.ts has its own `isInsideRepo` and
    // `samePath` here resolves to session-worktree's. Same names, different
    // normalisation — exactly the ambiguity the guard exists to stop.
    while (isInsideRepoNormalized(workRoot, dir) && !samePathNormalized(dir, workRoot)) {
      try {
        const st = fs.statSync(path.join(dir, '.git'));
        // CREATION time decides, and mtime is only the fallback for platforms
        // that do not report birthtime. `birthtime >= since || mtime >= since`
        // was wrong in both directions: an old repo COMMITTED to during the
        // turn has a fresh mtime and would read as new, and on macOS backdating
        // mtime drags birthtime with it. Prefer birthtime when the platform
        // gives a real one; a `git init` sets it to now, and no later commit
        // moves it.
        const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        return born >= sinceMs; // a nested repo, but is it THIS turn's?
      } catch { /* not a repo boundary — keep climbing */ }
      dir = path.dirname(dir);
    }
    return false;
  };

  const dropped: string[] = [];
  const kept = diff.split(/^(?=diff --git )/m).filter((sec) => {
    if (!sec.trim()) return false;
    const m = (sec.split('\n', 1)[0] || '').match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) return true;
    // Only whole-file DELETIONS qualify. A modification under a nested repo is
    // not expressible from the parent anyway, and dropping one would hide real
    // work rather than a phantom.
    const isDeletion = /^deleted file mode /m.test(sec) || /^\+\+\+ \/dev\/null$/m.test(sec);
    if (!isDeletion) return true;
    if (!hiddenByFreshNestedRepo(m[1])) return true;
    dropped.push(m[1]);
    return false;
  });
  if (dropped.length === 0) return unchanged();
  const nextDiff = kept.join('').trim();
  const droppedSet = new Set(dropped);
  return {
    filesChanged: filesChanged.filter((f) => !droppedSet.has(f)),
    diff: nextDiff,
    ...count(nextDiff),
    dropped,
  };
}

/** The tag the Antigravity handler files a conversation under — state file,
 *  minted turn ids and journal all live here. */
export function agySessionTag(conversationId: string): string {
  return `agy-${conversationId.slice(0, 12)}`;
}

/**
 * Open a turn for an Antigravity conversation at its first tool call.
 *
 * agy fires no user-prompt-submit, so the first pre-tool-use of a turn is the
 * earliest boundary available — and it fires BEFORE the tool writes, so a
 * mark here scopes the turn's tool writes exactly. Idempotent: a turn already
 * open keeps its id, so the many pre-tool-use fires inside one turn add one
 * mark, not one per tool. Returns the id in flight.
 */
export function agyOpenTurn(conversationId: string, cache: AgyRulesCache, workRoot: string | undefined): string | undefined {
  if (cache.openTurnId) return cache.openTurnId;
  if (!workRoot) return undefined;
  const paths = ensureDetachedJournalWatcher(agySessionTag(conversationId), workRoot);
  if (!paths) return undefined;
  const turnId = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  markTurn(paths.journalPath, turnId, Date.now());
  debugLog('pre-tool-use', 'antigravity turn opened in the write journal', { turnId, workRoot });
  return turnId;
}

// ── Antigravity (agy) capture ─────────────────────────────────────────────
// agy doesn't fit the SessionStart→prompts→Stop model: it only fires Stop /
// PreToolUse / PostToolUse, and the payload carries a stable `conversationId`,
// `workspacePaths`, and a `transcriptPath` to a full JSONL transcript. So we
// run a self-contained path: ensure a server session (deduped by
// conversationId), parse the transcript for prompts + the real model, estimate
// usage (agy exposes no token counts), and sync. Stop finalizes.
// Per-conversation cache of the server's enforcement rules + budget lock, so
// PreToolUse can decide allow/deny WITHOUT a network round-trip on every tool
// call. Written on each post-tool-use/stop (when we talk to the server anyway).
export function agyRulesCachePath(conversationId: string): string {
  return path.join(os.homedir(), '.origin', 'agy-rules', `${conversationId}.json`);
}

export interface AgyRulesCache {
  enforcementRules?: any[]; budgetBlocked?: boolean; budgetMessage?: string;
  repoPath?: string; transcriptPath?: string; baselineSha?: string;
  // The WORKING git root (for an agy worktree session this is the worktree,
  // not the canonical repo `repoPath` points at). Every git capture operation
  // — baseline shadow, working-tree snapshot, diff, commit detection — must run
  // here or it reads a tree the session never touched. See deriveAgyRoots.
  workRoot?: string;
  // Per-prompt diff baselines: promptBaselines[i] is a shadow of the tree as it
  // was at the START of prompt i, so prompt i's diff = its OWN changes (not the
  // cumulative session diff). `lastSyncShadow` is the rolling end-of-work
  // snapshot used as the next prompt's baseline.
  promptBaselines?: Record<number, string>;
  lastSyncShadow?: string;
  // When this conversation last ran agy's stand-in for session-start (notes
  // sync + rules-file refresh). Presence is the once-per-conversation guard;
  // the timestamp is for debugging a refresh that appears not to have happened.
  contextRefreshedAt?: string;
  // Prompt indices that made uncommitted changes. When a later prompt commits
  // everything at once, the commit swept up ALL of their work, so they all get
  // linked to that commit (the "prompts in this commit" set).
  dirtyPromptIndices?: number[];
  // Last commit SHA this session already ingested to the server. agy ingests
  // detected commits itself (the sandboxed agent often disables the git
  // post-commit hook), and its post-tool-use hook fires many times per turn —
  // this skips re-ingesting the same commit on every fire.
  ingestedCommitSha?: string;
  // Subjects of the commits this session has made, accumulated across fires.
  // The heuristic memory summary is built from these (the commit messages
  // describe the actual work far better than a vague opening prompt).
  commitSubjects?: string[];
  // Per-prompt mappings captured while the API was UNREACHABLE, waiting to be
  // flushed on the next fire that reaches the server.
  //
  // Capture is entirely local (git plumbing against a shadow baseline) but the
  // handler used to `return` the moment startSession threw, so a network blip
  // meant those turns were never captured AND their baseline never advanced —
  // the next reachable turn then diffed against the pre-blip tree and claimed
  // every intervening prompt's work as its own. Observed live: a 15-minute
  // outage across turn 1 left it empty and credited all 103 of its lines to
  // turn 2, which had actually changed one line.
  pendingPromptChanges?: Array<Record<string, any>>;
  // Stable identity per prompt index, minted by the first pre-tool-use of a
  // turn and bound to the index once the transcript names it. The write
  // journal keys a turn's span on this id.
  promptTurnIds?: Record<string, string>;
  // The turn currently in flight: minted at its first pre-tool-use, bound to
  // its prompt index at the next post-tool-use, cleared at Stop. agy fires no
  // prompt-submit, so the first tool call of a turn is the earliest boundary
  // there is — and it lands BEFORE the tool writes, which is what makes the
  // mark exact for tool writes.
  openTurnId?: string;
  // When the REAL hook last stamped a send. The transcript watcher's sync
  // re-sends the same turn from the same baselines and can never see more
  // than the hook did, so its rows carry this time rather than their own:
  // never newer than the hook's, so never able to replace what the hook
  // wrote, still able to fill a row the hook has not sent yet.
  lastHookCapturedAt?: number;
}

export function writeAgyRulesCache(conversationId: string, data: AgyRulesCache): void {
  try {
    const p = agyRulesCachePath(conversationId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch { /* non-fatal */ }
}

export function readAgyRulesCache(conversationId: string): AgyRulesCache | null {
  try { return JSON.parse(fs.readFileSync(agyRulesCachePath(conversationId), 'utf-8')); } catch { return null; }
}

// A conversation's cache used to be deleted on Stop, back when Stop meant the
// agy process had exited. It no longer does (see the stop branch), so the cache
// has to be aged out instead: a conversation untouched for this long is not
// coming back, and its baselines point at shadow commits git has long since
// been free to GC. Cheap enough to run on every Stop — one readdir over a
// directory that holds one small json per conversation.
export const AGY_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function pruneAgyRulesCaches(): void {
  try {
    const dir = path.dirname(agyRulesCachePath('x'));
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > AGY_CACHE_MAX_AGE_MS) fs.rmSync(full, { force: true });
      } catch { /* skip this one */ }
    }
  } catch { /* no dir yet — nothing to prune */ }
}

// Cap on the offline queue so a long outage can't grow the cache file without
// bound. 50 turns is far past any realistic blip; beyond it the OLDEST are
// dropped, since the newest turns are the ones a reviewer is still looking at.
export const MAX_PENDING_PROMPT_CHANGES = 50;

/**
 * Merge freshly-captured per-prompt mappings into the offline pending queue.
 *
 * agy's PostToolUse fires many times within a single turn, so the same
 * promptIndex gets captured repeatedly while the API is unreachable. The LAST
 * capture of a turn is the most complete (it has seen the most edits), so
 * incoming normally wins — except when it is EMPTY and we already hold a real
 * one. Mid-turn the working tree can momentarily match the baseline (the agent
 * reverts a file, then rewrites it), and letting that transient empty capture
 * overwrite a real diff would recreate exactly the gap this queue exists to
 * close.
 *
 * Pure + exported for testing.
 */
export function mergePendingPromptChanges(
  existing: Array<Record<string, any>> | undefined,
  incoming: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const byIndex = new Map<number, Record<string, any>>();
  for (const pc of existing || []) {
    if (pc && typeof pc.promptIndex === 'number') byIndex.set(pc.promptIndex, pc);
  }
  for (const pc of incoming || []) {
    if (!pc || typeof pc.promptIndex !== 'number') continue;
    const prev = byIndex.get(pc.promptIndex);
    const incomingEmpty = !((pc.filesChanged || []).length);
    const prevHasWork = !!prev && !!((prev.filesChanged || []).length);
    if (incomingEmpty && prevHasWork) continue;
    byIndex.set(pc.promptIndex, pc);
  }
  return [...byIndex.values()]
    .sort((a, b) => (a.promptIndex as number) - (b.promptIndex as number))
    .slice(-MAX_PENDING_PROMPT_CHANGES);
}

// agy's Stop event fires only on exit and may carry a minimal payload (no
// conversationId / transcriptPath). To still finalize the session — and capture
// any trailing prompt that triggered no tool call (so PostToolUse never fired) —
// recover the most-recently-active conversation from the on-disk brain dir.
export function discoverLatestAgyConversation(): { conversationId: string; transcriptPath: string } | null {
  // Antigravity's brain dir moved between versions: newer builds write to
  // ~/.gemini/antigravity/brain, older ones to ~/.gemini/antigravity-cli/brain.
  // Scan both, and prefer transcript_full.jsonl but accept transcript.jsonl.
  const brainDirs = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  ];
  let best: { conversationId: string; transcriptPath: string; mtime: number } | null = null;
  for (const brainDir of brainDirs) {
    let cids: string[];
    try { cids = fs.readdirSync(brainDir); } catch { continue; }
    for (const cid of cids) {
      const logs = path.join(brainDir, cid, '.system_generated', 'logs');
      for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const tp = path.join(logs, name);
        let st: fs.Stats;
        try { st = fs.statSync(tp); } catch { continue; }
        if (!best || st.mtimeMs > best.mtime) best = { conversationId: cid, transcriptPath: tp, mtime: st.mtimeMs };
        break; // prefer _full; don't double-count the same conversation
      }
    }
  }
  return best ? { conversationId: best.conversationId, transcriptPath: best.transcriptPath } : null;
}

// agy tool-call args use PascalCase, varying by tool (run_command →
// CommandLine; file tools → TargetFile/FilePath/AbsolutePath/Path). Pull the
// file path (for FILE_RESTRICTION) and the command (for command policies).
export function agyToolPaths(toolCall: any): { filePath: string | null; command: string | null } {
  // agyArgs() strips agy's double-JSON-encoding. Reading toolCall.args raw
  // yields `"\"/abs/path\""`, whose leading quote defeats both path.isAbsolute
  // and the FILE_RESTRICTION glob (which anchors on `$`) — so every policy
  // silently allowed every real agy write.
  const args = agyArgs(toolCall);
  const fileKeys = ['TargetFile', 'FilePath', 'AbsolutePath', 'Path', 'file', 'path', 'file_path'];
  let filePath: string | null = null;
  for (const k of fileKeys) {
    if (typeof args[k] === 'string' && args[k]) { filePath = args[k]; break; }
  }
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : null;
  return { filePath, command };
}

export function agyGlobToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${esc}$`);
}

// Decide allow/deny for an agy PreToolUse against cached rules. Budget lock
// blocks everything; FILE_RESTRICTION blocks edits to matching paths.
export function agyEvaluatePreTool(toolCall: any, cache: { enforcementRules?: any[]; budgetBlocked?: boolean; budgetMessage?: string } | null): { decision: 'allow' | 'deny'; reason?: string } {
  if (!cache) return { decision: 'allow' };
  if (cache.budgetBlocked) {
    return { decision: 'deny', reason: cache.budgetMessage || 'Origin: budget cap reached — session is locked.' };
  }
  const { filePath } = agyToolPaths(toolCall);
  if (filePath) {
    const base = filePath.split('/').pop() || filePath;
    for (const rule of cache.enforcementRules || []) {
      if (rule?.type !== 'FILE_RESTRICTION' || rule?.action !== 'block') continue;
      let cond: any = {};
      try { cond = JSON.parse(rule.condition || '{}'); } catch { /* ignore */ }
      const pattern = cond.path;
      if (typeof pattern !== 'string' || !pattern) continue;
      const re = agyGlobToRegex(pattern);
      if (re.test(filePath) || re.test(base)) {
        return { decision: 'deny', reason: `Origin policy "${rule.policyName || 'file restriction'}" blocks editing ${base} (${pattern}).` };
      }
    }
  }
  return { decision: 'allow' };
}
          // 12h absolute ceiling
export const AGY_WATCH_LOCK_FRESH_MS = 15_000;

export function spawnAgyWatcher(cid: string, repoPath: string, transcriptPath: string): void {
  try {
    if (process.env.ORIGIN_AGY_IS_WATCHER) return;        // never recurse from the watcher's own re-sync
    if (!cid || !transcriptPath) return;
    const lock = agyWatchLockPath(cid);
    try {
      const st = fs.statSync(lock);
      // A live watcher refreshes its lock every poll; a fresh lock means one is
      // already covering this conversation. A stale lock (crashed watcher) is
      // ignored so a new one respawns promptly.
      if (Date.now() - st.mtimeMs < AGY_WATCH_LOCK_FRESH_MS) return;
    } catch { /* no lock → spawn */ }
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, 'hooks', 'antigravity', '__watch'], {
      detached: true,
      stdio: 'ignore',
      // See the heartbeat spawn in session-state.ts — without this a detached
      // console app pops its own terminal window on Windows.
      windowsHide: true,
      env: {
        ...process.env,
        ORIGIN_AGY_IS_WATCHER: '1',
        ORIGIN_AGY_WATCH_CID: cid,
        ORIGIN_AGY_WATCH_REPO: repoPath,
        ORIGIN_AGY_WATCH_TRANSCRIPT: transcriptPath,
      },
    });
    child.unref();
    debugLog('post-tool-use', 'antigravity watcher spawned', { cid });
  } catch (err: any) {
    debugLog('post-tool-use', 'antigravity watcher spawn failed (non-fatal)', { message: err?.message });
  }
}

export function spawnAgyContextRefresh(repoPath: string): void {
  try {
    if (process.env.ORIGIN_AGY_IS_WATCHER) return;   // the watcher must not re-spawn chores
    if (!repoPath) return;
    const bin = process.argv[1];
    if (!bin) return;
    const child = spawn(process.execPath, [bin, 'hooks', 'antigravity', '__refresh-context'], {
      detached: true,
      stdio: 'ignore',
      // Same reason as the watcher spawn: without this a detached console app
      // pops its own terminal window on Windows.
      windowsHide: true,
      env: { ...process.env, ORIGIN_AGY_IS_WATCHER: '1', ORIGIN_AGY_REFRESH_REPO: repoPath },
    });
    child.unref();
    debugLog('pre-tool-use', 'antigravity context refresh spawned', { repoPath });
  } catch (err: any) {
    debugLog('pre-tool-use', 'antigravity context refresh spawn failed (non-fatal)', { message: err?.message });
  }
}

// Write a SessionState file for an agy conversation so the git-hook
// commit-attribution path treats Antigravity as a first-class session. The
// baseline shadow is stored as `sessionStartShadowSha` so staged-file matching
// can credit the session that actually produced the committed files. Always
// RUNNING — agy gives no exit event to end it on (its Stop is a turn boundary),
// so liveness is left to the state file's own mtime.
export function registerAgySessionState(opts: {
  serverSessionId: string;
  conversationId: string;
  repoPath: string;
  // Working tree the turn ran in (the agy worktree, when there is one). The
  // git-hook attribution path matches a commit's cwd against `lastCwd`, so a
  // worktree commit only finds this session if lastCwd is the worktree.
  workRoot?: string;
  model: string;
  baselineSha?: string;
  transcriptPath: string;
  prompts: string[];
  filesChanged: string[];
  // Turn identities by prompt index. The transcript watcher adopts these from
  // the state file (hookMintedTurns), so both producers name one turn the same
  // way and mark one journal with one id.
  promptTurnIds?: string[];
}): void {
  try {
    const tag = agySessionTag(opts.conversationId);
    const journal = journalPathsForTag(tag, opts.workRoot || opts.repoPath);
    const existing = loadSessionState(opts.repoPath, tag);
    const now = new Date().toISOString();
    // Accumulate the set of files this session has touched across syncs, so
    // staged-file matching credits this session for its own commit.
    const touched = new Set<string>(opts.filesChanged);
    for (const pm of (existing?.completedPromptMappings || [])) {
      for (const f of (pm?.filesChanged || [])) if (typeof f === 'string') touched.add(f);
    }
    const state = {
      ...(existing || {}),
      sessionId: opts.serverSessionId,
      agentSessionId: opts.conversationId,
      claudeSessionId: opts.conversationId,
      transcriptPath: opts.transcriptPath,
      model: opts.model,
      agentSlug: 'antigravity',
      repoPath: opts.repoPath,
      lastCwd: opts.workRoot || opts.repoPath,
      sessionTag: tag,
      startedAt: existing?.startedAt || now,
      headShaAtStart: existing?.headShaAtStart ?? null,
      sessionStartShadowSha: opts.baselineSha || existing?.sessionStartShadowSha || null,
      prompts: opts.prompts,
      ...(opts.promptTurnIds && opts.promptTurnIds.some(Boolean) ? { promptTurnIds: opts.promptTurnIds } : {}),
      writeJournalPath: journal.journalPath,
      writeSnapshotDir: journal.snapshotDir,
      // ONE row holding every file the session has touched — an accumulator for
      // staged-file matching, not a per-turn capture (agy's real per-turn rows
      // go straight to the API from the ledger). `fileSetOnly` says so out
      // loud: without it `origin verify-capture`, which reads this field as
      // turn captures, scored every agy session `files_without_content`
      // forever while the capture it was grading was correct.
      completedPromptMappings: touched.size > 0 ? [{ promptIndex: 0, promptText: opts.prompts[0] || '', filesChanged: [...touched], fileSetOnly: true }] : (existing?.completedPromptMappings || []),
      status: 'RUNNING',
    } as unknown as SessionState;
    saveSessionState(state, opts.repoPath, tag);
  } catch (err: any) {
    debugLog('antigravity', 'registerAgySessionState failed (non-fatal)', { message: err?.message });
  }
}

// Detect commits the agy session made since its baseline, so a committed turn
// shows as committed (with the SHA linked) instead of stuck on "uncommitted".
// The baseline shadow's PARENT is the session-start HEAD; a recorded-HEAD
// baseline (clean start) is itself the session-start HEAD.
export function agyDetectSessionCommit(
  repoPath: string,
  baselineSha?: string,
  // Epoch-ms of the session's first prompt. A commit made BEFORE the session
  // existed cannot be its work, whatever the revision walk says. Without this
  // guard a baseline pointing at an older branch tip made `baseline..HEAD`
  // enumerate the whole branch delta, and the newest of those commits — seven
  // weeks old, on another branch — was stamped onto a turn that had only asked
  // a clarifying question (session 5c281376). The root cause was a wrong
  // capture root, fixed separately; this is the backstop that keeps a bad range
  // from inventing authorship.
  notBeforeMs?: number,
): { commitSha?: string; treeClean: boolean } {
  if (!baselineSha || !/^[a-f0-9]{7,40}$/i.test(baselineSha)) return { treeClean: false };
  try {
    let startHead = baselineSha;
    try {
      // Ancestor of HEAD → a real commit (clean start); use as-is.
      execFileSync('git', ['merge-base', '--is-ancestor', baselineSha, 'HEAD'], { windowsHide: true, cwd: repoPath, timeout: 5_000 });
    } catch {
      // Not an ancestor → it's a shadow; the session-start HEAD is its parent.
      try {
        startHead = execFileSync('git', ['rev-parse', `${baselineSha}^`], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
      } catch { return { treeClean: false }; }
    }
    // %ct alongside the sha so the age guard needs no second git call.
    const log = execFileSync('git', ['log', '--format=%H %ct', `${startHead}..HEAD`], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
    let shas = log ? log.split('\n').filter(Boolean) : [];
    if (typeof notBeforeMs === 'number' && Number.isFinite(notBeforeMs)) {
      // Allow a minute of slack: the first prompt's transcript timestamp and
      // the committer clock are different clocks.
      const floor = notBeforeMs - 60_000;
      shas = shas.filter((line) => {
        const ct = Number(line.split(' ')[1]);
        return !Number.isFinite(ct) || ct * 1000 >= floor;
      });
    }
    shas = shas.map((line) => line.split(' ')[0]).filter(Boolean);
    if (!shas.length) return { treeClean: false };
    let treeClean = false;
    try {
      treeClean = execFileSync('git', ['diff', '--name-only', 'HEAD'], { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim() === '';
    } catch { /* leave false */ }
    return { commitSha: shas[0], treeClean };
  } catch { return { treeClean: false }; }
}

// Exported for the offline-capture integration test: the ordering inside this
// function (local capture BEFORE the first network call) is the whole fix, and
// only driving the real handler can catch a regression that moves it back.
export async function handleAntigravity(event: string, input: Record<string, any>): Promise<void> {
  // PreToolUse: agy reads {decision} on stdout. Enforce file-restriction +
  // budget from the locally-cached rule set (no network on the hot path).
  if (event === 'pre-tool-use') {
    const cid = typeof input.conversationId === 'string' ? input.conversationId : '';
    let cache = cid ? readAgyRulesCache(cid) : null;
    // Establish a per-conversation diff baseline BEFORE the first tool mutates
    // the tree (pre-tool-use fires ahead of the tool). Snapshot the current
    // working tree as a shadow commit so later captures show ONLY what agy
    // changed — excluding pre-existing dirt (unrelated edits, stray untracked
    // files). A clean tree yields no shadow, so anchor on HEAD instead. Once
    // per conversation, guarded by baselineSha.
    if (cid && !cache?.baselineSha) {
      // Prefer the git root of the file THIS tool is about to touch over agy's
      // workspacePaths[0] (often a bare project name) so the baseline shadow
      // lands in the same repo the session gets attributed to.
      const wsPath = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
        ? input.workspacePaths[0] : undefined;
      const toolFile = agyToolPaths(input.toolCall).filePath;
      const { repoPath: rp, workRoot: rw } = deriveAgyRoots(toolFile ? [toolFile] : [], wsPath, process.cwd());
      // '' = no repo identity resolved (see deriveAgyRepoPath). Snapshotting the
      // agent's own config dir would pin the baseline to a non-repo, so skip and
      // let a later step, once a real file path appears, set it. Skip the
      // BASELINE only — never the function: agy blocks the tool call unless this
      // hook still writes a decision to stdout below.
      if (rp) {
        // Snapshot the WORKING tree (the worktree agy is about to edit), not
        // the canonical checkout — a baseline taken from the main checkout
        // makes every later diff empty.
        let base: string | null = null;
        try { base = createShadowCommit(rw, `agy-start-${cid.slice(0, 8)}`) || getHeadSha(rw); } catch { /* non-fatal */ }
        if (base) {
          cache = { ...(cache || {}), baselineSha: base, repoPath: rp, workRoot: rw };
          writeAgyRulesCache(cid, cache);
          debugLog('pre-tool-use', 'antigravity baseline set', { cid, base, repoPath: rp, workRoot: rw });
        }
      }
    }
    // Open this turn in the write journal — the earliest boundary agy offers,
    // and ahead of the write this tool is about to make.
    if (cid && cache?.repoPath && !cache.openTurnId) {
      const openTurnId = agyOpenTurn(cid, cache, cache.workRoot || cache.repoPath);
      if (openTurnId) {
        cache = { ...cache, openTurnId };
        writeAgyRulesCache(cid, cache);
      }
    }
    // agy's stand-in for SessionStart. It fires no such event (only PreToolUse,
    // PostToolUse and Stop exist), so every chore the other agents get at launch
    // — fetching remote notes, refreshing the AGENTS.md Origin block — has never
    // run for an agy session. AGENTS.md was only ever rewritten as a SIBLING of
    // some other agent's session-start in the same repo, which means a repo
    // driven only by agy carries whatever block was last committed to it, and a
    // fresh clone whose backgrounded post-checkout fetch was killed keeps its
    // notes stranded in the staging ref with nothing to ever fold them.
    //
    // Detached, not inline: agy blocks the tool call until this hook writes a
    // decision to stdout, and the notes sync alone budgets 6s of network. The
    // refresh lands after this tool call either way — AGENTS.md is read at
    // conversation start, so what it buys is a current block for the NEXT
    // conversation instead of a months-stale one. Once per conversation.
    const refreshRoot = cache?.repoPath;
    if (cid && refreshRoot && !cache?.contextRefreshedAt) {
      cache = { ...(cache || {}), contextRefreshedAt: new Date().toISOString() };
      writeAgyRulesCache(cid, cache);
      spawnAgyContextRefresh(refreshRoot);
    }
    const verdict = agyEvaluatePreTool(input.toolCall, cache);
    if (verdict.decision === 'deny') {
      debugLog('pre-tool-use', 'antigravity DENY', { reason: verdict.reason });
    }
    process.stdout.write(JSON.stringify(verdict) + '\n');
    return;
  }
  if (event !== 'post-tool-use' && event !== 'stop') return;

  let conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
  let transcriptPath = typeof input.transcriptPath === 'string' ? input.transcriptPath : '';
  // On Stop the payload can be thin (agy fires it on exit). Recover the active
  // conversation from disk so the final state — including a trailing prompt that
  // made no tool call — still gets captured.
  if ((!conversationId || !transcriptPath) && event === 'stop') {
    const found = discoverLatestAgyConversation();
    if (found) {
      conversationId = conversationId || found.conversationId;
      transcriptPath = transcriptPath || found.transcriptPath;
      debugLog('stop', 'antigravity: recovered conversation from disk', { conversationId });
    }
  }
  if (!conversationId || !transcriptPath) {
    debugLog(event, 'antigravity: missing conversationId/transcriptPath', {
      hasConversationId: !!conversationId, hasTranscriptPath: !!transcriptPath,
    });
    return;
  }
  const cachedForRepo = readAgyRulesCache(conversationId);
  if (!isConnectedMode()) return;
  const agentConfig = loadAgentConfig();
  if (!agentConfig?.machineId) return;

  let jsonl = '';
  try { jsonl = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return; }
  const parsed = parseAntigravityTranscript(jsonl);
  if (parsed.prompts.length === 0) return; // nothing capturable yet

  // Repo identity comes from the git root of the files agy ACTUALLY touched —
  // NOT agy's workspacePaths[0], which is often a bare project name that no
  // registered repo matches (→ 403 → session stuck local, the "origin-demo-12
  // vs origin-demo-1" bug). Fall back to the workspace path / cached root / cwd
  // only when the transcript carries no absolute file path.
  const wsPath0 = (Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string')
    ? input.workspacePaths[0] : undefined;
  // repoPath = canonical repo (identity: repo naming, session/commit ingest,
  // memory). workRoot = the working tree those edits actually landed in — for
  // agy that is routinely its own linked worktree under
  // ~/.gemini/antigravity/worktrees/. Every `git` below runs in workRoot.
  let { repoPath, workRoot } = deriveAgyRoots(
    parsed.filePaths,
    wsPath0 || cachedForRepo?.workRoot || cachedForRepo?.repoPath,
    typeof input.cwd === 'string' ? input.cwd : process.cwd(),
  );

  // PIN the capture root to wherever the BASELINE was taken.
  //
  // A diff is a baseline plus a tree, and they have to come from the same
  // checkout. agy's workspacePaths[0] does not: across fires of one
  // conversation it flips between the worktree and the main project directory.
  // When a fire resolved to the main checkout while the baseline had been taken
  // in the worktree, the turn diffed the worktree's HEAD against the MAIN
  // checkout's tree and reported the whole delta between two branches as the
  // turn's work — 9 files and a seven-week-old commit on a turn that only asked
  // a clarifying question (session 5c281376, prompt 0).
  //
  // The baseline is the fixed point: it already exists, everything else is
  // derived from it. So once one is recorded, its root wins.
  if (cachedForRepo?.baselineSha && cachedForRepo?.workRoot && !samePath(cachedForRepo.workRoot, workRoot)) {
    debugLog(event, 'antigravity workRoot re-pinned to the baseline root', {
      derived: workRoot, pinned: cachedForRepo.workRoot, wsPath0,
    });
    workRoot = cachedForRepo.workRoot;
    if (cachedForRepo.repoPath) repoPath = cachedForRepo.repoPath;
  }
  debugLog(event, 'antigravity repoPath resolved', { repoPath, workRoot, wsPath0, filesInTranscript: parsed.filePaths.length });
  if (!repoPath) {
    // Nothing but the agent's own config dir was on offer. Capturing against it
    // yields an unregisterable repo and an offline queue that never drains, so
    // wait for a step that names a real file instead.
    debugLog(event, 'antigravity capture skipped — no repo identity resolved', { conversationId });
    return;
  }

  const usage = estimateAntigravityUsage(parsed);
  const model = parsed.model || 'gemini-3-pro';
  // Branch comes from the WORKING tree: a worktree sits on its own branch, and
  // labelling the session with the main checkout's branch is both wrong and the
  // visible tell that capture ran in the wrong directory.
  const branch = getBranch(workRoot) || undefined;
  // Send the git remote too — repos imported from GitHub are registered by
  // REMOTE identity (path = "github.com/owner/repo"), not a filesystem path, so
  // a repoPath-only lookup 404s even though Codex/Claude (which send repoUrl)
  // match fine. Mirror their derivation so agy attributes to the same repo.
  let repoUrl: string | undefined;
  try {
    repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { windowsHide: true, cwd: workRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
  } catch { /* no remote — path-only, as before */ }
  // agy exposes no tokens → estimate cost from the estimated tokens × price so
  // the session shows a sensible (clearly-estimated) cost instead of $0.
  const costUsd = estimateCost(model, usage.inputTokens, usage.outputTokens);

  // ── LOCAL CAPTURE — runs BEFORE any network call ────────────────────────
  //
  // Everything from here to the end of the commit-detection block is pure git
  // plumbing and on-disk bookkeeping. It used to sit AFTER startSession, so a
  // single failed fetch skipped all of it and `return`ed. That lost the turn's
  // diff outright, and — because `lastSyncShadow` never advanced — silently
  // handed the whole outage's work to whichever later turn first reached the
  // server. Capture is local; only the SEND needs the network, so the send is
  // what degrades now (see the pending queue below).

  // Per-prompt diff baseline: prompt i's diff must be ITS OWN changes, not the
  // cumulative session diff — otherwise a read-only prompt (e.g. "what changes
  // did you make") inherits earlier prompts' files. promptBaselines[i] = the
  // tree at prompt i's START (the previous prompt's end snapshot,
  // `lastSyncShadow`); the first prompt anchors on the session baseline.
  const currentIdx = parsed.prompts.length - 1;
  // The watcher must NOT own the per-prompt baseline bookkeeping. It runs
  // concurrently with the real pre/post-tool-use hooks, and a shared
  // read-modify-write of the agy cache races them (lost update → a stale
  // baseline that makes a read-only prompt show the whole cumulative diff).
  // Real hooks fire one-at-a-time, so they alone mutate state; the watcher only
  // READS existing baselines and re-sends to the server.
  const isWatcherSync = !!process.env.ORIGIN_AGY_IS_WATCHER;
  // Every row this fire sends carries this. A real hook stamps NOW; the
  // watcher sync borrows the hook's last stamp (see AgyRulesCache). Neither
  // stamped before, which made both EXEMPT from the server's ordering and
  // able to overwrite any stamped producer's content.
  const agyStamp = isWatcherSync
    ? { ...newCaptureStamp('agyw'), capturedAt: cachedForRepo?.lastHookCapturedAt ?? (Date.now() - 1) }
    : newCaptureStamp('agy');
  // Bind the turn opened at pre-tool-use to the prompt the transcript now
  // names. A turn that reached here with nothing open (its first fire was
  // this post-tool-use, or the cache was lost) is opened now — late, so the
  // mark may miss this tool's write, but every later write in the turn is
  // still scoped exactly. Real hooks only: the watcher sync reads ids, never
  // mints them, for the same reason it never touches the baselines.
  const promptTurnIds: Record<string, string> = { ...(cachedForRepo?.promptTurnIds || {}) };
  if (!promptTurnIds[String(currentIdx)] && !isWatcherSync) {
    const boundElsewhere = Object.values(promptTurnIds).includes(cachedForRepo?.openTurnId || '');
    const openId = (cachedForRepo?.openTurnId && !boundElsewhere)
      ? cachedForRepo.openTurnId
      : agyOpenTurn(conversationId, { ...(cachedForRepo || {}), openTurnId: undefined }, workRoot);
    if (openId) promptTurnIds[String(currentIdx)] = openId;
  }
  const promptTurnIdList: string[] = [];
  for (let i = 0; i <= currentIdx; i++) promptTurnIdList[i] = promptTurnIds[String(i)] || '';
  const promptBaselines: Record<number, string> = { ...(cachedForRepo?.promptBaselines || {}) };
  let promptBaseline = promptBaselines[currentIdx];
  if (!promptBaseline) {
    promptBaseline = cachedForRepo?.lastSyncShadow || cachedForRepo?.baselineSha || '';
    if (promptBaseline && !isWatcherSync) promptBaselines[currentIdx] = promptBaseline;
  }

  // Capture ONLY this prompt's working-tree edits since its baseline. Excludes
  // pre-existing dirt AND earlier prompts' work. With NO baseline we capture
  // nothing (captureAgyDiff returns empty rather than dumping `git diff HEAD`).
  let filesChanged: string[] = [];
  let diff = '';
  let linesAdded = 0;
  let linesRemoved = 0;
  try {
    const cap = captureAgyDiff(workRoot, promptBaseline || null);
    filesChanged = cap.filesChanged;
    diff = capDiff(cap.diff, MAX_PROMPT_DIFF_LEN);
    linesAdded = cap.linesAdded;
    linesRemoved = cap.linesRemoved;
  } catch { /* non-fatal */ }

  // THE LEDGER. Where the journal marked this turn, its answer replaces the
  // shadow diff wholesale — see the precedence rule in capture-from-ledger.ts.
  // Every agy session on record before this read `files_without_content`:
  // the file list came from the transcript and the diff from a shadow the
  // watcher sync could not be trusted to advance. The ledger's files and diff
  // are derived from one text and cannot disagree.
  let ledgerOwned = false;
  try {
    const jp = journalPathsForTag(agySessionTag(conversationId), workRoot);
    const row: Record<string, unknown> & { promptIndex: number } = { promptIndex: currentIdx, filesChanged, diff, linesAdded, linesRemoved };
    const owned = applyLedgerToMappings({
      writeJournalPath: jp.journalPath,
      writeSnapshotDir: jp.snapshotDir,
      promptTurnIds: promptTurnIdList,
      promptShadows: Object.entries(promptBaselines).map(([i, sha]) => ({ promptIndex: Number(i), shadowSha: sha })),
      prePromptSha: cachedForRepo?.baselineSha || null,
    }, [row as any], {
      readEntries: readJournalEntries,
      readAtRev: (sha, file) => readFileAtRev(workRoot, sha, file),
      ignoredFiles: (files) => gitIgnoredFiles(workRoot, files),
      log: (ev, data) => debugLog('ledger', ev, { via: 'antigravity', ...data }),
    });
    if (owned > 0) {
      ledgerOwned = true;
      filesChanged = row.filesChanged as string[];
      diff = row.diff as string;
      linesAdded = row.linesAdded as number;
      linesRemoved = row.linesRemoved as number;
    }
  } catch { /* the ledger is an optimisation; the shadow diff stands */ }

  // Guard against CONCURRENT-AGENT dirt: a file some OTHER agent created in the
  // shared working tree, swept into this turn by a stale watcher baseline. Scope
  // the capture to files THIS conversation actually edited (see the helper).
  {
    const scoped = scopeAgyDiffToSessionEdits(workRoot, filesChanged, diff, linesAdded, linesRemoved, parsed.filesEdited);
    if (scoped.dropped.length > 0) {
      filesChanged = scoped.filesChanged;
      diff = scoped.diff;
      linesAdded = scoped.linesAdded;
      linesRemoved = scoped.linesRemoved;
      debugLog(event, 'antigravity capture: dropped concurrent-agent dirt not edited by this session', { dropped: scoped.dropped, keptFiles: filesChanged.length });
    }
  }

  // A `git init` inside the work tree hides every file beneath it, and the
  // diff renders that as deleting all of them. Those files are still on disk;
  // nothing was deleted. See dropPhantomNestedRepoDeletions.
  {
    const turnStartMs = parsed.promptTimes[currentIdx];
    if (typeof turnStartMs === 'number') {
      const cleaned = dropPhantomNestedRepoDeletions(workRoot, filesChanged, diff, turnStartMs);
      if (cleaned.dropped.length > 0) {
        filesChanged = cleaned.filesChanged;
        diff = cleaned.diff;
        linesAdded = cleaned.linesAdded;
        linesRemoved = cleaned.linesRemoved;
        debugLog(event, 'antigravity capture: dropped phantom deletions from a nested repo created this turn', {
          dropped: cleaned.dropped, linesRemoved,
        });
      }
    }
  }

  // Roll the end-of-work snapshot forward so the NEXT prompt diffs against where
  // this one left off (clean tree → anchor on HEAD). Tag per prompt index so
  // each prompt's end-shadow keeps its own ref alive (a shared tag would move,
  // letting git GC prune a baseline an earlier prompt still points at).
  let lastSyncShadow = cachedForRepo?.lastSyncShadow;
  if (!isWatcherSync) {
    try { lastSyncShadow = createShadowCommit(workRoot, `agy-sync-${conversationId.slice(0, 8)}-${currentIdx}`) || getHeadSha(workRoot) || lastSyncShadow; } catch { /* keep previous */ }
  }

  // Track which prompts have uncommitted work. When a commit happens, every
  // such prompt's work was swept into it, so they all link to the commit.
  const firstPromptMs = parsed.promptTimes.find((t) => typeof t === 'number') ?? undefined;
  const { commitSha, treeClean } = agyDetectSessionCommit(workRoot, promptBaseline || undefined, firstPromptMs ?? undefined);
  const dirty = new Set<number>(cachedForRepo?.dirtyPromptIndices || []);
  if (filesChanged.length > 0) dirty.add(currentIdx);
  let committedIndices: number[] = [];
  if (commitSha) {
    committedIndices = [...new Set([...dirty, currentIdx])];
    dirty.clear();
  }

  // ── END LOCAL CAPTURE — the network starts here ─────────────────────────

  // Merge a patch over the cached entry so a partial write never drops a field
  // we didn't explicitly set (rules/budget survive an offline fire, baselines
  // survive a rules refresh).
  const persistAgyCache = (patch: Partial<AgyRulesCache>): void => {
    if (isWatcherSync) return;
    writeAgyRulesCache(conversationId, {
      ...(cachedForRepo || {}),
      repoPath,
      workRoot,
      transcriptPath,
      baselineSha: cachedForRepo?.baselineSha,
      promptBaselines,
      lastSyncShadow,
      dirtyPromptIndices: [...dirty],
      promptTurnIds,
      lastHookCapturedAt: agyStamp.capturedAt,
      // Stop closes the turn; the next pre-tool-use opens a fresh one.
      openTurnId: event === 'stop' ? undefined : cachedForRepo?.openTurnId,
      ...patch,
    });
  };

  // Persist the local bookkeeping BEFORE the network call. This is the half of
  // the fix that stops the MIS-attribution: with `lastSyncShadow` already on
  // disk, the next turn diffs from where this one ended even if everything
  // below fails, so it can no longer inherit this turn's work.
  persistAgyCache({});

  // Ensure/dedup the server session by conversationId.
  let sessionId: string | undefined;
  let startRes: any;
  try {
    startRes = await api.startSession({
      machineId: agentConfig.machineId,
      prompt: parsed.prompts[0],
      model,
      repoPath,
      repoUrl,
      agentSlug: 'antigravity',
      agentSessionId: conversationId,
      branch,
    } as any);
    sessionId = (startRes as any)?.sessionId;
  } catch (err: any) {
    debugLog(event, 'antigravity startSession failed (non-fatal)', { message: err?.message });
    sessionId = undefined;
  }

  // Register the session state NOW, not at the end of this handler.
  //
  // A git hook can only credit a commit to a session it can FIND, and the only
  // durable record is what registerAgySessionState writes (`.git` plus the
  // ~/.origin/sessions mirror). Writing it after the network payload means a
  // commit made in the NEXT turn — before that turn's Stop — has nothing to
  // attach to.
  //
  // Prod a5c2570c: the agent replaced the worktree's `.git` with a fresh repo,
  // destroying the state file. post-commit fired 7 seconds BEFORE the state was
  // re-created, logged "no active sessions, skipped API update", and the commit
  // was ingested as a brand-new repo row instead of onto the session.
  //
  // Idempotent — it merges over whatever exists — so registering early and
  // again at the end costs one extra write and makes the record exist for the
  // whole window a commit can land in.
  if (sessionId && !isWatcherSync) {
    try {
      registerAgySessionState({
        serverSessionId: sessionId,
        conversationId,
        repoPath,
        workRoot,
        model,
        transcriptPath,
        prompts: parsed.prompts,
        filesChanged,
        promptTurnIds: promptTurnIdList,
      });
    } catch { /* non-fatal: the end-of-handler registration still runs */ }
  }

  if (!sessionId) {
    // Unreachable server (or no session id). Everything below needs one, so
    // queue what we just captured and let a later fire deliver it — this is the
    // half of the fix that stops the DATA LOSS. Without the queue an offline
    // turn's diff would be gone for good: the baseline has already rolled
    // forward, so no future capture can reproduce it.
    if (!isWatcherSync) {
      const ownMapping: Record<string, any> = {
        ...agyStamp,
        promptIndex: currentIdx,
        promptText: parsed.prompts[currentIdx],
        diff,
        uncommittedDiff: (commitSha && treeClean) ? '' : diff,
        filesChanged,
        linesAdded,
        linesRemoved,
        authoritative: true,
        ...(ledgerOwned ? { diffSource: 'ledger' } : {}),
        ...(parsed.promptTimes[currentIdx] != null ? { createdAt: parsed.promptTimes[currentIdx] } : {}),
        ...(commitSha ? { commitSha } : {}),
      };
      const pending = mergePendingPromptChanges(cachedForRepo?.pendingPromptChanges, [ownMapping]);
      persistAgyCache({ pendingPromptChanges: pending });
      debugLog(event, 'antigravity capture queued offline', {
        promptIndex: currentIdx, queued: pending.length, files: filesChanged.length, linesAdded,
      });
    }
    return;
  }

  // Ingest the commit ROW ourselves. Normally the git post-commit hook calls
  // api.ingestCommits, but agy runs sandboxed and the model routinely commits
  // with hooks DISABLED (`git -c core.hooksPath=/dev/null commit`, to dodge the
  // sandbox's .git-write restrictions). Then the post-commit ingest never fires
  // and the commit is 404 server-side — the turn shows "uncommitted" forever
  // even though we linked its SHA. So ingest it here too. Idempotent (server
  // dedups by SHA); guarded by ingestedCommitSha so the many per-turn hook
  // fires don't re-send; fire-and-forget so a slow call never blocks capture.
  let ingestedCommitSha = cachedForRepo?.ingestedCommitSha;
  // Subjects of the session's commits, accumulated across fires — the heuristic
  // memory summary is built from these (see summarizeFromCommitSubjects).
  const commitSubjects: string[] = [...(cachedForRepo?.commitSubjects || [])];
  if (commitSha && !isWatcherSync && commitSha !== ingestedCommitSha && /^[a-fA-F0-9]{7,40}$/.test(commitSha)) {
    try {
      const cOpts = { encoding: 'utf-8' as const, cwd: workRoot, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
      const { diff: cDiff, filesChanged: cFiles } = extractCommitDiff(workRoot, commitSha);
      let cAdd = 0, cDel = 0;
      if (cDiff) for (const l of cDiff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) cAdd++; else if (l.startsWith('-') && !l.startsWith('---')) cDel++; }
      const g = (fmt: string) => { try { return execFileSync('git', ['log', '-1', `--format=${fmt}`, commitSha], cOpts).trim(); } catch { return ''; } };
      const thisSubject = g('%s');
      if (thisSubject && !commitSubjects.includes(thisSubject)) commitSubjects.push(thisSubject);
      void api.ingestCommits({
        repoPath,
        repoUrl,
        commits: [{
          sha: commitSha,
          message: g('%s'),
          author: g('%an'),
          branch: branch || null,
          filesChanged: cFiles,
          additions: cAdd,
          deletions: cDel,
          committedAt: g('%cI') || undefined,
          diff: cDiff ? cDiff.slice(0, 500_000) : undefined,
        }],
      }).then((r: any) => debugLog(event, 'antigravity commit ingested', { commitSha: commitSha.slice(0, 8), ingested: r?.ingested }))
        .catch((e: any) => debugLog(event, 'antigravity commit ingest failed (non-fatal)', { message: e?.message }));
      ingestedCommitSha = commitSha;

      // memoryUpdate=commit/both: agy commits routinely bypass the git
      // post-commit hook (sandbox commits with hooks disabled), so
      // handlePostCommit — where the normal commit-time memory write lives —
      // never fires for them. Write memory HERE, attributed to the agy session
      // itself (correct agentSlug=antigravity + gemini model + the transcript's
      // real prompts), so this work is actually remembered instead of the write
      // being missed (or landing on whatever OTHER session the hook picked).
      // Upsert-by-sessionId collapses the per-turn fires to one latest entry.
      if (shouldWriteMemoryOnCommit(memoryUpdateTrigger())) {
        try {
          const agyState = loadSessionState(repoPath, `agy-${conversationId.slice(0, 12)}`);
          const agyStartedAt = agyState?.startedAt || new Date().toISOString();
          // Accumulate the files this SESSION touched, not just this one commit's.
          // Upsert-by-sessionId would otherwise leave memory showing only the
          // latest commit's file (a 3-file session collapsing to 1). Union this
          // commit (cFiles) + this fire's captured edits + every prior prompt's
          // files recorded on the agy session state.
          const accSet = new Set<string>(cFiles);
          for (const f of (filesChanged || [])) if (typeof f === 'string') accSet.add(f);
          for (const pm of (((agyState as any)?.completedPromptMappings) || [])) for (const f of ((pm?.filesChanged) || [])) if (typeof f === 'string') accSet.add(f);
          const accFiles = accSet.size > 0 ? Array.from(accSet) : cFiles;
          // Summary priority: LLM synthesis (if memorySummary='llm' + key) →
          // the session's COMMIT MESSAGES (deterministic, no key; "Add terminal
          // digital clock script; Add calculator script" beats a vague opening
          // prompt like "do whatever you want") → first prompt → commit subject.
          const commitSummary = summarizeFromCommitSubjects(commitSubjects);
          let agySummary: string | undefined = commitSummary || parsed.prompts[0] || g('%s') || undefined;
          const synth = await synthesizeSessionSummary({ prompts: parsed.prompts, filesChanged: accFiles, linesAdded: cAdd, linesRemoved: cDel, commitSubjects, diff: cDiff });
          if (synth?.summary) agySummary = synth.summary;
          const agyFileNotes = synth?.fileNotes && Object.keys(synth.fileNotes).length > 0 ? synth.fileNotes : undefined;
          // Decisions: explicit [Origin: Decision] markers (ground truth) + LLM-inferred.
          const agyDecisions: string[] = [];
          let agyMarkers: OriginMarkers | undefined;
          try {
            agyMarkers = parseMarkersFromTranscriptPath(transcriptPath);
            for (const d of agyMarkers?.decision || []) if (d && !agyDecisions.includes(d)) agyDecisions.push(d);
          } catch { /* best-effort */ }
          for (const d of (synth?.decisions || [])) if (d && !agyDecisions.includes(d)) agyDecisions.push(d);
          writeSessionMemory(repoPath, buildMemoryEntry(
            { sessionId, startedAt: agyStartedAt, prompts: parsed.prompts, branch: branch || null, agentSlug: 'antigravity' },
            {
              agentSlug: 'antigravity',
              model,
              branch: branch || null,
              filesChanged: accFiles,
              linesAdded: cAdd,
              linesRemoved: cDel,
              summary: agySummary,
              prompts: parsed.prompts,
              fileNotes: agyFileNotes,
              decisions: agyDecisions,
              markers: agyMarkers,
            },
          ));
          debugLog(event, 'antigravity session memory refreshed (memoryUpdate=commit)', { sessionId, commitSha: commitSha.slice(0, 8), files: accFiles.length, synth: !!synth });
          // Antigravity commits with hooks off and rarely reaches a clean
          // session end — refresh the continuation brief here, grounded in this
          // commit's diff, so its brief doesn't go stale.
          scheduleMemoryBriefRefresh(repoPath, isConnectedMode(), event, cDiff);

          // Immutable per-commit record for THIS commit (add-once by SHA), with
          // its own files + per-file notes (filtered to this commit).
          try {
            const commitNotes: Record<string, string> = {};
            for (const f of cFiles) if (agyFileNotes && agyFileNotes[f]) commitNotes[f] = agyFileNotes[f];
            writeCommitMemory(repoPath, {
              commitSha, sessionId, agentSlug: 'antigravity', message: g('%s') || '',
              filesChanged: cFiles, fileNotes: Object.keys(commitNotes).length > 0 ? commitNotes : undefined,
              decisions: agyDecisions.length > 0 ? agyDecisions.slice(0, 6) : undefined,
              linesAdded: cAdd, linesRemoved: cDel, branch: branch || null,
              committedAt: g('%cI') || new Date().toISOString(),
            });
          } catch { /* non-fatal */ }
        } catch (e: any) {
          debugLog(event, 'antigravity session memory refresh error (non-fatal)', { message: e?.message });
        }
      }
    } catch (e: any) {
      debugLog(event, 'antigravity commit ingest error', { message: e?.message });
    }
  }

  // Cache the server's rules + budget lock so PreToolUse can enforce locally,
  // plus the per-prompt baselines (preserve the session baselineSha set on the
  // first pre-tool-use). REAL hooks only — the watcher never writes the cache
  // (see isWatcherSync above), so it can't race/corrupt the baselines.
  // `pendingPromptChanges` is carried through explicitly: this write happens
  // BEFORE the send that flushes the queue, so omitting it here would erase
  // offline captures a moment before they were due to be delivered. It is
  // cleared only after the send lands (clearFlushedPending).
  if (!isWatcherSync) persistAgyCache({
    enforcementRules: Array.isArray(startRes?.enforcementRules) ? startRes.enforcementRules : [],
    budgetBlocked: !!startRes?.budget?.blocked,
    budgetMessage: startRes?.budget?.message,
    ingestedCommitSha,
    commitSubjects,
    pendingPromptChanges: cachedForRepo?.pendingPromptChanges || [],
  });

  // Register the agy session as a local SessionState (with the files it touched)
  // so git-hook commit attribution can SEE it and credit it for its own commit
  // — otherwise agy is invisible to prepare-commit-msg and its commits get
  // stamped with whatever other session is around (the "shown as Cursor" bug).
  // REAL hooks only — it read-modify-writes the state file, so the watcher must
  // not race it.
  //
  // Never ENDED here, on Stop or otherwise: agy fires Stop at every turn
  // boundary, so marking (and archiving) the state there retired a session that
  // was still working. The turn's own commit could then land with no candidate
  // left to own it. The state ages out on its own — isSessionAlive() reads it as
  // dead once the file goes stale, and expireStaleSessionsOnServer() closes it.
  if (!isWatcherSync) registerAgySessionState({
    serverSessionId: sessionId,
    conversationId,
    repoPath,
    workRoot,
    model,
    baselineSha: cachedForRepo?.baselineSha,
    transcriptPath,
    prompts: parsed.prompts,
    filesChanged,
        promptTurnIds: promptTurnIdList,
  });

  // Attach this prompt's OWN diff to its turn (it's the current/last prompt) so
  // the per-turn view renders only what this prompt changed + AI Blame. Mark it
  // `authoritative` so the captured value REPLACES any prior diff for this
  // prompt wholesale — without it the server's "don't overwrite with empty"
  // rule keeps stale data forever (e.g. a read-only prompt that briefly
  // inherited the cumulative diff never clears to "no changes"). Earlier prompts
  // carry text only, so their already-stored (own) diffs are kept.
  // If the agent committed, link the commit to the turn (and every earlier
  // prompt whose uncommitted work it swept up) and — when nothing tracked is
  // left dirty — stop labeling the work "uncommitted", so the per-turn view
  // shows a "committed" badge. Read-only prompts (empty diff) never go dirty,
  // so they're never linked to the commit.
  const uncommittedDiff = (commitSha && treeClean) ? '' : diff;
  const committedSet = new Set(committedIndices);
  // Turns captured while the server was unreachable. We're reachable now, so
  // they ride along on this send and land on their OWN turn — without this the
  // flush never happens and an offline turn stays permanently blank.
  const pendingByIndex = new Map<number, Record<string, any>>();
  for (const pc of (cachedForRepo?.pendingPromptChanges || [])) {
    if (pc && typeof pc.promptIndex === 'number' && pc.promptIndex !== currentIdx) {
      pendingByIndex.set(pc.promptIndex, pc);
    }
  }
  if (pendingByIndex.size > 0) {
    debugLog(event, 'antigravity flushing offline captures', { indices: [...pendingByIndex.keys()] });
  }
  const promptChanges = parsed.prompts.map((p, i) => {
    // Real prompt time from the transcript. agy has no UserPromptSubmit hook, so
    // without this the server stamps the DB insert time (whenever the first Stop
    // fired) — wrong, and unstable across re-parses. parsed.prompts is sorted by
    // this time, so promptIndex `i` is a stable identity for the prompt.
    const ts = parsed.promptTimes[i];
    const createdAt = ts != null ? { createdAt: ts } : {};
    // What this turn wrote that is NOT in the repo — agy's own scratch dir, a
    // sibling checkout, /tmp. Without it a turn that wrote only outside the
    // repo is indistinguishable from a capture that broke: both render "0
    // files changed". Derived from the transcript, which is re-parsed in full
    // on every fire, so re-sending it is idempotent.
    // A NESTED REPO is inside workRoot, so outOfRepoWrites cannot see it —
    // and neither can git, which reports the directory and nothing under it.
    // Prod b6f3cc59 turn 3: the agent decided this worktree's git pointer was
    // broken (it was not — it resolves, and `git status` works), ran `git init`
    // inside `inventory/`, moved five files in and committed 228 lines there.
    // From the parent those five files simply VANISHED, so the turn rendered
    // "+0 -192" — a deletion, for work that was created. Same blind spot as
    // the 0-file case, wearing a worse mask.
    //
    // Only the turn that is CURRENTLY closing gets this: the window is its own
    // prompt time, and an earlier turn's nested repo is not its work.
    const nestedFiles = (i === currentIdx && typeof parsed.promptTimes[i] === 'number')
      ? nestedRepoFilesWritten(workRoot, parsed.promptTimes[i] as number)
      : [];
    const outsideFiles = [...new Set([
      ...outOfRepoWrites(workRoot, parsed.promptFilesEdited[i] || []),
      ...nestedFiles,
    ])];
    const outside = outsideFiles.length > 0 ? { outOfRepoFiles: outsideFiles } : {};
    if (nestedFiles.length > 0) {
      debugLog('stop', 'antigravity nested-repo writes reported as out-of-repo', {
        promptIndex: i, count: nestedFiles.length, sample: nestedFiles.slice(0, 3),
      });
    }
    if (i === currentIdx) {
      return { ...agyStamp, promptIndex: i, promptText: p, diff, uncommittedDiff, filesChanged, linesAdded, linesRemoved, authoritative: true, ...(ledgerOwned ? { diffSource: 'ledger' } : {}), ...(promptTurnIds[String(i)] ? { turnId: promptTurnIds[String(i)] } : {}), ...outside, ...createdAt, ...(commitSha ? { commitSha } : {}) };
    }
    const queued = pendingByIndex.get(i);
    if (queued) {
      // Replay the offline capture verbatim, re-stamping the text/time from the
      // current parse, and applying the commit backfill if this turn's work was
      // swept into a commit that landed later.
      // The queued row keeps the stamp of the fire that captured it.
      return {
        ...agyStamp,
        ...queued,
        promptIndex: i,
        promptText: p,
        ...outside,
        ...createdAt,
        ...(commitSha && committedSet.has(i) ? { commitSha, uncommittedDiff: '' } : {}),
      };
    }
    if (commitSha && committedSet.has(i)) {
      // Backfill the commit link onto an earlier prompt whose work it included;
      // clear its uncommitted flag without touching its stored diff.
      return { ...agyStamp, promptIndex: i, promptText: p, commitSha, uncommittedDiff: '', ...outside, ...createdAt };
    }
    return { ...agyStamp, promptIndex: i, promptText: p, ...outside, ...createdAt };
  });

  // Synthesize the conversation transcript (turns of user/assistant messages)
  // so the session view renders the agent's actual output per turn — reasoning,
  // tool actions, and final answers — instead of "No response captured". agy
  // gives no real transcript file in our format, so we build one from the
  // parsed prompts + assembled responses, the same shape Gemini's stop hook
  // synthesizes. buildUnifiedTurns(transcript, promptChanges) on the web groups
  // these into per-turn cards.
  const turns: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < parsed.prompts.length; i++) {
    turns.push({ role: 'user', content: parsed.prompts[i] });
    const resp = parsed.responses[i];
    if (resp && resp.trim()) turns.push({ role: 'assistant', content: resp });
  }
  const transcript = turns.length > 0 ? JSON.stringify(turns) : undefined;

  const usagePayload = {
    tokensUsed: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokensEstimated: true,
    costUsd,
    // agy has no usage payload of its own, so these were never sent and the
    // session detail rendered "0 tools" for turns that plainly ran several.
    // The counts come from the transcript's tool_calls, normalized to the same
    // labels the UI colors chips by. Omit a zero so a thin/early parse can't
    // overwrite a real count with 0.
    ...(parsed.toolCalls > 0 ? { toolCalls: parsed.toolCalls } : {}),
    ...(parsed.toolBreakdown.length > 0 ? { toolBreakdown: parsed.toolBreakdown } : {}),
  };

  // Drop the offline queue only once the send that carried it LANDED. Re-reads
  // the cache rather than reusing `cachedForRepo`, which is stale by now — the
  // big write above has already run.
  const clearFlushedPending = (): void => {
    if (isWatcherSync || pendingByIndex.size === 0) return;
    try {
      const cur = readAgyRulesCache(conversationId);
      if (cur?.pendingPromptChanges?.length) {
        writeAgyRulesCache(conversationId, { ...cur, pendingPromptChanges: [] });
        debugLog(event, 'antigravity offline captures flushed', { count: pendingByIndex.size });
      }
    } catch { /* non-fatal — a retry just re-sends them, which is idempotent */ }
  };

  if (event === 'stop') {
    // agy's Stop is a TURN boundary, not a process exit.
    //
    // The original capture was built against agy builds that fired Stop only
    // when the CLI exited, so this branch called api.endSession() — which
    // COMPLETES the row. Current builds fire Stop at the end of EVERY turn
    // (proven from ~/.origin/hooks.log: one conversation logged four Stops,
    // 13:23/13:25/13:27/13:41, each followed by more Pre/PostToolUse from the
    // same still-running agy). So every turn ended the session, the next turn's
    // /session/start re-opened it via the COMPLETED-resume rung, and the row sat
    // on "Completed" the whole time the user was still working in it.
    //
    // There is no signal on the payload that separates a turn-end Stop from a
    // real exit, so treat Stop the way handleSessionEnd treats the other agents
    // with a per-turn "session end" (cursor / codex / claude-code / copilot):
    // send the full final-state payload as an UPDATE and leave the session
    // RUNNING. Ending it is then the server's job, on the same clock as every
    // other agent — IDLE at IDLE_THRESHOLD_MS (1h), COMPLETED by the
    // activity-idle sweep at IDLE_ACTIVITY_COMPLETE_MS (3h) — plus the local
    // expireStaleSessionsOnServer() path when a later commit finds the state
    // file stale.
    let sendOk = false;
    try {
      await api.updateSession(sessionId, {
        prompt: parsed.prompts.join('\n\n---\n\n'),
        promptChanges,
        transcript,
        model,
        branch,
        filesChanged,
        diff,
        ...usagePayload,
      } as any);
      sendOk = true;
      clearFlushedPending();
      debugLog('stop', 'antigravity turn finalized (session stays RUNNING)', { sessionId, prompts: parsed.prompts.length, model, costUsd, files: filesChanged?.length || 0, turns: turns.length });
    } catch (err: any) {
      debugLog('stop', 'antigravity stop updateSession failed (non-fatal)', { message: err?.message });
    }
    // The cache is NOT discarded here any more. It used to be, because Stop
    // meant the conversation was over — but a per-turn Stop is followed by more
    // turns, and the cache holds this conversation's diff baselines
    // (baselineSha / promptBaselines / lastSyncShadow). Deleting it mid-session
    // would make the next turn diff from nothing and re-report the whole
    // cumulative session as its own work. Old conversations are pruned by age
    // instead.
    if (!sendOk) {
      debugLog('stop', 'antigravity keeping cache — stop send failed, offline captures still queued', {
        queued: (readAgyRulesCache(conversationId)?.pendingPromptChanges || []).length,
      });
    }
    pruneAgyRulesCaches();
    // Tell the watcher a turn just closed. It drains any output written after
    // this hook's own transcript read, then exits; the next turn's PostToolUse
    // spawns a fresh one.
    try {
      const donePath = agyWatchDonePath(conversationId);
      fs.mkdirSync(path.dirname(donePath), { recursive: true });
      fs.writeFileSync(donePath, String(Date.now()));
    } catch { /* non-fatal */ }
  } else {
    try {
      await api.updateSession(sessionId, { promptChanges, transcript, model, filesChanged, diff, ...usagePayload });
      clearFlushedPending();
    } catch (err: any) {
      debugLog('post-tool-use', 'antigravity updateSession failed (non-fatal)', { message: err?.message });
    }
    // Catch trailing output that lands AFTER this tool call (a final answer, a
    // no-tool prompt) — agy emits no event for it, so watch the transcript and
    // re-sync once it settles. No-op when this IS the watcher's own re-sync.
    spawnAgyWatcher(conversationId, repoPath, transcriptPath);
  }
}
