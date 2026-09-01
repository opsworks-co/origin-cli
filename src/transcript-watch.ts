// ---------------------------------------------------------------------------
// Origin CLI — Hook-independent, multi-agent transcript watcher
// ---------------------------------------------------------------------------
// Sibling of codex-watch.ts, generalized across agents. Codex proved the model:
// an agent ALWAYS writes a complete session transcript to disk, regardless of
// whether Origin's lifecycle hooks fire. On Windows the GUI/desktop agents
// (Claude Code, Cursor, Antigravity, Gemini, Copilot) frequently DON'T fire
// their settings.json hooks at all — the client just doesn't run them — so
// hook-based capture silently never triggers even though the CLI, the hooks,
// and the runtime are all installed and working. (Verified: on a Windows box
// with global hooks installed, 407/407 lifecycle fires were Codex-CLI; the
// Claude *desktop app* fired zero, yet wrote every session to
// ~/.claude/projects/**/*.jsonl.)
//
// This watcher captures those sessions straight from the on-disk transcripts,
// with NO dependency on any hook firing. It is a machine-global daemon
// (`origin transcript-watch`) that polls each agent's transcript store every
// few seconds. For each ACTIVE session it:
//   1. ensures an Origin session exists, keyed on agentSessionId = the agent's
//      own session id (so a watcher-created session and any hook-created one for
//      the SAME session merge server-side — the server dedups by agentSessionId,
//      so on macOS/Linux where hooks DO fire, nothing double-counts),
//   2. parses the transcript live and PATCHes prompts / transcript / tokens /
//      tools to the server,
//   3. creates a per-prompt shadow commit at every new user-prompt boundary and
//      computes a per-prompt diff against it (same per-turn baseline model as
//      the heartbeat and codex-watch, reusing createShadowCommit + captureAgyDiff),
//   4. marks the session ENDED once the transcript goes idle.
//
// Per-agent specifics (transcript location, filename→identity, which parser to
// reuse, recency window) live in transcript-adapters.ts. This file is the
// agent-agnostic engine: reconcile, per-prompt shadows/diffs, git capture,
// single-instance pid, idle sweep, auto-start gating, logon auto-start.
//
// Cross-platform TypeScript. Rolled out Windows-first: `origin enable`
// auto-starts it on Windows only (the CLI agents' hooks work on macOS/Linux, so
// a watcher there would only duplicate-then-dedup). The `origin transcript-watch`
// command runs on every platform for testing. Codex keeps its dedicated
// codex-watch daemon; this one covers the other five.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createShadowCommit, captureAgyDiff, captureGitState, commitDiffScopedToPrompt, captureShadowRangeDiff, filesChangedSinceShadow, readFileAtRev, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
import { shellWindowEdits, SHELL_WINDOW_SOURCE } from './shell-write-capture.js';
import { isOriginAutoManagedPath, shouldIgnoreFile } from './ignore-patterns.js';
import { isInsideRepo, outOfRepoWrites, scopeDiffPathsToRepo } from './paths.js';
import { newCaptureStamp } from './capture-stamp.js';
import { promptKey } from './session-state.js';
import { getWorkingGitRoot, getCanonicalRepoPath, getBranch, getHeadSha, saveSessionState as writeGitSessionFile, loadSessionState as readGitSessionFile, clearSessionState as endGitSessionFile } from './session-state.js';
import { createSnapshot } from './commands/snapshot.js';
import { estimateCost } from './transcript.js';
import { capturePromptEdits } from './prompt-capture/index.js';
import { timeoutForPayload } from './fetch-timeout.js';
import { transcriptWriterTurns, filesRecordedForOtherTurns, reconcileWindowAttribution, type AttributedTurn } from './transcript-attribution.js';
import { git } from './utils/exec.js';
import { registerLogonAutoStart, type LogonAutoStartResult } from './utils/logon-autostart.js';
import { api } from './api.js';
import { loadConfig, loadAgentConfig } from './config.js';
import { debugLog, logSkipOnce } from './debug-log.js';
import { ADAPTERS, countDiffLines, type TranscriptAdapter, type ScannedTranscript, type ParsedSession } from './transcript-adapters.js';
import { writeWatchMeta, touchWatchMeta, removeWatchMeta, watchFreshness } from './watch-meta.js';
import { finalHunksForCaptures, computeFileLineMaps, type FileLineMap } from './final-state-blame.js';
import { syncNotesForSessionStart } from './git-notes.js';
import {
  writeSessionMemory,
  memoryUpdateTrigger,
  shouldWriteMemoryOnSessionEnd,
  isSubstantiveMemory,
  summarizeFromCommitSubjects,
  writeCommitMemory,
  enrichDecisionsForSession,
  shouldWriteMemoryOnCommit,
  type SessionMemoryEntry,
  type CommitMemoryEntry,
} from './memory.js';
import { extractTodosFromPrompts } from './handoff.js';
import { parseMarkersFromTranscriptPath } from './origin-markers.js';
import { anchorEditPositions, backfillWriteBaselines, chainWholeFileWrites, type PromptCapture } from './prompt-capture/index.js';

export type { TranscriptAdapter, ScannedTranscript, ParsedSession };

// ─── Tunables ────────────────────────────────────────────────────────────────

// How often to poll every agent's transcript store. Polling (fs.stat) is
// simpler and more robust than a filesystem watch across platforms — a few
// seconds of lag on a live turn is fine.
export const POLL_INTERVAL_MS = 8_000;
// A session whose transcript hasn't been written within this window is idle →
// END. Kept the same as codex-watch for consistency; adapters own their own
// (usually shorter) active-scan window in listActive().
export const IDLE_MS = 20 * 60 * 1000; // 20 min
// Safety net: never let the daemon run forever.
export const MAX_DAEMON_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h

// Platforms where `origin enable` auto-starts the watcher. Windows-first: the
// CLI agents' hooks work on macOS/Linux, so a watcher there would only create-
// then-dedup. Enabling later is a one-line change (add 'darwin' / 'linux').
export const AUTO_START_PLATFORMS: NodeJS.Platform[] = ['win32'];

// ─── Paths ───────────────────────────────────────────────────────────────────

export function watchStateDir(): string {
  return path.join(os.homedir(), '.origin', 'transcript-watch');
}

export function watchPidFile(): string {
  return path.join(os.homedir(), '.origin', 'transcript-watch.pid');
}

// State files are namespaced by agent slug so two agents that (improbably) mint
// the same session id can't collide, and so a corrupt agent's states can be
// cleared in isolation.
function sessionStatePath(agentSlug: string, sessionId: string, dir = watchStateDir()): string {
  const safeAgent = agentSlug.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, safeAgent, `${safeId}.json`);
}

// ─── Per-session watch state ───────────────────────────────────────────────────

export interface PromptShadow {
  promptIndex: number;
  // Baseline for this prompt's per-turn diff: a shadow commit snapshotting the
  // working tree at the START of the prompt, or the HEAD sha when the tree was
  // clean (createShadowCommit returns null for a clean tree).
  baselineSha: string;
  capturedAt: string;
  promptStartedAt?: number;
}

export interface SessionWatchState {
  agentSlug: string;       // adapter slug (claude, cursor, …)
  sessionId: string;       // the agent's own session id (== agentSessionId)
  // Origin session id once created; null until the first successful startSession.
  originSessionId: string | null;
  repoPath: string;        // canonical repo path (identity sent to server)
  workRoot: string;        // working git root (where git ops run)
  // Number of user prompts already processed — the dedup anchor that lets a
  // restart resume without re-creating shadows or double-counting turns.
  promptCount: number;
  promptShadows: PromptShadow[];
  createdAt: string;
  lastTranscriptMtime: number;
  // Stable per-turn identity, minted once per prompt and persisted.
  //
  // `promptIndex` is a POSITION. The hook path learned this the hard way and
  // mints a `turnId` at submission (see currentTurnIndex in session-state.ts);
  // the watcher never did, so every row it wrote was identified by its loop
  // index alone. It re-sends EVERY prompt on EVERY poll, so once the
  // transcript renumbers — a lost middle prompt, a resume, a mid-turn
  // interjection, all of which have shipped fixes — position i addresses a
  // different turn and the server writes there via @@unique([sessionId,
  // promptIndex]). That is the mechanism behind "a resumed conversation wrote
  // its turns onto turn one's row".
  //
  // Keyed by promptKey rather than by position, because for the WATCHER the
  // transcript owns numbering: re-parsing is the only way it sees prompts, so
  // if the transcript drops one, a positional array silently re-points every
  // id after it. Matching on the text means a renumber shifts indices without
  // moving identity.
  promptTurns?: Array<{ turnId: string; promptKey: string }>;
  // Transcript size in bytes at the last reconcile. #1289 added the prompt
  // count to the skip guard, which catches a new PROMPT landing inside an mtime
  // tick. A turn's WORK — tool calls, edits, the assistant's reply — moves
  // neither mtime nor that count, and is the likelier last write of a session.
  // Transcripts are append-only, so size moves whenever content does. Absent
  // (state written before this field) means unknown, which does not permit a
  // skip.
  lastTranscriptSize?: number;
  // Fingerprint of the working tree at the last poll. The transcript, the
  // prompt count and HEAD can all sit still while an agent is still writing
  // files, so this is the fourth signal the idle-skip needs to be sound.
  lastTreeFingerprint?: string | null;
  // Repo HEAD the last time this session was reconciled. Paired with
  // lastTranscriptMtime it answers "did anything happen since?" — the transcript
  // covers what the agent did, HEAD covers a commit made outside it. Both
  // unchanged → the poll has nothing to recompute and skips the whole pass.
  lastHeadSha?: string;
  status: 'RUNNING' | 'ENDED';
  endedAt?: string;
  // Repo HEAD sha at session creation — baseline for the session-level commit
  // walk (headShaAtStart..HEAD) so commits the agent makes DURING the session
  // are attributed to it and become PR-linkable. Persisted so a restart keeps
  // the original baseline instead of re-anchoring on a later HEAD.
  headShaAtStart?: string;
  // True once the initial full-prompt backfill (every prompt 0..latest) has
  // landed on the server. Until then each poll re-sends the whole backfill so a
  // failed first PATCH can't leave the server having seen only prompt N>0 —
  // which its mid-stream heuristic would mis-flag as partial capture.
  initialBackfillSent?: boolean;
  // Short tag for the `.git/origin-session-<tag>.json` state file the local git
  // hooks read to attribute commits/PRs/AI-blame (agentSessionId.slice(0,12),
  // matching the lifecycle-hook convention).
  sessionTag?: string;
  // Shadow commit of the full working tree at first-notice — lets diffs subtract
  // pre-existing dirt. Created once, persisted.
  sessionStartShadowSha?: string | null;
  // Prompt indices that already have a snapshot registered — keeps it to ONE
  // snapshot per prompt instead of one per 8s poll.
  snapshottedPrompts?: number[];
  // SHAs of commits attributed to this session (from the gitCapture walk),
  // persisted into the .git state file so the post-commit hook + timestamp
  // baselines scope to this session's own commits.
  sessionCommitShas?: string[];
  // Commits this session has already written a per-commit memory record for.
  // Separate from sessionCommitShas because "seen" and "recorded" are not the
  // same event and drifted apart in practice: the release that let a Cursor
  // turn claim its commit stored the sha here-adjacent immediately, so by the
  // time the recording fix shipped the commit no longer looked new and never
  // got written. Keyed on what was RECORDED, a missed commit stays pending and
  // is picked up on the next poll instead of being lost for good.
  recordedCommitShas?: string[];
  // Commits this session has already delivered to /commits/ingest. Separate
  // from the two lists above for the same reason they are separate from each
  // other: "attributed", "recorded in memory" and "sent to the server" are
  // three different events. Keyed on what was SENT, a failed ingest stays
  // pending and is retried on the next poll instead of being lost.
  ingestedCommitShas?: string[];
}

export function loadSessionState(agentSlug: string, sessionId: string, dir = watchStateDir()): SessionWatchState | null {
  try {
    const raw = fs.readFileSync(sessionStatePath(agentSlug, sessionId, dir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.sessionId !== sessionId) return null;
    if (!Array.isArray(parsed.promptShadows)) parsed.promptShadows = [];
    return parsed as SessionWatchState;
  } catch {
    return null;
  }
}

export function saveSessionState(state: SessionWatchState, dir = watchStateDir()): void {
  try {
    const p = sessionStatePath(state.agentSlug, state.sessionId, dir);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* non-fatal — worst case we re-derive next poll */ }
}

export function listSessionStates(dir = watchStateDir()): SessionWatchState[] {
  const out: SessionWatchState[] = [];
  const readdir = (p: string): fs.Dirent[] => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
  for (const agentDir of readdir(dir)) {
    if (!agentDir.isDirectory()) continue;
    const adir = path.join(dir, agentDir.name);
    for (const entry of readdir(adir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(adir, entry.name), 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.sessionId) out.push(parsed as SessionWatchState);
      } catch { /* skip corrupt */ }
    }
  }
  return out;
}

// ─── Repo resolution ─────────────────────────────────────────────────────────

