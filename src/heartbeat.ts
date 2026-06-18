#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Origin CLI — Background Heartbeat Daemon
// ---------------------------------------------------------------------------
// Spawned as a detached child process on session-start.
// Pings the API every 30s to keep the session marked as RUNNING.
// Exits when:
//   - PID file is removed (session-end cleanup)
//   - Parent agent process is no longer alive (Ctrl+C, terminal closed)
//   - Session state file is gone (session ended by another hook)
//   - 24 hours elapsed (safety net)
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as fzstd from 'fzstd';
import { createShadowCommit, MAX_PROMPT_DIFF_LEN } from './git-capture.js';
import {
  parseSessionLimits,
  evaluateSessionLimits,
  sendDesktopNotification,
} from './session-limits.js';
import {
  evaluateBudgetBreach,
  BUDGET_BLOCKING_AGENTS,
  writeBudgetLockNotice,
  clearBudgetLockNotice,
  type BudgetBreachState,
} from './budget-breach.js';

const args = process.argv.slice(2);
const sessionId = args[0];
const apiUrl = args[1];
const apiKey = process.env.ORIGIN_HEARTBEAT_API_KEY || args[2];
const pidFile = args[3];
const parentPid = args[4] ? parseInt(args[4], 10) : 0;
const stateFile = args[5] || '';

if (!sessionId || !pidFile) {
  process.exit(1);
}
const isConnected = !!(apiUrl && apiKey);

// Write our PID so the main process can kill us
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

const PING_INTERVAL_MS = 30_000; // 30 seconds
// Confirm parent-death over N consecutive ticks before we actually
// call /session/end. A single "parent gone" check is too trigger-
// happy — kernel race conditions during agent reload, transient
// `ps` failures, or pattern-matched PIDs that were short-lived
// subprocesses (an Origin hook, an aux launcher) all fire false
// positives. 3 ticks × 30s = 90s confirmation window. Real agent
// deaths persist for hours; this only delays the COMPLETED stamp.
const PARENT_DEAD_TICKS_BEFORE_END = 3;
let parentDeadTickCount = 0;
// For agents where we can't detect parent PID (Cursor, Claude Code —
// they're standalone Electron apps with messy process trees), the
// heartbeat falls back to state-file freshness. The state file's mtime
// gets bumped on every Claude hook (UserPromptSubmit, PreToolUse, Stop,
// SessionEnd, …) via saveSessionState in commands/hooks.ts, so a fresh
// mtime means the editor is alive and the user is interacting with it.
//
// History of this number:
//   - 2h originally — sessions stayed RUNNING for hours after the tab
//     closed.
//   - 30 min — overcorrected. Users reported sessions going COMPLETED
//     at ~19 min while the Claude tab was still open. The trigger was
//     macOS Claude Desktop's `disclaimer` wrapper getting picked as the
//     "agent" PID and dying early; moving Claude Code to stale-file-
//     only fixes the wrong-PID problem but the 30-min window is still
//     tight (a user reading a long Claude response for half an hour
//     would false-end).
//   - 90 min (now) — comfortable headroom over IDLE_THRESHOLD (1h).
//     Sequence for an actually idle session:
//       T+0      → user walks away
//       T+1h     → server's computeStatus() shows IDLE label
//                  (lastActivityAt > IDLE_THRESHOLD_MS)
//       T+1.5h   → state file age > STALE_THRESHOLD_MS
//                  → heartbeat starts 3-tick parent-dead confirmation
//       T+1.5h + 90s → /session/end → row flips to COMPLETED
//     IDLE is visible for ~30 min before the row completes — what the
//     user expected. Sessions actively in use (Claude hook firing at
//     least every 90 min) never trip this.
//
// If the user comes back later and types a new prompt after a
// false-end, the existing session/start resume path (routes/mcp.ts)
// finds the COMPLETED row via agentSessionId and re-opens it — the
// row recovers automatically.
const STALE_THRESHOLD_MS = 90 * 60 * 1000; // 90 minutes

/**
 * Check if a process is still alive (signal 0 = existence check).
 */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false; // unknown parent — can't verify, use stale check instead
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the session state file was recently updated.
 * Only used as safety net for agents where parent PID is unknown (Cursor, Codex).
 * Uses 2-hour threshold to avoid killing sessions during long idle periods.
 */
function isStateFileStale(): boolean {
  if (!stateFile) return false; // can't check without state file
  try {
    const stat = fs.statSync(stateFile);
    const age = Date.now() - stat.mtimeMs;
    return age > STALE_THRESHOLD_MS;
  } catch {
    return true; // file gone = session ended
  }
}

/**
 * Read the agent's current git branch from the session's repo path.
 * Hooks fire on prompt-submit which Gemini/Codex/etc don't always trigger,
 * so the heartbeat reports branch every 30s as a backstop — keeps the
 * dashboard in sync after a mid-session `git checkout`.
 */
