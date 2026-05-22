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
import { createShadowCommit } from './git-capture.js';

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
// For agents where we can't detect parent PID (Cursor, Codex), we fall back to
// state file freshness. Use a long threshold — the heartbeat should keep running
// as long as the editor/terminal is open. Sessions stay IDLE on the dashboard
// until the heartbeat dies (app closed) or the agent explicitly ends the session.
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — safety net only

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
    const sessionStartShadow = state.headShaAtStart || state.prePromptSha;
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

    // Tag the inflight push with the latest session-owned commit SHA so the
    // commit-detail page can link this prompt → its commit even before the
    // session ends. Falls back to current HEAD when the session hasn't
    // committed anything yet (covers the rare case where pushInflightDiff
    // fires after post-commit but before state has reloaded).
    let heartbeatCommitSha: string | null = null;
    let heartbeatTreeSha: string | null = null;
    const ownCommits = state.sessionCommitShas || [];
    try {
      heartbeatCommitSha = ownCommits.length > 0
        ? ownCommits[ownCommits.length - 1]
        : execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim();
      heartbeatTreeSha = execFileSync('git', ['rev-parse', `${heartbeatCommitSha}^{tree}`], gitOpts).toString().trim();
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
            diff: fullDiff.slice(0, 100_000),
            uncommittedDiff: uncommittedDiff.slice(0, 100_000),
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
async function handleRestore(command: { treeSha?: string; commitSha?: string }) {
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

  const sha = command.commitSha || command.treeSha;
  if (!sha || !/^[a-fA-F0-9]+$/.test(sha)) {
    await reportResult('restore', 'failed', 'Invalid or missing SHA');
    return;
  }

  const gitOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 15000 };

  try {
    // Get current branch (fallback to HEAD sha if detached)
    let originalBranch = '';
    try {
      originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).trim();
    } catch { /* ignore */ }

    // Stash any uncommitted work so we don't lose it
    let stashed = false;
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], gitOpts).trim();
      if (dirty) {
        execFileSync('git', ['stash', 'push', '-u', '-m', `origin-restore-autostash-${Date.now()}`], gitOpts);
        stashed = true;
      }
    } catch { /* ignore */ }

    // If we have a commit SHA, branch off of it. Otherwise use tree SHA (still does soft restore).
    if (command.commitSha) {
      const branchName = `origin-restore-${command.commitSha.slice(0, 7)}-${Date.now().toString(36)}`;
      try {
        execFileSync('git', ['checkout', '-b', branchName, command.commitSha], gitOpts);
      } catch (err: any) {
        // Restore stash if checkout failed
        if (stashed) {
          try { execFileSync('git', ['stash', 'pop'], gitOpts); } catch { /* ignore */ }
        }
        throw err;
      }

      // Write marker file
      const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
      fs.writeFileSync(markerPath, JSON.stringify({
        restoredAt: new Date().toISOString(),
        commitSha: command.commitSha,
        branch: branchName,
        originalBranch,
        stashed,
        sessionId,
      }), { mode: 0o600 });

      const msg = `Checked out branch "${branchName}" at commit ${command.commitSha.slice(0, 7)}. ` +
        (originalBranch ? `Original branch "${originalBranch}" preserved. ` : '') +
        (stashed ? 'Uncommitted changes stashed. ' : '') +
        `Run "git checkout ${originalBranch || 'main'}" to return.`;
      await reportResult('restore', 'success', msg);
      return;
    }

    // Fallback: no commitSha, only treeSha — do soft restore (working tree only)
    const treeSha = command.treeSha!;
    execFileSync('git', ['read-tree', treeSha], gitOpts);
    execFileSync('git', ['checkout-index', '-a', '-f'], gitOpts);
    execFileSync('git', ['read-tree', 'HEAD'], gitOpts);

    const markerPath = path.join(repoPath, '.git', 'origin-restore-marker');
    fs.writeFileSync(markerPath, JSON.stringify({
      restoredAt: new Date().toISOString(),
      treeSha,
      sessionId,
      mode: 'soft',
    }), { mode: 0o600 });

    await reportResult('restore', 'success',
      `Soft-restored files to tree ${treeSha.slice(0, 7)}. HEAD unchanged — use "git diff" to review or "git checkout ." to revert.`);
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

async function ping() {
  try {
    // If PID file is gone, session ended — exit
    if (!fs.existsSync(pidFile)) {
      process.exit(0);
    }

    // If parent agent process died, end the session and exit
    if (parentPid > 0 && !isProcessAlive(parentPid)) {
      await endSession();
      process.exit(0);
    }

    // If we couldn't find the parent PID (common for Codex/Cursor), fall back
    // to state file freshness — if no prompt activity for 5 minutes, agent is dead
    if (parentPid <= 0 && isStateFileStale()) {
      await endSession();
      process.exit(0);
    }

    // If session state file was removed (session ended by hook), exit
    if (stateFile && !fs.existsSync(stateFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      process.exit(0);
    }

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
      const data = await resp.json() as { ok: boolean; status?: string; command?: any };

      // Push live diff for the in-flight prompt so the dashboard
      // shows the change as it happens, instead of staying empty
      // until the next prompt or session end. Fire-and-forget so a
      // slow git diff doesn't delay the ping cadence.
      pushInflightDiff().catch(() => { /* non-fatal */ });
      // Codex doesn't surface its assistant output via hooks while a
      // prompt is in flight — Stop only fires at turn end and there's
      // no streaming hook. Poll the rollout JSONL on every tick so the
      // dashboard shows assistant text + tool calls live.
      pushInflightCodexState().catch(() => { /* non-fatal */ });

      // Handle pending commands from the dashboard
      if (data.command && data.command.type === 'restore') {
        handleRestore(data.command);
      }
      if (data.command && data.command.type === 'branch') {
        handleBranch(data.command);
      }

      // If server says session is ended/completed, self-terminate
      if (data.status && data.status !== 'RUNNING') {
        // Clean up PID and state files
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
