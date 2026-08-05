// ---------------------------------------------------------------------------
// Origin CLI — Hook-independent Codex session watcher
// ---------------------------------------------------------------------------
// Codex ALWAYS writes complete session data to its rollout JSONL under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl[.zst], regardless
// of whether Origin's lifecycle hooks fire, whether the hook was trusted, or
// whether the sandbox blocked the hook's writes. Codex Desktop / v0.145 keep
// breaking hook discovery/trust/sandbox/exit-codes, so hook-based capture is
// fragile — this watcher captures Codex sessions straight from the rollout
// files instead, with NO dependency on any hook firing.
//
// It is a machine-global daemon (`origin codex-watch`) that polls the rollout
// directory every few seconds. For each ACTIVE Codex thread (recent rollout
// mtime, NOT one of Codex's internal LLM subroutines) it:
//   1. ensures an Origin session exists, keyed on `agentSessionId = threadId`
//      (so a watcher-created session and any hook-created session for the SAME
//      thread merge server-side — the server dedups Codex by agentSessionId),
//   2. parses the rollout live and PATCHes prompts / transcript / tokens /
//      tools to the server (mirrors heartbeat.ts pushInflightCodexState),
//   3. creates a per-prompt shadow commit at every new user_message boundary
//      and computes a per-prompt diff against it (mirrors the heartbeat's
//      per-turn baseline model, reusing createShadowCommit + captureAgyDiff),
//   4. marks the session ENDED once the rollout goes idle.
//
// Cross-platform TypeScript. Rolled out Windows-first: `origin enable` only
// auto-starts it on Windows (hooks still work on macOS/Linux) — flip
// AUTO_START_PLATFORMS / codexWatchAutoStartEnabled() to enable elsewhere.
// The `origin codex-watch` command itself runs on every platform for testing.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  readRolloutCwd,
  parseCodexRolloutLive,
  isCodexInternalSubroutine,
  codexApplyPatchesToDiff,
} from './agents/codex.js';
import type { CodexBaselineResolver } from './agents/codex.js';
import { createShadowCommit, captureAgyDiff, captureShadowRangeDiff, captureGitState, readFileAtRev, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
import { getWorkingGitRoot, getCanonicalRepoPath, getBranch, getHeadSha } from './session-state.js';
import { git } from './utils/exec.js';
import { isWindows } from './utils/platform.js';
import { api } from './api.js';
import { loadConfig, loadAgentConfig } from './config.js';
import { debugLog, logSkipOnce } from './debug-log.js';
import { writeWatchMeta, removeWatchMeta, watchFreshness } from './watch-meta.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

// How often to poll the rollout directory. Polling (fs.stat) is simpler and
// more robust than a filesystem watch across platforms — a few seconds of lag
// on a live turn is fine.
export const POLL_INTERVAL_MS = 8_000;
// Only consider rollout files touched within this window "active" candidates.
// Wider than IDLE_MS so a just-idle thread is still re-scanned and gets its
// ENDED transition (and so a restart re-adopts recent threads).
export const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
// A thread whose rollout hasn't been written within this window is idle → END.
export const IDLE_MS = 20 * 60 * 1000; // 20 min
// Safety net: never let the daemon run forever.
export const MAX_DAEMON_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24h
// Grace added to a thread's last-activity time when deciding which commits it
// authored. A commit is recorded in the rollout moments after it lands, so a
// commit up to this long after the thread's last rollout write is still plausibly
// its own; anything later was made by a DIFFERENT concurrent thread (see the
// commit-scoping in reconcileThread). Wide enough to survive clock skew / FS
// mtime granularity, tight enough to exclude a session idle for minutes.
export const COMMIT_SCOPE_GRACE_MS = 2 * 60 * 1000; // 2 min

// How soon after a prompt STARTS its shadow must have been taken for that
// shadow to be a trustworthy turn boundary. The watcher polls every 8s, so a
// prompt can be discovered well after the agent already began editing — a
// shadow taken then has the NEXT turn's work baked in, and using it as a range
// endpoint over-attributes one turn and starves the other (session 1ffc5f67:
// 4.7s lag → +29/+0 instead of +10/+19, while a 0.2s lag bracketed its turn
// exactly). Deliberately tight: failing the check costs nothing (the turn keeps
// its existing data), while a false pass corrupts two turns at once.
export const SHADOW_ALIGN_MS = 1000; // 1s

// How stale a prompt's shadow may be and still be trusted as the file state to
// ANCHOR that turn's apply_patch hunks against (see codexApplyPatchToDiff).
// Codex's Update-File sections carry a bare `@@` with no line ranges, so the
// only source of real line numbers is the file as it was when the turn started
// — which is exactly what the shadow holds, PROVIDED it was taken at the prompt
// boundary. On the FIRST capture the watcher back-creates shadows for every
// prompt already in the rollout in one go, so an old prompt's "baseline" is
// really the current tree; anchoring against that could land a hunk at a
// plausible but wrong line. This check rejects that case.
//
// Deliberately far looser than SHADOW_ALIGN_MS, which gates diff ATTRIBUTION
// (there, seconds of agent work silently moves lines between turns). Anchoring
// only needs the content ABOVE the hunk to be unchanged, and every candidate
// position is additionally verified by exact content match before use — so the
// cost of a slightly stale baseline is a failed match, not a wrong number.
export const ANCHOR_MAX_SHADOW_LAG_MS = 60_000; // 1 min

// Terminal status ON THE WIRE. The server's allowlist is
// {RUNNING, COMPLETED, ERROR} and it silently DROPS anything else (mcp.ts
// ALLOWED_SESSION_STATUS → coerceStatus returns undefined), so the watcher's
// old `status: 'ENDED'` PATCH returned success while changing nothing — every
// watcher-captured Codex session stayed RUNNING forever. 'ENDED' remains the
// LOCAL state vocabulary (ThreadWatchState.status); only the payload differs.
export const API_STATUS_ENDED = 'COMPLETED';

// Platforms where `origin enable` auto-starts the watcher. Windows-first
// rollout: hooks still work on macOS/Linux, so we don't auto-start there yet.
// Enabling later is a one-line change (add 'darwin' / 'linux').
export const AUTO_START_PLATFORMS: NodeJS.Platform[] = ['win32'];

// ─── Paths ───────────────────────────────────────────────────────────────────

export function codexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function watchStateDir(): string {
  return path.join(os.homedir(), '.origin', 'codex-watch');
}

export function watchPidFile(): string {
  return path.join(os.homedir(), '.origin', 'codex-watch.pid');
}

function threadStatePath(threadId: string, dir = watchStateDir()): string {
  // Thread ids are uuids (safe filenames); sanitize defensively anyway.
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

// ─── Per-thread watch state ──────────────────────────────────────────────────

export interface PromptShadow {
  promptIndex: number;
  // Baseline for this prompt's per-turn diff: a shadow commit snapshotting the
  // working tree at the START of the prompt, or the HEAD sha when the tree was
  // clean (createShadowCommit returns null for a clean tree).
  baselineSha: string;
  capturedAt: string;
  promptStartedAt?: number;
}

export interface ThreadWatchState {
  threadId: string;
  // Origin session id once created; null until the first successful startSession.
  sessionId: string | null;
  repoPath: string;        // canonical repo path (identity sent to server)
  workRoot: string;        // working git root (where git ops run)
  // Number of user prompts we've already processed — the dedup anchor that lets
  // a restart resume without re-creating shadows or double-counting turns.
  promptCount: number;
  promptShadows: PromptShadow[];
  createdAt: string;
  lastRolloutMtime: number;
  status: 'RUNNING' | 'ENDED';
  endedAt?: string;
  // Repo HEAD sha at session creation. Baseline for the session-level commit
  // walk (headShaAtStart..HEAD) so commits the agent makes DURING the session
  // are attributed to it and become PR-linkable (FIX 2). Persisted so a restart
  // keeps the original baseline instead of re-anchoring on a later HEAD.
  headShaAtStart?: string;
  // True once we've successfully pushed the initial full-prompt backfill (every
  // prompt 0..latest) to the server. Until then each poll re-sends the whole
  // backfill so a failed first PATCH can't leave the server having seen only
  // prompt N>0 — which its mid-stream heuristic would mis-flag as partial (FIX
  // 1). Once the server has prompt 0, later polls send only the latest prompt.
  initialBackfillSent?: boolean;
  // Prompt indices already SEALED with their final shadow-range diff
  // (shadow[i] → shadow[i+1]). Once both shadows exist that range is immutable,
  // so each turn is computed exactly once and never re-diffed on later polls.
  // Recorded even when the range came back empty — the answer won't change.
  sealedPrompts?: number[];
}

export function loadThreadState(threadId: string, dir = watchStateDir()): ThreadWatchState | null {
  try {
    const raw = fs.readFileSync(threadStatePath(threadId, dir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.threadId !== threadId) return null;
    if (!Array.isArray(parsed.promptShadows)) parsed.promptShadows = [];
    return parsed as ThreadWatchState;
  } catch {
    return null;
  }
}

export function saveThreadState(state: ThreadWatchState, dir = watchStateDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = threadStatePath(state.threadId, dir);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* non-fatal — worst case we re-derive next poll */ }
}

export function listThreadStates(dir = watchStateDir()): ThreadWatchState[] {
  const out: ThreadWatchState[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.threadId) out.push(parsed as ThreadWatchState);
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir missing — no state yet */ }
  return out;
}

// ─── Rollout scan ────────────────────────────────────────────────────────────

export interface ScannedRollout {
  rolloutPath: string;
  threadId: string;
  cwd: string;
  mtimeMs: number;
}

const THREAD_ID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

// List every rollout file under sessions/YYYY/MM/DD modified within `sinceMs`
// of `now`, resolving each file's cwd (from its session_meta line) and thread
// id (from the filename). Only walks the latest year / last few months / days
// so a long-lived ~/.codex doesn't make each poll O(all history).
export function listActiveRollouts(
  sessionsDir: string,
  now: number,
  sinceMs = ACTIVE_WINDOW_MS,
): ScannedRollout[] {
  const results: ScannedRollout[] = [];
  if (!fs.existsSync(sessionsDir)) return results;
  const readdir = (p: string): string[] => { try { return fs.readdirSync(p); } catch { return []; } };
  try {
    const years = readdir(sessionsDir).filter((d) => /^\d{4}$/.test(d)).sort().slice(-1);
    for (const y of years) {
      const yDir = path.join(sessionsDir, y);
      const months = readdir(yDir).filter((d) => /^\d{2}$/.test(d)).sort().slice(-2);
      for (const mo of months) {
        const moDir = path.join(yDir, mo);
        const days = readdir(moDir).filter((d) => /^\d{2}$/.test(d)).sort().slice(-3);
        for (const d of days) {
          const dDir = path.join(moDir, d);
          for (const f of readdir(dDir)) {
            if (!f.includes('rollout')) continue;
            if (!(f.endsWith('.jsonl') || f.endsWith('.jsonl.zst') || f.endsWith('.jsonl.zstd'))) continue;
            const fp = path.join(dDir, f);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(fp).mtimeMs; } catch { continue; }
            if (now - mtimeMs > sinceMs) continue;
            const idMatch = f.match(THREAD_ID_RE);
            if (!idMatch) continue;
            const cwd = readRolloutCwd(fp);
            if (!cwd) continue;
            results.push({ rolloutPath: fp, threadId: idMatch[1], cwd, mtimeMs });
          }
        }
      }
    }
  } catch { /* best-effort */ }
  // Newest first; if a thread has multiple rollout files (resumed session),
  // keep only the most recently written one per thread id.
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set<string>();
  return results.filter((r) => (seen.has(r.threadId) ? false : (seen.add(r.threadId), true)));
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
  parseRollout: (rolloutPath: string) => ReturnType<typeof parseCodexRolloutLive>;
  isInternalSubroutine: typeof isCodexInternalSubroutine;
  // cwd → { repoPath (canonical), workRoot, repoUrl?, branch? }; null when the
  // cwd is not inside a git repo.
  resolveRepo: (cwd: string) => { repoPath: string; workRoot: string; repoUrl?: string; branch?: string } | null;
  createShadow: (workRoot: string, tag: string) => string | null;
  getHead: (workRoot: string) => string | null;
  captureDiff: (workRoot: string, baselineSha: string | null) => {
    diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number;
  };
  // Delta between two per-prompt shadow baselines = exactly one COMPLETED
  // turn's work. Lets a superseded turn be sealed with its true diff instead of
  // being frozen at whatever the live capture happened to see.
  captureRangeDiff: (workRoot: string, fromSha: string | null, toSha: string | null) => {
    diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number;
  };
  // Walk the real git commits made since `headBefore` (session start) so they
  // can be attributed to the session + PR-linked. Wraps captureGitState with a
  // committed-only, full-context capture in production.
  captureGit: (workRoot: string, headBefore: string | null) => {
    headBefore: string;
    headAfter: string;
    commitShas: string[];
    commitDetails: Array<{
      sha: string; message: string; author: string; filesChanged: string[];
      linesAdded: number; linesRemoved: number; patch?: string; committedAt?: number;
    }>;
    diff: string;
    diffTruncated: boolean;
    linesAdded: number;
    linesRemoved: number;
  };
  // A repo-relative file's content at a commit/tree sha. Supplies the per-turn
  // baseline that gives rollout-derived apply_patch hunks their real line
  // numbers. OPTIONAL: without it the converter keeps its previous sequential
  // numbering, so an older deps object (or a test that doesn't care) still
  // produces exactly the pre-existing output.
  readFileAtRev?: (workRoot: string, sha: string, relPath: string) => string | null;
  loadState: (threadId: string) => ThreadWatchState | null;
  saveState: (s: ThreadWatchState) => void;
}