function getCurrentBranch(): string | null {
  if (!stateFile) return null;
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(raw) as { repoPath?: string };
    const repoPath = state.repoPath;
    if (!repoPath) return null;
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compute a live diff for the prompt that's currently in-flight and
 * push it to the server. Without this, the most-recently-submitted
 * prompt's diff stays empty on the dashboard until either the NEXT
 * user-prompt-submit fires (retroactive capture) or the agent's Stop
 * hook fires (safety-net synthesis). For Codex specifically, Stop
 * doesn't fire per-turn — only at session end — so the user sees no
 * diff for the current turn until they submit another prompt. This
 * function plugs that gap by recomputing prompt-N's diff every
 * heartbeat tick.
 */
async function pushInflightDiff(): Promise<void> {
  if (!isConnected || !stateFile) return;
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(raw) as {
      repoPath?: string;
      prePromptSha?: string;
      prompts?: string[];
      sessionId?: string;
      prePromptDirtyFiles?: string[];
      sessionStartDirtyFiles?: string[];
      sessionCommitShas?: string[];
      headShaAtStart?: string;
      // Dirty-tree snapshot SHA from session start (tracked + untracked).
      // Used as the "what did the session change" baseline so pre-existing
      // working-tree dirt isn't mistaken for the session's own edits.
      sessionStartShadowSha?: string | null;
      // Shadow commits captured at the START of each Codex prompt by
      // pushInflightCodexState. Each entry is the baseline SHA for that
      // prompt's turn — the diff scope for prompt N is shadowSha[N]..HEAD.
      // The shadow itself can be stale (created at heartbeat tick time,
      // not at prompt-submit time), so we ALSO read promptStartedAt below
      // to pick the real baseline from sessionCommitShas.
      promptShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string; promptStartedAt?: number }>;
      promptStartedAt?: number[];
    };
    const repoPath = state.repoPath;
    const prePromptSha = state.prePromptSha;
    const prompts = state.prompts || [];
    if (!repoPath || !prePromptSha || prompts.length === 0) return;

    const promptIndex = prompts.length - 1;
    const promptText = (prompts[promptIndex] || '').slice(0, 1000);
    const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 5000 };
    const isHex = (s: string) => /^[a-fA-F0-9]{7,40}$/.test(s);
    const isAncestor = (anc: string, descendant: string): boolean => {
      if (!isHex(anc) || !isHex(descendant)) return false;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', anc, descendant], gitOpts);
        return true;
      } catch { return false; }
    };

    // Per-prompt baseline. Two-stage resolution:
    //   1. Prefer timestamp-based: find the LAST session commit whose commit
    //      time is at-or-before this prompt's rollout timestamp. Codex often
    //      makes commits inside a prompt BEFORE the heartbeat notices the
    //      prompt arrival, so a shadow created at detection time captures
    //      POST-commit state and the diff against it loses the prompt's
    //      real work. The timestamp approach pegs the baseline to the
    //      moment the user actually submitted the prompt.
    //   2. Fall back to the stored shadow SHA, then to session-start.
    const promptShadows = state.promptShadows || [];
    const currentShadow = promptShadows.find((s) => s.promptIndex === promptIndex);
    const promptStartedAt: number =
      (state.promptStartedAt && state.promptStartedAt[promptIndex]) ||
      currentShadow?.promptStartedAt ||
      0;
    const sessionCommitShas = state.sessionCommitShas || [];
    let timestampBaseline: string | null = null;
    if (promptStartedAt > 0 && sessionCommitShas.length > 0) {
      // git log emits ISO commit time per sha; pick the most recent commit
      // whose time is BEFORE promptStartedAt. Single git call instead of
      // one-per-commit so even a 50-commit session stays fast.
      try {
        const shaList = sessionCommitShas.filter((s) => isHex(s));
        if (shaList.length > 0) {
          const out = execFileSync(
            'git',
            ['log', '--no-walk', '--format=%H %ct', ...shaList],
            gitOpts,
          ).toString();
          let latestBefore: { sha: string; ct: number } | null = null;
          for (const ln of out.split('\n')) {
            const m = ln.match(/^([0-9a-f]{7,40})\s+(\d+)$/);
            if (!m) continue;
            const ctMs = Number(m[2]) * 1000;
            if (ctMs < promptStartedAt && (!latestBefore || ctMs > latestBefore.ct)) {
              latestBefore = { sha: m[1], ct: ctMs };
            }
          }
          if (latestBefore) timestampBaseline = latestBefore.sha;
        }
      } catch { /* git log can fail on shallow clones — fall back below */ }
    }
    const promptBaseline =
      timestampBaseline || currentShadow?.shadowSha || state.headShaAtStart || prePromptSha;

    // Committed side: only commits this session authored AND made AFTER the
    // current prompt's baseline. Walking the session's own commit list
    // keeps concurrent-session commits out; filtering by ancestry of the
    // prompt baseline keeps EARLIER prompts' commits out.
    let committedDiff = '';
    let uncommittedDiff = '';
    if (sessionCommitShas.length > 0) {
      const parts: string[] = [];
      for (const sha of sessionCommitShas) {
        if (!isHex(sha)) continue;
        // Skip commits whose ancestry doesn't include the prompt baseline —
        // those landed BEFORE this prompt started and belong to a sibling.
        if (isHex(promptBaseline) && !isAncestor(promptBaseline, sha)) continue;
        try {
          // --unified=2000 = full-file context for any reasonable source file.
          // The blame route reconstructs per-line attribution by replaying
          // each prompt's apply_patch / Edit onto a baseline buffer built
          // from this diff. With only the default 3-line context, the
          // buffer is full of small holes and replay's findSubsequence
          // misses, forcing attribution into content-keyed guessing.
          // Full-file context lets every edit anchor to a real position
          // and removes the guesswork. Capped by MAX_DIFF_SIZE below.
          const out = execFileSync('git', ['show', sha, '--format=', '--no-color', '--unified=2000'], gitOpts).toString().trim();
          if (out) parts.push(out);
        } catch { /* commit may be unreachable after a rebase */ }
      }
      committedDiff = parts.join('\n').trim();
    }
    try {
      // Uncommitted = working tree vs HEAD. Diffing against the prompt
      // baseline conflated committed + uncommitted (since baseline..HEAD is
      // the committed side and baseline..working-tree adds the uncommitted
      // part), which made the dashboard render lines as "uncommitted" even
      // after the agent had committed them. `git diff HEAD` is uncommitted-
      // only by definition.
      // --unified=2000: see comment above on committed diff. Per-prompt
      // diff feeds the blame fallback when sessionDiff doesn't cover the
      // file — and that path needs full-file context to anchor edits.
      uncommittedDiff = execFileSync('git', ['diff', '--unified=2000', 'HEAD'], gitOpts).toString();
    } catch { /* clean tree — no uncommitted */ }
    // `git diff HEAD` omits NEW untracked files — so a prompt that creates a
    // file showed fewer files/lines in its per-prompt diff than the Full
    // Session Diff (git-capture.ts appends untracked, so the full diff has
    // them). Append untracked here too, the same way, to keep them in sync.
    try {
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts).toString().trim();
      if (untracked) {
        for (const file of untracked.split('\n').filter(Boolean)) {
          let out = '';
          try {
            out = execFileSync('git', ['diff', '--no-index', '/dev/null', file], gitOpts).toString();
          } catch (e: any) {
            // `git diff --no-index` exits 1 when there IS a diff — stdout still
            // holds the patch (encoding is set, so it's a string).
            out = e?.stdout != null ? String(e.stdout) : '';
          }
          out = out.trim();
          if (out) uncommittedDiff = uncommittedDiff ? uncommittedDiff + '\n' + out : out;
        }
      }
    } catch { /* ls-files failed — skip untracked */ }

    if (!committedDiff && !uncommittedDiff) return; // nothing to send

    // Smart strip: drop a session-start-dirty file ONLY when the session
    // has demonstrably NOT touched it. "Touched" means either:
    //   1. The file appears in any sessionCommitSha's filesChanged
    //      (committed work), OR
    //   2. The file's current content differs from its content in the
    //      session-start shadow (uncommitted work the session has done so
    //      far, including the very first prompt before any commits land).
    // Earlier versions only checked (1), which over-filtered on prompt 0
    // and the first heartbeat of any prompt that hadn't committed yet —
    // EVERY dirty file got dropped because sessionCommitShas was empty.
    const sessionStartDirty = new Set<string>(state.sessionStartDirtyFiles || []);
    const sessionTouched = new Set<string>();
    for (const sha of sessionCommitShas) {
      if (!isHex(sha)) continue;
      try {
        const names = execFileSync(
          'git',
          ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
          gitOpts,
        ).toString();
        for (const ln of names.split('\n')) {
          const t = ln.trim();
          if (t) sessionTouched.add(t);
        }
      } catch { /* commit may be unreachable after a rebase */ }
    }
    // Files modified-from-shadow add the (2) signal — a single `git diff`
    // gives us all files whose current content differs from the session-
    // start snapshot, so we can mark them as session work even when no
    // commit exists yet.
    //
    // Prefer the session-start DIRTY shadow (a snapshot of the full working
    // tree — tracked + untracked — taken when the session began). Diffing
    // against it reports only what changed SINCE session start, so files that
    // were already dirty before the session (pre-existing uncommitted edits
    // from a prior agent or the user) do NOT register as "touched" and stay
    // in the strip set. Falling back to headShaAtStart (a CLEAN commit) — the
    // old behavior — counted that pre-existing dirt as session work, which
    // leaked it onto every prompt, including pure read-only ones.
    const sessionStartShadow =
      state.sessionStartShadowSha || state.headShaAtStart || state.prePromptSha;
    if (sessionStartDirty.size > 0 && sessionStartShadow && isHex(sessionStartShadow)) {
      try {
        const out = execFileSync(
          'git',
          ['diff', sessionStartShadow, '--name-only'],
          gitOpts,
        ).toString();
        for (const ln of out.split('\n')) {
          const t = ln.trim();
          if (t) sessionTouched.add(t);
        }
      } catch { /* shadow gone — fall back to commit-only signal */ }
    }
    const excludeSet = new Set<string>();
    for (const f of sessionStartDirty) {
      if (!sessionTouched.has(f)) excludeSet.add(f);
    }
    // prePromptDirtyFiles applies only within the current prompt's window —
    // never let prior-prompt dirt leak even if the session has touched it.
    for (const f of (state.prePromptDirtyFiles || [])) {
      if (!sessionTouched.has(f)) excludeSet.add(f);
    }
    const stripFiles = (text: string): string => {
      if (!text || excludeSet.size === 0) return text;
      const parts = text.split(/(?=^diff --git )/m);
      const kept: string[] = [];
      for (const part of parts) {
        const m = part.match(/^diff --git a\/(.*?) b\//);
        if (m && m[1] && excludeSet.has(m[1])) continue;
        kept.push(part);
      }
      return kept.join('').trim();
    };
    committedDiff = stripFiles(committedDiff);
    uncommittedDiff = stripFiles(uncommittedDiff);

    if (!committedDiff && !uncommittedDiff) return; // pure pre-existing dirt — nothing to publish

    const filesChanged = new Set<string>();
    for (const blob of [committedDiff, uncommittedDiff]) {
      for (const m of blob.matchAll(/^diff --git a\/(.*?) b\//gm)) {
        if (m[1]) filesChanged.add(m[1]);
      }
    }
    const fullDiff = (committedDiff + (uncommittedDiff ? '\n' + uncommittedDiff : '')).trim();
    const counted = fullDiff.split('\n');
    const linesAdded = counted.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const linesRemoved = counted.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

    // Tag the inflight push with the commit that landed THIS prompt's
    // edits — NOT the session's latest commit. Previously this used
    // ownCommits[last], which overwrote pc.commitSha on every heartbeat
    // so all of a session's prompts ended up tagged with the FINAL
    // commit and the commit-detail filter showed all prompts on every
    // commit page (or none, depending on which way we filtered).
    //
    // Correct rule: a heartbeat firing during prompt N attributes to
    // the FIRST commit that landed AFTER this prompt's prePromptSha
    // (the HEAD recorded when the prompt was submitted). If no new
    // commit has happened yet, leave commitSha null — the server's
    // content-overlap pass will pick the right one at read time
    // (or a later heartbeat fills it in once the commit lands).
    let heartbeatCommitSha: string | null = null;
    let heartbeatTreeSha: string | null = null;
    const ownCommits = state.sessionCommitShas || [];
    try {
      if (prePromptSha && ownCommits.length > 0) {
        // First own commit AFTER prePromptSha — i.e., a commit this
        // prompt caused. Falls back to null if none yet.
        const prePromptIdx = ownCommits.indexOf(prePromptSha);
        const candidates = prePromptIdx >= 0
          ? ownCommits.slice(prePromptIdx + 1)
          : ownCommits;
        heartbeatCommitSha = candidates[0] || null;
      }
      if (heartbeatCommitSha) {
        heartbeatTreeSha = execFileSync('git', ['rev-parse', `${heartbeatCommitSha}^{tree}`], gitOpts).toString().trim();
      }
    } catch { /* fresh repo with no HEAD — fine */ }

    await fetch(`${apiUrl}/api/mcp/session/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        promptChanges: [
          {
            promptIndex,
            promptText,
            filesChanged: Array.from(filesChanged),
            diff: fullDiff.slice(0, MAX_PROMPT_DIFF_LEN),
            uncommittedDiff: uncommittedDiff.slice(0, MAX_PROMPT_DIFF_LEN),
            linesAdded,
            linesRemoved,
            checkpointType: 'auto',
            commitSha: heartbeatCommitSha,
            treeSha: heartbeatTreeSha,
          },
        ],
      }),
    });
  } catch { /* best-effort */ }
}

/**
 * Live Codex rollout poller. Reads ~/.codex/state_*.sqlite to find this
 * repo's rollout JSONL, decompresses + parses it for user prompts and
 * assistant text, and pushes the result via api.updateSession so the
 * dashboard shows Codex's in-flight output without waiting for Stop or
 * the next UserPromptSubmit. Mirrors the minimal slice of
 * discoverCodexSessionData / parseCodexRollout from commands/hooks.ts —
 * we don't share a module because heartbeat.ts is a standalone daemon
 * with its own dependency surface.
 */
function findCodexRollout(repoPath: string): { rolloutPath: string; threadId: string; model: string; firstUserMessage: string } | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const repoBasename = path.basename(repoPath);
    if (!/^[a-zA-Z0-9_.\-]+$/.test(repoBasename)) return null;
    const escapedBasename = repoBasename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const threadQuery = `SELECT id, model, rollout_path, first_user_message FROM threads WHERE cwd LIKE '%${escapedBasename}%' ORDER BY updated_at DESC LIMIT 1;`;
    const raw = execFileSync('sqlite3', [stateFiles[0].path, threadQuery], {
      encoding: 'utf-8' as const, timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;

    const parts = raw.split('|');
    if (parts.length < 4) return null;
    const threadId = parts[0];
    const model = parts[1] || 'codex';
    let rolloutPath = parts[2] || '';
    const firstUserMessage = parts.slice(3).join('|') || '';

    if (!rolloutPath) return null;
    if (!fs.existsSync(rolloutPath)) {
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) rolloutPath = abs;
      else return null;
    }
    return { rolloutPath, threadId, model, firstUserMessage };
  } catch { return null; }
}

function parseCodexRolloutLive(rolloutFile: string): {
  userPrompts: string[];
  // Per-prompt timestamps (ms epoch) parsed from the rollout's user message
  // events. Used to compute the per-prompt diff baseline at heartbeat time
  // — the LAST committed sha whose commit time is at-or-before the prompt
  // start. Without this, baselines fall back to whichever HEAD existed when
  // the heartbeat happened to notice the prompt, which is usually AFTER
  // Codex has already made commits inside the prompt (then the diff against
  // that "baseline" loses the prompt's real work).
  promptTimestamps: number[];
  transcript: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  toolCalls: number;
} | null {
  try {
    let content: string;
    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      const compressed = fs.readFileSync(rolloutFile);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      content = Buffer.from(decompressed).toString('utf-8');
    } else {
      content = fs.readFileSync(rolloutFile, 'utf-8');
    }

    const lines = content.split('\n').filter(l => l.trim());
    const turns: Array<{ role: string; content: string }> = [];
    const promptTimestamps: number[] = [];
    const pendingTools = new Map<string, number>();
    let maxInputTokens = 0, maxOutputTokens = 0, maxTotalTokens = 0;
    let model: string | undefined;
    let toolCalls = 0;
    const TRUNC = 2000;
    const truncate = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + `… [+${s.length - TRUNC} chars]` : s;

    const extractText = (c: any): string => {
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return '';
      return c.map((p: any) => p?.text || (typeof p === 'string' ? p : '') || (typeof p?.content === 'string' ? p.content : '')).filter(Boolean).join('');
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const tokenUsage = event?.total_token_usage || event?.data?.total_token_usage || event?.payload?.info?.total_token_usage || event?.payload?.total_token_usage;
        if (tokenUsage) {
          const i = tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0;
          const o = tokenUsage.output_tokens || tokenUsage.completion_tokens || 0;
          const t = tokenUsage.total_tokens || (i + o);
          if (t > maxTotalTokens) { maxInputTokens = i; maxOutputTokens = o; maxTotalTokens = t; }
        }
        if (!model && (event?.model || event?.data?.model || event?.payload?.model)) {
          model = event.model || event.data?.model || event.payload?.model;
        }
        const payload = event?.payload;
        const ptype = payload?.type || '';
        if (ptype === 'message') {
          const role = payload.role || 'assistant';
          const text = extractText(payload.content);
          if (text.trim()) {
            const isUser = role === 'user' || role === 'human';
            const isEcho = isUser && (text.includes('<!-- origin-managed -->') || /^#\s+AGENTS\.md instructions for /m.test(text));
            if (!isEcho) {
              const cleaned = isUser
                ? text
                    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                    .trim()
                : text;
              if (cleaned) {
                turns.push({ role, content: cleaned });
                // Capture per-user-prompt timestamp from any of Codex's
                // event-level time fields. Without this the prompt baseline
                // falls back to "whenever heartbeat noticed", which is
                // usually AFTER Codex made commits inside the prompt.
                if (isUser) {
                  const ts = (() => {
                    const candidates = [
                      event?.timestamp,
                      event?.created_at,
                      event?.payload?.timestamp,
                      event?.payload?.created_at,
                      payload?.timestamp,
                      payload?.created_at,
                    ];
                    for (const c of candidates) {
                      if (typeof c === 'number' && Number.isFinite(c)) return c > 1e12 ? c : c * 1000;
                      if (typeof c === 'string') {
                        const n = Date.parse(c);
                        if (Number.isFinite(n)) return n;
                      }
                    }
                    return 0;
                  })();
                  promptTimestamps.push(ts);
                }
              }
            }
          }
        } else if (ptype === 'reasoning') {
          const summary = Array.isArray(payload.summary) ? payload.summary : [];
          const t = summary.map((s: any) => s?.text || '').filter(Boolean).join('\n\n');
          if (t.trim()) turns.push({ role: 'assistant', content: `[Reasoning] ${t}` });
        } else if (ptype === 'function_call' || ptype === 'local_shell_call') {
          toolCalls++;
          const tool = payload.name || (ptype === 'local_shell_call' ? 'shell' : 'tool');
          const args = payload.arguments ?? payload.action ?? payload.command ?? '';
          const argStr = typeof args === 'string' ? args : JSON.stringify(args);
          const callId = payload.call_id || payload.id || '';
          const idx = turns.length;
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
          if (callId) pendingTools.set(callId, idx);
        } else if (ptype === 'function_call_output' || ptype === 'local_shell_call_output') {
          const callId = payload.call_id || payload.id || '';
          const out = typeof payload.output === 'string' ? payload.output
            : (payload.output?.content ? (typeof payload.output.content === 'string' ? payload.output.content : JSON.stringify(payload.output.content))
            : JSON.stringify(payload.output ?? ''));
          if (out) {
            const idx = callId ? pendingTools.get(callId) : undefined;
            if (idx !== undefined) {
              turns[idx].content += `\n[Output] ${truncate(out)}`;
              pendingTools.delete(callId);
            } else {
              turns.push({ role: 'assistant', content: `[Output] ${truncate(out)}` });
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    if (turns.length === 0 && maxTotalTokens === 0) return null;
    const userPrompts: string[] = [];
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'human') {
        const c = t.content.trim();
        if (c) userPrompts.push(c);
      }
    }
    return {
      userPrompts,
      promptTimestamps,
      transcript: JSON.stringify(turns),
      tokensUsed: maxTotalTokens,
      inputTokens: maxInputTokens,
      outputTokens: maxOutputTokens,
      model,
      toolCalls,
    };
  } catch { return null; }
}

async function pushInflightCodexState(): Promise<void> {
  if (!isConnected || !stateFile) return;
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(raw) as {
      repoPath?: string;
      prompts?: string[];
      agentSlug?: string;
      sessionId?: string;
    };
    if ((state.agentSlug || '').toLowerCase() !== 'codex') return;
    if (!state.repoPath) return;

    const rollout = findCodexRollout(state.repoPath);
    if (!rollout) return;
    const parsed = parseCodexRolloutLive(rollout.rolloutPath);
    if (!parsed) return;

    const existing = state.prompts || [];
    const newer = parsed.userPrompts.length > existing.length;

    // Update state file with the latest prompts so user-prompt-submit /
    // Stop don't lose ground we've already gained.
    //
    // Also create a per-prompt shadow commit for EVERY new prompt detected
    // since last poll. Codex doesn't fire user-prompt-submit reliably, so
    // without these shadows we have no per-turn baseline to compute the
    // diff against — every prompt's work ends up looking like the SAME
    // cumulative diff. Capturing a shadow at the moment we detect a new
    // user_message in the rollout gives us a per-prompt boundary that
    // doesn't depend on hook firing.
    if (newer) {
      try {
        const fresh = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const existingShadows: Array<{
          promptIndex: number;
          shadowSha: string;
          capturedAt: string;
          // Rollout's own user_message timestamp (ms epoch) for this prompt.
          // capturedAt is whenever the heartbeat noticed the prompt — usually
          // AFTER Codex started doing work — so it's useless as a "what did
          // this prompt actually start with" anchor. promptStartedAt is the
          // true prompt-submit time and lets pushInflightDiff pick the LAST
          // commit that landed before this prompt as the diff baseline.
          promptStartedAt?: number;
        }> = Array.isArray(fresh.promptShadows) ? fresh.promptShadows : [];
        const have = new Set(existingShadows.map((s) => s.promptIndex));

        // For each newly arrived prompt (indices existing.length .. parsed.userPrompts.length - 1),
        // snapshot the current working tree to a shadow commit so we have a
        // baseline marker for that prompt's turn. The shadow represents the
        // state at the START of that prompt (= end of previous prompt's work).
        const newCount = parsed.userPrompts.length;
        const prevCount = existing.length;
        for (let i = prevCount; i < newCount; i++) {
          if (have.has(i)) continue;
          const shadowSha = createShadowCommit(fresh.repoPath, `prompt-${i}-${sessionId.slice(0, 8)}`);
          const ts = parsed.promptTimestamps?.[i] || 0;
          if (shadowSha) {
            existingShadows.push({
              promptIndex: i,
              shadowSha,
              capturedAt: new Date().toISOString(),
              promptStartedAt: ts > 0 ? ts : undefined,
            });
          }
        }

        fresh.prompts = parsed.userPrompts;
        fresh.promptShadows = existingShadows;
        // Mirror promptStartedAt timestamps into a parallel array so
        // pushInflightDiff can pick the right baseline without re-parsing
        // the rollout each tick.
        fresh.promptStartedAt = parsed.promptTimestamps?.slice(0, parsed.userPrompts.length) || [];
        fs.writeFileSync(stateFile, JSON.stringify(fresh), { mode: 0o600 });
      } catch { /* non-fatal */ }
    }

    const promptsForPush = parsed.userPrompts.length > 0 ? parsed.userPrompts : existing;
    const joinedPrompt = promptsForPush.join('\n\n---\n\n');

    await fetch(`${apiUrl}/api/mcp/session/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        prompt: joinedPrompt || undefined,
        transcript: parsed.transcript || undefined,
        model: parsed.model || undefined,
        tokensUsed: parsed.tokensUsed > 0 ? parsed.tokensUsed : undefined,
        inputTokens: parsed.inputTokens > 0 ? parsed.inputTokens : undefined,
        outputTokens: parsed.outputTokens > 0 ? parsed.outputTokens : undefined,
        toolCalls: parsed.toolCalls > 0 ? parsed.toolCalls : undefined,
        status: 'RUNNING',
      }),
    });
  } catch { /* best-effort */ }
}