// Recover a repo from the absolute file paths an agent touched, for agents that
// (unlike Codex/Claude) don't record their cwd on disk. Walks each path upward
// to the first git root; returns the most frequently seen root. Returns null
// when no path resolves to a repo. Mirrors the intent of deriveAgyRepoPath.
export function deriveRepoFromFilePaths(filePaths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const fp of filePaths) {
    if (!fp) continue;
    let dir = path.isAbsolute(fp) ? path.dirname(fp) : '';
    if (!dir) continue;
    const root = getWorkingGitRoot(dir);
    if (root) counts.set(root, (counts.get(root) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [root, n] of counts) {
    if (n > bestN) { best = root; bestN = n; }
  }
  return best;
}

// ─── Dependency-injected core (unit-testable) ────────────────────────────────

export interface WatchDeps {
  now: () => number;
  idleMs: number;
  machineId: string;
  hostname?: string;
  stateDir: string;
  api: {
    startSession: (data: any) => Promise<any>;
    updateSession: (id: string, data: any, reqOpts?: { timeoutMs?: number }) => Promise<any>;
  };
  // cwd → { repoPath (canonical), workRoot, repoUrl?, branch? }; null when the
  // cwd is not inside a git repo.
  resolveRepo: (cwd: string) => { repoPath: string; workRoot: string; repoUrl?: string; branch?: string } | null;
  createShadow: (workRoot: string, tag: string) => string | null;
  getHead: (workRoot: string) => string | null;
  // Cheap "has anything in the working tree moved" signal for the idle-skip
  // guard — porcelain status, untracked included. Optional: omitted, the guard
  // keeps its previous behaviour exactly.
  treeFingerprint?: (workRoot: string) => string | null;
  captureDiff: (workRoot: string, baselineSha: string | null) => {
    diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number;
  };
  // `preSessionBaseline` is the session's first shadow — measured against for
  // the inherited-work split, never walked. See codex-watch's copy.
  captureGit: (workRoot: string, headBefore: string | null, preSessionBaseline?: string | null) => {
    headBefore: string;
    headAfter: string;
    commitShas: string[];
    commitDetails: Array<{
      sha: string; message: string; author: string; filesChanged: string[];
      linesAdded: number; linesRemoved: number; patch?: string;
      preSessionLinesAdded?: number; preSessionLinesRemoved?: number;
    }>;
    diff: string;
    diffTruncated: boolean;
    linesAdded: number;
    linesRemoved: number;
  };
  // Ping a session; the response may carry a queued dashboard command
  // (restore/branch). Optional so tests can omit it.
  pingSession?: (originSessionId: string) => Promise<any>;
  // Report a command's outcome back to the dashboard.
  reportCommandResult?: (originSessionId: string, type: string, status: 'success' | 'failed', message: string) => Promise<any>;
  loadState: (agentSlug: string, sessionId: string) => SessionWatchState | null;
  saveState: (s: SessionWatchState) => void;
  // Write the `.git/origin-session-<tag>.json` state file (session-state.ts
  // shape) so the local git hooks attribute commits/PRs/AI-blame to this
  // session. Optional so tests can omit it; the real impl wraps saveSessionState.
  saveGitState?: (state: Record<string, unknown>, workRoot: string, tag: string) => void;
  // Read that same file back, so a rewrite can carry the fields this writer
  // does not own instead of erasing them. See the carry block at the call site.
  loadGitState?: (workRoot: string, tag: string) => Record<string, unknown> | null;
  // Mark that git state file ENDED when the session goes idle.
  endGitState?: (workRoot: string, tag: string) => void;
  // Record what this session did into the repo's cross-session memory when it
  // ends. Optional so tests can omit it; the real impl wraps writeSessionMemory.
  writeMemory?: (repoPath: string, entry: SessionMemoryEntry) => void;
  // Record the immutable per-commit memory entries. Optional, like writeMemory.
  writeCommitMemoryEntry?: (repoPath: string, entry: CommitMemoryEntry) => void;
  // Backfill decisions onto a session's already-written records. The sanctioned
  // exception to commit-record immutability: it fills EMPTY decisions only, for
  // agents that emit the marker after the commit has already been frozen.
  enrichDecisions?: (repoPath: string, sessionId: string, decisions: string[]) => boolean;
  // Unified diff of specific repo-relative files against HEAD, including
  // untracked files (rendered fully-added). The diff source for agents whose
  // transcript carries no edit content (Antigravity) and for brand-new files
  // the shadow-baseline tree diff misses. Optional; omitted in tests.
  /**
   * Sync + fold git notes for a repo the watcher is about to open a session in.
   * Injected so tests can assert it runs without touching a real remote.
   */
  syncNotes?: (workRoot: string) => void;
  // Deliver a commit this session owns to /commits/ingest — sha, subject,
  // numstat totals and the patch. The post-commit hook has always done this;
  // for an agent that fires no hooks the watcher is the only path, and without
  // it the commit exists server-side only as a reconstruction with null stats
  // and no subject. Optional so tests can omit it.
  ingestCommits?: (data: {
    repoPath: string;
    repoUrl?: string;
    commits: Array<Record<string, unknown>>;
  }) => Promise<unknown>;
  // Read one commit out of the checkout for the call above. Injected so tests
  // can supply commits without a real repo.
  readCommitForIngest?: (workRoot: string, sha: string) => Record<string, unknown> | null;
  captureFilesDiff?: (workRoot: string, relFiles: string[]) => {
    diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number;
  };
  // A committing turn's OWN contribution: baseline tree → commit tree, scoped to
  // the commit's files. Recovers turns whose transcript recorded no edits (the
  // agent worked through the terminal) and which never got the latest-turn
  // working-tree treatment. Optional; omitted in tests.
  captureCommitScoped?: (
    workRoot: string,
    baselineSha: string | null,
    commitSha: string,
    files: string[],
  ) => { diff: string; linesAdded: number; linesRemoved: number } | null;
  // Canonical per-prompt edit capture — wraps capturePromptEdits. Returns one
  // PromptCapture per prompt (edits[] + commits[]), serialized into editsJson.
  capturePromptEdits?: (opts: {
    agent: 'claude' | 'cursor' | 'codex' | 'gemini' | 'copilot';
    repoPath: string;
    transcriptPath?: string;
    sessionCommitShas?: string[];
    // Which turn each commit belongs to, and how firmly — see
    // SessionState.commitTurns. Lets the extractor use an observation instead of
    // guessing "the highest-index turn that claims the sha".
    commitTurns?: Array<{ sha: string; turnId: string; via?: 'post-commit' | 'transcript' }>;
    promptTurnIds?: string[];
    headShaAtStart?: string;
  }) => Array<{
    promptIndex: number;
    edits: unknown[];
    commits?: string[];
    // Paths the turn wrote OUTSIDE the repo (home collapsed to `~`), peeled
    // off edits[] by dropOutOfRepoEdits. Declared here so reconcileSession can
    // put them on the wire — a turn with an empty edits[] has to be able to
    // say why it is empty.
    outOfRepoFiles?: string[];
  }>;
  // Create a local snapshot and register it on the server (createSnapshot +
  // api.uploadSnapshot). Optional; no-op in tests.
  registerSnapshot?: (
    workRoot: string,
    originSessionId: string,
    opts: { sessionTag: string; model?: string; promptIndex: number; transcriptPath: string; filesChanged: string[]; linesAdded: number; linesRemoved: number },
  ) => Promise<void>;
}

// Server rejections that will NOT resolve on their own — the repo has to be
// registered by a human before startSession can succeed.
const REPO_REJECTED_RE = /not registered in Origin|Ask your admin to add it/i;
const REPO_REJECTED_BACKOFF_MS = 30 * 60_000; // 30 min
const TRANSIENT_BACKOFF_MIN_MS = 30_000;      // 30s, doubling
const TRANSIENT_BACKOFF_MAX_MS = 5 * 60_000;  // capped at 5 min

// The server telling us the id we hold is not a session it knows (deleted,
// pruned, or created against another account). Unlike a transient failure this
// answer never changes, so the id must be dropped rather than retried.
const SESSION_GONE_RE = /session not found|\b404\b/i;


/**
 * Transcript size in bytes, or null when it cannot be read.
 *
 * null means UNKNOWN, never "unchanged" — it must not satisfy a freshness
 * check. Size is what mtime and the prompt count both miss: mtime is
 * millisecond-truncated so two writes can share it, and the count only moves
 * for a new prompt, not for the work a turn does.
 */
function transcriptSize(transcriptPath: string): number | null {
  try {
    const st = fs.statSync(transcriptPath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

// Per (agent, repo) cooloff after a failed startSession. Module-level rather
// than persisted: the daemon is long-lived, and a restart re-asking once is
// fine — the point is to stop asking every single poll.
const startSessionBackoff = new Map<string, { until: number; waitMs: number }>();

// Test seam — the backoff map is module state, so a test that exercises two
// failure sequences needs to reset it between them.
export function __resetStartSessionBackoff(): void {
  startSessionBackoff.clear();
}

// Process ONE scanned session: create/reuse its Origin session, push the latest
// transcript state, capture per-prompt shadows + diffs, or end it when idle.
// Returns the (possibly-updated) state, or null when the session was skipped
// (noise, non-git cwd, unparseable transcript).
// Expand a short commit SHA to its full form using the repo itself. Returns
// null when git cannot resolve it — an ambiguous or unknown prefix must not be
// guessed at.
export function resolveFullSha(workRoot: string, short: string): string | null {
  if (!/^[0-9a-f]{4,40}$/i.test(short)) return null;
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${short}^{commit}`], {
      cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Make a possibly-absolute path repo-relative in a way that works REGARDLESS of
 * the host OS. `path.isAbsolute` only recognizes the CURRENT platform's format,
 * so a Windows path like "C:/repo/src/x.ts" looks relative on Linux/macOS and
 * slips through un-stripped — then isSubstantiveMemory drops it as foreign work
 * (the watcher runs cross-platform; Cursor/Windows agents emit `C:/…` paths).
 * Strip the workRoot prefix directly after normalizing slashes, and only fall
 * back to path.relative for a genuine same-OS absolute path.
 */
export function toRepoRelative(workRoot: string, file: string): string {
  const f = (file || '').replace(/\\/g, '/');
  const root = (workRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root) {
    if (f === root) return '.';
    if (f.startsWith(root + '/')) return f.slice(root.length + 1);
  }
  if (root && path.isAbsolute(file)) {
    const r = path.relative(workRoot, file).replace(/\\/g, '/');
    if (r && !r.startsWith('..')) return r;
  }
  return f;
}

/**
 * For the in-flight turn: does the transcript's own diff beat the working-tree
 * window?
 *
 * The window is `git diff HEAD -- <files>` measured against the turn's shadow
 * baseline, and that baseline is created on a POLL. An agent that fires no
 * lifecycle hooks — Antigravity — can be several edits into a turn before the
 * watcher first sees it, and everything written before the baseline lands is
 * already IN the baseline: it shows up as context, not as this turn's work.
 *
 * Session a4d0708a turn 3 is the shape. Its window reported `monitor.html`
 * +126/-12 and `monitor_server.py` +33/-8; the commit it produced is +150/-12
 * and +44/-8. Hunk for hunk the two agree — same 16 hunks, same deletions,
 * same structure — with 24 added lines simply absent from the early hunks,
 * which is what a baseline taken mid-turn looks like. 35 lines of real work
 * were reported as pre-existing.
 *
 * The transcript diff has no baseline to race: it is built from the content the
 * agent recorded writing. So when it measures MORE than the window, the window
 * missed something and the transcript is the better record. Monotonic toward
 * truth — it can only ever recover work, never shrink a correct capture.
 *
 * Gated on `transcriptDiffIsDelta`, and that gate is load-bearing. For every
 * other adapter a whole-file write counts the entire file as added, so "more"
 * is routine and meaningless there: preferring it would report a one-line
 * change to a 400-row file as +401. Only an adapter that chains whole-file
 * writes against their prior in-session content produces a comparable number.
 */
export function transcriptDiffBeatsWindow(
  transcript: { diff: string; linesAdded: number; linesRemoved: number },
  window: { diff: string; linesAdded: number; linesRemoved: number },
  transcriptIsDelta: boolean,
): boolean {
  if (!transcriptIsDelta) return false;
  if (!transcript.diff.trim()) return false;
  const t = (transcript.linesAdded || 0) + (transcript.linesRemoved || 0);
  const w = (window.linesAdded || 0) + (window.linesRemoved || 0);
  return t > w;
}

/**
 * The session's line totals for its memory entry, counting only work that
 * landed INSIDE the repo.
 *
 * The adapter's own per-turn counts cover every section of the diff it built,
 * including files the agent wrote outside the repo — which the entry's
 * `filesChanged` has already dropped. Antigravity writes an implementation plan
 * and a walkthrough into its brain dir on most turns, so a session's remembered
 * total ran well above what its own file list could account for.
 *
 * A turn whose diff scoping did not change keeps the adapter's numbers. Those
 * counts are authoritative for the diff the adapter produced and need not be
 * derivable from its body — an agent that reports totals without a full patch
 * is a real shape, and recounting it would replace good numbers with whatever
 * the body happened to contain.
 */
export function scopedMemoryLineCounts(
  workRoot: string,
  promptDiffs: Array<{ diff?: string; linesAdded?: number; linesRemoved?: number }> | undefined,
): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const d of promptDiffs || []) {
    const raw = d.diff || '';
    const scoped = scopeDiffPathsToRepo(workRoot, raw);
    const counts = scoped === raw
      ? { linesAdded: d.linesAdded || 0, linesRemoved: d.linesRemoved || 0 }
      : countDiffLines(scoped);
    linesAdded += counts.linesAdded;
    linesRemoved += counts.linesRemoved;
  }
  return { linesAdded, linesRemoved };
}

/**
 * A memory entry for a session the watcher is ending, in the same shape the
 * hook path writes. Re-parses the transcript once — this runs a single time per
 * session, at its end.
 *
 * Returns null when the transcript no longer parses or the session touched
 * nothing; the caller additionally drops non-substantive entries.
 */
function buildWatchMemoryEntry(
  scanned: ScannedTranscript,
  adapter: TranscriptAdapter,
  prior: SessionWatchState,
  now: number,
): SessionMemoryEntry | null {
  const parsed = adapter.parse(scanned.transcriptPath);
  if (!parsed) return null;
  const prompts = parsed.userPrompts || [];
  const workRoot = prior.workRoot || prior.repoPath;
  // toRepoRelative hands the path BACK when it cannot relativise, so an
  // out-of-repo absolute (the agent's own memory notes under ~/.claude, a
  // scratch file in /tmp) is not caught by the `..` check — it does not start
  // with `..`, it starts with `/`. Ask the membership question directly.
  const rel = (parsed.filesChanged || [])
    .filter((f) => isInsideRepo(workRoot, f))
    .map((f) => toRepoRelative(workRoot, f))
    .filter((f) => f && !f.startsWith('..'));
  // What the session actually landed beats what it was asked to do. The hook
  // path summarises from commit subjects (or an LLM) and only falls back to the
  // opening prompt; matching that keeps a 6-turn session from being remembered
  // as its first sentence.
  const subjects = commitSubjects(workRoot, prior.sessionCommitShas || []);
  const summary = summarizeFromCommitSubjects(subjects) || prompts[0]?.slice(0, 200) || '';

  // Explicit [Origin: Decision] markers are ground truth and need no LLM — the
  // same source the commit path uses.
  let decisions: string[] = [];
  try {
    decisions = parseMarkersFromTranscriptPath(scanned.transcriptPath)?.decision || [];
  } catch { /* best-effort */ }

  return {
    sessionId: scanned.sessionId,
    agentSlug: adapter.agentSlugForServer || adapter.slug,
    model: parsed.model || adapter.slug,
    startedAt: prior.createdAt || new Date(now).toISOString(),
    endedAt: new Date(now).toISOString(),
    branch: null,
    summary,
    filesChanged: [...new Set(rel)],
    promptCount: prompts.length,
    // Summed from the per-turn diffs the adapter already computed. The hook
    // path takes these from its gitCapture; the watcher has no equivalent at
    // END time, and a per-turn sum is the same number by a different route.
    //
    // Scoped first, for the same reason `filesChanged` above is: the adapter's
    // counts include every section of the raw diff, and an agent that writes
    // outside the repo (Antigravity keeps its plan and walkthrough notes in its
    // own brain dir) had those lines summed in as repo work — so the remembered
    // total disagreed with the file list sitting beside it.
    ...scopedMemoryLineCounts(workRoot, parsed.promptDiffs),
    openTodos: extractTodosFromPrompts(prompts),
    ...(decisions.length > 0 ? { decisions: decisions.slice(0, 8) } : {}),
  };
}

/**
 * Record the per-commit memory entries for `shas`, plus a refreshed session
 * rollup. Both are needed together: writeCommitMemory keeps only commits whose
 * session is present in memory (or is the one being written), so recording a
 * commit mid-session without its rollup would let a LATER write from a
 * different session prune it away.
 *
 * writeSessionMemory upserts by sessionId and writeCommitMemory is add-once by
 * sha, so calling this repeatedly is safe.
 */
function recordCommitMemory(
  deps: WatchDeps,
  adapter: TranscriptAdapter,
  scanned: ScannedTranscript,
  prior: SessionWatchState,
  shas: string[],
  now: number,
): string[] {
  if (!deps.writeCommitMemoryEntry || !prior.repoPath || shas.length === 0) return [];
  if (!shouldWriteMemoryOnCommit(memoryUpdateTrigger())) return [];
  const workRoot = prior.workRoot || prior.repoPath;
  // The shas actually recorded, so the caller can remember them and stop
  // re-deriving. A sha we could NOT resolve is deliberately absent: it stays
  // pending and gets another chance next poll.
  const written: string[] = [];
  // The rollup first — it is what keeps these commits from being pruned.
  if (deps.writeMemory) {
    const entry = buildWatchMemoryEntry(scanned, adapter, prior, now);
    if (entry && isSubstantiveMemory(entry)) deps.writeMemory(prior.repoPath, entry);
  }
  // The same [Origin: Decision] markers the post-commit hook records. Without
  // these a commit captured on Windows produced a THINNER record than the same
  // commit captured on macOS, where hooks fire and the hook path writes them —
  // the granular history a reader actually wants ("why", not just filenames)
  // was present on one platform and absent on the other.
  let decisions: string[] = [];
  try {
    decisions = parseMarkersFromTranscriptPath(scanned.transcriptPath)?.decision || [];
  } catch { /* best-effort, exactly as the hook path treats it */ }

  for (const sha of shas.slice(-20)) {
    const facts = commitFacts(workRoot, sha);
    if (!facts) continue; // a sha this repo cannot resolve — record nothing
    deps.writeCommitMemoryEntry(prior.repoPath, {
      commitSha: sha,
      sessionId: scanned.sessionId,
      agentSlug: adapter.agentSlugForServer || adapter.slug,
      message: facts.message,
      filesChanged: facts.files,
      linesAdded: facts.added,
      linesRemoved: facts.removed,
      decisions: decisions.length > 0 ? decisions.slice(0, 6) : undefined,
      branch: facts.branch,
      committedAt: facts.committedAt,
    });
    written.push(sha);
  }

  // Late markers. Cursor and Codex flush [Origin: Decision] a few seconds AFTER
  // the commit fires, so the write above can freeze a record with none — and
  // commit records are add-once, so it would never be revisited. #1007 fixed
  // this for the hook path only; the watcher is the path that captures Cursor
  // on Windows, so it needs the same backfill. Fills only empty decisions, so
  // it can never overwrite what a record already states.
  if (decisions.length > 0 && deps.enrichDecisions) {
    try { deps.enrichDecisions(prior.repoPath, scanned.sessionId, decisions); } catch { /* non-fatal */ }
  }
  return written;
}

/**
 * How much OLDER than the session's start a commit is, in ms. 0 when the commit
 * is at or after that point. null when either side is unknown, which callers
 * must treat as "no opinion" rather than as a rejection.
 *
 * Negative-looking cases are normal and must stay allowed: a Cursor transcript
 * is written at turn end, so its first commit is routinely a little older than
 * the moment the watcher first saw the session.
 */
function commitAgeMs(workRoot: string | undefined, sha: string, sessionStart?: string): number | null {
  if (!workRoot || !sha || !sessionStart) return null;
  const started = Date.parse(sessionStart);
  if (!Number.isFinite(started)) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', sha], {
      cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const at = Date.parse(out);
    if (!Number.isFinite(at)) return null;
    return Math.max(0, started - at);
  } catch {
    return null;
  }
}

/**
 * Which commit a turn made, when the turn ran `git commit` but never printed
 * the sha.
 *
 * The command text is in the transcript and the MESSAGE is inside it, so rather
 * than parse that message out — agents quote it three different ways, including
 * PowerShell here-strings and `$(@'…'@)` — ask the question backwards: take the
 * repo's recent commit subjects and see which one appears verbatim in the
 * command the turn ran. Quoting style becomes irrelevant.
 *
 * Deliberately strict, same bar as the rest of the attribution path:
 *   - the subject must be long enough to be distinctive (a "wip" or "fix"
 *     subject matches far too much to be evidence of anything)
 *   - exactly one candidate may match; two mean we cannot tell, so we say so
 *     by returning null rather than picking one
 *   - only commits within the session's window are considered, so a turn that
 *     happens to quote an old commit's message cannot claim it
 * Returns null whenever any of that fails — the caller then falls back to the
 * existing order-based pairing, exactly as before.
 */
export function matchCommitByCommand(
  commands: string[],
  candidates: Array<{ sha: string; subject: string }>,
  minSubjectLength = 12,
): string | null {
  if (!commands.length || !candidates.length) return null;
  const haystack = commands.join('\n');
  const hits = new Set<string>();
  for (const c of candidates) {
    const subject = (c.subject || '').trim();
    if (subject.length < minSubjectLength) continue;
    if (haystack.includes(subject)) hits.add(c.sha);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Recent commits in the repo, newest first, as {sha, subject}. Bounded because
 * this is only ever used to identify a commit a turn just made.
 */
function recentCommits(workRoot: string | undefined, limit = 40): Array<{ sha: string; subject: string }> {
  if (!workRoot) return [];
  try {
    const out = execFileSync('git', ['log', `-n${limit}`, '--format=%H%x00%s'], {
      cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.split('\n').map((line) => {
      const [sha, subject] = line.split('\0');
      return sha && subject ? { sha: sha.trim(), subject } : null;
    }).filter((x): x is { sha: string; subject: string } => !!x);
  } catch {
    return [];
  }
}

/**
 * The branch a commit belongs to, or null when that cannot be answered without
 * guessing.
 *
 * The post-commit hook simply records the branch it was standing on, which is
 * exact because it runs AT commit time. The watcher can be recording minutes
 * later — or catching up a backlog — by which point the current branch may have
 * moved on, so "whatever HEAD says now" would quietly attach the wrong branch.
 *
 * Instead ask which local branches actually contain the commit. The current
 * branch wins when it is one of them (the overwhelmingly common case: the
 * commit was just made here); a single containing branch is unambiguous; and
 * anything else — several branches, or none — returns null, because a wrong
 * branch is worse than an absent one.
 */
export function commitBranch(run: (args: string[]) => string, sha: string): string | null {
  try {
    const containing = run(['for-each-ref', '--format=%(refname:short)', '--contains', sha, 'refs/heads'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (containing.length === 0) return null;
    const head = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (head && head !== 'HEAD' && containing.includes(head)) return head;
    return containing.length === 1 ? containing[0] : null;
  } catch {
    return null;
  }
}

/**
 * Subject, files, line counts and branch for ONE commit, read from the repo.
 * Returns null when the sha isn't resolvable there.
 */
function commitFacts(
  workRoot: string | undefined,
  sha: string,
): { message: string; files: string[]; added: number; removed: number; committedAt: string; branch: string | null } | null {
  if (!workRoot || !sha) return null;
  const run = (args: string[]) => execFileSync('git', args, {
    cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const [message, committedAt] = run(['log', '-1', '--format=%s%x00%cI', sha]).trim().split('\0');
    if (!message && !committedAt) return null;
    const files: string[] = [];
    let added = 0;
    let removed = 0;
    // --numstat gives "added<TAB>removed<TAB>path"; a binary file reports "-".
    for (const line of run(['show', '--numstat', '--format=', sha]).split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length < 3) continue;
      const [a, d, file] = parts;
      if (file) files.push(file.replace(/\\/g, '/'));
      added += Number.isFinite(Number(a)) ? Number(a) : 0;
      removed += Number.isFinite(Number(d)) ? Number(d) : 0;
    }
    return {
      message: message || '',
      files,
      added,
      removed,
      committedAt: committedAt || new Date().toISOString(),
      branch: commitBranch(run, sha),
    };
  } catch {
    return null;
  }
}

/** Subject lines of the commits this session made, oldest→newest. */
/**
 * A cheap signal that says whether anything in the working tree has moved.
 *
 * `git status --porcelain -uall` names every modified and untracked path with
 * its status letters, so any write, delete or rename changes the string. It is
 * one spawn — the same order of cost as the `getHead` call the idle-skip guard
 * already makes — and it is the only way that guard can see the input the
 * transcript does not describe.
 *
 * Returns null when git cannot answer. The guard treats unknown as "changed",
 * so a failure costs a redundant capture rather than a lost one.
 */
export function realTreeFingerprint(workRoot: string): string | null {
  try {
    return execFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Upper bound on a per-commit patch we ship. Beyond it the row still gets its
 *  subject and its numstat totals — only the body is dropped. */
const MAX_INGEST_PATCH = 2 * 1024 * 1024;

/**
 * Commits this session owns that the server has not been told about yet.
 *
 * `sessionCommitShas` is ownership (#1306) — anything outside it belongs to
 * another session and must never be ingested under this one. Bounded so a
 * long-running session cannot turn one poll into a hundred round trips; the
 * remainder is picked up on the polls after it.
 */
export function pendingCommitIngests(
  sessionCommitShas: string[] | undefined,
  alreadyIngested: string[] | undefined,
  limit = 5,
): string[] {
  const done = new Set(alreadyIngested || []);
  return (sessionCommitShas || []).filter((sha) => sha && !done.has(sha)).slice(0, limit);
}

/**
 * A commit as /commits/ingest wants it, read straight from git.
 *
 * The post-commit hook has always sent this; the WATCHER never did, and the
 * watcher is the only capture path for agents that fire no hooks. So an
 * Antigravity commit only ever existed as the reconstruction the server builds
 * from per-prompt captures — deliberately `additions: null, deletions: null`
 * because a turn's scoped counts are not the commit's — and nothing ever
 * arrived to fill them in. Session 4aa080fa commit c3a29ffe is +239/-0 in git
 * and rendered with no "commit total" chip and "subject not captured".
 *
 * Returns null when the sha is not in this checkout: a commit on a branch the
 * worktree no longer has is not ours to describe.
 */
export function realReadCommitForIngest(
  workRoot: string,
  sha: string,
): {
  sha: string; message: string; author: string; committedAt?: string;
  filesChanged: string[]; additions: number; deletions: number; diff?: string;
} | null {
  const g = (args: string[]): string => execFileSync('git', args, {
    cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const [message = '', author = '', committedAt = ''] =
      g(['log', '-1', '--format=%s%n%an%n%aI', sha]).split('\n');
    const filesChanged: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of g(['show', '--numstat', '--format=', sha]).split('\n')) {
      // `-\t-\tpath` is git's marker for a binary file: it contributes a file
      // but no line counts, and Number('-') would poison the totals with NaN.
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      if (m[1] !== '-') additions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
      filesChanged.push(m[3]);
    }
    let diff = '';
    try { diff = g(['show', '--format=', '--patch', sha]); } catch { /* stats still stand */ }
    return {
      sha,
      message,
      author,
      committedAt: committedAt || undefined,
      filesChanged,
      additions,
      deletions,
      ...(diff && diff.length <= MAX_INGEST_PATCH ? { diff } : {}),
    };
  } catch {
    return null;
  }
}

function commitSubjects(workRoot: string | undefined, shas: string[]): string[] {
  if (!workRoot || shas.length === 0) return [];
  const out: string[] = [];
  for (const sha of shas.slice(-10)) {
    try {
      out.push(execFileSync('git', ['log', '-1', '--format=%s', sha], {
        cwd: workRoot, encoding: 'utf-8', windowsHide: true, timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim());
    } catch { /* a sha the repo no longer has — skip it */ }
  }
  return out.filter(Boolean);
}

/**
 * Stable turn ids for this session's prompts, minted once and carried across
 * polls.
 *
 * Mirrors what the hook path does in currentTurnIndex: a random id, minted the
 * first time a prompt is seen and then never re-minted. NOT derived from the
 * prompt text — text repeats ("try again"), so a content hash would give two
 * genuinely different turns the same identity.
 *
 * Matching is by promptKey (the hook path's own normalizer, shared rather than
 * re-implemented) and each key is consumed once, so a session that asks the
 * same thing twice gets two ids in prompt order rather than one id reused.
 *
 * A prompt that disappears from the transcript therefore shifts later
 * POSITIONS without moving their identity, which is the whole point: the
 * server keys on turnId when present, so the row follows the prompt instead of
 * the slot.
 */
/**
 * The hook path's turn identities, in the shape assignTurnIds consumes.
 *
 * `promptTurnIds[i]` belongs to the prompt the hook path stored at
 * `prompts[i]`, so the pairing is read from ITS OWN list and re-keyed by
 * promptKey. Never zipped against the watcher's prompts by index — the two
 * paths do not always see the same set (an agent-injected follow-up prompt
 * lands in one and not the other), and a positional zip would hand a turn its
 * neighbour's identity.
 *
 * Returns [] for any state that doesn't carry both arrays, so a hook-less agent
 * and a state file written before promptTurnIds existed both behave as today.
 */
export function hookMintedTurns(
  gitState: Record<string, unknown> | null,
): Array<{ turnId: string; promptKey: string }> {
  const ids = gitState?.promptTurnIds;
  const texts = gitState?.prompts;
  if (!Array.isArray(ids) || !Array.isArray(texts)) return [];
  const out: Array<{ turnId: string; promptKey: string }> = [];
  for (let i = 0; i < Math.min(ids.length, texts.length); i++) {
    const id = ids[i];
    if (typeof id === 'string' && id) out.push({ turnId: id, promptKey: promptKey(String(texts[i] ?? '')) });
  }
  return out;
}

export function assignTurnIds(
  prior: Array<{ turnId: string; promptKey: string }> | undefined,
  prompts: string[],
  newId: () => string = () => `w_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
): Array<{ turnId: string; promptKey: string }> {
  const unclaimed = [...(prior || [])];
  const out: Array<{ turnId: string; promptKey: string }> = [];
  for (const text of prompts) {
    const key = promptKey(text || '');
    const at = unclaimed.findIndex((e) => e.promptKey === key);
    if (at >= 0) {
      out.push(unclaimed[at]);
      unclaimed.splice(at, 1);   // consume, so a repeated prompt gets its own id
    } else {
      out.push({ turnId: newId(), promptKey: key });
    }
  }
  return out;
}

export async function reconcileSession(
  scanned: ScannedTranscript,
  adapter: TranscriptAdapter,
  deps: WatchDeps,
): Promise<SessionWatchState | null> {
  const now = deps.now();
  const prior = deps.loadState(adapter.slug, scanned.sessionId);

  // Idle → END. If we already have a session, tell the server it's done and
  // stamp the state ENDED so we never touch it again.
  if (now - scanned.mtimeMs > deps.idleMs) {
    if (prior && prior.status === 'RUNNING') {
      if (prior.originSessionId) {
        try { await deps.api.updateSession(prior.originSessionId, { status: 'ENDED' }); } catch { /* best-effort */ }
      }
      if (prior.sessionTag) {
        try { deps.endGitState?.(prior.workRoot, prior.sessionTag); } catch { /* best-effort */ }
      }
      // Cross-session memory. Only the hook path ever wrote this, and GUI
      // agents fire no hooks on Windows — they are captured HERE — so on a
      // Windows box `origin context memory` stayed empty forever no matter how
      // many sessions ran (reported on origin-demo-1, which had dozens). A
      // session ending is exactly the moment the hook path records one, so the
      // watcher records one too, in the same shape.
      try {
        if (deps.writeMemory && prior.repoPath && shouldWriteMemoryOnSessionEnd(memoryUpdateTrigger())) {
          const entry = buildWatchMemoryEntry(scanned, adapter, prior, now);
          if (entry && isSubstantiveMemory(entry)) {
            deps.writeMemory(prior.repoPath, entry);
            debugLog('transcript-watch', 'session memory written', {
              agent: adapter.slug, sessionId: scanned.sessionId, files: entry.filesChanged.length,
            });
          }
        }

        // The immutable per-commit records (config memoryUpdate = commit|both).
        // Their only writer was the post-commit git hook, which does not run for
        // commits an agent makes from its own sandboxed shell — on this machine
        // three agent commits in a row left no note and no record, so turning
        // memoryUpdate on did nothing at all. The watcher already knows exactly
        // which commits a session produced, so it writes them here.
        //
        // Written AFTER the session rollup on purpose: writeCommitMemory prunes
        // commits whose session isn't in memory yet.
        // Same rule as the live path: only commits this session can claim. At
        // END there is no attribution pass, so use the SHAs the agent itself
        // printed, resolved against the session's list for their full form.
        const endParsed = adapter.parse(scanned.transcriptPath);
        const claimed = Object.values(endParsed?.promptCommitShas || {})
          .flat()
          .map((short) => (prior.sessionCommitShas || []).find((full) => full.startsWith(short)) || null)
          .filter((x): x is string => !!x);
        if (claimed.length > 0) {
          recordCommitMemory(deps, adapter, scanned, prior, [...new Set(claimed)], now);
        }
      } catch (err) {
        debugLog('transcript-watch', 'session memory write failed (non-fatal)', { err: String(err) });
      }

      const ended: SessionWatchState = { ...prior, status: 'ENDED', endedAt: new Date(now).toISOString() };
      deps.saveState(ended);
      return ended;
    }
    return prior; // already ended or never started — nothing to do
  }

  const parsed = adapter.parse(scanned.transcriptPath);
  if (!parsed || parsed.userPrompts.length === 0) return prior;

  // Nothing changed since the last pass → nothing to recompute.
  //
  // Every poll used to redo the FULL reconcile for every live session — per-prompt
  // shadows, working-tree and commit-scoped git windows, line maps, an
  // updateSession — every 8 seconds, for the whole 20-minute idle window AFTER
  // the agent had gone quiet. The result was identical each time (same turns,
  // same shas, same files), so all of it was wasted; the log shows the same
  // Antigravity session re-sending `turns: 0:none,1:none` minute after minute
  // with the transcript untouched since the first one.
  //
  // On Windows that waste is visible: the daemon has no console, so every git
  // child it spawns gets its own console window. A finished session still
  // flashed black windows every 8s until it aged out.
  //
  // The PROMPT COUNT is part of the test, and not for symmetry — mtime alone is
  // unsound here. It has finite resolution (a whole second on some filesystems),
  // so a turn appended within the same tick as the previous poll's reading is
  // invisible to an mtime comparison, and this guard would skip it. If that turn
  // is the session's last, nothing ever bumps mtime again and the turn is
  // dropped permanently — which is exactly what happened: a 3-prompt session
  // reported turns 0 and 1 and silently lost the newest one.
  //
  // Placed AFTER the parse for the same reason: the count cannot be known
  // without it. That is the cheap half of the work — reading a JSONL file,
  // spawning nothing — while the git pass below is what costs real time and what
  // opens the console windows. Skipping that half is the whole point, and it
  // still happens for a genuinely idle session.
  //
  // SIZE covers what the count cannot. The count moves only for a new PROMPT,
  // and a turn's work — tool calls, file edits, the assistant's reply — appends
  // to the turn already counted. That is the likelier final write of a session,
  // so on an mtime tie it is the likelier thing to lose. An append-only
  // transcript's size moves whenever its content does.
  //
  // Unknown size — unreadable path, or state written before the field existed —
  // does NOT qualify as unchanged. Skipping is the optimisation; doing the work
  // is the correct answer, so anything unconfirmed falls through.
  // The WORKING TREE is the input this guard could not see, and it is a second
  // source of change, not a mirror of the first. An agent writes its files and
  // THEN summarises, so the last transcript write can precede the last file
  // write; and a turn whose work is never committed never moves HEAD either. So
  // all four signals above can sit still while real work lands on disk.
  //
  // Session 65014e0b: turn 1 captured at 17:45:45Z as one file, +37/-37. The
  // agent went on to write three files, +1352/-41 — verified by re-running the
  // same window against the same worktree, which reports +1347/-41 across all
  // three. The transcript never changed again, so every later poll skipped and
  // the session stayed frozen on the partial capture for over an hour.
  //
  // Unknown fingerprint does NOT qualify as unchanged, matching the size rule
  // right above: skipping is the optimisation, doing the work is the correct
  // answer, so anything unconfirmed falls through. A caller that supplies no
  // fingerprint at all keeps exactly today's behaviour.
  const transcriptSizeNow = transcriptSize(scanned.transcriptPath);
  const treeNow = prior?.workRoot ? (deps.treeFingerprint?.(prior.workRoot) ?? null) : null;
  const treeUnchanged = !deps.treeFingerprint
    || (treeNow !== null && treeNow === prior?.lastTreeFingerprint);
  if (prior && prior.status === 'RUNNING' && prior.originSessionId && prior.workRoot
      && typeof prior.lastHeadSha === 'string'
      && typeof prior.lastTranscriptSize === 'number'
      && transcriptSizeNow !== null
      && transcriptSizeNow === prior.lastTranscriptSize
      && scanned.mtimeMs === prior.lastTranscriptMtime
      && parsed.userPrompts.length === prior.promptCount
      && treeUnchanged
      && deps.getHead(prior.workRoot) === prior.lastHeadSha) {
    return prior;
  }

  // Per-agent noise filter (e.g. a sidechain-only Claude session, an
  // Antigravity re-injection). Optional; most adapters don't define one.
  if (adapter.isNoise?.(parsed)) return null;

  // Repo mapping. Prefer the cwd the adapter recovered from the transcript;
  // fall back to deriving it from the absolute file paths the agent touched
  // (agents like Gemini/Cursor/Copilot don't record their cwd on disk). Not a
  // git repo → skip (a bare cwd has no per-prompt diff to capture).
  // Both skips below used to be silent, so a session that simply never appeared
  // on the dashboard looked identical to a bug — nothing anywhere said why.
  // Logged once per (agent, path) so a permanently-skipped session doesn't
  // repeat every poll.
  // adapter.fallbackCwd is the third and last source, for a turn that edited
  // nothing at all: no cwd in the transcript AND no path to derive one from is
  // the ordinary shape of a chat-only turn (a clarifying question, a refusal, a
  // plan awaiting approval), and skipping it dropped the whole conversation
  // rather than just its diff. It runs last on purpose — see fallbackCwd's note.
  const cwd = scanned.cwd || deriveRepoFromFilePaths(parsed.filePaths) || adapter.fallbackCwd?.(scanned) || null;
  if (!cwd) {
    logSkipOnce(`nocwd|${adapter.slug}|${scanned.sessionId}`, () => debugLog('transcript-watch', 'skipped: no cwd for session', {
      agent: adapter.slug, sessionId: scanned.sessionId,
      hint: 'transcript records no cwd, no absolute file paths to recover one from, and no adapter fallback resolved a workspace',
    }));
    return prior;
  }
  const repo = deps.resolveRepo(cwd);
  if (!repo) {
    logSkipOnce(`norepo|${adapter.slug}|${cwd}`, () => debugLog('transcript-watch', 'skipped: cwd is not a usable git repo', {
      agent: adapter.slug, sessionId: scanned.sessionId, cwd,
      hint: 'not a repo, or git refuses it (e.g. safe.directory / dubious ownership)',
    }));
    return prior;
  }

  // Repo HEAD at session start — the baseline for the session-level commit walk.
  // Recorded once at creation and persisted; migrated onto older state rows.
  // `headNow` is also what the next poll compares against to decide whether a
  // commit landed while the transcript stood still (see the skip above).
  const headNow = deps.getHead(repo.workRoot);
  const headShaAtStart = prior?.headShaAtStart || headNow || undefined;

  // Short tag for the `.git/origin-session-<tag>.json` state file (matches the
  // lifecycle-hook convention: agentSessionId.slice(0,12)).
  const sessionTag = prior?.sessionTag || scanned.sessionId.slice(0, 12);
  // Full-tree shadow at first-notice — a diff baseline that lets us subtract
  // pre-existing dirt. Created once, persisted. (Null when the tree was clean.)
  const sessionStartShadowSha = prior?.sessionStartShadowSha !== undefined
    ? prior.sessionStartShadowSha
    : (deps.createShadow(repo.workRoot, `twatch-start-${scanned.sessionId.slice(0, 8)}`) || null);

  // Ensure a session exists. Keyed on agentSessionId = the agent's session id so
  // a hook-created session for the same conversation merges server-side.
  let originSessionId = prior?.originSessionId || null;
  if (!originSessionId) {
    // Fold staged notes before the session opens.
    //
    // syncNotesForSessionStart carries the self-repair for a repo whose notes
    // fetched but never folded — and it was wired ONLY into hooks.ts. GUI
    // agents on Windows fire no hooks at all, which is the entire reason this
    // watcher exists, so for exactly the agents it covers nothing ever folded:
    // refs/notes/origin-remote* stayed populated, refs/notes/origin-memory
    // never appeared, and `origin context memory` reported "No session memory
    // yet" while the payload sat in .git (reproduced on a Cursor-written repo
    // whose 2 sessions and 3 commit records were invisible to every later
    // agent).
    //
    // Here rather than in the poll loop: this runs once, when the watcher first
    // adopts a session, so it costs one throttled sync per session instead of
    // one per 8s tick. Best-effort — capture must never fail on notes.
    try { deps.syncNotes?.(repo.workRoot); } catch { /* non-fatal */ }

    const backoffKey = `${adapter.slug}|${repo.repoPath}`;
    const backoff = startSessionBackoff.get(backoffKey);
    if (backoff && now < backoff.until) return prior; // still cooling off — don't call, don't log
    try {
      // Stamp the start time from the transcript's FIRST prompt, not "now": the
      // watcher only NOTICES a session after its first prompt is already on
      // disk, so a "now" start would look like Origin joined mid-stream. The
      // watcher reads the WHOLE transcript, so it has every prompt.
      const validTs = (parsed.promptTimestamps || []).filter((t) => t > 0);
      // Prefer the adapter's explicit session-start (earliest line timestamp);
      // fall back to the earliest per-prompt timestamp. Either beats "now",
      // which would make a watcher-noticed session look joined mid-stream.
      const earliestTs = (parsed.sessionStartedAtMs && parsed.sessionStartedAtMs > 0)
        ? parsed.sessionStartedAtMs
        : (validTs.length ? Math.min(...validTs) : 0);
      const res = await deps.api.startSession({
        machineId: deps.machineId,
        prompt: parsed.userPrompts[0] || '',
        model: parsed.model || adapter.slug,
        repoPath: repo.repoPath,
        repoUrl: repo.repoUrl || undefined,
        agentSlug: adapter.agentSlugForServer,
        branch: repo.branch || undefined,
        hostname: deps.hostname || undefined,
        agentSessionId: scanned.sessionId,
        startedAt: earliestTs > 0 ? new Date(earliestTs).toISOString() : undefined,
      });
      originSessionId = (res?.sessionId as string) || null;
      if (!originSessionId) return prior;
      startSessionBackoff.delete(backoffKey); // succeeded — clear any cooloff
    } catch (err) {
      const msg = String(err);
      const permanent = REPO_REJECTED_RE.test(msg);
      const prevMs = backoff?.waitMs ?? 0;
      // A repo the server refuses stays refused until an admin registers it —
      // re-asking every poll never changes the answer, it just hammers the API
      // and buries the log (observed: the same rejection every ~10s for hours,
      // thousands of identical lines). Transient failures still retry, just on a
      // widening interval instead of flat-out.
      const waitMs = permanent
        ? REPO_REJECTED_BACKOFF_MS
        : Math.min(TRANSIENT_BACKOFF_MAX_MS, prevMs > 0 ? prevMs * 2 : TRANSIENT_BACKOFF_MIN_MS);
      startSessionBackoff.set(backoffKey, { until: now + waitMs, waitMs });
      // Log only when entering a NEW cooloff, so a persistent failure costs one
      // line per window rather than one per poll.
      if (!backoff || backoff.waitMs !== waitMs) {
        debugLog('transcript-watch', 'startSession failed — backing off', {
          agent: adapter.slug, sessionId: scanned.sessionId, repoPath: repo.repoPath,
          permanent, retryInMs: waitMs, err: msg,
        });
      }
      return prior; // retry after the cooloff
    }
  }

  // Per-prompt shadows: capture a baseline for every NEW prompt since last poll.
  // The baseline reflects the working tree at the START of the prompt.
  const promptShadows: PromptShadow[] = Array.isArray(prior?.promptShadows) ? [...prior!.promptShadows] : [];
  const have = new Set(promptShadows.map((s) => s.promptIndex));
  const newCount = parsed.userPrompts.length;
  const prevCount = prior?.promptCount ?? 0;
  for (let i = prevCount; i < newCount; i++) {
    if (have.has(i)) continue;
    const shadow = deps.createShadow(repo.workRoot, `twatch-${adapter.slug}-${i}-${scanned.sessionId.slice(0, 8)}`);
    // Clean tree → no shadow needed; HEAD is the baseline.
    const baselineSha = shadow || deps.getHead(repo.workRoot) || '';
    if (baselineSha) {
      const ts = parsed.promptTimestamps?.[i] || 0;
      promptShadows.push({
        promptIndex: i,
        baselineSha,
        capturedAt: new Date(now).toISOString(),
        promptStartedAt: ts > 0 ? ts : undefined,
      });
      have.add(i);
    }
  }

  // Per-prompt changes. EVERY prompt gets its OWN per-turn diff — not just the
  // latest — so a multi-prompt session attributes changes to the right turn
  // (prompt that created a file shows +N; a read-only prompt shows nothing; the
  // committing prompt shows its own increment). The source is the transcript's
  // per-prompt edit content (extractPromptFileMappings, exposed as promptDiffs),
  // which is git-independent and immune to the poll-based shadow baseline being
  // captured after the edit. The latest (in-flight) prompt adds two fallbacks
  // when the transcript carried no edit content for it: a working-tree diff of
  // the edited files (Antigravity + brand-new untracked files), then the
  // shadow-baseline tree diff. Sent as uncommittedDiff; committed work is linked
  // separately via gitCapture. Re-sent every poll (server upserts by index).
  // Capture the real git commits the agent made during the session so the server
  // attributes them (and PR webhooks can link them). Walks headShaAtStart..HEAD;
  // only sent when there are actual commits.
  //
  // ORDER MATTERS: this runs BEFORE the per-prompt edit capture below, because
  // capturePromptEdits needs this session's commit SHAs to mark an edit
  // source:'commit' and populate PromptCapture.commits[] — which is what links a
  // turn to the commit it produced (the commit row + total-diff badge in the UI).
  // Passing a stale list (prior state only) meant the poll where the commit
  // actually landed still saw zero commits, so the turn never got its commitSha.
  let gitCapture: Record<string, unknown> | undefined;
  let sessionCommitShas = Array.isArray(prior?.sessionCommitShas) ? [...prior!.sessionCommitShas] : [];
  // Commits already written to per-commit memory. Carried forward so the write
  // further down can tell "recorded" from merely "seen".
  let recordedCommitShas = Array.isArray(prior?.recordedCommitShas) ? [...prior!.recordedCommitShas] : [];
  // Commits SEEN in the session's window, owned or not. Deliberately not
  // persisted and never treated as ownership — see the walk below.
  let rangeCommitShas: string[] = [];
  /**
   * Shas the PAIRING passes may consider: this session's own, plus everything
   * seen in the window.
   *
   * Safe here and nowhere else. Every pass that uses this list tests the
   * candidate commit's files against files THIS session edited before pairing
   * it to a turn, so a foreign commit that touched nothing we touched cannot
   * win. Ownership, commit memory and persisted state must NOT use it — that
   * conflation is what put another session's commit on this one's turn.
   */
  const commitCandidates = (): string[] =>
    Array.from(new Set([...sessionCommitShas, ...rangeCommitShas]));
  // sha → repo-relative files in that commit. Used to attribute a commit to a
  // prompt for agents with no canonical extractor (Antigravity/Copilot).
  const commitFiles = new Map<string, string[]>();
  if (headShaAtStart) {
    try {
      // Same pair as codex-watch: HEAD to walk commits from, the first
      // prompt's shadow to measure inherited work against. A commit sitting on
      // headShaAtStart has it as its own parent, so measuring there answers
      // "the session started clean" however dirty the tree really was.
      const gc = deps.captureGit(
        repo.workRoot,
        headShaAtStart,
        promptShadows.find((s) => s.promptIndex === 0)?.baselineSha || null,
      );
      if (gc.commitShas.length > 0) {
        for (const d of gc.commitDetails || []) {
          if (d?.sha) commitFiles.set(d.sha, (d.filesChanged || []).map((f) => f.replace(/\\/g, '/')));
        }
        // gc.commitShas is a headShaAtStart..HEAD walk: every commit made in
        // this repo since the session began, INCLUDING ones other sessions made
        // concurrently. It is not "this session's commits".
        //
        // It used to be merged straight into sessionCommitShas one line below
        // this very warning, which made the name a lie and carried the lie into
        // persisted state. Session fdf299d3 turn 10 is what that produces: its
        // 17 files are exactly commit 9f811c65f, made by a concurrent session,
        // while its own three edited files appear nowhere on the row.
        //
        // Kept separate now. The pairing heuristics below still see it — they
        // each test file overlap against this session's own edits before using
        // a sha, which is what makes a range list safe THERE — but ownership,
        // commit memory and everything persisted read the owned list only.
        rangeCommitShas = Array.from(new Set([...rangeCommitShas, ...gc.commitShas]));
        gitCapture = {
          headBefore: gc.headBefore,
          headAfter: gc.headAfter,
          commitShas: gc.commitShas,
          commitDetails: gc.commitDetails,
          diff: gc.diff || '',
          diffTruncated: gc.diffTruncated,
          linesAdded: gc.linesAdded,
          linesRemoved: gc.linesRemoved,
        };
      }
    } catch (err) {
      debugLog('transcript-watch', 'captureGit failed', { agent: adapter.slug, sessionId: scanned.sessionId, err: String(err) });
    }
  }

  // Canonical per-prompt edit capture (the NEW pipeline). PromptChange.editsJson
  // is what the dashboard treats as the authoritative record of a turn — with it,
  // the read path uses the agent's own edit list instead of re-deriving from
  // legacy diff projections (whose defensive heuristics blank files/diffs when a
  // poll re-sends similar content). Only for agents the extractor understands.
  let editsJsonByIndex = new Map<number, string>();
  const outOfRepoByIndex = new Map<number, string[]>();
  // Commit SHA the capture attributes to each prompt — sent as PromptChange
  // .commitSha so the UI can render the turn's commit row + total-diff badge.
  // Stable identity for every prompt this session has, carried from the prior
  // pass so an id is minted once and then reused. Computed HERE, ahead of the
  // capture call, because that call resolves commit ownership and needs the
  // identity to key it to.
  //
  // ADOPT the hook path's identities where it already has them. The two paths
  // used to mint independently — the hook `t_…` in currentTurnIndex, the
  // watcher `w_…` here — so on a dual-path agent ONE turn existed under TWO
  // identities and the server had no way to tell "the same turn, re-reported"
  // from "a different turn". Both rows then competed for the same slot and the
  // last writer won.
  //
  // Prod b46ec40f (Cursor) stores exactly that, alternating by which writer got
  // there last:
  //
  //   row 0  t_ebe0674b658b4cae   +0/-0
  //   row 1  w_8p1nmx3rmtg543d1   +534/-0     <- the watcher's row won
  //   row 2  t_97aa68bef20047d2   +134/-34
  //   row 3  w_yqny8h47mtg5k119   +0/-0
  //
  // The hook path had sent +604/-0 for row 1. Neither number reached the page
  // by being merged; the watcher's poll-derived one simply overwrote the row a
  // few seconds later, which is why a turn looked right and then changed.
  //
  // Matched by promptKey against the hook's OWN prompt list, never by position:
  // the two paths do not always see the same prompts (Cursor injects a
  // follow-up prompt that grew this very session's list mid-flight), so
  // zipping the id array against our prompts by index would pair ids to the
  // wrong turns — the exact failure turnId exists to prevent.
  //
  // The watcher's own prior ids are offered FIRST so an id it already
  // published keeps its row; adoption changes identity only for a prompt the
  // watcher has not yet named.
  // Guarded: an unreadable state file must not take down the poll. Adoption is
  // an improvement on the identity we would otherwise mint, never a dependency.
  const hookTurns = (() => {
    try { return hookMintedTurns(deps.loadGitState?.(repo.workRoot, sessionTag) || null); } catch { return []; }
  })();
  const promptTurns = assignTurnIds([...(prior?.promptTurns || []), ...hookTurns], parsed.userPrompts || []);

  // DISCOVERY attestation: shas the agent disclosed in its own output
  // ("[branch 73df467]"), bound to the turn they appeared under BY IDENTITY.
  //
  // Weaker than post-commit and labelled so (`via: transcript`). The hook
  // watches a commit land; this is the agent SAYING it committed, in prose that
  // can carry an old sha ("reverted abc1234") — which is why the pairing below
  // still resolves the short form and bounds it by age.
  //
  // It exists because for Cursor there is no alternative. Across this machine's
  // entire log history its worktree fired after-file-edit 30x,
  // user-prompt-submit 29x and post-tool-use 9x — and post-commit ZERO times,
  // with core.hooksPath set correctly and the hook executable. Its commits do
  // not invoke git hooks at all, so commit-time attestation can never exist for
  // it. Naming discovery honestly lets a reader rank it below proof rather than
  // mistake one for the other.
  const discoveredCommitTurns: Array<{ sha: string; turnId: string; at: string; via: "transcript" }> = [];
  for (const [idxRaw, shas] of Object.entries(parsed.promptCommitShas || {})) {
    const idx = Number(idxRaw);
    const turnId = promptTurns[idx]?.turnId;
    if (!Number.isInteger(idx) || !turnId || !Array.isArray(shas) || shas.length === 0) continue;
    const short = shas[shas.length - 1];
    const full = commitCandidates().find((c) => c.startsWith(short)) || resolveFullSha(repo.workRoot, short);
    if (!full) continue;
    discoveredCommitTurns.push({ sha: full, turnId, at: new Date(now).toISOString(), via: "transcript" });
  }

  const commitShaByIndex = new Map<number, string>();
  if (adapter.promptCaptureAgent && deps.capturePromptEdits) {
    try {
      const captures = deps.capturePromptEdits({
        agent: adapter.promptCaptureAgent,
        repoPath: repo.workRoot,
        transcriptPath: scanned.transcriptPath,
        // This session's OWN commits. Was the freshly-walked range list, which
        // also carried concurrent sessions' commits; the extractor is handed
        // ownership, not "what landed in the repo lately".
        sessionCommitShas,
        // Discovery-grade attestation + the identity it is keyed to. Lets the
        // extractor attribute a commit to the turn the transcript disclosed it
        // under instead of falling back to "the highest-index turn that claims
        // the sha" — which for a late-surfacing commit names the wrong turn.
        commitTurns: discoveredCommitTurns,
        promptTurnIds: promptTurns.map((t) => t.turnId),
        headShaAtStart: headShaAtStart || undefined,
      });
      // Send a capture for EVERY prompt the extractor produced — including ones
      // with an empty edits[]. An empty edits[] is a meaningful signal, not a
      // gap: it tells the server "this prompt provably touched nothing", which is
      // what makes a read-only/chat-only turn render clean instead of inheriting
      // a phantom file from the previous turn's legacy diff projection.
      for (const cap of captures) {
        if (Array.isArray(cap.edits)) {
          editsJsonByIndex.set(cap.promptIndex, JSON.stringify({
            edits: cap.edits,
            commits: cap.commits || [],
            ...(cap.outOfRepoFiles && cap.outOfRepoFiles.length > 0
              ? { outOfRepoFiles: cap.outOfRepoFiles }
              : {}),
          }));
        }
        if (cap.outOfRepoFiles && cap.outOfRepoFiles.length > 0) {
          outOfRepoByIndex.set(cap.promptIndex, cap.outOfRepoFiles);
        }
        // The commit this turn produced. Newest wins when a turn somehow carries
        // several — the UI shows one commit row per turn.
        const commits = Array.isArray(cap.commits) ? cap.commits.filter((c) => typeof c === 'string' && c) : [];
        if (commits.length > 0) commitShaByIndex.set(cap.promptIndex, commits[commits.length - 1]);
      }
      // ONE PRODUCER PER COMMIT. capturePromptEdits attributes a commit to every
      // prompt whose edits it contains — so three turns that all edited the same
      // file each claim the commit that finally landed it. Only the turn that ran
      // `git commit` produced it, which is the LAST (highest-index) claimant; the
      // earlier turns' work was still uncommitted at the time. Without this the
      // server's commit-producer enforcement sees multiple claims for one sha
      // (the "cumulative stamp" class it defends against) and earlier turns
      // render a commit they didn't make.
      const lastClaimBySha = new Map<string, number>();
      for (const [idx, sha] of commitShaByIndex) {
        const prev = lastClaimBySha.get(sha);
        if (prev === undefined || idx > prev) lastClaimBySha.set(sha, idx);
      }
      for (const [idx, sha] of [...commitShaByIndex]) {
        if (lastClaimBySha.get(sha) !== idx) commitShaByIndex.delete(idx);
      }
    } catch (err) {
      debugLog('transcript-watch', 'capturePromptEdits failed', { agent: adapter.slug, err: String(err) });
    }
  }

  // isInsideRepo first: toRepoRelative returns the input unchanged for a file
  // outside the root, and an absolute path does not start with `..`, so the
  // filter alone let ~/.claude memory notes and /tmp scratch through as repo
  // files. See scopeCapturedPath.
  const toRepoRel = (files: string[]): string[] =>
    files
      .filter((f) => isInsideRepo(repo.workRoot, f))
      .map((f) => toRepoRelative(repo.workRoot, f))
      .filter((f) => f && !f.startsWith('..'));

  // editsJson for agents outside the canonical pipeline (Antigravity) that DO
  // record what they wrote. Same contract as above — without editsJson the read
  // path falls back to legacy projections and blanks per-prompt files, which is
  // why agy turns showed correct line counts but "0 files".
  if (editsJsonByIndex.size === 0 && Array.isArray(parsed.promptEdits)) {
    // Chain whole-file rewrites across the SESSION before anything else looks at
    // them. Agents on this branch record a write as the file's ENTIRE new
    // content with no "before", so every turn after the first claims the whole
    // file: a turn that appended 5 rows to a 4-row file rendered as +9 from line
    // 1, showing the previous turn's rows as its own. Giving each rewrite the
    // file's prior in-session content as oldContent turns it back into the
    // delta it actually was. Must run across all prompts at once — chaining
    // per prompt has nothing to chain from.
    const chained: PromptCapture[] = parsed.promptEdits.map((pe) => ({
      promptIndex: pe.promptIndex,
      promptText: '',
      agent: 'claude' as const,
      // `|| e.file` used to be the fallback here, which handed the raw path
      // back the moment toRepoRel rejected it — exactly the out-of-repo files
      // it had just filtered out. A file that isn't this repo's is dropped.
      edits: (pe.edits || []).flatMap((e) => {
        const file = toRepoRel([e.file])[0];
        if (!file) return [];
        return [{
          file,
          op: e.op,
          oldContent: e.oldContent,
          newContent: e.newContent,
          source: 'tool_call',
        }];
      }) as PromptCapture['edits'],
      commits: [],
    }));
    for (const pe of parsed.promptEdits) {
      const outside = outOfRepoWrites(repo.workRoot, (pe.edits || []).map((e) => e.file));
      if (outside.length > 0) outOfRepoByIndex.set(pe.promptIndex, outside);
    }
    try {
      chainWholeFileWrites(chained);
    } catch { /* best-effort: an unchained write is still worth sending */ }

    for (const pe of chained) {
      const edits = pe.edits;
      // Stamp the real line each edit starts at. Agents on this branch build
      // editsJson from their own adapter's records and never pass through the
      // canonical capture, so their edits reached the server with NO position —
      // and the By-Prompt view, which synthesizes a diff from editsJson, then
      // anchors every hunk at line 1. A turn that appended rows 12-16 rendered
      // as "@@ -1,1 +1,6 @@" with Row 11 shown as line 1, which is also what the
      // per-line blame reads. The same anchoring the hook path has always done.
      try {
        // Recover the before-state of any whole-file write first, so a rewrite
        // synthesizes as a real replace instead of a whole-file insertion (all
        // adds, zero deletes — see backfillWriteBaselines). This path had NO
        // coverage: it serves every agent that fires no hooks, which on Windows
        // is every GUI agent. `promptShadows` here is captured per prompt at
        // the moment the prompt is NOTICED — which on a poll is up to one poll
        // interval AFTER it was submitted, so a fast agent's first writes are
        // already in that "baseline". The session-start baseline is passed as
        // the fallback so those writes recover a real before-state instead of
        // collapsing to no-ops (see backfillWriteBaselines; agy 65953fe2 lost
        // 5 files / +422 lines to exactly this).
        backfillWriteBaselines(
          edits as Parameters<typeof backfillWriteBaselines>[0],
          repo.workRoot,
          promptShadows.find((sh) => sh.promptIndex === pe.promptIndex)?.baselineSha || null,
          sessionStartShadowSha || headShaAtStart || null,
        );
        anchorEditPositions(edits as Parameters<typeof anchorEditPositions>[0], repo.workRoot);
      } catch { /* best-effort: an unanchored edit is still worth sending */ }
      // Empty edits[] is still sent — the "this turn touched nothing" signal.
      editsJsonByIndex.set(pe.promptIndex, JSON.stringify({ edits, commits: [] }));
    }
  }

  // Last-resort editsJson: synthesize the per-prompt FILE SET from promptDiffs
  // for any agent that has neither a canonical extractor nor structured
  // promptEdits (Copilot). The server treats editsJson as the authoritative
  // per-prompt record and blanks filesChanged without it — so a turn would show
  // the right line count and diff but "0 files". The file list is what that read
  // path consumes; the diff itself still travels in uncommittedDiff.
  if (editsJsonByIndex.size === 0 && parsed.promptDiffs.length > 0) {
    for (const pd of parsed.promptDiffs) {
      const edits = toRepoRel(pd.filesChanged).map((file) => ({ file, op: 'edit', source: 'tool_call' }));
      editsJsonByIndex.set(pd.promptIndex, JSON.stringify({ edits, commits: [] }));
    }
  }

  // Read a repo-relative file as it stands on disk (the LAST turn's end state).
  const readWorkingFile = (root: string, file: string): string | null => {
    try {
      const abs = path.join(root, file);
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    } catch { return null; }
  };

  // Which turns the TRANSCRIPT records writing each file. This is the authority
  // the window sweep below is checked against — see transcript-attribution.ts.
  // Built even when `promptEdits` produced no editsJson (another path may have
  // won that race); an empty map disables both halves of the check, which is
  // the correct behaviour when the parser saw nothing.
  const transcriptWriters = transcriptWriterTurns(
    parsed.promptEdits,
    (f) => toRepoRel([f])[0] || null,
  );

  // ─── Shell writes → real edits (watcher path) ─────────────────────────
  // The hook path records a write-shaped shell command live at PostToolUse and
  // resolves it at Stop. Agents that fire NO hooks (Gemini, Antigravity,
  // hookless Cursor) only have the transcript, so the same turns arrived here
  // with `edits: []` — indistinguishable from chat-only, which is what every
  // read surface then has to guess about.
  //
  // The window must be bounded by the NEXT turn's baseline, not by the working
  // tree: the watcher polls and routinely processes several finished turns at
  // once, so diffing turn N to the tree in front of us would hand it every
  // later turn's work — the exact mis-attribution this whole area keeps
  // producing. The last turn has no successor, so it alone reads the tree.
  if ((parsed.promptsThatWroteViaShell || []).length > 0 && promptShadows.length > 0) {
    for (const idx of parsed.promptsThatWroteViaShell || []) {
      try {
        const from = promptShadows.find((sh) => sh.promptIndex === idx)?.baselineSha;
        if (!from) continue;
        const next = promptShadows
          .filter((sh) => sh.promptIndex > idx && sh.baselineSha)
          .sort((a, b) => a.promptIndex - b.promptIndex)[0];
        const to = next?.baselineSha || null;
        const files = to
          ? captureShadowRangeDiff(repo.workRoot, from, to).filesChanged
          : filesChangedSinceShadow(repo.workRoot, from);
        if (files.length === 0) continue;
        // Files this turn already carries from a real tool call — never
        // re-derive those; the agent's own payload is the precise record.
        const covered: string[] = [];
        try {
          const existing = JSON.parse(editsJsonByIndex.get(idx) || '{"edits":[]}');
          for (const e of existing.edits || []) {
            if (e && typeof e.file === 'string' && (!e.source || e.source === 'tool_call')) covered.push(e.file);
          }
        } catch { /* unparseable — treat as nothing covered */ }
        // …and files the transcript says ANOTHER turn wrote. The window runs to
        // the next turn's baseline, which the poll takes late, so a fast turn's
        // first writes sit inside its predecessor's window (session 376cc22f:
        // turn 2's README.md landed on turn 1 this way). A file the transcript
        // attributes elsewhere is never this turn's to claim.
        covered.push(...filesRecordedForOtherTurns(transcriptWriters, idx));
        const { edits } = shellWindowEdits(
          {
            listChangedFiles: () => files,
            readAtRev: (sha, file) => readFileAtRev(repo.workRoot, sha, file),
            readWorking: (file) => (to
              ? readFileAtRev(repo.workRoot, to, file)
              : readWorkingFile(repo.workRoot, file)),
          },
          {
            baselineSha: from,
            coveredFiles: covered,
            isIgnored: (file) => isOriginAutoManagedPath(file) || shouldIgnoreFile(file),
          },
        );
        if (edits.length === 0) continue;
        let payload: { edits: unknown[]; commits: unknown[] } = { edits: [], commits: [] };
        try {
          const existing = editsJsonByIndex.get(idx);
          if (existing) payload = JSON.parse(existing);
        } catch { /* start from an empty shell */ }
        if (!Array.isArray(payload.edits)) payload.edits = [];
        if (!Array.isArray(payload.commits)) payload.commits = [];
        payload.edits.push(...edits);
        editsJsonByIndex.set(idx, JSON.stringify(payload));
        debugLog('transcript-watch', 'shell window edits captured', {
          agent: adapter.slug, promptIndex: idx, files: edits.length,
          bounded: to ? 'next-turn baseline' : 'working tree',
          source: SHELL_WINDOW_SOURCE,
        });
      } catch (err) {
        debugLog('transcript-watch', 'shell window capture failed (non-fatal)', {
          agent: adapter.slug, promptIndex: idx, err: String(err),
        });
      }
    }
  }

  // ─── Transcript-vs-attribution check ──────────────────────────────────
  // Prevention above stops a window from claiming another turn's file, but only
  // for windows assembled HERE. An inferred edit can still arrive from a path
  // that never consulted `coveredFiles`, and a turn's payload can be re-sent
  // after the fact. So verify the assembled result against the transcript and
  // re-parent (or drop) anything the window put on the wrong turn.
  if (transcriptWriters.size > 0 && editsJsonByIndex.size > 0) {
    try {
      const payloads = new Map<number, { edits: unknown[]; [k: string]: unknown }>();
      const turnsToCheck: AttributedTurn[] = [];
      for (const [idx, raw] of editsJsonByIndex) {
        let cap: { edits?: unknown[] };
        try { cap = JSON.parse(raw); } catch { continue; }
        if (!Array.isArray(cap.edits)) continue;
        payloads.set(idx, cap as { edits: unknown[] });
        turnsToCheck.push({ promptIndex: idx, edits: cap.edits as AttributedTurn['edits'] });
      }
      const findings = reconcileWindowAttribution(turnsToCheck, transcriptWriters);
      if (findings.length > 0) {
        // Write back only the turns the check actually touched — a turn whose
        // edits are unchanged keeps its existing serialization byte for byte.
        const touched = new Set(findings.flatMap((f) => [f.heldBy, f.recordedBy]));
        for (const turn of turnsToCheck) {
          if (!touched.has(turn.promptIndex)) continue;
          const payload = payloads.get(turn.promptIndex);
          if (!payload) continue;
          payload.edits = turn.edits;
          editsJsonByIndex.set(turn.promptIndex, JSON.stringify(payload));
        }
        debugLog('transcript-watch', 'transcript-attribution corrections', {
          agent: adapter.slug,
          corrections: findings.map((f) => `${f.file}: ${f.heldBy}→${f.recordedBy} (${f.action})`),
        });
      }
    } catch (err) {
      debugLog('transcript-watch', 'transcript-attribution check failed (non-fatal)', {
        agent: adapter.slug, err: String(err),
      });
    }
  }

  // Fallback commit attribution for agents with no canonical extractor
  // (Antigravity, Copilot): match each commit to the LAST prompt that edited a
  // file the commit contains. Same one-producer rule as above — the turn that
  // ran `git commit` is the latest one whose work the commit carries.
  // A turn that printed its own commit SHA needs no matching at all. Resolve
  // the short SHA against the session's commit list (or accept it as-is — the
  // server stores what git printed) and use it directly. This is the only
  // source that stays correct when the watcher joined the session late and
  // never walked the first commit: session dedec2fa committed on turns 2 and 4,
  // the walk saw only the later commit, and order-based pairing left turn 2
  // showing "uncommitted" beside the commit it had just made.
  if (commitShaByIndex.size === 0 && parsed.promptCommitShas) {
    for (const [idxRaw, shas] of Object.entries(parsed.promptCommitShas)) {
      const idx = Number(idxRaw);
      if (!Number.isInteger(idx) || !Array.isArray(shas) || shas.length === 0) continue;
      const short = shas[shas.length - 1];
      // Agents print a SHORT sha (`[branch 73df467]`), and the server can only
      // work with a full one: it matches a prompt's commitSha against the
      // session's own commit rows, and a 7-char value matches nothing. The row
      // then looks like it carries a commit from somewhere else, which makes it
      // eligible for reassignment — so the turn ends up showing `uncommitted`
      // next to the commit it just made (session f7e315db, turn 2).
      //
      // The session's own commit list resolves it when the walk has seen that
      // commit; it hasn't when the watcher joined after the commit landed,
      // which is precisely when this path matters. Ask git directly, and if
      // even git can't resolve it, send nothing — an unusable sha is worse than
      // an honest blank.
      const full = commitCandidates().find((s) => s.startsWith(short))
        || resolveFullSha(repo.workRoot, short);
      if (!full) {
        debugLog('transcript-watch', 'commit sha unresolvable — sending none', {
          agent: adapter.slug, promptIndex: idx, short,
        });
        continue;
      }
      // A resolvable sha still has to be plausibly THIS session's work. Cursor's
      // shas come from the agent's prose, where an old sha can legitimately
      // appear ("reverted `abc1234`"), and prose can't distinguish the two. A
      // commit predating the session by more than a day is not what this turn
      // just made, so leave it unpaired. The bound is deliberately loose: it
      // exists to reject history, not to second-guess clock skew, and the
      // watcher regularly meets commits made minutes BEFORE it saw the session.
      const age = commitAgeMs(repo.workRoot, full, prior?.createdAt);
      if (age !== null && age > 24 * 60 * 60 * 1000) {
        debugLog('transcript-watch', 'commit sha too old for this session — sending none', {
          agent: adapter.slug, promptIndex: idx, short, ageHours: Math.round(age / 3_600_000),
        });
        continue;
      }
      commitShaByIndex.set(idx, full);
      // Make the session OWN it. The walk cannot have produced this sha (that is
      // why we are here), and several consumers key off the session's commit
      // list rather than off the pairing: the session-end per-commit memory
      // resolves its claimed shorts against it, and the rollup reads its
      // subjects. Without this the turn shows the right commit while memory
      // still records nothing for it.
      if (!sessionCommitShas.includes(full)) sessionCommitShas.push(full);
    }
    if (commitShaByIndex.size > 0) {
      debugLog('transcript-watch', 'commit shas read from transcript', {
        agent: adapter.slug, pairs: [...commitShaByIndex].map(([i, s]) => i + ':' + s.slice(0, 8)),
      });
    }
  }

  // Turns that COMMITTED but never printed the sha. Reading the sha out of the
  // agent's summary only works when the agent chose to mention it; plenty of
  // turns just say "done". The command they ran is recorded either way, and the
  // commit message is inside it, so identify the commit by matching the repo's
  // recent subjects against that command text (see matchCommitByCommand).
  //
  // Runs for turns the reported-sha pass could not resolve, and never
  // overwrites one it did: an explicit sha beats an inferred match.
  const unresolvedCommitting = Object.entries(parsed.promptCommitCommands || {})
    .filter(([idxRaw, commands]) =>
      Number.isInteger(Number(idxRaw))
      && !commitShaByIndex.has(Number(idxRaw))
      && Array.isArray(commands) && commands.length > 0);
  // Nothing to resolve → no git calls at all. The watcher polls every 8s, and
  // the common case is that the reported-sha pass already answered.
  if (unresolvedCommitting.length > 0) {
    const candidates = recentCommits(repo.workRoot).filter((c) => {
      // Same window rule as the reported-sha path — a turn quoting an old
      // commit's message must not be able to claim it.
      const age = commitAgeMs(repo.workRoot, c.sha, prior?.createdAt);
      return age === null || age <= 24 * 60 * 60 * 1000;
    });
    for (const [idxRaw, commands] of unresolvedCommitting) {
      const idx = Number(idxRaw);
      // Don't hand two turns the same commit. A repeated match means the
      // message is ambiguous, and a duplicate pairing is a wrong pairing.
      const taken = new Set(commitShaByIndex.values());
      const full = matchCommitByCommand(commands, candidates.filter((c) => !taken.has(c.sha)));
      if (!full) continue;
      commitShaByIndex.set(idx, full);
      if (!sessionCommitShas.includes(full)) sessionCommitShas.push(full);
      debugLog('transcript-watch', 'commit matched by its command message', {
        agent: adapter.slug, promptIndex: idx, sha: full.slice(0, 8),
      });
    }
  }

  if (commitShaByIndex.size === 0 && commitFiles.size > 0) {
    // Prefer the transcript's OWN record of which turns ran `git commit`. Pair
    // those turns with the session's commits in chronological order: the Nth
    // commit belongs to the Nth committing turn.
    //
    // The previous "last turn that edited a file the commit contains" heuristic
    // was ambiguous and non-deterministic: when several turns edit the same file,
    // EVERY commit resolves to the same turn, and since one turn holds one sha
    // each commit overwrote the last — so one turn showed an arbitrary commit,
    // the real committing turns showed none, and the answer changed between
    // polls (a turn would flip committed → uncommitted).
    const committingTurns = (parsed.promptsThatCommitted || []).slice().sort((a, b) => a - b);
    // Chronological commit order: the candidate list is accumulated oldest-first.
    // Keep only commits that actually touch a file THIS session edited — the
    // headShaAtStart..HEAD walk also picks up commits made by other sessions (or
    // by the user) in the same repo during the window, and an unrelated commit in
    // the list shifts the pairing so every turn gets the wrong sha.
    const sessionFiles = new Set(toRepoRel(parsed.filesChanged));
    const orderedShas = commitCandidates().filter((sha) => {
      const files = commitFiles.get(sha);
      return !!files && files.some((f) => sessionFiles.has(f));
    });
    if (committingTurns.length > 0 && orderedShas.length > 0) {
      if (committingTurns.length === orderedShas.length) {
        committingTurns.forEach((turn, i) => commitShaByIndex.set(turn, orderedShas[i]));
      } else {
        // Counts disagree (a commit made outside the session, or a turn that
        // committed nothing). Anchor the newest commit to the last committing
        // turn — the one relationship we can still assert confidently.
        commitShaByIndex.set(committingTurns[committingTurns.length - 1], orderedShas[orderedShas.length - 1]);
      }
    } else {
      // No transcript commit signal at all: fall back to file overlap, but keep
      // it deterministic by walking commits oldest-first and never reusing a turn.
      const taken = new Set<number>();
      for (const sha of commitCandidates()) {
        const files = commitFiles.get(sha);
        if (!files) continue;
        const inCommit = new Set(files);
        let best = -1;
        for (const pd of parsed.promptDiffs) {
          if (taken.has(pd.promptIndex)) continue;
          const rel = toRepoRel(pd.filesChanged);
          if (rel.some((f) => inCommit.has(f)) && pd.promptIndex > best) best = pd.promptIndex;
        }
        if (best >= 0) { commitShaByIndex.set(best, sha); taken.add(best); }
      }
    }
  }

  // Per-commit memory (config memoryUpdate = commit|both). Deliberately keyed
  // off commitShaByIndex — the commits attribution could tie to one of THIS
  // session's prompts — and not off the commit walk. The walk sweeps up
  // whatever else landed in the repo meanwhile: with a Cursor and an
  // Antigravity session running side by side, the walk-based version recorded
  // Cursor's commit under the Antigravity session, with Antigravity's decisions
  // attached. A commit nobody can attribute is left unrecorded; a commit
  // attributed to the wrong agent is worse than a missing one.
  //
  // The trigger is "owned but not yet recorded", never the walk. A Cursor
  // transcript is written at turn end, so its commit is routinely the session's
  // own headShaAtStart and the walk NEVER reports it — session 5c2973be owned
  // 21727e6 and a walk-gated write produced nothing. Nor can the trigger be
  // "newly owned": ownership is persisted the moment it is worked out, so a
  // commit owned by an older build that never recorded it would stay invisible
  // forever. Comparing against what was RECORDED makes the write self-healing —
  // any backlog is caught up on the next poll.
  if (prior && commitShaByIndex.size > 0) {
    try {
      const already = new Set(prior.recordedCommitShas || []);
      const pending = [...new Set(commitShaByIndex.values())].filter((sha) => !already.has(sha));
      if (pending.length > 0) {
        const done = recordCommitMemory(deps, adapter, scanned, prior, pending, now);
        recordedCommitShas = [...new Set([...recordedCommitShas, ...done])];
        if (done.length > 0) {
          debugLog('transcript-watch', 'commit memory written', {
            agent: adapter.slug, sessionId: scanned.sessionId, commits: done.length,
          });
        }
      }
    } catch (err) {
      debugLog('transcript-watch', 'commit memory write failed (non-fatal)', { err: String(err) });
    }
  }

  const agentFilesRel = toRepoRel(parsed.filesChanged);

  // Per-turn attribution in FINAL-file coordinates, walked over the session's
  // own shadow commits (see final-state-blame.ts). A turn's captured diff is
  // anchored to the file as it looked when that turn ran, so once a later turn
  // deletes or inserts above, those coordinates describe positions that no
  // longer exist — and the dashboard, which renders the file as it is now, has
  // no way to correct for it. These hunks carry only each turn's SURVIVING
  // lines, all in one coordinate system, so they compose across turns.
  //
  // Purely additive: an unverifiable chain yields nothing and every existing
  // field is untouched.
  // The authoritative per-line record: every line of every touched file with
  // the turn that wrote it (or null when it predates the session). The server
  // renders this directly instead of choosing between six diff sources.
  let lineMaps: FileLineMap[] = [];

  try {
    if (promptShadows.length > 0 && editsJsonByIndex.size > 0) {
      const finalByPrompt = finalHunksForCaptures(
        repo.workRoot,
        promptShadows,
        editsJsonByIndex,
        prior?.sessionStartShadowSha || headShaAtStart || null,
      );
      for (const [idx, hunks] of finalByPrompt) {
        let payload: Record<string, unknown> = { edits: [], commits: [] };
        const raw = editsJsonByIndex.get(idx);
        if (raw) {
          try { payload = JSON.parse(raw); } catch { /* keep the empty shell */ }
        }
        const withHunks = JSON.stringify({ ...payload, finalHunks: hunks });
        // editsJson is size-capped downstream; a huge file's line content would
        // push the real edits out of the payload. Better to ship the turn's
        // edits without final coordinates than to lose both.
        if (withHunks.length <= 60_000) editsJsonByIndex.set(idx, withHunks);
      }
      lineMaps = computeFileLineMaps(
        repo.workRoot,
        promptShadows,
        editsJsonByIndex,
        prior?.sessionStartShadowSha || headShaAtStart || null,
      );
      if (lineMaps.length > 0) {
        debugLog('transcript-watch', 'line maps', {
          agent: adapter.slug,
          files: lineMaps.map((m) => `${m.file}:${m.total}L/${m.runs.length}runs`),
        });
      }
    }
  } catch (err) {
    debugLog('transcript-watch', 'final-state hunks failed (non-fatal)', {
      agent: adapter.slug, sessionId: scanned.sessionId, err: String(err),
    });
  }

  const promptChanges: any[] = [];
  // ONE stamp for the whole pass: every row this pass writes describes the
  // same capture, which is exactly what the server needs to order them.
  const captureStamp = newCaptureStamp('w');
  // Stable identity for every prompt this session has, carried from the prior
  // pass so an id is minted once and then reused. Persisted below with the
  // rest of the watch state.
  const latestIndex = newCount - 1;

  // Files EARLIER prompts already claim.
  //
  // The in-flight prompt falls back to the session-wide edited-file list when
  // its own transcript mapping is empty (`agentFilesRel`), and captureFilesDiff
  // measures those files against HEAD rather than against this turn's baseline.
  // Without this subtraction a turn that only chatted re-reports every
  // uncommitted line the session has accumulated, and an UNTRACKED file is
  // re-counted in full every time (captureFilesDiff renders untracked files as
  // entirely added).
  //
  // Observed on session 4308e5b5: three consecutive chat-only turns each
  // duplicated their predecessor exactly (+9/-0, +31/-1, +337/-6), summing to
  // +1278/-31 per-turn against a true session diff of +179/-0. The session and
  // commit diffs were right throughout — only the per-turn split was wrong,
  // which is why the headline totals never looked alarming.
  //
  // This is the same rule the snapshot gate below already applied to decide
  // whether a turn touched code; it just never reached the payload itself.
  const claimedByEarlier = new Set<string>();
  for (const pd of parsed.promptDiffs) {
    if (pd.promptIndex >= latestIndex) continue;
    for (const f of toRepoRel(pd.filesChanged)) claimedByEarlier.add(f);
  }
  const unclaimedSessionFiles = agentFilesRel.filter((f) => !claimedByEarlier.has(f));
  for (let i = 0; i < newCount; i++) {
    const mapping = parsed.promptDiffs.find((pd) => pd.promptIndex === i);
    let files = mapping ? toRepoRel(mapping.filesChanged) : [];
    // Put the transcript diff in the SAME path space as `files` above. The
    // adapter builds it from the agent's own edit records, which for an agent
    // with no cwd on disk (Antigravity) carry absolute paths — so the body
    // named `.../worktrees/repo/branch/app.py` while `files` said `app.py`, and
    // it also still carried sections for files `toRepoRel` had just dropped as
    // out-of-repo. Recount afterwards: dropping a section changes the totals,
    // and a diff whose body disagrees with its own +/- is worse than either.
    const rawDiff = mapping?.diff || '';
    let diff = scopeDiffPathsToRepo(repo.workRoot, rawDiff);
    let linesAdded = mapping?.linesAdded || 0;
    let linesRemoved = mapping?.linesRemoved || 0;
    if (diff !== rawDiff) {
      // Only when scoping actually removed something. The adapter's counts are
      // authoritative for the diff it produced and need not be derivable from
      // its body — an agent that reports totals without a full patch is a real
      // shape, so recounting unconditionally would overwrite good numbers with
      // whatever the body happened to contain.
      const counts = countDiffLines(diff);
      linesAdded = counts.linesAdded;
      linesRemoved = counts.linesRemoved;
    }

    if (i === latestIndex) {
      // For the IN-FLIGHT prompt the WORKING TREE is authoritative for still-
      // uncommitted files — it has the real current content, whereas a
      // transcript's edit content can be partial (Cursor reports a summary, so
      // its line counts are wrong) or absent. So prefer a working-tree diff of
      // the edited files; keep the transcript diff only when the tree shows
      // nothing (already committed / clean); then the shadow-baseline tree diff
      // as a last resort.
      const candidateFiles = files.length ? files : unclaimedSessionFiles;
      if (candidateFiles.length && deps.captureFilesDiff) {
        const wd = deps.captureFilesDiff(repo.workRoot, candidateFiles);
        if (wd.diff && !transcriptDiffBeatsWindow(
          { linesAdded, linesRemoved, diff },
          wd,
          adapter.transcriptDiffIsDelta === true,
        )) {
          diff = wd.diff; linesAdded = wd.linesAdded; linesRemoved = wd.linesRemoved;
          files = wd.filesChanged.length ? wd.filesChanged : candidateFiles;
        }
      }
      if (!diff) {
        // LAST-RESORT WINDOW: everything that changed between this turn's
        // baseline and the working tree. It catches work no transcript records
        // — shell writes, an editor the agent drove indirectly — which is why
        // it is unscoped.
        //
        // Unscoped also means it catches whatever ELSE landed in the checkout.
        // A `git pull` or a sibling agent's merge during the turn moves files
        // this session never touched, and the window reports them as the turn's
        // work. Prod fdf299d3 turn 10: 17 files, exactly commit 9f811c65f from
        // a concurrent session, and none of the three files the turn actually
        // edited.
        const baseline = promptShadows.find((s) => s.promptIndex === i)?.baselineSha || null;
        const d = deps.captureDiff(repo.workRoot, baseline);
        if (d.diff || d.filesChanged.length) {
          // Files that moved only because a commit we do NOT own landed in the
          // window. `sessionCommitShas` is ownership (#1306); anything in the
          // range walk beyond it belongs to somebody else.
          const ownedSet = new Set(sessionCommitShas.map((sha) => sha.toLowerCase()));
          const foreignFiles = new Set<string>();
          for (const sha of rangeCommitShas) {
            if (ownedSet.has(sha.toLowerCase())) continue;
            for (const f of (commitFiles.get(sha) || [])) foreignFiles.add(f);
          }
          // A file the agent itself edited stays even when a foreign commit
          // also touched it — our change is really in the tree, and dropping it
          // would lose real work to fix an over-report.
          const agentEdited = new Set(agentFilesRel);
          const dFiles = toRepoRel(d.filesChanged);
          const kept = dFiles.filter((f) => !foreignFiles.has(f) || agentEdited.has(f));

          if (kept.length === dFiles.length) {
            // Nothing foreign in the window — the common case, untouched.
            diff = d.diff; linesAdded = d.linesAdded; linesRemoved = d.linesRemoved;
            files = files.length ? files : d.filesChanged;
          } else if (kept.length > 0 && deps.captureFilesDiff) {
            // Re-measure the survivors. Filtering the file list without
            // recomputing the diff would leave the row's files and line counts
            // describing different sets — the mosaic shape this whole area
            // exists to prevent.
            const rescoped = deps.captureFilesDiff(repo.workRoot, kept);
            diff = rescoped.diff;
            linesAdded = rescoped.linesAdded;
            linesRemoved = rescoped.linesRemoved;
            files = files.length ? files : (rescoped.filesChanged.length ? rescoped.filesChanged : kept);
            debugLog('transcript-watch', 'dropped foreign-commit files from turn window', {
              agent: adapter.slug, promptIndex: i,
              dropped: dFiles.length - kept.length, kept: kept.length,
            });
          } else if (kept.length === 0) {
            // Every file in the window came from someone else's commit. The
            // turn gets nothing here rather than another session's work; the
            // fallbacks below still run.
            debugLog('transcript-watch', 'turn window was entirely foreign — attributing none', {
              agent: adapter.slug, promptIndex: i, dropped: dFiles.length,
            });
          } else {
            // Cannot re-measure (captureFilesDiff not wired). Keeping the
            // unfiltered result is wrong, and a filtered list with unfiltered
            // counts is worse, so take neither.
            debugLog('transcript-watch', 'foreign files in window but no re-measure available', {
              agent: adapter.slug, promptIndex: i,
            });
          }
        }
      }
      // Report the session's edited-file list if nothing else surfaced files —
      // minus what earlier turns already claim, so a chat-only turn stays empty.
      if (files.length === 0) files = unclaimedSessionFiles;
    }

    // COMMITTING TURN WITH NO RECORDED EDITS. Cursor logs no file-edit when the
    // agent works through the terminal, so that turn's transcript mapping comes
    // back empty — and the working-tree recovery above only runs for the LATEST
    // turn. When two prompts land inside one poll the turn is never latest, so
    // it stays blank forever: no diff, no files, a grey badge and missing from
    // the "N with changes" count, even though it demonstrably changed code
    // (session 7ff68eb7 turn 1, "add 5 more rows and commit").
    //
    // If such a turn owns a commit, git still knows what it did: diff its
    // baseline tree against the commit tree, scoped to that commit's files.
    // That yields the turn's OWN contribution (+5) rather than the commit's
    // headline total (+16 — the file was untracked, so the commit adds all of
    // it, including the 11 lines the previous turn already claims).
    if (!diff && files.length === 0 && commitShaByIndex.has(i) && deps.captureCommitScoped) {
      const sha = commitShaByIndex.get(i)!;
      const baseline = promptShadows.find((s) => s.promptIndex === i)?.baselineSha || null;
      const commitOwnFiles = commitFiles.get(sha) || [];
      let scoped: { diff: string; linesAdded: number; linesRemoved: number } | null = null;
      try {
        scoped = deps.captureCommitScoped(repo.workRoot, baseline, sha, commitOwnFiles);
      } catch {
        scoped = null; // best-effort recovery; never break the poll
      }
      // Only adopt a result that actually carries work — an empty one must fall
      // through and leave the turn as-is rather than cement the blank row.
      if (scoped && scoped.linesAdded + scoped.linesRemoved > 0) {
        diff = scoped.diff;
        linesAdded = scoped.linesAdded;
        linesRemoved = scoped.linesRemoved;
        if (commitOwnFiles.length) files = commitOwnFiles;
      }
    }

    // Claiming authority over an EMPTY payload is what makes a blank turn
    // permanent: the server replaces diff/uncommittedDiff/filesChanged wholesale
    // for an authoritative write, so a poll that recovered nothing would wipe a
    // good capture from an earlier poll. Assert authority only when we actually
    // carry content; otherwise let the server's fill-only policy preserve it.
    // An editsJson only counts as content when it actually holds edits — the
    // last-resort synthesis above emits `{"edits":[],"commits":[]}` for EVERY
    // turn, so a bare `.has(i)` would treat an empty turn as authoritative and
    // defeat the guard. Mirrors the server's own editsJsonHasEdits rule.
    const editsJsonForTurn = editsJsonByIndex.get(i);
    const editsJsonHasEdits = (() => {
      if (!editsJsonForTurn) return false;
      try {
        const cap = JSON.parse(editsJsonForTurn);
        return Array.isArray(cap?.edits) && cap.edits.length > 0;
      } catch { return false; }
    })();
    const carriesContent = !!diff || files.length > 0 || editsJsonHasEdits;

    // The prompt's REAL submit time, straight from the transcript.
    //
    // Without this the server has nothing to store and PromptChange.createdAt
    // defaults to the DB insert time — i.e. whenever this watcher happened to
    // poll. That is not when the user submitted, and the skew is large enough
    // to corrupt attribution: prod session 03a338b8 recorded commit 5f6c7a37 at
    // 19:08:24 while the prompt that produced it was stamped 19:08:58 — the
    // turn's own commit appearing to predate the turn by 34s. Every
    // timestamp-based rule downstream (which turn was active at commit time,
    // intent windows, ordering) then reasons from a fiction.
    //
    // The parser already exposes `promptTimestamps` ("epoch-ms per prompt,
    // aligned") and the code below uses it for session duration; codex-watch
    // threads it through as promptStartedAt. This watcher simply never sent it.
    // The server accepts epoch-ms or ISO and validates the range
    // (parsePromptCreatedAt in routes/mcp.ts), so a 0/absent value is omitted
    // rather than sent as a bogus epoch.
    const promptTs = (parsed.promptTimestamps || [])[i];
    promptChanges.push({
      promptIndex: i,
      // Identity, as distinct from position. The server prefers turnId when
      // present, so this row lands on the turn it describes even after the
      // transcript renumbers underneath us.
      ...(promptTurns[i]?.turnId ? { turnId: promptTurns[i].turnId } : {}),
      promptText: (parsed.userPrompts[i] || '').slice(0, 1000),
      ...(typeof promptTs === 'number' && promptTs > 0 ? { createdAt: promptTs } : {}),
      filesChanged: files,
      ...(diff ? { uncommittedDiff: diff.slice(0, MAX_PROMPT_DIFF_LEN) } : {}),
      linesAdded,
      linesRemoved,
      checkpointType: 'auto',
      // Provenance for THIS pass. Without it the server cannot order this
      // payload against the hook path's, and treats it as always-newer.
      ...captureStamp,
      ...(editsJsonByIndex.has(i) ? { editsJson: editsJsonByIndex.get(i) } : {}),
      ...(outOfRepoByIndex.has(i) ? { outOfRepoFiles: outOfRepoByIndex.get(i) } : {}),
      ...(commitShaByIndex.has(i) ? { commitSha: commitShaByIndex.get(i) } : {}),
      // The watcher re-reads the WHOLE transcript every poll and recomputes each
      // turn from scratch, so this payload IS the ground truth for the prompt —
      // the same guarantee Codex's rollout backfill makes. Without this flag the
      // server's default "preserve existing / fill-only" policy makes a bad
      // earlier capture permanent: files=[] and an inflated cumulative
      // linesAdded from a pre-fix client could never be corrected.
      ...(carriesContent ? { authoritative: true } : {}),
    });
  }

  const joinedPrompt = parsed.userPrompts.join('\n\n---\n\n');

  // Duration and cost. The watcher never sent either, so every watcher-captured
  // session showed "0ms" and "$0.00" on the dashboard.
  //
  // Duration = session start → last transcript activity. We use the transcript's
  // own timestamps (earliest start, latest prompt) rather than wall-clock "now",
  // so a session that ended before the watcher noticed it still reports the real
  // elapsed time instead of growing forever while the daemon polls.
  const startMs = parsed.sessionStartedAtMs
    || (parsed.promptTimestamps || []).filter((t) => t > 0).sort((a, b) => a - b)[0]
    || 0;
  // Prefer the transcript's own LAST timestamp. The file's mtime is a poor end
  // signal: anything that rewrites the file moves it, and for an already-finished
  // session the duration would otherwise stretch to "whenever the daemon last
  // looked" (a 56s Copilot session measured 7h that way).
  const lastActivityMs = parsed.sessionLastActivityMs
    || Math.max(0, ...(parsed.promptTimestamps || []).filter((t) => t > 0))
    || scanned.mtimeMs
    || 0;
  const durationMs = startMs > 0 && lastActivityMs > startMs ? lastActivityMs - startMs : 0;

  // Cost from the same estimator the hook path uses, so watcher and hook
  // sessions are priced identically. Cache tokens are passed separately because
  // cache reads bill far cheaper than fresh input.
  let costUsd = 0;
  try {
    costUsd = estimateCost(
      parsed.model || adapter.slug,
      parsed.inputTokens,
      parsed.outputTokens,
      parsed.cacheReadTokens || 0,
      parsed.cacheCreationTokens || 0,
    );
  } catch { /* pricing unavailable — leave 0 rather than guess */ }

  // What actually goes on the wire, per turn. Inference has been wrong three
  // times on this: the capture computes a commit SHA, the daemon logs it, the
  // server updates every other field on the same row, and the SHA still lands
  // null. Log the payload itself so the next poll settles where it is lost.
  if (promptChanges.length > 0) {
    debugLog('transcript-watch', 'payload commit shas', {
      agent: adapter.slug,
      sessionId: scanned.sessionId,
      turns: promptChanges.map((pc: any) => `${pc.promptIndex}:${pc.commitSha ? String(pc.commitSha).slice(0, 8) : 'none'}`),
    });
  }

  let updateOk = false;
  // Set when the server says the session id we hold no longer exists.
  let sessionGone = false;
  try {
    const updatePayload = {
      prompt: joinedPrompt || undefined,
      transcript: parsed.transcript || undefined,
      model: parsed.model || undefined,
      tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
      inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
      outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
      toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
      // Per-tool chips. Sent alongside the total so the two can't disagree;
      // omitted when the adapter can't break its count down.
      toolBreakdown: parsed.toolBreakdown?.length ? parsed.toolBreakdown : undefined,
      durationMs: durationMs > 0 ? durationMs : undefined,
      costUsd: costUsd > 0 ? costUsd : undefined,
      promptChanges: promptChanges.length > 0 ? promptChanges : undefined,
      lineMaps: lineMaps.length > 0 ? lineMaps : undefined,
      gitCapture,
      status: 'RUNNING',
    };
    // Size the timeout to the payload. This PATCH carries the session's whole
    // state and grows all session long, so on the 8s default it eventually
    // aborts at exactly 8s EVERY poll — the watcher rebuilds the same payload
    // each time, so the server's copy freezes while local capture keeps working
    // (session 1271f66c: four consecutive 8.0s aborts, 35 minutes stale, the
    // turn captured correctly with its 7 files and commit the whole time).
    await deps.api.updateSession(originSessionId, updatePayload, {
      timeoutMs: timeoutForPayload(JSON.stringify(updatePayload).length),
    });
    updateOk = true;
  } catch (err) {
    debugLog('transcript-watch', 'updateSession failed', { agent: adapter.slug, sessionId: scanned.sessionId, err: String(err) });
    // A server that says the session is GONE will say it again every poll: the
    // id we hold is dead and re-sending it can never start working. Observed on
    // this machine as the same "Session not found" every 8 seconds for hours —
    // and each of those polls did a full git pass first, which is exactly the
    // console-window flapping. Drop the id so the next poll re-creates the
    // session (startSession keys on agentSessionId, so it re-attaches to the
    // same conversation rather than forking it).
    if (SESSION_GONE_RE.test(String(err))) sessionGone = true;
    // Fall through — persist state so we don't re-create shadows next poll.
  }

  const startedAtIso = prior?.createdAt || new Date(now).toISOString();

  // Write the `.git/origin-session-<tag>.json` state file in the session-state.ts
  // shape. This is what makes commit/PR/AI-blame attribution work on Windows:
  // the local git hooks (which DO fire on `git commit`/`git push`) find this
  // active session by scanning these files and attribute the commit, stamp the
  // Origin-Session trailer, and write+push refs/notes/origin. Rewritten every
  // poll so the file's mtime keeps the session "alive" (no heartbeat needed).
  //
  // CARRY what this writer does not own. saveSessionState serializes the whole
  // object, so every field missing from the literal below is not "left alone" —
  // it is ERASED. The hook path's re-attach literal carries these four for
  // exactly that reason (#1341); this literal never did, and it is rewritten
  // every POLL_INTERVAL_MS, so on any agent where both paths run (Cursor,
  // Antigravity) the watcher wiped the hook path's turn identities within
  // 8 seconds of them being minted.
  //
  // Measured on prod session b46ec40f (Cursor): the first Stop hook sent
  // `t:"t_ebe0674b"`, the watcher polled 4 seconds later, and all 15 payloads
  // after it sent `t:null`. With no turnId every writer falls back to POSITION,
  // and position is not stable — Cursor injected a follow-up prompt mid-session
  // and the watcher's own log shows the commit moving from turn 1 to turn 2
  // twenty seconds apart. Rows written before the shift kept their old index,
  // so one turn's diff landed on another turn's row: the page ended up showing
  // +534/-0 and +134/-34 for turns nothing had ever sent those numbers for.
  //
  // The same session shows the second symptom. This literal also wrote
  // `prePromptSha: null`, and handleAfterFileEdit bails on a state with no
  // prePromptSha — `ABORT: missing repoPath or prePromptSha`, 34 times, every
  // Cursor file edit in that session. With no edit evidence the turn's diff
  // falls back to a source that has no "before" content, so a whole-file
  // rewrite reads as pure additions: turn 2 was captured `a:604, r:0` while the
  // agent itself reported -97 and -14, and the commit says -116 against the
  // session's -34.
  //
  // So this carries the prior file WHOLESALE rather than a hand-picked list.
  // A list is what failed here: #1341 named four fields for the hook path's
  // literal and this one was never updated, and any field a future hook starts
  // writing would be silently erased again. The prior file IS this session's
  // own state; the watcher's fields below are the ones it actually observed.
  const carried = (() => {
    try {
      const prev = deps.loadGitState?.(repo.workRoot, sessionTag) || null;
      if (!prev) return {} as Record<string, unknown>;
      // activeTurn is the one field that must NOT survive: a turn left open by
      // a missed close attests the next commit to a turn that ended long ago
      // (#1334). Same rule the hook path's re-attach applies.
      const { activeTurn: _dropped, ...rest } = prev as Record<string, unknown>;
      return rest;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  try {
    deps.saveGitState?.({
      ...carried,
      sessionId: originSessionId,             // the SERVER session id
      claudeSessionId: scanned.sessionId,     // required by loadSessionState
      agentSessionId: scanned.sessionId,
      sessionTag,
      transcriptPath: scanned.transcriptPath,
      model: parsed.model || adapter.slug,
      agentSlug: adapter.agentSlugForServer,
      startedAt: startedAtIso,
      prompts: parsed.userPrompts,
      repoPath: repo.workRoot,
      canonicalRepoPath: repo.repoPath,
      lastCwd: cwd,
      branch: repo.branch || null,
      headShaAtStart: headShaAtStart || null,
      // These two are the hook path's to set, and the watcher does not observe
      // them — so it must not write null OVER a real value. `prePromptSha` is
      // the per-turn baseline handleAfterFileEdit requires; nulling it every
      // poll is what silently disabled Cursor's edit capture (see above).
      headShaAtLastStop: (carried.headShaAtLastStop as string | null | undefined) ?? null,
      prePromptSha: (carried.prePromptSha as string | null | undefined) ?? null,
      sessionStartShadowSha,
      sessionCommitShas,
      promptShadows: promptShadows.map((s) => ({ promptIndex: s.promptIndex, shadowSha: s.baselineSha, capturedAt: s.capturedAt })),
      status: 'RUNNING',
    }, repo.workRoot, sessionTag);
  } catch (err) {
    debugLog('transcript-watch', 'saveGitState failed', { agent: adapter.slug, sessionId: scanned.sessionId, err: String(err) });
  }

  // Register ONE snapshot per prompt so the dashboard's Snapshots view and
  // restore points are populated (the hook path does this via createSnapshot +
  // api.uploadSnapshot; the watcher has no hooks, so it does it here).
  //
  // Once per PROMPT, not once per poll: the daemon re-polls every 8s, so a long
  // turn used to accumulate a snapshot per tick — which the UI renders as a rail
  // of green dots under the turn number, and which buries the real restore
  // points. The hook path snapshots at meaningful boundaries; this matches it.
  // ...and only for a prompt that actually TOUCHED CODE. createSnapshot's dedup
  // is not the "did anything change?" test it's assumed to be: it returns null
  // only when the whole working tree is clean, or when the tree is byte-identical
  // to the previous snapshot. In a repo carrying pre-existing dirt the first can
  // never fire, so any unrelated tree movement — the user editing a file, another
  // agent, a sibling session — mints a snapshot that gets stamped with whatever
  // prompt happens to be current. That is how a chat-only turn ends up wearing a
  // green dot in the Session view.
  //
  // "Touched code" is deliberately NOT just `linesAdded + linesRemoved > 0`. That
  // was the gate removed from the Stop hook (hooks.ts) for locking out Cursor
  // mid-turn prompts, and line counts genuinely are unrecoverable sometimes — a
  // poll whose shadow baseline was captured after the edit lands reports 0 for a
  // turn that demonstrably wrote a file. So files count as evidence too.
  //
  // But only files THIS prompt can claim. The payload above already subtracts
  // what earlier prompts claim before using the session-wide list, so `latest`
  // no longer arrives pre-inflated; this filter still stands because a turn's
  // OWN mapping can legitimately name a file an earlier turn also touched, and
  // re-editing a file someone else already claimed is not new evidence of work.
  //
  // Deliberately not latched into snapshottedPrompts when it skips: a turn polled
  // mid-flight legitimately reads empty before the edit lands, and has to stay
  // eligible for the next poll.
  // Deliver this session's commits. Without it the server only ever sees the
  // reconstruction it builds from per-prompt captures, which leaves
  // additions/deletions null ON PURPOSE (a turn's scoped counts are not the
  // commit's) — so the "commit total" chip never renders and the subject stays
  // empty. The hook path has always ingested; the watcher, the only capture
  // path for an agent that fires no hooks, never did.
  //
  // After the update, and best-effort: a commit we fail to send stays out of
  // `ingestedCommitShas` and is retried next poll, and nothing here may take
  // down the capture that already succeeded.
  const ingestedCommitShas = Array.isArray(prior?.ingestedCommitShas) ? [...prior!.ingestedCommitShas] : [];
  if (updateOk && deps.ingestCommits && deps.readCommitForIngest) {
    for (const sha of pendingCommitIngests(sessionCommitShas, ingestedCommitShas)) {
      const commit = deps.readCommitForIngest(repo.workRoot, sha);
      if (!commit) continue;
      try {
        await deps.ingestCommits({
          repoPath: repo.repoPath,
          ...(repo.repoUrl ? { repoUrl: repo.repoUrl } : {}),
          commits: [commit],
        });
        ingestedCommitShas.push(sha);
      } catch (err) {
        debugLog('transcript-watch', 'commit ingest failed — will retry', {
          agent: adapter.slug, sessionId: scanned.sessionId, sha: sha.slice(0, 8), err: String(err),
        });
      }
    }
  }

  const snapshottedPrompts = Array.isArray(prior?.snapshottedPrompts) ? [...prior!.snapshottedPrompts] : [];
  if (updateOk && latestIndex >= 0 && !snapshottedPrompts.includes(latestIndex)) {
    const latest = promptChanges.find((c) => c.promptIndex === latestIndex);
    // Shares `claimedByEarlier` with the payload above — two copies of this rule
    // is how the payload kept inflating while the snapshot gate stayed correct.
    const ownFiles = (latest?.filesChanged || []).filter((f: string) => !claimedByEarlier.has(f));
    const touchedCode = (latest?.linesAdded || 0) + (latest?.linesRemoved || 0) > 0 || ownFiles.length > 0;
    if (!touchedCode) {
      debugLog('transcript-watch', 'snapshot skipped: prompt touched no code', {
        agent: adapter.slug, sessionId: scanned.sessionId, promptIndex: latestIndex,
      });
    } else {
      try {
        await deps.registerSnapshot?.(repo.workRoot, originSessionId, {
          sessionTag,
          model: parsed.model || undefined,
          promptIndex: latestIndex,
          transcriptPath: scanned.transcriptPath,
          filesChanged: latest?.filesChanged || [],
          linesAdded: latest?.linesAdded || 0,
          linesRemoved: latest?.linesRemoved || 0,
        });
        snapshottedPrompts.push(latestIndex);
      } catch (err) {
        debugLog('transcript-watch', 'registerSnapshot failed', { agent: adapter.slug, sessionId: scanned.sessionId, err: String(err) });
      }
    }
  }

  const next: SessionWatchState = {
    agentSlug: adapter.slug,
    sessionId: scanned.sessionId,
    // Dropped when the server disowned it, so the next poll starts a session
    // instead of PATCHing a dead id forever.
    originSessionId: sessionGone ? null : originSessionId,
    repoPath: repo.repoPath,
    workRoot: repo.workRoot,
    promptCount: newCount,
    promptShadows,
    createdAt: startedAtIso,
    lastTranscriptMtime: scanned.mtimeMs,
    promptTurns,
    // Re-stat rather than reuse the value read above: the agent may have
    // appended during this pass, and recording the pre-pass size would let the
    // next poll call that append "unchanged".
    lastTranscriptSize: transcriptSize(scanned.transcriptPath) ?? undefined,
    // Re-read AFTER the capture, not reused from the guard: the agent may have
    // written more while we worked, and storing the pre-capture value would
    // make the next poll believe it had already measured those writes.
    lastTreeFingerprint: deps.treeFingerprint?.(repo.workRoot) ?? null,
    lastHeadSha: headNow || prior?.lastHeadSha || undefined,
    status: 'RUNNING',
    headShaAtStart,
    // We now send ALL prompts' per-turn diffs every poll, so the backfill is
    // implicit — latch true once the first update lands.
    initialBackfillSent: (prior?.initialBackfillSent ?? false) || updateOk,
    sessionTag,
    sessionStartShadowSha,
    sessionCommitShas,
    recordedCommitShas,
    ingestedCommitShas,
    snapshottedPrompts,
  };
  deps.saveState(next);
  return next;
}

// Sweep RUNNING sessions that fell OUTSIDE every adapter's active scan window
// before we could end them (e.g. the daemon was down while a session went idle).
// Ends any whose last transcript write is older than the idle threshold and that
// weren't seen this cycle.
export async function sweepIdleSessionStates(
  seen: Set<string>,
  deps: WatchDeps,
): Promise<void> {
  const now = deps.now();
  for (const st of listSessionStates(deps.stateDir)) {
    if (st.status !== 'RUNNING') continue;
    const key = `${st.agentSlug}:${st.sessionId}`;
    if (seen.has(key)) continue;
    if (now - st.lastTranscriptMtime <= deps.idleMs) continue;
    if (st.originSessionId) {
      try { await deps.api.updateSession(st.originSessionId, { status: 'ENDED' }); } catch { /* best-effort */ }
    }
    deps.saveState({ ...st, status: 'ENDED', endedAt: new Date(now).toISOString() });
  }
}

// ─── Cloud commands (restore) ────────────────────────────────────────────────
//
// The dashboard's "Run from cloud" restore QUEUES a command that the CLI is
// expected to collect on its next session ping — historically only the heartbeat
// pinged, so watcher-captured sessions (which run no heartbeat) left the dialog
// stuck on "Waiting for CLI heartbeat to pick it up…" forever. The watcher now
// pings each running session it owns and executes any queued restore itself,
// mirroring handleRestore in heartbeat.ts (soft = files only, hard = reset HEAD).
export async function handleCloudCommands(
  state: SessionWatchState,
  deps: WatchDeps,
): Promise<void> {
  if (!state.originSessionId || state.status !== 'RUNNING') return;
  let command: { type?: string; commitSha?: string; treeSha?: string; mode?: 'soft' | 'hard' } | undefined;
  try {
    const res: any = await deps.pingSession?.(state.originSessionId);
    command = res?.command;
  } catch { return; /* offline — retry next poll */ }
  if (!command || command.type !== 'restore') return;

  const mode: 'soft' | 'hard' = command.mode === 'hard' ? 'hard' : 'soft';
  const sha = command.commitSha || command.treeSha || '';
  const report = (status: 'success' | 'failed', message: string) =>
    deps.reportCommandResult?.(state.originSessionId!, 'restore', status, message).catch(() => {});

  if (!/^[a-fA-F0-9]{4,64}$/.test(sha)) { await report('failed', 'Invalid or missing SHA'); return; }
  if (mode === 'hard' && !command.commitSha) { await report('failed', 'hard mode requires commitSha'); return; }
  try {
    // Never destroy uncommitted work — stash first, exactly like the manual
    // `origin rewind` path, so `git stash pop` recovers it.
    let stashed = false;
    if (git(['status', '--porcelain'], { cwd: state.workRoot }).trim()) {
      git(['stash', 'push', '-m', 'origin-restore-backup'], { cwd: state.workRoot });
      stashed = true;
    }
    if (mode === 'hard') git(['reset', '--hard', sha], { cwd: state.workRoot });
    else git(['checkout', sha, '--', '.'], { cwd: state.workRoot });
    await report('success', `Restored to ${sha.slice(0, 12)} (${mode})${stashed ? ' — prior changes stashed' : ''}`);
  } catch (err: any) {
    await report('failed', String(err?.message || err));
  }
}

// One full poll cycle: scan every adapter, reconcile each active session, sweep
// idle leftovers. A single adapter throwing (bad store dir, parse crash) must
// not sink the whole cycle.
export async function runWatchCycle(
  adapters: TranscriptAdapter[],
  deps: WatchDeps,
): Promise<void> {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    let scannedList: ScannedTranscript[] = [];
    try {
      scannedList = adapter.listActive(deps.now());
    } catch (err) {
      debugLog('transcript-watch', 'listActive error', { agent: adapter.slug, err: String(err) });
      continue;
    }
    // Collapse to one transcript per session id, newest write wins. A single
    // conversation can surface as multiple files (e.g. an agent's chat log plus
    // a checkpoint); reconciling both would fork/thrash one Origin session.
    // Mirrors codex-watch's newest-per-thread filter (listActiveRollouts).
    const bySession = new Map<string, ScannedTranscript>();
    for (const s of scannedList) {
      const cur = bySession.get(s.sessionId);
      if (!cur || s.mtimeMs > cur.mtimeMs) bySession.set(s.sessionId, s);
    }
    for (const s of bySession.values()) {
      seen.add(`${adapter.slug}:${s.sessionId}`);
      try {
        const st = await reconcileSession(s, adapter, deps);
        // Pick up any dashboard-queued restore for this session (the watcher is
        // the only live CLI for watcher-captured sessions).
        if (st) await handleCloudCommands(st, deps).catch(() => {});
      } catch (err) {
        debugLog('transcript-watch', 'reconcile error', { agent: adapter.slug, sessionId: s.sessionId, err: String(err) });
      }
    }
  }
  await sweepIdleSessionStates(seen, deps);
}

// ─── Single-instance guard ───────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// True when a live watcher already owns the pid file (a different, running pid).
export function anotherWatcherRunning(pidFile = watchPidFile()): boolean {
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

// True when THIS process no longer owns the pid file and must exit (a concurrent
// start overwrote the file with its pid).
export function watcherSuperseded(pidFile = watchPidFile()): boolean {
  try {
    if (!fs.existsSync(pidFile)) return true;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false; // garbage → don't self-destruct
    return pid !== process.pid;
  } catch {
    return false;
  }
}

function writeOwnPid(pidFile = watchPidFile()): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
}

// ─── Auto-start gating ───────────────────────────────────────────────────────

// Whether `origin enable` should auto-start the watcher on this machine. Gated
// to Windows for now; ORIGIN_TRANSCRIPT_WATCH=1 force-enables anywhere for
// testing, =0 force-disables.
export function transcriptWatchAutoStartEnabled(platform: NodeJS.Platform = process.platform): boolean {
  const flag = process.env.ORIGIN_TRANSCRIPT_WATCH;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return AUTO_START_PLATFORMS.includes(platform);
}

// Absolute path to this CLI's JS entry (dist/index.js) so we can spawn
// `node <entry> transcript-watch` directly — skips npm's origin.cmd batch shim,
// which drags a visible cmd.exe console window into every spawn on Windows.
function cliEntryScript(): string {
  try {
    const entry = process.argv[1];
    if (entry) {
      const abs = path.resolve(entry);
      if (abs.toLowerCase().endsWith('.js') && fs.existsSync(abs)) return abs;
    }
  } catch { /* fall through */ }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, 'index.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* ignore */ }
  return '';
}

// Idempotently ensure a watcher daemon is running for this machine. No-op if one
// already owns the pid file. Any spawn sets windowsHide so it never pops a
// console window (the GUI agents fire constantly — same reason as codex-watch).
export function ensureTranscriptWatchRunning(): { started: boolean; reason: string } {
  if (!transcriptWatchAutoStartEnabled()) return { started: false, reason: 'gated-off' };
  if (anotherWatcherRunning()) return { started: false, reason: 'already-running' };
  const entry = cliEntryScript();
  if (!entry) return { started: false, reason: 'no-entry-script' };
  try {
    const child = spawn(process.execPath, [entry, 'transcript-watch'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { started: true, reason: 'spawned' };
  } catch (err) {
    return { started: false, reason: `spawn-failed: ${String(err)}` };
  }
}

// Kill any incumbent watcher and spawn a fresh one on the JUST-INSTALLED code.
// `origin upgrade` only swaps dist/ on disk — a long-running daemon keeps
// executing its stale in-memory version until a reboot or its 24h lifetime, so
// upgrade calls this to cycle it. No-op where auto-start is gated off. Mirrors
// restartCodexWatch.
export function restartTranscriptWatch(): { restarted: boolean; reason: string } {
  if (!transcriptWatchAutoStartEnabled()) return { restarted: false, reason: 'gated-off' };
  const pidFile = watchPidFile();
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      // Only kill a live, OTHER process — never signal ourselves; a dead/garbage
      // pid is nothing to stop.
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
        try { process.kill(pid); } catch { /* already gone — fine */ }
      }
      // Free the incumbent's slot; the fresh daemon writes its own pid on start.
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      // Drop the incumbent's version sidecar with it.
      removeWatchMeta(pidFile);
    }
  } catch { /* best-effort: spawn a fresh watcher regardless */ }
  const res = ensureTranscriptWatchRunning();
  return { restarted: res.started, reason: res.reason };
}

// Restart ONLY if the running daemon is on a different build than this one —
// the up-to-date-path counterpart to restartTranscriptWatch. See
// restartCodexWatchIfStale for why this exists.
export function restartTranscriptWatchIfStale(
  installedVersion?: string,
): { restarted: boolean; reason: string } {
  if (!transcriptWatchAutoStartEnabled()) return { restarted: false, reason: 'gated-off' };
  const freshness = watchFreshness(watchPidFile(), installedVersion);
  // A watcher that isn't running captures NOTHING, and that was the one state
  // nothing healed: `origin upgrade` reported everything healthy while the
  // daemon had been dead for hours (observed — pid 9340, ESRCH, sessions
  // missing). Starting one is still not this function's job in general, so
  // distinguish the two ways it can be absent:
  //
  //   pid file left behind, process gone → it DIED (crash, kill, reboot mid-
  //     session). Nobody asked for that; bring it back.
  //   no pid file → it exited cleanly, which is what a deliberate stop looks
  //     like. Leave it alone — `origin enable` owns starting it.
  if (freshness === 'not-running') {
    let orphanedPidFile = false;
    try { orphanedPidFile = fs.existsSync(watchPidFile()); } catch { /* treat as absent */ }
    if (!orphanedPidFile) return { restarted: false, reason: 'not-running' };
    const res = ensureTranscriptWatchRunning();
    return { restarted: res.started, reason: res.started ? 'revived-dead-watcher' : res.reason };
  }
  if (freshness !== 'stale') return { restarted: false, reason: freshness };
  return restartTranscriptWatch();
}

// Register the watcher to relaunch at logon, so it survives reboots. Was a
// Scheduled Task until Defender started blocking that as malware persistence —
// utils/logon-autostart.ts has the full story. Windows-only; reports why on
// every other platform. Callers must SURFACE a failure rather than swallow it:
// silently losing this means capture stops at the next reboot with no warning.
export function registerTranscriptWatchAtLogon(): LogonAutoStartResult {
  return registerLogonAutoStart({
    name: 'OriginTranscriptWatch',
    entryScript: cliEntryScript(),
    subcommand: 'transcript-watch',
  });
}

// ─── Real-dependency wiring ──────────────────────────────────────────────────

// Unified diff of specific files against HEAD. Tracked files use `git diff`;
// untracked files are read and rendered as fully-added (git diff HEAD wouldn't
// show them). Repo-relative paths in, bounded diff out. This is how we capture
// uncommitted work for agents whose transcript has no edit content, and new
// files the poll-based shadow baseline captured too late to see.
export function realCaptureFilesDiff(
  workRoot: string,
  relFiles: string[],
): { diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number } {
  const parts: string[] = [];
  const changed: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  const countHunk = (d: string) => {
    for (const line of d.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  };
  // Both git questions asked ONCE for the whole file list instead of twice per
  // file. A spawn costs ~80ms on Windows, so a 10-file turn was ~20 spawns and
  // ~3.0s; batched it is 2 spawns and ~0.2s. `ls-files` prints the paths it
  // knows, and `diff` labels each file with its own `diff --git` header, so
  // neither answer loses per-file resolution.
  const wanted = relFiles.filter((rel) => rel && !rel.startsWith('..'));
  const trackedSet = new Set<string>();
  if (wanted.length) {
    try {
      for (const line of git(['ls-files', '--', ...wanted], { cwd: workRoot }).split('\n')) {
        const p = line.trim();
        if (p) trackedSet.add(p);
      }
    } catch { /* leave empty — every file then takes the untracked path below */ }
  }
  const trackedDiffs = new Map<string, string>();
  if (trackedSet.size) {
    try {
      const all = git(['diff', '--unified=2000', 'HEAD', '--', ...trackedSet], { cwd: workRoot });
      for (const section of all.split(/^(?=diff --git )/m)) {
        const m = section.match(/^diff --git a\/(\S+) b\/(\S+)/);
        if (m && section.trim()) trackedDiffs.set(m[2], section);
      }
    } catch { /* no diff readable — tracked files simply report no change */ }
  }

  for (const rel of wanted) {
    if (trackedSet.has(rel)) {
      const d = trackedDiffs.get(rel) || '';
      if (d.trim()) { parts.push(d); changed.push(rel); countHunk(d); }
    } else {
      let content = '';
      try { content = fs.readFileSync(path.join(workRoot, rel), 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing-newline artifact
      const body = lines.map((l) => '+' + l).join('\n');
      // WITH a real `@@` hunk header. The canonical counter (countDiffAddRemove)
      // is hunk-aware — it ignores everything before the first `@@`, because in
      // the file-header section a `+`/`-` is not a diff op. A block without one
      // therefore scores +0/-0 on every server surface that measures this diff,
      // while the tracked-file blocks beside it (real `git diff` output, hunks
      // included) count normally.
      //
      // agy session 65953fe2: the capture held 8 untracked new files (+1922)
      // and 2 modified tracked ones (+59/-77). The session header read exactly
      // +59/-77 — the tracked half — because the untracked half was invisible
      // to the counter. Emitting a well-formed block costs one line and makes
      // this diff parseable by every consumer, not just the ones that scan for
      // a leading `+`.
      parts.push(
        `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
      );
      changed.push(rel);
      linesAdded += lines.length;
    }
  }
  return { diff: parts.join('\n'), filesChanged: changed, linesAdded, linesRemoved };
}

function realResolveRepo(cwd: string): { repoPath: string; workRoot: string; repoUrl?: string; branch?: string } | null {
  const workRoot = getWorkingGitRoot(cwd);
  if (!workRoot) return null;
  const repoPath = getCanonicalRepoPath(workRoot);
  let repoUrl: string | undefined;
  try { repoUrl = git(['remote', 'get-url', 'origin'], { cwd: workRoot }).trim() || undefined; } catch { /* no remote */ }
  const branch = getBranch(workRoot) || undefined;
  return { repoPath, workRoot, repoUrl, branch };
}

export function buildRealDeps(machineId: string, hostname?: string): WatchDeps {
  return {
    now: () => Date.now(),
    idleMs: IDLE_MS,
    machineId,
    hostname,
    stateDir: watchStateDir(),
    api: { startSession: api.startSession, updateSession: api.updateSession },
    resolveRepo: realResolveRepo,
    writeMemory: writeSessionMemory,
    writeCommitMemoryEntry: writeCommitMemory,
    enrichDecisions: enrichDecisionsForSession,
    createShadow: createShadowCommit,
    getHead: (workRoot: string) => getHeadSha(workRoot),
    captureDiff: captureAgyDiff,
    captureGit: (workRoot: string, headBefore: string | null, preSessionBaseline?: string | null) =>
      captureGitState(workRoot, headBefore, {
        committedOnly: true, fullContext: true, preSessionBaseline,
      }),
    loadState: (agentSlug: string, sessionId: string) => loadSessionState(agentSlug, sessionId),
    saveState: (s: SessionWatchState) => saveSessionState(s),
    // Write the `.git/origin-session-<tag>.json` state file the local git hooks
    // read for commit/PR/AI-blame attribution.
    captureFilesDiff: realCaptureFilesDiff,
    treeFingerprint: realTreeFingerprint,
    ingestCommits: (data) => api.ingestCommits(data as any),
    readCommitForIngest: (workRoot, sha) => realReadCommitForIngest(workRoot, sha),
    syncNotes: (workRoot: string) => { syncNotesForSessionStart(workRoot); },
    captureCommitScoped: commitDiffScopedToPrompt,
    pingSession: (id) => api.pingSession(id),
    reportCommandResult: (id, type, status, message) => api.reportCommandResult(id, type, status, message),
    capturePromptEdits: (opts) => capturePromptEdits(opts as any) as any,
    saveGitState: (state, workRoot, tag) => writeGitSessionFile(state as any, workRoot, tag),
    loadGitState: (workRoot, tag) => readGitSessionFile(workRoot, tag) as any,
    endGitState: (workRoot, tag) => { try { endGitSessionFile(workRoot, tag); } catch { /* best-effort */ } },
    registerSnapshot: async (workRoot, originSessionId, opts) => {
      const snapshotId = createSnapshot(workRoot, {
        sessionTag: opts.sessionTag,
        model: opts.model,
        promptIndex: opts.promptIndex,
        type: 'auto',
        transcriptPath: opts.transcriptPath,
        linesAdded: opts.linesAdded,
        linesRemoved: opts.linesRemoved,
      });
      if (!snapshotId) return;
      await api.uploadSnapshot(originSessionId, {
        snapshotId,
        type: 'auto',
        takenAt: new Date().toISOString(),
        promptIndex: opts.promptIndex,
        filesChanged: opts.filesChanged,
        linesAdded: opts.linesAdded,
        linesRemoved: opts.linesRemoved,
      });
    },
  };
}

// ─── Command entry ───────────────────────────────────────────────────────────

export interface TranscriptWatchOptions {
  once?: boolean;   // run a single poll cycle then exit (testing / cron)
  quiet?: boolean;
  adapters?: TranscriptAdapter[]; // override (testing); defaults to the registry
}

// Long-lived watcher loop. Acquires the single-instance pid file, then polls
// until superseded, the lifetime cap, or a signal.
export async function transcriptWatchCommand(opts: TranscriptWatchOptions = {}): Promise<void> {
  const log = (msg: string) => { if (!opts.quiet) process.stdout.write(msg + '\n'); };
  const adapters = opts.adapters || ADAPTERS;

  const config = loadConfig();
  if (!config?.apiKey) {
    log('Origin is not logged in — run `origin login` first. transcript-watch needs a connected account.');
    process.exitCode = 1;
    return;
  }
  const agentConfig = loadAgentConfig();
  const machineId = agentConfig?.machineId || '';
  if (!machineId) {
    log('No machine id found — run `origin enable` first to register this machine.');
    process.exitCode = 1;
    return;
  }
  const deps = buildRealDeps(machineId, agentConfig?.hostname);

  if (opts.once) {
    await runWatchCycle(adapters, deps);
    return;
  }

  // Single-instance: exit if a live watcher already owns the pid file.
  if (anotherWatcherRunning()) {
    log('Another transcript-watch instance is already running — exiting.');
    return;
  }
  writeOwnPid();
  // Record the build this daemon is running so `origin upgrade` can tell a
  // stale daemon from a current one even when it installs nothing.
  writeWatchMeta(watchPidFile());

  let stopped = false;
  const cleanup = () => {
    stopped = true;
    try {
      const pid = parseInt(fs.readFileSync(watchPidFile(), 'utf-8').trim(), 10);
      if (pid === process.pid) { fs.unlinkSync(watchPidFile()); removeWatchMeta(watchPidFile()); }
    } catch { /* ignore */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  log(`transcript-watch started (pid ${process.pid}); watching ${adapters.map((a) => a.slug).join(', ')} every ${POLL_INTERVAL_MS / 1000}s.`);
  const startedAt = Date.now();
  while (!stopped) {
    if (watcherSuperseded()) { log('Superseded by a newer transcript-watch instance — exiting.'); break; }
    if (Date.now() - startedAt > MAX_DAEMON_LIFETIME_MS) {
      // Hand off before going. The cap exists so a daemon can't run forever on
      // stale code — it was never meant to STOP capture, but with nothing
      // spawning a successor that is exactly what it did: every 24h the watcher
      // exited and nothing captured again until the next logon (observed: a
      // dead pid, hours of missing sessions, and `origin upgrade` reporting
      // everything healthy because it only ever restarted a STALE watcher).
      // cleanup() first so the successor doesn't see us holding the pid file.
      cleanup();
      const handoff = ensureTranscriptWatchRunning();
      log(`Lifetime cap reached — ${handoff.started ? 'handed off to a fresh daemon' : `exiting (${handoff.reason})`}.`);
      debugLog('transcript-watch', 'lifetime handoff', handoff);
      break;
    }
    try { await runWatchCycle(adapters, deps); } catch (err) {
      debugLog('transcript-watch', 'cycle error', { err: String(err) });
    }
    // Stamp liveness so `origin doctor` can tell a working daemon from one
    // that is merely still a process.
    touchWatchMeta(watchPidFile());
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