// Baseline reader for prompt `promptIndex`: repo-relative path → that file at
// the prompt's shadow. The turn-level converter drives the rest (it keeps the
// running per-file view across the turn's patches).
//
// Returns undefined when there is no baseline we trust (no dep, no shadow, or a
// shadow taken too long after the prompt started — see
// ANCHOR_MAX_SHADOW_LAG_MS), which leaves the converter on its previous
// behaviour.
function baselineReaderFor(
  deps: WatchDeps,
  workRoot: string,
  shadows: PromptShadow[],
  promptIndex: number,
): CodexBaselineResolver | undefined {
  const read = deps.readFileAtRev;
  if (!read) return undefined;
  const shadow = shadows.find((s) => s.promptIndex === promptIndex);
  if (!shadow?.baselineSha) return undefined;
  // No recorded prompt start → no evidence the shadow is stale; the exact
  // content match inside the converter is still the real guard.
  const lag = shadow.promptStartedAt
    ? Date.parse(shadow.capturedAt) - shadow.promptStartedAt
    : 0;
  if (!(lag <= ANCHOR_MAX_SHADOW_LAG_MS)) return undefined; // also rejects NaN
  return (relPath: string): string | null => {
    try {
      return read(workRoot, shadow.baselineSha, relPath);
    } catch {
      return null;
    }
  };
}