/**
 * Report command execution result back to the dashboard.
 */
async function reportResult(type: string, status: 'success' | 'failed', message: string) {
  if (!isConnected) return;
  try {
    await fetch(`${apiUrl}/api/mcp/session/${sessionId}/command-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ type, status, message }),
    });
  } catch { /* ignore */ }
}

/**
 * Handle a branch command from the dashboard.
 * Creates a new branch at the snapshot's commit, optionally checks it out.
 * Non-destructive by default — doesn't touch current HEAD or working tree.
 */
async function handleBranch(command: { commitSha?: string; branchName?: string; checkout?: boolean }) {
  let repoPath = '';
  if (stateFile) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      repoPath = state.repoPath || '';
    } catch { /* ignore */ }
  }
  if (!repoPath) {
    await reportResult('branch', 'failed', 'Could not resolve repo path from session state');
    return;
  }
  if (!command.commitSha || !/^[a-fA-F0-9]+$/.test(command.commitSha)) {
    await reportResult('branch', 'failed', 'Invalid or missing commit SHA');
    return;
  }

  const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 15000 };

  try {
    // Generate branch name if not provided
    const shortSha = command.commitSha.slice(0, 7);
    const sanitizedName = (command.branchName || `snapshot-${shortSha}`)
      .replace(/[^a-zA-Z0-9/_-]/g, '-')
      .slice(0, 80);

    // Create the branch pointing to the commit (no checkout by default)
    execFileSync('git', ['branch', sanitizedName, command.commitSha], gitOpts);

    let msg = `Created branch "${sanitizedName}" at commit ${shortSha}.`;

    // Optionally check it out
    if (command.checkout) {
      // Stash uncommitted work first so we don't lose anything
      let stashed = false;
      try {
        const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
        if (dirty) {
          execFileSync('git', ['stash', 'push', '-u', '-m', `origin-branch-autostash-${Date.now()}`], gitOpts);
          stashed = true;
        }
      } catch { /* ignore */ }

      try {
        execFileSync('git', ['checkout', sanitizedName], gitOpts);
        msg += ` Checked out.${stashed ? ' Uncommitted changes stashed.' : ''}`;
      } catch (err: any) {
        if (stashed) {
          try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
        }
        msg += ` Could not checkout: ${err?.message || 'unknown error'}`;
      }
    } else {
      msg += ` Run "git checkout ${sanitizedName}" when ready.`;
    }

    await reportResult('branch', 'success', msg);
  } catch (err: any) {
    const errMsg = err?.message || 'Unknown error';
    // Common case: branch already exists
    if (errMsg.includes('already exists')) {
      await reportResult('branch', 'failed', `Branch already exists. Try a different name.`);
    } else {
      await reportResult('branch', 'failed', errMsg);
    }
  }
}

/**
 * Handle a restore command from the dashboard.
 * Creates a new branch at the snapshot's commit so HEAD moves cleanly
 * and the user's current branch is preserved.
 */
async function handleRestore(command: {
  treeSha?: string;
  commitSha?: string;
  // 'soft' (default): write files to working tree, leave HEAD alone.
  //                   Non-destructive — `git stash pop` recovers
  //                   pre-restore work; `git checkout .` discards.
  // 'hard'         : `git reset --hard <commitSha>`. Moves HEAD too,
  //                   discards commits between HEAD and the target
  //                   on the current branch.
  mode?: 'soft' | 'hard';
}) {
  // Get repo path from state file
  let repoPath = '';
  if (stateFile) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      repoPath = state.repoPath || '';
    } catch { /* ignore */ }
  }
  if (!repoPath) {
    await reportResult('restore', 'failed', 'Could not resolve repo path from session state');
    return;
  }

  const restoreMode: 'soft' | 'hard' = command.mode === 'hard' ? 'hard' : 'soft';
  const sha = command.commitSha || command.treeSha;
  if (!sha || !/^[a-fA-F0-9]+$/.test(sha)) {
    await reportResult('restore', 'failed', 'Invalid or missing SHA');
    return;
  }
  if (restoreMode === 'hard' && !command.commitSha) {
    await reportResult('restore', 'failed', 'hard mode requires commitSha');
    return;
  }

  const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 15000 };

  try {
    // Get current branch (fallback to HEAD sha if detached)
    let originalBranch = '';
    try {
      originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).trim();
    } catch { /* ignore */ }

    // Capture pre-restore HEAD so the post-restore panel can show the
    // "commits ahead" count and offer to roll HEAD back too.
    let headBeforeRestore = '';
    try {
      headBeforeRestore = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).trim();
    } catch { /* ignore */ }

    // Stash any uncommitted work so we don't lose it. Stash name is
    // searchable so the post-restore panel can point the user at it.
    let stashed = false;
    const stashName = `origin-restore-autostash-${Date.now()}`;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
      if (dirty) {
        execFileSync('git', ['stash', 'push', '-u', '-m', stashName], gitOpts);
        stashed = true;
      }
    } catch { /* ignore */ }

    if (restoreMode === 'hard') {
      // Destructive: move HEAD to commitSha and reset working tree to
      // its content in one shot. Commits between original HEAD and the
      // target become unreachable from this branch (still in the reflog
      // for ~30 days). The pre-restore stash is the recovery escape.
      try {
        execFileSync('git', ['reset', '--hard', command.commitSha!], gitOpts);
      } catch (err: any) {
        if (stashed) {
          try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
        }
        throw err;
      }
      const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
      fs.writeFileSync(markerPath, JSON.stringify({
        restoredAt: new Date().toISOString(),
        commitSha: command.commitSha,
        mode: 'hard',
        headBeforeRestore,
        originalBranch,
        stashed,
        stashName: stashed ? stashName : null,
        sessionId,
      }), { mode: 0o600 });
      const msg = `Hard-restored: HEAD moved to ${command.commitSha!.slice(0, 7)} on ${originalBranch || 'detached HEAD'}. ` +
        `Working tree matches. ` +
        (stashed ? `Pre-restore changes stashed as "${stashName}" — recover with "git stash pop". ` : '') +
        `Commits between ${headBeforeRestore.slice(0, 7) || 'HEAD'} and ${command.commitSha!.slice(0, 7)} are unreachable from this branch (still in the reflog for ~30 days).`;
      await reportResult('restore', 'success', msg);
      return;
    }

    // Soft restore: write file content, leave HEAD alone. Works with
    // either commitSha (resolve to commit's tree) or a bare treeSha.
    const targetTree = command.treeSha
      ? command.treeSha
      : (() => {
          // Resolve commit → tree SHA.
          try {
            return execFileSync('git', ['rev-parse', `${command.commitSha}^{tree}`], gitOpts).trim();
          } catch { return ''; }
        })();
    if (!/^[a-fA-F0-9]{40}$/.test(targetTree)) {
      if (stashed) {
        try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
      }
      await reportResult('restore', 'failed', 'Could not resolve target tree SHA');
      return;
    }
    execFileSync('git', ['read-tree', targetTree], gitOpts);
    execFileSync('git', ['checkout-index', '-a', '-f'], gitOpts);
    // Restore the index to match HEAD so `git status` only shows the
    // working-tree-vs-HEAD diff (the restored content) instead of also
    // flagging every file as staged-vs-HEAD.
    execFileSync('git', ['read-tree', 'HEAD'], gitOpts);

    // Count commits between the restored snapshot's commit and current
    // HEAD so the dialog can show "X commits ahead of restored snapshot."
    // Only meaningful when we know the target's commit SHA; tree-only
    // restores don't have a commit lineage to compare against.
    let commitsAhead: number | null = null;
    if (command.commitSha) {
      try {
        const out = execFileSync(
          'git',
          ['rev-list', '--count', `${command.commitSha}..HEAD`],
          gitOpts,
        ).trim();
        const n = parseInt(out, 10);
        if (Number.isFinite(n)) commitsAhead = n;
      } catch { /* non-fatal — leave null */ }
    }

    const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
    fs.writeFileSync(markerPath, JSON.stringify({
      restoredAt: new Date().toISOString(),
      treeSha: targetTree,
      commitSha: command.commitSha || null,
      mode: 'soft',
      headBeforeRestore,
      commitsAhead,
      originalBranch,
      stashed,
      stashName: stashed ? stashName : null,
      sessionId,
    }), { mode: 0o600 });

    const aheadFragment = commitsAhead != null
      ? ` (${commitsAhead} commit${commitsAhead === 1 ? '' : 's'} ahead of restored snapshot)`
      : '';
    await reportResult('restore', 'success',
      `Soft-restored files to tree ${targetTree.slice(0, 7)}. HEAD unchanged (still at ${headBeforeRestore.slice(0, 7) || 'unknown'}${aheadFragment}). ` +
      `Use "git diff" to review or "git checkout ." to revert. ` +
      (stashed ? `Pre-restore changes stashed as "${stashName}" — recover with "git stash pop".` : ''));
  } catch (err: any) {
    await reportResult('restore', 'failed', err?.message || 'Unknown error during restore');
  }
}

/**
 * End the session on the API when the agent process dies.
 * Cleans up state file so the next session-start doesn't find stale state.
 */
async function endSession() {
  // Read state file to send accumulated data with end request
  let stateData: any = null;
  if (stateFile) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      stateData = JSON.parse(raw);
    } catch { /* best effort */ }
  }

  // Archive state file to ~/.origin/sessions/ before deleting
  if (stateData) {
    try {
      stateData.status = 'ENDED';
      stateData.endedAt = new Date().toISOString();
      const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
      const archiveDir = `${homeDir}/.origin/sessions`;
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = `${archiveDir}/${(stateData.sessionId || sessionId).slice(0, 12)}.json`;
      fs.writeFileSync(archivePath, JSON.stringify(stateData), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  // End on API if connected — include accumulated prompt/session data
  if (apiKey && apiUrl) {
    try {
      const endPayload: any = { sessionId };

      if (stateData) {
        // Send prompts accumulated during the session
        const prompts: string[] = stateData.prompts || [];
        if (prompts.length > 0) {
          endPayload.prompt = prompts.join('\n\n---\n\n');
        }

        // Send duration
        if (stateData.startedAt) {
          const durationMs = Date.now() - new Date(stateData.startedAt).getTime();
          if (durationMs > 0) endPayload.durationMs = durationMs;
        }

        // Send model if known
        if (stateData.model && stateData.model !== 'unknown' && stateData.model !== 'default') {
          // Don't overwrite — server already has model from updateSession calls
        }

        // Use saved per-prompt mappings (from stop handler) if available.
        // Only build empty fallback if no real mappings exist — avoids
        // overwriting real diffs that stop already sent to the API.
        const savedMappings = stateData.completedPromptMappings;
        if (savedMappings && Array.isArray(savedMappings) && savedMappings.length > 0) {
          endPayload.promptChanges = savedMappings;
        } else if (prompts.length > 0) {
          endPayload.promptChanges = prompts.map((p: string, i: number) => ({
            promptIndex: i,
            promptText: p.slice(0, 1000),
            filesChanged: [],
            diff: '',
          }));
        }
      }

      await fetch(`${apiUrl}/api/mcp/session/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(endPayload),
      });
    } catch { /* best effort */ }
  }

  // Clean up ALL state files for this session (multiple hooks can create duplicates)
  if (stateFile) {
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    // Also clean sibling state files with the same session ID in the same directory
    try {
      // path.dirname handles all edge cases (windows paths, missing
      // separator, trailing slash). The old stateFile.lastIndexOf('/')
      // returned -1 on any path without '/', which then produced
      // substring(0, -1) === '' and readdirSync('') scanned cwd.
      const dir = path.dirname(stateFile);
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try {
            const filePath = path.join(dir, entry);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.sessionId === sessionId) {
              fs.unlinkSync(filePath);
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
  }
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

// ─── SESSION_LIMITS policy checks ──────────────────────────────────────────
//
// The heartbeat is the only component with a timer (hooks fire only on agent
// activity — an idle session triggers nothing), so idle detection and the
// time-based notifications live here. "Idle" = state-file mtime age: every
// lifecycle hook bumps it via saveSessionState, so it stays fresh while the
// user or agent is working and only ages when both go quiet.
//
// Once-flags are process-local: the daemon lives for the whole session, so
// each notification fires once (idle notify re-arms when activity resumes).
// A daemon restart re-notifying once is acceptable; persisting the flags in
// the state file is not — writing it would bump the mtime we use as the
// idle signal.
let idleNotified = false;
let durationWarned = false;
let durationCapNotified = false;
// Current budget-breach episode (null = not breached). Process-local
// for the same reason as the flags above.
let budgetBreach: BudgetBreachState | null = null;
// Last scoped soft-cap warning we desktop-notified for (null = none
// active). Distinct message = new episode = new notification.
let softWarnNotifiedFor: string | null = null;

async function checkSessionLimits(): Promise<void> {
  if (!stateFile) return;
  let state: { enforcementRules?: any[]; startedAt?: string; prompts?: string[] };
  let mtimeMs: number;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    mtimeMs = fs.statSync(stateFile).mtimeMs;
  } catch { return; }

  const cfg = parseSessionLimits(state.enforcementRules);
  if (!cfg) return;
  const status = evaluateSessionLimits(cfg, state.startedAt, mtimeMs, Date.now());

  // Idle notification — re-arms once the session shows activity again, so
  // each idle EPISODE notifies once.
  if (status.idleNotifyDue) {
    if (!idleNotified) {
      idleNotified = true;
      sendDesktopNotification(
        'Origin — idle session',
        `Your session has been idle for ${Math.round(status.idleMinutes)} min. ` +
        `Close it and start fresh next time — resuming a large context costs far more than a new session.`,
      );
    }
  } else {
    idleNotified = false;
  }

  // Approaching the duration cap — one heads-up so the block isn't a surprise.
  if (status.durationWarnDue && !durationWarned && cfg.maxDurationMinutes) {
    durationWarned = true;
    sendDesktopNotification(
      'Origin — session limit approaching',
      `This session is ${Math.round(status.ageMinutes)} min old; your team's limit is ` +
      `${cfg.maxDurationMinutes} min. Wrap up and start a new session soon.`,
    );
  }

  // Duration cap crossed — notify once. The actual prompt blocking happens
  // in user-prompt-submit (commands/hooks.ts), which reads the same rules;
  // the session itself is left to end via the normal stale/parent-death
  // path so an in-flight turn is never cut off.
  if (status.durationExceeded && !durationCapNotified && cfg.maxDurationMinutes) {
    durationCapNotified = true;
    sendDesktopNotification(
      'Origin — session limit reached',
      cfg.enforce
        ? `This session passed your team's ${cfg.maxDurationMinutes}-min limit. New prompts are blocked — start a new session to continue.`
        : `This session passed your team's ${cfg.maxDurationMinutes}-min limit. Consider starting a new session.`,
    );
  }

  // Max idle — auto-end. Only for enforcing (action: block) rules. Safe by
  // construction: an in-flight turn bumps the state file constantly, so a
  // session can only be "idle past the limit" when nothing is running.
  if (status.idleEndDue && cfg.maxIdleMinutes) {
    sendDesktopNotification(
      'Origin — session ended by policy',
      `Session idle for ${Math.round(status.idleMinutes)} min — ended per your team's ` +
      `${cfg.maxIdleMinutes}-min idle limit. Your work is saved; start a new session when you're back.`,
    );
    await endSession();
    process.exit(0);
  }
}

async function ping() {
  try {
    // If PID file is gone, session ended — exit
    if (!fs.existsSync(pidFile)) {
      process.exit(0);
    }

    // Confirm "parent gone" over multiple ticks before ending —
    // see PARENT_DEAD_TICKS_BEFORE_END comment. A single failed
    // check can fire on transient kernel state (process briefly
    // unreachable) or on a pattern-matched PID that was always
    // short-lived. We don't want to end on those.
    const parentLooksDead =
      (parentPid > 0 && !isProcessAlive(parentPid)) ||
      (parentPid <= 0 && isStateFileStale());
    if (parentLooksDead) {
      parentDeadTickCount++;
      if (parentDeadTickCount >= PARENT_DEAD_TICKS_BEFORE_END) {
        await endSession();
        process.exit(0);
      }
      // Not yet confirmed — keep pinging. Falls through to normal
      // heartbeat so the server's updatedAt stays current; the
      // session-cleanup sweep handles the long-silence case if our
      // process is itself killed before confirmation.
    } else {
      // Reset on any live check so transient "dead" blips don't
      // accumulate across long periods of healthy operation.
      parentDeadTickCount = 0;
    }

    // If session state file was removed (session ended by hook), exit
    if (stateFile && !fs.existsSync(stateFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      process.exit(0);
    }

    // Team SESSION_LIMITS policy: idle notification, duration warnings,
    // max-idle auto-end. Works in local mode too — notifications and the
    // auto-end don't need the API.
    await checkSessionLimits();

    // Only ping API in connected mode
    if (isConnected) {
      const resp = await fetch(`${apiUrl}/api/mcp/session/${sessionId}/ping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ branch: getCurrentBranch() }),
      });
      const data = await resp.json() as {
        ok: boolean;
        status?: string;
        command?: any;
        budget?: { blocked?: boolean; level?: string; message?: string };
        // Live policy set, recomputed server-side each ping. Persisted into
        // session state so pre-tool-use enforces a mid-session policy change
        // within one ping interval (~30s) instead of only at session start.
        enforcementRules?: Array<{ type: string; condition: string; action: string; severity: string; policyId?: string; ruleId?: string; policyName?: string }>;
        activePolicies?: string[];
      };

      // Budget lockout propagation — persist the server's hard-cap state
      // into the session state file so user-prompt-submit / pre-tool-use
      // can block new work within one ping interval (~30s) of a breach,
      // even mid-turn, instead of only at the next session start.
      if (data.budget && stateFile && fs.existsSync(stateFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const blocked = !!data.budget.blocked;
          const reason = blocked ? (data.budget.message || 'Hard budget cap exceeded') : undefined;
          // Scoped SOFT-cap warning (warning: true, blocked: false) —
          // persisted so the next user-prompt-submit can surface it in
          // the conversation; cleared (re-arming the banner) when the
          // warning lifts.
          const warnReason = !blocked && (data.budget as any).warning
            ? (data.budget.message || 'Soft budget cap exceeded')
            : undefined;
          if (
            !!raw.budgetBlocked !== blocked ||
            raw.budgetBlockReason !== reason ||
            (raw.budgetWarnReason || undefined) !== warnReason
          ) {
            raw.budgetBlocked = blocked;
            raw.budgetBlockReason = reason;
            if (!blocked) raw.budgetBlockReported = undefined; // next episode reports again
            raw.budgetWarnReason = warnReason;
            if (!warnReason) raw.budgetWarnShownFor = undefined; // re-arm for the next episode
            fs.writeFileSync(stateFile, JSON.stringify(raw), { mode: 0o600 });
          }
          // One desktop notification per distinct warning (mid-session
          // soft-cap crossings shouldn't wait for the next prompt).
          if (warnReason && softWarnNotifiedFor !== warnReason) {
            softWarnNotifiedFor = warnReason;
            sendDesktopNotification(
              'Origin — budget warning',
              `${warnReason}. Work continues (soft limit) — mind the spend.`,
            );
          }
          if (!warnReason) softWarnNotifiedFor = null;
        } catch { /* best effort — next tick retries */ }

        // Breach reaction: notify the user the moment a hard-cap breach
        // is first seen, then end the session once the breach has stood
        // for the grace window AND the session is quiet (no in-flight
        // turn — state mtime is bumped by every lifecycle hook). See
        // budget-breach.ts for why neither happens immediately. The
        // persistence write above bumps mtime at episode start, which
        // harmlessly folds into the quiet window.
        try {
          const mtimeMs = fs.statSync(stateFile).mtimeMs;
          const hadEpisode = budgetBreach !== null;
          const decision = evaluateBudgetBreach(
            budgetBreach,
            !!data.budget.blocked,
            mtimeMs,
            Date.now(),
          );
          budgetBreach = decision.state;
          // Agent-aware reaction: blockable agents (Claude Code, Gemini)
          // get their session ended — their prompt/tool gates have already
          // stopped the loop, so nothing is lost. Codex/Cursor IGNORE
          // those gates: their sessions stay ALIVE so the continued burn
          // keeps appearing on the dashboard (badged over-budget); the
          // AGENTS.md notice + git pre-commit gate are their enforcement.
          const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { agentSlug?: string; repoPath?: string };
          const slug = (raw.agentSlug || '').toLowerCase();
          const canTerminate = BUDGET_BLOCKING_AGENTS.has(slug);
          if (decision.notifyDue) {
            writeBudgetLockNotice(raw.repoPath, data.budget.message || 'hard budget cap exceeded');
            sendDesktopNotification(
              'Origin — budget cap exceeded',
              `${data.budget.message || 'Your team\'s hard budget cap was exceeded'}. ` +
              (canTerminate
                ? `New AI work is blocked and this session will be ended shortly. `
                : `New prompts keep tracking but commits are blocked. `) +
              `It unblocks when the period resets or an admin raises the cap.`,
            );
          }
          if (hadEpisode && decision.state === null) {
            // Breach lifted — remove the model-facing stop-work notice.
            clearBudgetLockNotice(raw.repoPath);
          }
          if (decision.terminateDue && canTerminate) {
            sendDesktopNotification(
              'Origin — session ended by budget policy',
              'Budget cap exceeded — this session was ended. Your work is saved; ' +
              'sessions resume when the cap resets or an admin raises it.',
            );
            await endSession();
            process.exit(0);
          }
        } catch { /* never let breach handling break the ping loop */ }
      }

      // Live policy refresh — persist the server's current enforcementRules
      // into session state so pre-tool-use blocks a file that violates a
      // policy created AFTER this session started, within one ping (~30s).
      // Same write-only-on-change discipline as budget above to avoid
      // needless state churn / mtime bumps.
      if (data.enforcementRules && stateFile && fs.existsSync(stateFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const next = JSON.stringify(data.enforcementRules);
          if (JSON.stringify(raw.enforcementRules || []) !== next) {
            raw.enforcementRules = data.enforcementRules;
            if (data.activePolicies) raw.activePolicies = data.activePolicies;
            raw.enforcementRulesFetchedAt = Date.now();
            fs.writeFileSync(stateFile, JSON.stringify(raw), { mode: 0o600 });
          } else {
            // Unchanged, but still mark fresh so pre-tool-use's TTL doesn't
            // trigger a redundant refetch on a session the heartbeat covers.
            raw.enforcementRulesFetchedAt = Date.now();
            fs.writeFileSync(stateFile, JSON.stringify(raw), { mode: 0o600 });
          }
        } catch { /* best effort — next tick retries */ }
      }

      // Codex doesn't surface its assistant output (or prompt boundaries) via
      // hooks — Stop only fires at turn end and there's no streaming hook. We
      // poll the rollout JSONL on every tick to refresh prompts[] + per-prompt
      // shadows and show assistant text live.
      //
      // This MUST run BEFORE pushInflightDiff and be AWAITED: pushInflightDiff
      // attributes the uncommitted working tree to `promptIndex =
      // prompts.length - 1`. With the old order (diff first, both
      // fire-and-forget), pushInflightDiff could read a STALE prompts[] and pin
      // a NEW prompt's uncommitted change onto an earlier, already-finished
      // (often read-only) prompt's row — the AI-Blame "P1 wrote a line P3
      // actually wrote" bug. Refreshing the prompt list first keeps the index
      // current. No-op for non-Codex agents (guarded inside).
      await pushInflightCodexState().catch(() => { /* non-fatal */ });

      // Push live diff for the in-flight prompt so the dashboard shows the
      // change as it happens, instead of staying empty until the next prompt
      // or session end. Fire-and-forget so a slow git diff doesn't delay the
      // ping cadence.
      pushInflightDiff().catch(() => { /* non-fatal */ });

      // Handle pending commands from the dashboard
      if (data.command && data.command.type === 'restore') {
        handleRestore(data.command);
      }
      if (data.command && data.command.type === 'branch') {
        handleBranch(data.command);
      }

      // If server says session is ended/completed, self-terminate — BUT only
      // when the agent process is genuinely gone. The server occasionally
      // marks a session COMPLETED while the agent is still alive (a sibling
      // conversation got collapsed onto the same row, an admin ended it,
      // server-side auto-end fired prematurely, etc.). If we tore the local
      // state down in that case the live agent's next prompt would orphan,
      // and the dashboard would never get to render the session as IDLE.
      // While the parent is alive we keep pinging — the server can recompute
      // RUNNING/IDLE from lastActivityAt on subsequent pings.
      if (data.status && data.status !== 'RUNNING' && data.status !== 'IDLE') {
        // Same multi-tick confirmation as above — a single
        // process-tree check can't be trusted to decide whether the
        // agent is really gone. We already incremented
        // parentDeadTickCount in the loop above; honor the same
        // threshold here.
        const parentDead = parentPid > 0 && !isProcessAlive(parentPid);
        const noParent = parentPid <= 0;
        const confirmed = parentDeadTickCount >= PARENT_DEAD_TICKS_BEFORE_END;
        if (confirmed && (parentDead || (noParent && isStateFileStale()))) {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          if (stateFile) {
            try {
              const raw = fs.readFileSync(stateFile, 'utf-8');
              const state = JSON.parse(raw);
              state.status = 'ENDED';
              state.endedAt = new Date().toISOString();
              const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
              const archiveDir = `${homeDir}/.origin/sessions`;
              fs.mkdirSync(archiveDir, { recursive: true });
              fs.writeFileSync(`${archiveDir}/${(state.sessionId || sessionId).slice(0, 12)}.json`, JSON.stringify(state), { mode: 0o600 });
            } catch { /* best effort */ }
            try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
          }
          process.exit(0);
        }
        // Parent still alive: don't tear down. Continue pinging so the server
        // can re-derive RUNNING/IDLE from lastActivityAt on the next tick.
      }
    }
  } catch {
    // Silently ignore network errors — will retry next interval
  }
}

// Initial ping
ping();

// Ping every 30s
const interval = setInterval(ping, PING_INTERVAL_MS);

// Clean exit on signals — always call endSession so the server knows
async function signalExit() {
  clearInterval(interval);
  await endSession();
  process.exit(0);
}
process.on('SIGTERM', signalExit);
process.on('SIGINT', signalExit);
process.on('SIGHUP', signalExit);

// Safety: auto-exit after 24 hours (prevents zombie processes)
setTimeout(() => { clearInterval(interval); process.exit(0); }, 24 * 60 * 60 * 1000);
