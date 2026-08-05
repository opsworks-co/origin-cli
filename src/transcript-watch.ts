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
// single-instance pid, idle sweep, auto-start gating, schtasks logon task.
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
import { createShadowCommit, captureAgyDiff, captureGitState, commitDiffScopedToPrompt, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
import { getWorkingGitRoot, getCanonicalRepoPath, getBranch, getHeadSha, saveSessionState as writeGitSessionFile, clearSessionState as endGitSessionFile } from './session-state.js';
import { createSnapshot } from './commands/snapshot.js';
import { estimateCost } from './transcript.js';
import { capturePromptEdits } from './prompt-capture/index.js';
import { git } from './utils/exec.js';
import { isWindows } from './utils/platform.js';
import { api } from './api.js';
import { loadConfig, loadAgentConfig } from './config.js';
import { debugLog, logSkipOnce } from './debug-log.js';
import { ADAPTERS, type TranscriptAdapter, type ScannedTranscript, type ParsedSession } from './transcript-adapters.js';
import { writeWatchMeta, removeWatchMeta, watchFreshness } from './watch-meta.js';

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
    updateSession: (id: string, data: any) => Promise<any>;
  };
  // cwd → { repoPath (canonical), workRoot, repoUrl?, branch? }; null when the
  // cwd is not inside a git repo.
  resolveRepo: (cwd: string) => { repoPath: string; workRoot: string; repoUrl?: string; branch?: string } | null;
  createShadow: (workRoot: string, tag: string) => string | null;
  getHead: (workRoot: string) => string | null;
  captureDiff: (workRoot: string, baselineSha: string | null) => {
    diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number;
  };
  captureGit: (workRoot: string, headBefore: string | null) => {
    headBefore: string;
    headAfter: string;
    commitShas: string[];
    commitDetails: Array<{
      sha: string; message: string; author: string; filesChanged: string[];
      linesAdded: number; linesRemoved: number; patch?: string;
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
  // Mark that git state file ENDED when the session goes idle.
  endGitState?: (workRoot: string, tag: string) => void;
  // Unified diff of specific repo-relative files against HEAD, including
  // untracked files (rendered fully-added). The diff source for agents whose
  // transcript carries no edit content (Antigravity) and for brand-new files
  // the shadow-baseline tree diff misses. Optional; omitted in tests.
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
    agent: 'claude' | 'cursor' | 'codex' | 'gemini';
    repoPath: string;
    transcriptPath?: string;
    sessionCommitShas?: string[];
    headShaAtStart?: string;
  }) => Array<{ promptIndex: number; edits: unknown[]; commits?: string[] }>;
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
      const ended: SessionWatchState = { ...prior, status: 'ENDED', endedAt: new Date(now).toISOString() };
      deps.saveState(ended);
      return ended;
    }
    return prior; // already ended or never started — nothing to do
  }

  const parsed = adapter.parse(scanned.transcriptPath);
  if (!parsed || parsed.userPrompts.length === 0) return prior;

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
  const cwd = scanned.cwd || deriveRepoFromFilePaths(parsed.filePaths);
  if (!cwd) {
    logSkipOnce(`nocwd|${adapter.slug}|${scanned.sessionId}`, () => debugLog('transcript-watch', 'skipped: no cwd for session', {
      agent: adapter.slug, sessionId: scanned.sessionId,
      hint: 'transcript records no cwd and no absolute file paths to recover one from',
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
  const headShaAtStart = prior?.headShaAtStart || deps.getHead(repo.workRoot) || undefined;

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
  // sha → repo-relative files in that commit. Used to attribute a commit to a
  // prompt for agents with no canonical extractor (Antigravity/Copilot).
  const commitFiles = new Map<string, string[]>();
  if (headShaAtStart) {
    try {
      const gc = deps.captureGit(repo.workRoot, headShaAtStart);
      if (gc.commitShas.length > 0) {
        for (const d of gc.commitDetails || []) {
          if (d?.sha) commitFiles.set(d.sha, (d.filesChanged || []).map((f) => f.replace(/\\/g, '/')));
        }
        sessionCommitShas = Array.from(new Set([...sessionCommitShas, ...gc.commitShas]));
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
  // Commit SHA the capture attributes to each prompt — sent as PromptChange
  // .commitSha so the UI can render the turn's commit row + total-diff badge.
  const commitShaByIndex = new Map<number, string>();
  if (adapter.promptCaptureAgent && deps.capturePromptEdits) {
    try {
      const captures = deps.capturePromptEdits({
        agent: adapter.promptCaptureAgent,
        repoPath: repo.workRoot,
        transcriptPath: scanned.transcriptPath,
        // Freshly-walked list (includes a commit made THIS cycle), not just prior state.
        sessionCommitShas,
        headShaAtStart: headShaAtStart || undefined,
      });
      // Send a capture for EVERY prompt the extractor produced — including ones
      // with an empty edits[]. An empty edits[] is a meaningful signal, not a
      // gap: it tells the server "this prompt provably touched nothing", which is
      // what makes a read-only/chat-only turn render clean instead of inheriting
      // a phantom file from the previous turn's legacy diff projection.
      for (const cap of captures) {
        if (Array.isArray(cap.edits)) {
          editsJsonByIndex.set(cap.promptIndex, JSON.stringify({ edits: cap.edits, commits: cap.commits || [] }));
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

  const toRepoRel = (files: string[]): string[] =>
    files
      .map((f) => (path.isAbsolute(f) ? path.relative(repo.workRoot, f) : f))
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => f && !f.startsWith('..'));

  // editsJson for agents outside the canonical pipeline (Antigravity) that DO
  // record what they wrote. Same contract as above — without editsJson the read
  // path falls back to legacy projections and blanks per-prompt files, which is
  // why agy turns showed correct line counts but "0 files".
  if (editsJsonByIndex.size === 0 && Array.isArray(parsed.promptEdits)) {
    for (const pe of parsed.promptEdits) {
      const edits = (pe.edits || []).map((e) => ({
        file: toRepoRel([e.file])[0] || e.file,
        op: e.op,
        ...(e.oldContent !== undefined ? { oldContent: e.oldContent } : {}),
        ...(e.newContent !== undefined ? { newContent: e.newContent } : {}),
        source: 'tool_call',
      }));
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

  // Fallback commit attribution for agents with no canonical extractor
  // (Antigravity, Copilot): match each commit to the LAST prompt that edited a
  // file the commit contains. Same one-producer rule as above — the turn that
  // ran `git commit` is the latest one whose work the commit carries.
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
    // Chronological commit order: sessionCommitShas is accumulated oldest-first.
    // Keep only commits that actually touch a file THIS session edited — the
    // headShaAtStart..HEAD walk also picks up commits made by other sessions (or
    // by the user) in the same repo during the window, and an unrelated commit in
    // the list shifts the pairing so every turn gets the wrong sha.
    const sessionFiles = new Set(toRepoRel(parsed.filesChanged));
    const orderedShas = sessionCommitShas.filter((sha) => {
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
      for (const sha of sessionCommitShas) {
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

  const agentFilesRel = toRepoRel(parsed.filesChanged);

  const promptChanges: any[] = [];
  const latestIndex = newCount - 1;
  for (let i = 0; i < newCount; i++) {
    const mapping = parsed.promptDiffs.find((pd) => pd.promptIndex === i);
    let files = mapping ? toRepoRel(mapping.filesChanged) : [];
    let diff = mapping?.diff || '';
    let linesAdded = mapping?.linesAdded || 0;
    let linesRemoved = mapping?.linesRemoved || 0;

    if (i === latestIndex) {
      // For the IN-FLIGHT prompt the WORKING TREE is authoritative for still-
      // uncommitted files — it has the real current content, whereas a
      // transcript's edit content can be partial (Cursor reports a summary, so
      // its line counts are wrong) or absent (Antigravity). So prefer a
      // working-tree diff of the edited files; keep the transcript diff only
      // when the tree shows nothing (already committed / clean); then the
      // shadow-baseline tree diff as a last resort.
      const candidateFiles = files.length ? files : agentFilesRel;
      if (candidateFiles.length && deps.captureFilesDiff) {
        const wd = deps.captureFilesDiff(repo.workRoot, candidateFiles);
        if (wd.diff) {
          diff = wd.diff; linesAdded = wd.linesAdded; linesRemoved = wd.linesRemoved;
          files = wd.filesChanged.length ? wd.filesChanged : candidateFiles;
        }
      }
      if (!diff) {
        const baseline = promptShadows.find((s) => s.promptIndex === i)?.baselineSha || null;
        const d = deps.captureDiff(repo.workRoot, baseline);
        if (d.diff || d.filesChanged.length) {
          diff = d.diff; linesAdded = d.linesAdded; linesRemoved = d.linesRemoved;
          files = files.length ? files : d.filesChanged;
        }
      }
      // Report the session's edited-file list if nothing else surfaced files.
      if (files.length === 0) files = agentFilesRel;
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
      promptText: (parsed.userPrompts[i] || '').slice(0, 1000),
      ...(typeof promptTs === 'number' && promptTs > 0 ? { createdAt: promptTs } : {}),
      filesChanged: files,
      ...(diff ? { uncommittedDiff: diff.slice(0, MAX_PROMPT_DIFF_LEN) } : {}),
      linesAdded,
      linesRemoved,
      checkpointType: 'auto',
      ...(editsJsonByIndex.has(i) ? { editsJson: editsJsonByIndex.get(i) } : {}),
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

  let updateOk = false;
  try {
    await deps.api.updateSession(originSessionId, {
      prompt: joinedPrompt || undefined,
      transcript: parsed.transcript || undefined,
      model: parsed.model || undefined,
      tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
      inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
      outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
      toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
      durationMs: durationMs > 0 ? durationMs : undefined,
      costUsd: costUsd > 0 ? costUsd : undefined,
      promptChanges: promptChanges.length > 0 ? promptChanges : undefined,
      gitCapture,
      status: 'RUNNING',
    });
    updateOk = true;
  } catch (err) {
    debugLog('transcript-watch', 'updateSession failed', { agent: adapter.slug, sessionId: scanned.sessionId, err: String(err) });
    // Fall through — persist state so we don't re-create shadows next poll.
  }

  const startedAtIso = prior?.createdAt || new Date(now).toISOString();

  // Write the `.git/origin-session-<tag>.json` state file in the session-state.ts
  // shape. This is what makes commit/PR/AI-blame attribution work on Windows:
  // the local git hooks (which DO fire on `git commit`/`git push`) find this
  // active session by scanning these files and attribute the commit, stamp the
  // Origin-Session trailer, and write+push refs/notes/origin. Rewritten every
  // poll so the file's mtime keeps the session "alive" (no heartbeat needed).
  try {
    deps.saveGitState?.({
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
      headShaAtLastStop: null,
      prePromptSha: null,
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
  const snapshottedPrompts = Array.isArray(prior?.snapshottedPrompts) ? [...prior!.snapshottedPrompts] : [];
  if (updateOk && latestIndex >= 0 && !snapshottedPrompts.includes(latestIndex)) {
    const latest = promptChanges.find((c) => c.promptIndex === latestIndex);
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

  const next: SessionWatchState = {
    agentSlug: adapter.slug,
    sessionId: scanned.sessionId,
    originSessionId,
    repoPath: repo.repoPath,
    workRoot: repo.workRoot,
    promptCount: newCount,
    promptShadows,
    createdAt: startedAtIso,
    lastTranscriptMtime: scanned.mtimeMs,
    status: 'RUNNING',
    headShaAtStart,
    // We now send ALL prompts' per-turn diffs every poll, so the backfill is
    // implicit — latch true once the first update lands.
    initialBackfillSent: (prior?.initialBackfillSent ?? false) || updateOk,
    sessionTag,
    sessionStartShadowSha,
    sessionCommitShas,
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
  if (freshness !== 'stale') return { restarted: false, reason: freshness };
  return restartTranscriptWatch();
}

// Best-effort: register a Windows Scheduled Task that relaunches the watcher at
// logon, so it survives reboots. Windows-only; silently no-ops elsewhere or on
// any failure. Uses `schtasks /Create /F` (idempotent — /F overwrites).
export function registerTranscriptWatchLogonTask(): { registered: boolean; reason: string } {
  if (!isWindows()) return { registered: false, reason: 'not-windows' };
  const entry = cliEntryScript();
  if (!entry) return { registered: false, reason: 'no-entry-script' };
  try {
    const node = process.execPath;
    const tr = `\"${node}\" \"${entry}\" transcript-watch`;
    execFileSync('schtasks', [
      '/Create', '/F',
      '/SC', 'ONLOGON',
      '/TN', 'OriginTranscriptWatch',
      '/TR', tr,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return { registered: true, reason: 'schtasks-created' };
  } catch (err) {
    return { registered: false, reason: `schtasks-failed: ${String(err)}` };
  }
}

// ─── Real-dependency wiring ──────────────────────────────────────────────────

// Unified diff of specific files against HEAD. Tracked files use `git diff`;
// untracked files are read and rendered as fully-added (git diff HEAD wouldn't
// show them). Repo-relative paths in, bounded diff out. This is how we capture
// uncommitted work for agents whose transcript has no edit content, and new
// files the poll-based shadow baseline captured too late to see.
function realCaptureFilesDiff(
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
  for (const rel of relFiles) {
    if (!rel || rel.startsWith('..')) continue;
    let tracked = true;
    try { git(['ls-files', '--error-unmatch', '--', rel], { cwd: workRoot }); } catch { tracked = false; }
    if (tracked) {
      let d = '';
      try { d = git(['diff', '--unified=2000', 'HEAD', '--', rel], { cwd: workRoot }); } catch { d = ''; }
      if (d.trim()) { parts.push(d); changed.push(rel); countHunk(d); }
    } else {
      let content = '';
      try { content = fs.readFileSync(path.join(workRoot, rel), 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing-newline artifact
      const body = lines.map((l) => '+' + l).join('\n');
      parts.push(`diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n${body}`);
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
    createShadow: createShadowCommit,
    getHead: (workRoot: string) => getHeadSha(workRoot),
    captureDiff: captureAgyDiff,
    captureGit: (workRoot: string, headBefore: string | null) =>
      captureGitState(workRoot, headBefore, { committedOnly: true, fullContext: true }),
    loadState: (agentSlug: string, sessionId: string) => loadSessionState(agentSlug, sessionId),
    saveState: (s: SessionWatchState) => saveSessionState(s),
    // Write the `.git/origin-session-<tag>.json` state file the local git hooks
    // read for commit/PR/AI-blame attribution.
    captureFilesDiff: realCaptureFilesDiff,
    captureCommitScoped: commitDiffScopedToPrompt,
    pingSession: (id) => api.pingSession(id),
    reportCommandResult: (id, type, status, message) => api.reportCommandResult(id, type, status, message),
    capturePromptEdits: (opts) => capturePromptEdits(opts as any) as any,
    saveGitState: (state, workRoot, tag) => writeGitSessionFile(state as any, workRoot, tag),
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
    if (Date.now() - startedAt > MAX_DAEMON_LIFETIME_MS) { log('Lifetime cap reached — exiting.'); cleanup(); break; }
    try { await runWatchCycle(adapters, deps); } catch (err) {
      debugLog('transcript-watch', 'cycle error', { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