// Process ONE scanned thread: create/reuse its Origin session, push the latest
// rollout state, capture per-prompt shadows + diffs, or end it when idle.
// Returns the (possibly-updated) thread state, or null when the thread was
// skipped (internal subroutine, non-git cwd, unparseable rollout).
export async function reconcileThread(
  scanned: ScannedRollout,
  deps: WatchDeps,
): Promise<ThreadWatchState | null> {
  const now = deps.now();
  const prior = deps.loadState(scanned.threadId);

  // Idle → END. If we already have a session, tell the server it's done and
  // stamp the state ENDED so we don't touch it again.
  if (now - scanned.mtimeMs > deps.idleMs) {
    if (prior && prior.status === 'RUNNING') {
      let endOk = true;
      if (prior.sessionId) {
        endOk = false;
        try {
          await deps.api.updateSession(prior.sessionId, { status: API_STATUS_ENDED });
          endOk = true;
        } catch (err) {
          debugLog('codex-watch', 'end updateSession failed', { threadId: scanned.threadId, err: String(err) });
        }
      }
      // Only latch ENDED once the SERVER knows. This used to stamp ENDED
      // unconditionally with the failure swallowed, so a single transient PATCH
      // failure left the session displaying RUNNING forever — nothing ever
      // retried it (observed on session 1ffc5f67). Staying RUNNING costs one
      // retry per poll until the rollout ages out of the active window.
      if (!endOk) return prior;
      const ended: ThreadWatchState = { ...prior, status: 'ENDED', endedAt: new Date(now).toISOString() };
      deps.saveState(ended);
      return ended;
    }
    return prior; // already ended or never started — nothing to do
  }

  const parsed = deps.parseRollout(scanned.rolloutPath);
  if (!parsed) return prior;

  // Skip Codex's own internal LLM subroutines (ambient-suggestion safety
  // filter, title generation, output summarizer). Same filter discovery uses,
  // corroborated with the parsed rollout's real model / tool-call counts.
  const firstPrompt = parsed.userPrompts[0] || '';
  if (deps.isInternalSubroutine({ model: parsed.model, prompt: firstPrompt, toolCalls: parsed.toolCalls })) {
    return null;
  }

  // Repo mapping: rollout cwd → git root. Not a git repo → skip (matches the
  // existing repo-less guards; a bare cwd has no per-prompt diff to capture).
  const repo = deps.resolveRepo(scanned.cwd);
  if (!repo) {
    // Say so. This skip used to be silent, which made "not tracked" and "broken"
    // look identical from the outside: a real session vanished from the dashboard
    // with nothing anywhere explaining why. Seen live when Codex Desktop opened a
    // scratch folder that WAS a git repo but one git refused to read
    // ("detected dubious ownership"), so every git call failed and resolveRepo
    // returned null. Logged once per thread so a long-lived skip stays quiet.
    logSkipOnce(`codex|${scanned.cwd}`, () => debugLog('codex-watch', 'skipped: cwd is not a usable git repo', {
      threadId: scanned.threadId, cwd: scanned.cwd,
      hint: 'not a repo, or git refuses it (e.g. safe.directory / dubious ownership)',
    }));
    return prior;
  }

  // Repo HEAD at session start — the baseline for the session-level commit walk
  // (FIX 2). Recorded once at creation and persisted; migrated onto older state
  // rows that predate this field (best-effort: captures commits from now on).
  const headShaAtStart = prior?.headShaAtStart || deps.getHead(repo.workRoot) || undefined;

  // Ensure a session exists. Keyed on agentSessionId=threadId so a hook-created
  // session for the same thread merges server-side (server dedups Codex by
  // agentSessionId) — the watcher never forks a second session for one thread.
  let sessionId = prior?.sessionId || null;
  if (!sessionId) {
    try {
      // FIX 1: stamp the session's start time from the rollout's FIRST user
      // prompt, not "now". The watcher only NOTICES a thread after its first
      // prompt already exists on disk, so a "now" start looks like Origin joined
      // mid-stream. The watcher reads the WHOLE rollout, so it captured every
      // prompt — the earliest prompt timestamp is the true session start.
      const validTs = (parsed.promptTimestamps || []).filter((t) => t > 0);
      const earliestTs = validTs.length ? Math.min(...validTs) : 0;
      const res = await deps.api.startSession({
        machineId: deps.machineId,
        prompt: firstPrompt,
        model: parsed.model || 'codex',
        repoPath: repo.repoPath,
        repoUrl: repo.repoUrl || undefined,
        agentSlug: 'codex',
        branch: repo.branch || undefined,
        hostname: deps.hostname || undefined,
        agentSessionId: scanned.threadId,
        startedAt: earliestTs > 0 ? new Date(earliestTs).toISOString() : undefined,
      });
      sessionId = (res?.sessionId as string) || null;
      if (!sessionId) return prior;
    } catch (err) {
      debugLog('codex-watch', 'startSession failed', { threadId: scanned.threadId, err: String(err) });
      return prior; // retry next poll
    }
  }

  // Per-prompt shadows: capture a baseline for every NEW prompt since last poll.
  // Codex doesn't fire user-prompt-submit reliably, so this is our only per-turn
  // boundary. The baseline reflects the working tree at the START of the prompt.
  const promptShadows: PromptShadow[] = Array.isArray(prior?.promptShadows) ? [...prior!.promptShadows] : [];
  const have = new Set(promptShadows.map((s) => s.promptIndex));
  const newCount = parsed.userPrompts.length;
  const prevCount = prior?.promptCount ?? 0;
  for (let i = prevCount; i < newCount; i++) {
    if (have.has(i)) continue;
    const shadow = deps.createShadow(repo.workRoot, `codexwatch-${i}-${scanned.threadId.slice(0, 8)}`);
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

  // Per-prompt changes. Two modes:
  //
  //  • FIRST capture (FIX 1): the rollout may already hold several prompts (the
  //    watcher only noticed the thread AFTER the user's first prompt). Emit a
  //    promptChange for EVERY prompt — index 0 included — so the server records
  //    prompt 0 and does NOT flag the session partialCapture (its mid-stream
  //    heuristic trips only when the lowest incoming promptIndex is > 0). The
  //    watcher read the whole rollout, so nothing was missed. Earlier prompts
  //    carry only their text — their real per-prompt working tree is long gone,
  //    and diffing against a just-created baseline would misattribute the
  //    CURRENT tree to an old prompt. The latest prompt carries the live diff;
  //    git commits are attributed via gitCapture below. Re-sent every poll until
  //    the server acks it (initialBackfillSent) so a failed first PATCH can't
  //    leave the server seeing only prompt N>0.
  //  • STEADY state: only the latest prompt's diff, refreshed each tick (mirrors
  //    the heartbeat's "push current prompt each tick" model — earlier prompts
  //    keep the diff they were last pushed with).
  const firstCapture = !prior?.initialBackfillSent;
  const promptChanges: any[] = [];
  const latestIndex = newCount - 1;
  const sealed = new Set<number>(Array.isArray(prior?.sealedPrompts) ? prior!.sealedPrompts! : []);
  const newlySealed: number[] = [];
  for (let i = 0; i < newCount; i++) {
    const isLatest = i === latestIndex;
    const patches = parsed.promptPatches?.[i] || [];
    const promptText = (parsed.userPrompts[i] || '').slice(0, 1000);
    // ROLLOUT-DERIVED per-turn diff (ground truth). Codex records every edit as
    // an apply_patch in the rollout; the parser attributes each patch to the
    // prompt that produced it. This is immune to poll timing — two prompts that
    // land inside one 8s tick each keep their OWN diff, where a git working-tree
    // snapshot could only show the latest. Emitted for EVERY patched turn on
    // EVERY poll (not just latest/new): the server replaces a promptChange diff
    // whenever the incoming one is non-empty, so a turn that finished right
    // after it stopped being `latest` still converges to its full diff, and the
    // re-send is otherwise idempotent.
    if (patches.length > 0) {
      // The turn's own shadow is the file state its patches were applied to, so
      // it's what turns Codex's bare `@@` markers into real line numbers.
      // Without it every Update-File hunk rendered as starting at line 1 in the
      // dashboard's "by prompt" view while "by file" (real git diffs) showed the
      // truth. Converted as a whole turn, not patch by patch: the patches form a
      // chain against a moving file, and a file patched repeatedly has to be
      // re-rendered as one diff. undefined reader = previous behaviour.
      const readBaseline = baselineReaderFor(deps, repo.workRoot, promptShadows, i);
      const { diff, linesAdded, linesRemoved, filesChanged } =
        codexApplyPatchesToDiff(patches, repo.workRoot, readBaseline);
      const files = new Set<string>(filesChanged);
      // ADDITIVE ONLY — never a downgrade. Codex frequently BUILDS the patch
      // body at runtime rather than writing it literally:
      //   const lines = Array.from({length:88}, …);
      //   const patch = "*** Begin Patch\n*** Add File: x\n"
      //               + lines.map(x=>"+"+x).join("\n") + "\n*** End Patch";
      // The rollout then stores the EXPRESSION, not the rows, so the converter
      // legitimately yields zero lines. Taking that empty result and skipping
      // the git-snapshot path below lost the turn's diff entirely (session
      // 1ffc5f67: "create 1 file with 88 rows" and "add 77 more" both went to
      // +0). A rollout patch is only used when it actually produced content;
      // otherwise we fall through to exactly the pre-existing behaviour.
      if (linesAdded + linesRemoved > 0 && diff) {
        promptChanges.push({
          promptIndex: i,
          promptText,
          filesChanged: [...files],
          diff: diff.slice(0, MAX_PROMPT_DIFF_LEN),
          linesAdded,
          linesRemoved,
          checkpointType: 'auto',
        });
        continue;
      }
    }
    // SEAL a completed turn from its shadow range (shadow[i] → shadow[i+1]).
    // Without this an earlier turn is frozen at whatever the live capture
    // happened to see: once superseded, its work is gone from the working tree,
    // so a bad or empty value could never be corrected and had to be repaired by
    // hand (session 1ffc5f67). The range is immutable once both shadows exist,
    // so it's computed exactly ONCE per turn — and we mark the turn sealed even
    // when the range is empty (identical shadows, e.g. several prompts
    // discovered in one poll), because that answer will never change either.
    // Empty never overwrites: we fall through and leave the server's data alone.
    if (!isLatest && !sealed.has(i)) {
      const fromShadow = promptShadows.find((s) => s.promptIndex === i);
      const toShadow = promptShadows.find((s) => s.promptIndex === i + 1);
      // The range is only turn i's work if the CLOSING shadow was taken at the
      // prompt boundary. The watcher discovers a prompt up to one poll late, and
      // Codex is fast enough to have already applied that turn's edits by then —
      // measured on session 1ffc5f67: a 0.2s-lag shadow bracketed its turn
      // exactly (+88), while a 4.7s-lag one had already absorbed the NEXT turn's
      // work (+29 instead of +10, leaving the following turn at +0). An inflated
      // range is worse than no data, so a late shadow disqualifies the seal and
      // we leave the turn as-is.
      const lag = toShadow?.promptStartedAt
        ? Date.parse(toShadow.capturedAt) - toShadow.promptStartedAt
        : Number.POSITIVE_INFINITY;
      const from = fromShadow?.baselineSha;
      const to = toShadow?.baselineSha;
      if (from && to && lag <= SHADOW_ALIGN_MS) {
        newlySealed.push(i);
        let ranged: { diff: string; filesChanged: string[]; linesAdded: number; linesRemoved: number } | null = null;
        try {
          ranged = deps.captureRangeDiff(repo.workRoot, from, to);
        } catch (err) {
          debugLog('codex-watch', 'captureRangeDiff failed', { threadId: scanned.threadId, promptIndex: i, err: String(err) });
        }
        if (ranged && ranged.linesAdded + ranged.linesRemoved > 0) {
          promptChanges.push({
            promptIndex: i,
            promptText,
            filesChanged: ranged.filesChanged,
            ...(ranged.diff ? { diff: ranged.diff.slice(0, MAX_PROMPT_DIFF_LEN) } : {}),
            linesAdded: ranged.linesAdded,
            linesRemoved: ranged.linesRemoved,
            checkpointType: 'auto',
          });
          continue;
        }
      }
    }
    // Unpatched turn: keep the original steady-state economy — the latest turn
    // carries a git working-tree diff (picks up non-apply_patch state), earlier
    // turns are text-only backfill rows so the server still records the index.
    if (!firstCapture && !isLatest) continue;
    if (isLatest) {
      const baseline = promptShadows.find((s) => s.promptIndex === i)?.baselineSha || null;
      const d = deps.captureDiff(repo.workRoot, baseline);
      promptChanges.push({
        promptIndex: i,
        promptText,
        filesChanged: d.filesChanged,
        // captureAgyDiff returns a single tree-to-tree delta (committed +
        // uncommitted + untracked since the prompt baseline) — the right
        // per-prompt total. Send it as `diff`; do NOT also set uncommittedDiff
        // (that would mislabel a turn's committed lines as uncommitted).
        ...(d.diff ? { diff: d.diff.slice(0, MAX_PROMPT_DIFF_LEN) } : {}),
        linesAdded: d.linesAdded,
        linesRemoved: d.linesRemoved,
        checkpointType: 'auto',
      });
    } else {
      // Backfill row: prompt text only, so the server records the index.
      promptChanges.push({
        promptIndex: i,
        promptText,
        filesChanged: [],
        linesAdded: 0,
        linesRemoved: 0,
        checkpointType: 'auto',
      });
    }
  }

  // FIX 2: capture the real git commits the agent made during the session so
  // the server attributes them to it (and PR webhooks can link them). Walks
  // headShaAtStart..HEAD via captureGitState; the server's gitCapture handler
  // creates/links the Commit rows AND back-attributes each new commit to the
  // prompt that produced it (clearing the "uncommitted forever" state). Only
  // sent when there are actual commits — otherwise the per-prompt diffs above
  // remain the source for still-uncommitted work.
  let gitCapture: Record<string, unknown> | undefined;
  if (headShaAtStart) {
    try {
      const gc = deps.captureGit(repo.workRoot, headShaAtStart);
      // Scope commits to the ones THIS thread authored. captureGit walks the
      // cumulative headShaAtStart..HEAD range, which — with two Codex sessions
      // live in the same repo — sweeps in commits a DIFFERENT thread made after
      // HEAD moved. The server links a commit to the FIRST session that claims
      // it, so an older still-running thread stole a newer session's commit
      // (session 15234617's turn-3 commit went to the idle d09ee3c8). Drop any
      // commit whose commit-time is meaningfully AFTER this thread's last
      // rollout activity — the thread was idle then, so it didn't make it. GRACE
      // covers the gap between a commit landing and Codex writing the rollout
      // that records it. Commits with no timestamp are kept (fail-open). Mac
      // never hits this: it captures per-thread via hooks, not a shared watcher.
      const cutoff = scanned.mtimeMs + COMMIT_SCOPE_GRACE_MS;
      const foreignShas = new Set(
        gc.commitDetails
          .filter((d) => typeof d.committedAt === 'number' && d.committedAt > cutoff)
          .map((d) => d.sha),
      );
      const ownDetails = foreignShas.size
        ? gc.commitDetails.filter((d) => !foreignShas.has(d.sha))
        : gc.commitDetails;
      const ownShas = foreignShas.size
        ? gc.commitShas.filter((s) => !foreignShas.has(s))
        : gc.commitShas;
      if (foreignShas.size) {
        debugLog('codex-watch', 'dropped foreign concurrent commits', {
          threadId: scanned.threadId, dropped: [...foreignShas].map((s) => s.slice(0, 8)),
        });
      }
      if (ownShas.length > 0) {
        gitCapture = {
          headBefore: gc.headBefore,
          headAfter: gc.headAfter,
          commitShas: ownShas,
          commitDetails: ownDetails,
          diff: gc.diff || '',
          diffTruncated: gc.diffTruncated,
          // Re-total from the thread's own commits so the header/line counts
          // don't include a concurrent thread's work.
          linesAdded: foreignShas.size ? ownDetails.reduce((s, d) => s + (d.linesAdded || 0), 0) : gc.linesAdded,
          linesRemoved: foreignShas.size ? ownDetails.reduce((s, d) => s + (d.linesRemoved || 0), 0) : gc.linesRemoved,
        };
      }
    } catch (err) {
      debugLog('codex-watch', 'captureGit failed', { threadId: scanned.threadId, err: String(err) });
    }
  }

  const joinedPrompt = parsed.userPrompts.join('\n\n---\n\n');
  let updateOk = false;
  try {
    await deps.api.updateSession(sessionId, {
      prompt: joinedPrompt || undefined,
      transcript: parsed.transcript || undefined,
      model: parsed.model || undefined,
      tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
      inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
      outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
      toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
      promptChanges: promptChanges.length > 0 ? promptChanges : undefined,
      gitCapture,
      status: 'RUNNING',
    });
    updateOk = true;
  } catch (err) {
    debugLog('codex-watch', 'updateSession failed', { threadId: scanned.threadId, err: String(err) });
    // Fall through — persist state so we don't re-create shadows next poll.
  }

  const next: ThreadWatchState = {
    threadId: scanned.threadId,
    sessionId,
    repoPath: repo.repoPath,
    workRoot: repo.workRoot,
    promptCount: newCount,
    promptShadows,
    // Only latch seals when the PATCH landed — a failed push must be retried on
    // the next poll, not silently swallowed by the once-per-turn guard.
    sealedPrompts: updateOk ? [...sealed, ...newlySealed].sort((a, b) => a - b) : [...sealed],
    createdAt: prior?.createdAt || new Date(now).toISOString(),
    lastRolloutMtime: scanned.mtimeMs,
    status: 'RUNNING',
    headShaAtStart,
    // Latch once the full backfill lands on the server; until then keep retrying
    // it so prompt 0 can never be missed (see firstCapture above).
    initialBackfillSent: (prior?.initialBackfillSent ?? false) || (firstCapture && updateOk),
  };
  deps.saveState(next);
  return next;
}

// Sweep RUNNING threads that fell OUTSIDE the active scan window before we could
// end them (e.g. the daemon was down while the thread went idle). Ends any whose
// last rollout write is older than the idle threshold and that weren't seen this
// cycle.
export async function sweepIdleThreadStates(
  seenThreadIds: Set<string>,
  deps: WatchDeps,
): Promise<void> {
  const now = deps.now();
  for (const st of listThreadStates(deps.stateDir)) {
    if (st.status !== 'RUNNING') continue;
    if (seenThreadIds.has(st.threadId)) continue;
    if (now - st.lastRolloutMtime <= deps.idleMs) continue;
    if (st.sessionId) {
      try { await deps.api.updateSession(st.sessionId, { status: API_STATUS_ENDED }); } catch { /* best-effort */ }
    }
    deps.saveState({ ...st, status: 'ENDED', endedAt: new Date(now).toISOString() });
  }
}

// One full poll cycle: scan, reconcile each active thread, sweep idle leftovers.
export async function runWatchCycle(sessionsDir: string, deps: WatchDeps): Promise<void> {
  const scanned = listActiveRollouts(sessionsDir, deps.now());
  const seen = new Set<string>();
  for (const s of scanned) {
    seen.add(s.threadId);
    try { await reconcileThread(s, deps); } catch (err) {
      debugLog('codex-watch', 'reconcile error', { threadId: s.threadId, err: String(err) });
    }
  }
  await sweepIdleThreadStates(seen, deps);
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

// True when THIS process no longer owns the pid file and must exit. Mirrors
// heartbeatSuperseded: a concurrent start overwrote the file with its pid.
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
// to Windows for now (hooks still work on macOS/Linux); ORIGIN_CODEX_WATCH=1
// force-enables anywhere for testing, ORIGIN_CODEX_WATCH=0 force-disables.
export function codexWatchAutoStartEnabled(platform: NodeJS.Platform = process.platform): boolean {
  const flag = process.env.ORIGIN_CODEX_WATCH;
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return AUTO_START_PLATFORMS.includes(platform);
}

// Absolute path to this CLI's JS entry (dist/index.js) so we can spawn
// `node <entry> codex-watch` directly — skips npm's origin.cmd batch shim,
// which drags a visible cmd.exe console window into every spawn on Windows.
function cliEntryScript(): string {
  try {
    const entry = process.argv[1];
    if (entry) {
      const abs = path.resolve(entry);
      if (abs.toLowerCase().endsWith('.js') && fs.existsSync(abs)) return abs;
    }
  } catch { /* fall through */ }
  // Fallback: sibling index.js next to this module in dist/.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, 'index.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* ignore */ }
  return '';
}

// Idempotently ensure a watcher daemon is running for this machine. No-op if
// one already owns the pid file. Any spawn sets windowsHide so it never pops a
// console window (Codex Desktop fires constantly — see the heartbeat fix).
export function ensureCodexWatchRunning(): { started: boolean; reason: string } {
  if (!codexWatchAutoStartEnabled()) return { started: false, reason: 'gated-off' };
  if (anotherWatcherRunning()) return { started: false, reason: 'already-running' };
  const entry = cliEntryScript();
  if (!entry) return { started: false, reason: 'no-entry-script' };
  try {
    const child = spawn(process.execPath, [entry, 'codex-watch'], {
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

// Force-restart the watcher so it runs the CURRENTLY-INSTALLED code. A plain
// `origin upgrade` replaces dist/ on disk but leaves the OLD daemon running —
// ensureCodexWatchRunning sees it alive and skips, so the process keeps
// executing its stale in-memory code (e.g. a version from before a per-prompt
// capture fix) until a reboot or its 24h lifetime. That silently mis-captures
// every session in between (observed: a daemon 13h behind the on-disk build
// stopped backfilling prompt 0, so every Codex session got flagged "partial").
// Kill the incumbent (the fresh daemon rewrites the pid file it just vacated)
// and spawn a new one on the new code. No-op where the watcher isn't
// auto-started, so `origin upgrade` on macOS/Linux stays untouched.
export function restartCodexWatch(): { restarted: boolean; reason: string } {
  if (!codexWatchAutoStartEnabled()) return { restarted: false, reason: 'gated-off' };
  const pidFile = watchPidFile();
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      // Only kill a live, OTHER process — never signal ourselves, and treat a
      // dead/garbage pid as nothing to stop.
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
        try { process.kill(pid); } catch { /* already gone — fine */ }
      }
      // Clear the pid file so the incumbent's slot is free; the fresh daemon
      // writes its own pid on startup (writeOwnPid).
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      // Drop the incumbent's version sidecar with it, so nothing reads a
      // dead daemon's version while the fresh one is still coming up.
      removeWatchMeta(pidFile);
    }
  } catch { /* best-effort: fall through to spawn a fresh watcher regardless */ }
  const res = ensureCodexWatchRunning();
  return { restarted: res.started, reason: res.reason };
}

// Restart ONLY if the running daemon is on a different build than this one.
//
// `origin upgrade` used to reach its restart solely after a successful install,
// so a daemon left stale by any other route — the CLI installed via npm, or an
// upgrade that ran while this daemon was already up — was never cycled. The
// command reported "Already up to date!" and returned while the watcher kept
// capturing with old code. This is the up-to-date path's counterpart: a no-op
// when the daemon already matches, so a healthy watcher isn't churned on every
// `origin upgrade` invocation.
//
// Deliberately does NOT start a watcher that isn't running — the user may have
// stopped it on purpose, and `origin enable` owns starting it.
export function restartCodexWatchIfStale(
  installedVersion?: string,
): { restarted: boolean; reason: string } {
  if (!codexWatchAutoStartEnabled()) return { restarted: false, reason: 'gated-off' };
  const freshness = watchFreshness(watchPidFile(), installedVersion);
  if (freshness !== 'stale') return { restarted: false, reason: freshness };
  return restartCodexWatch();
}

// Best-effort: register a Windows Scheduled Task that relaunches the watcher at
// logon, so it survives reboots (the spawn above only covers the current login
// session). Windows-only; silently no-ops elsewhere or on any failure. Uses
// `schtasks /Create /F` (idempotent — /F overwrites an existing task).
export function registerCodexWatchLogonTask(): { registered: boolean; reason: string } {
  if (!isWindows()) return { registered: false, reason: 'not-windows' };
  const entry = cliEntryScript();
  if (!entry) return { registered: false, reason: 'no-entry-script' };
  try {
    const node = process.execPath;
    // schtasks needs the whole command as one quoted /TR string.
    const tr = `\"${node}\" \"${entry}\" codex-watch`;
    execFileSync('schtasks', [
      '/Create', '/F',
      '/SC', 'ONLOGON',
      '/TN', 'OriginCodexWatch',
      '/TR', tr,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return { registered: true, reason: 'schtasks-created' };
  } catch (err) {
    return { registered: false, reason: `schtasks-failed: ${String(err)}` };
  }
}

// ─── Real-dependency wiring ──────────────────────────────────────────────────

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
    parseRollout: parseCodexRolloutLive,
    isInternalSubroutine: isCodexInternalSubroutine,
    resolveRepo: realResolveRepo,
    createShadow: createShadowCommit,
    getHead: (workRoot: string) => getHeadSha(workRoot),
    captureDiff: captureAgyDiff,
    captureRangeDiff: captureShadowRangeDiff,
    readFileAtRev,
    // Committed-only, full-context walk of headShaAtStart..HEAD — the session's
    // real commits with per-commit numstat + patch, for server attribution.
    captureGit: (workRoot: string, headBefore: string | null) =>
      captureGitState(workRoot, headBefore, { committedOnly: true, fullContext: true }),
    loadState: (threadId: string) => loadThreadState(threadId),
    saveState: (s: ThreadWatchState) => saveThreadState(s),
  };
}

// ─── Command entry ───────────────────────────────────────────────────────────

export interface CodexWatchOptions {
  once?: boolean;   // run a single poll cycle then exit (testing / cron)
  quiet?: boolean;
}

// Long-lived watcher loop. Acquires the single-instance pid file, then polls
// until superseded, the lifetime cap, or a signal.
export async function codexWatchCommand(opts: CodexWatchOptions = {}): Promise<void> {
  const log = (msg: string) => { if (!opts.quiet) process.stdout.write(msg + '\n'); };

  const config = loadConfig();
  if (!config?.apiKey) {
    log('Origin is not logged in — run `origin login` first. codex-watch needs a connected account.');
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
  const sessionsDir = codexSessionsDir();

  if (opts.once) {
    await runWatchCycle(sessionsDir, deps);
    return;
  }

  // Single-instance: exit if a live watcher already owns the pid file.
  if (anotherWatcherRunning()) {
    log('Another codex-watch instance is already running — exiting.');
    return;
  }
  writeOwnPid();
  // Record the build this daemon is running so `origin upgrade` can tell a
  // stale daemon from a current one even when it installs nothing.
  writeWatchMeta(watchPidFile());

  let stopped = false;
  const cleanup = () => {
    stopped = true;
    // Only remove the pid file if WE still own it.
    try {
      const pid = parseInt(fs.readFileSync(watchPidFile(), 'utf-8').trim(), 10);
      if (pid === process.pid) { fs.unlinkSync(watchPidFile()); removeWatchMeta(watchPidFile()); }
    } catch { /* ignore */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  log(`codex-watch started (pid ${process.pid}); polling ${sessionsDir} every ${POLL_INTERVAL_MS / 1000}s.`);
  const startedAt = Date.now();
  while (!stopped) {
    if (watcherSuperseded()) { log('Superseded by a newer codex-watch instance — exiting.'); break; }
    if (Date.now() - startedAt > MAX_DAEMON_LIFETIME_MS) { log('Lifetime cap reached — exiting.'); cleanup(); break; }
    try { await runWatchCycle(sessionsDir, deps); } catch (err) {
      debugLog('codex-watch', 'cycle error', { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
