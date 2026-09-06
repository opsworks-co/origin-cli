// Cursor's afterFileEdit: live evidence of a write, and the turn it belongs to.
//
// Moved out of commands/hooks.ts mechanically: the text is unchanged, only its
// home is. Shared helpers still live in hooks.ts and are imported from there.
import { findCursorTranscriptJsonl } from '../../agents/cursor.js';
import { api } from '../../api.js';
import { isConnectedMode } from '../../config.js';
import { debugLog } from '../../debug-log.js';
import { capDiff } from '../../diff-budget.js';
import { MAX_PROMPT_DIFF_LEN, captureGitState, createShadowCommit, getDirtyFiles } from '../../git-capture.js';
import { closeTurn, getGitRoot, getHeadSha, getWorkingGitRoot, reconcilePromptHistory, recordPromptShadow, saveSessionState } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { countDiffLines } from '../../transcript-adapters.js';
import { toRepoRelative } from '../../transcript-watch.js';
import { parseTranscript } from '../../transcript.js';
import { markTurn } from '../../write-journal-watch.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureWriteJournal, filterUncommittedDiff, findStateForHook, hookLookupSessionId, normalizeWorkspaceRoot, recordProbedShellEdits, sessionRepoRoots, sessionScopedCommittedDiff, uncommittedExcludeUnion } from '../hooks.js';
import { newCaptureStamp } from '../../capture-stamp.js';


// Cursor's afterFileEdit names the file it just wrote. Its own ledger slot so
// it and the shell probe can both contribute to one turn without either
// replacing the other's entries.
export const EDIT_HOOK_TOOL = 'origin:edit-hook';

/**
 * Resolve the repo cwd for an `afterFileEdit` payload.
 *
 * Cursor's afterFileEdit stdin carries NO `cwd` key (unlike beforeSubmitPrompt
 * / stop) — only `file_path` + `workspace_roots`. The old
 * `input.cwd || process.cwd()` therefore always fell through to process.cwd(),
 * which for a Cursor-spawned hook is `~/.cursor`. findStateForHook then scanned
 * `~/.cursor` for active sessions, found none, and every single edit aborted
 * with "no session state" — a 100% drop rate, measured 10/10 on a real
 * karamba session. That silently blanked the very case this hook exists for,
 * and it hurt worst on multitask/background-agent turns: a forked Cursor
 * subagent gets a fresh per-turn `session_id` and fires NO stop hook, so
 * afterFileEdit is the ONLY signal its edits ever produce.
 *
 * The edited file itself is the most precise anchor available (it is correct
 * even in multi-root workspaces, where workspace_roots[0] may be a different
 * project than the one being edited), so prefer its git root — the same
 * derive-the-repo-from-the-edited-file rule the Antigravity adapter uses.
 *
 * WORKING root, not canonical: getWorkingGitRoot keeps a linked worktree as
 * itself, where getGitRoot would collapse it to the main repo — and a session
 * running in a worktree stores its state under the worktree path, so
 * collapsing here would abort the hook all over again for that case.
 * handleSessionStart resolves in exactly this order.
 */
export function resolveAfterFileEditCwd(input: Record<string, any>): string {
  const rootOf = (dir: string): string | null => {
    try { return getWorkingGitRoot(dir) || getGitRoot(dir); } catch { return null; }
  };

  const filePath = normalizeWorkspaceRoot(input.file_path || input.path);
  if (filePath) {
    const fileRoot = rootOf(path.dirname(filePath));
    if (fileRoot) return fileRoot;
  }

  if (Array.isArray(input.workspace_roots)) {
    for (const raw of input.workspace_roots) {
      const wsRoot = normalizeWorkspaceRoot(raw);
      if (wsRoot) {
        const wsGitRoot = rootOf(wsRoot);
        if (wsGitRoot) return wsGitRoot;
      }
    }
  }

  return normalizeWorkspaceRoot(input.cwd) || process.cwd();
}

/**
 * Adopt prompts the hooks never announced, and bind the turn an edit landing
 * right now actually belongs to.
 *
 * Cursor fires no `beforeSubmitPrompt` for a message typed while the previous
 * turn is still generating: it folds that prompt into the RUNNING generation —
 * same `requestId`, no `turn_ended` line in the transcript, and no `stop` hook
 * for the turn it interrupted either. Session e2c3508a is the whole shape:
 * three prompts, two prompt-submit hooks, two stop hooks, and not one hook
 * between turn 2's last edit and turn 3's first.
 *
 * `state.prompts` therefore still ended in "generate some code" while Cursor
 * was writing turn 3's files, so `prompts.length - 1` named turn 2 for every
 * one of them. Turn 2's mapping got rebuilt into a window spanning BOTH turns
 * (7 files → 12), turn 3's edits went into the ledger under turn 2, and the
 * server's first-author-wins de-dup then had nothing left to give turn 3: it
 * rendered as a chat-only turn sitting directly above the 11-file commit it
 * had just made.
 *
 * The transcript is the only place that mid-turn prompt is recorded, and it is
 * the same list Stop reconciles against — adopting it here keeps the live path
 * and the Stop pass on ONE numbering. When it hasn't been flushed yet the
 * reconcile is a no-op and the counter's answer stands; growth only, never a
 * renumber.
 *
 * A turn discovered late also has nobody to have anchored its baseline, so we
 * anchor one now. The new turn's window starts HERE rather than at the
 * previous turn's shadow, which is what stops it re-claiming work already
 * attributed. The edit that revealed the boundary falls inside that shadow,
 * but the caller reads it against the OLD baseline and records it as edit-hook
 * evidence first, so it is not lost.
 */
export function adoptUnannouncedPrompts(
  state: SessionState,
  parsedPrompts: string[],
  anchorShadow: () => string | null,
  opts?: { now?: () => number; newId?: () => string; revealedBy?: string[] },
): number {
  const before = state.prompts?.length || 0;
  const merged = reconcilePromptHistory(state.prompts, parsedPrompts);
  if (merged.length <= before) return before - 1;

  state.prompts = [...merged];
  const idx = merged.length - 1;

  // The turn that was open belonged to the prompt before this one; close it so
  // any later `currentTurnIndex` binds the turn we just found instead.
  if (before > 0) closeTurn(state, before - 1);

  const newId = opts?.newId || (() => `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`);
  if (!state.promptTurnIds) state.promptTurnIds = [];
  for (let i = before; i <= idx; i++) {
    if (!state.promptTurnIds[i]) state.promptTurnIds[i] = newId();
  }

  // Re-anchor ONLY when there was a previous turn to separate this one from.
  // With `before === 0` nothing has claimed the current baseline yet — the
  // session-start shadow IS this turn's start — and cutting a fresh one here
  // would silently discard everything the turn had already written before we
  // noticed it existed.
  const shadow = before > 0 ? anchorShadow() : null;
  if (shadow) {
    state.prePromptSha = shadow;
    state.prePromptDirtyFiles = [];
    recordPromptShadow(state, idx, shadow);
  }
  state.currentTurnStartedAt = (opts?.now || (() => Date.now()))();
  // Put the boundary in the JOURNAL too, exactly as user-prompt-submit does.
  // These ids used to be minted here and never marked, so the ledger had no
  // span for them and declined — silently — and the turn fell back to the
  // window reconstruction this adoption exists to replace. A session that
  // reached this path without a journal (its prompt-submit never fired, or
  // fired before the journal existed) gets one now.
  ensureWriteJournal(state, undefined);
  // The edit that revealed this turn is already in the log AHEAD of this
  // mark; by position it would be the previous turn's. Name it, so the ledger
  // moves that one record here — see TurnMark.reclaim.
  if (state.writeJournalPath) {
    markTurn(state.writeJournalPath, state.promptTurnIds[idx], state.currentTurnStartedAt, opts?.revealedBy);
  }

  debugLog('after-file-edit', 'adopted prompt the hooks never announced', {
    from: before, to: idx, shadow: shadow ? shadow.slice(0, 12) : null,
  });
  return idx;
}

/**
 * The prompt list Cursor's own transcript records for this conversation, or
 * null when there is nothing readable to compare against.
 */
export function cursorTranscriptPrompts(state: SessionState): string[] | null {
  try {
    const jsonl = (state.transcriptPath && fs.existsSync(state.transcriptPath))
      ? state.transcriptPath
      : findCursorTranscriptJsonl(state.agentSessionId || undefined);
    if (!jsonl) return null;
    const parsed = parseTranscript(jsonl, { repoRoots: sessionRepoRoots(state) });
    return parsed.prompts || null;
  } catch (err: unknown) {
    debugLog('after-file-edit', 'transcript prompt sync failed (non-fatal)', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The `promptChanges` payload for a mid-turn (live-edit) PATCH.
 *
 * Every mapping is counted from ITS OWN diff. This used to derive a single
 * `linesAdded`/`linesRemoved` pair from `fullDiff` — the diff of the turn that
 * had just edited a file — and spread that one pair across EVERY mapping in
 * the list. The editing turn's row was right by luck (its diff IS fullDiff);
 * every earlier turn's row got line counts describing work it never did,
 * rewritten once per edit for as long as the session ran.
 *
 * That is a cross-turn write in the same family as the ones the server refuses
 * by turnId — except it travels inside a payload whose routing looks perfectly
 * healthy, because only the numbers are wrong.
 *
 * `countDiffLines` is the shared counter for exactly this reason (see its
 * comment in transcript-adapters): two different counters are how a row's line
 * totals and its own diff body drift permanently out of step.
 */
export function buildLiveEditPromptChanges(
  mappings: Array<Record<string, any>>,
): Array<Record<string, any>> {
  // One stamp per send. This producer never stamped, so the server could
  // not order its writes against Stop's: an unstamped payload is EXEMPT from
  // the staleness rule and outranks every producer that plays by it. Stop
  // fires later and stamps later, so with both stamped Stop's capture wins
  // — which is the order the row's content was actually observed in.
  const captureStamp = newCaptureStamp('afe');
  return (mappings || []).map((pm) => {
    const diff = capDiff(pm.diff, MAX_PROMPT_DIFF_LEN);
    const { linesAdded, linesRemoved } = countDiffLines(diff);
    return {
      ...captureStamp,
      ...pm,
      promptText: (pm.promptText || '').slice(0, 1000),
      diff,
      uncommittedDiff: capDiff(pm.uncommittedDiff, MAX_PROMPT_DIFF_LEN),
      linesAdded,
      linesRemoved,
      aiPercentage: 100,
      checkpointType: 'auto',
    };
  });
}

// ─── Cursor: afterFileEdit ───────────────────────────────────────────────
//
// Fires after every Cursor edit (StrReplace / Write / etc.). Cursor's git
// commits don't reliably trigger the global post-commit hook (sandbox /
// worktree isolation), so user-prompt-submit's retroactive capture path
// runs against an empty working tree at next-prompt time and the dashboard
// shows "0 files" for the prompt. We work around that by capturing the
// working tree against the per-prompt shadow on every file edit — same
// content as the heartbeat's pushInflightDiff, but triggered by the edit
// event so it fires even when no shell commands have run.
export async function handleAfterFileEdit(input: Record<string, any>, agentSlug?: string): Promise<void> {
  debugLog('after-file-edit', 'begin', { cwd: input.cwd, file: input.file_path || input.path });

  const hookCwd = resolveAfterFileEditCwd(input);
  const found = findStateForHook(hookCwd, hookLookupSessionId(input.session_id, agentSlug), agentSlug);
  if (!found) {
    debugLog('after-file-edit', 'ABORT: no session state', { hookCwd });
    return;
  }
  const { state, saveCwd } = found;
  if (!state.repoPath || !state.prePromptSha) {
    debugLog('after-file-edit', 'ABORT: missing repoPath or prePromptSha');
    return;
  }
  const announcedIdx = (state.prompts?.length || 0) - 1;
  // The baseline this edit's before-state must be read against: the turn that
  // was open when Cursor wrote the file, whether or not it is still the turn
  // we end up filing under. With no announced turn at all this is the session
  // start, which is the correct before-state for the first turn.
  const editBaseline = (state.promptShadows || []).find((s) => s.promptIndex === announcedIdx)?.shadowSha
    || state.prePromptSha;

  // Ask the transcript BEFORE giving up on the counter — see
  // adoptUnannouncedPrompts. Two different states land here with a counter
  // that can't name a turn: a prompt Cursor never announced (the counter is a
  // turn behind), and a state file that never received one at all. The second
  // is not hypothetical — when the auto-create path raced session-start into a
  // duplicate state file, `after-file-edit` resolved the EMPTY one and aborted
  // on 23 of 23 edits, taking the whole session's live capture with it.
  const parsedPrompts = cursorTranscriptPrompts(state);
  // The file this hook is about — repo-relative, as the journal records it.
  const revealedBy = [input.file_path, input.path]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => toRepoRelative(state.repoPath!, p))
    .filter((p) => p && !path.isAbsolute(p));
  const promptIdx = parsedPrompts
    ? adoptUnannouncedPrompts(state, parsedPrompts, () => {
      const repo = state.repoPath!;
      try {
        if (getDirtyFiles(repo).length === 0) return getHeadSha(repo);
        return createShadowCommit(repo, `prompt-${state.sessionTag || state.sessionId.slice(0, 12)}`)
          || getHeadSha(repo);
      } catch { return null; }
    }, { revealedBy })
    : announcedIdx;
  if (promptIdx < 0) {
    debugLog('after-file-edit', 'ABORT: no current prompt', {
      announcedIdx, transcriptPrompts: parsedPrompts ? parsedPrompts.length : null,
    });
    return;
  }

  try {
    // Re-capture working tree against the per-prompt shadow so the current
    // prompt's mapping reflects whatever Cursor just wrote to disk.
    const promptShadow = (state.promptShadows || []).find((s) => s.promptIndex === promptIdx);
    const captureBaseline = promptShadow?.shadowSha || state.prePromptSha;

    // EVIDENCE, before the window runs.
    //
    // This hook names the exact file Cursor just wrote. That is proof — the
    // agent is telling us, not us deducing it from what happens to be dirty —
    // and until now the path was used only as an extra NAME appended to
    // filesChanged while the attribution still came from a whole-tree diff. So
    // a Cursor turn in a shared checkout picked up a sibling agent's work the
    // same way every other window-based turn did, despite having the one
    // signal that could have prevented it.
    //
    // Recorded first so the window below skips it as already covered.
    try {
      const edited = [input.file_path, input.path]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => toRepoRelative(state.repoPath!, p))
        .filter((p) => p && !path.isAbsolute(p));
      if (edited.length > 0) {
        // `editBaseline`, not `captureBaseline`: when this edit is the one that
        // revealed a missed turn boundary, the new turn's shadow was cut a
        // moment ago with this write already in it, so reading the before-state
        // against it yields an empty delta. The turn that was open when Cursor
        // wrote the file is the tree this content actually changed.
        if (recordProbedShellEdits(state, state.repoPath, editBaseline, promptIdx, edited, {
          toolLabel: EDIT_HOOK_TOOL, evidence: 'edit_hook',
        })) {
          debugLog('after-file-edit', 'edit-hook evidence recorded', { files: edited });
        }
      }
    } catch (evErr: unknown) {
      debugLog('after-file-edit', 'edit-hook evidence failed (non-fatal)', {
        message: evErr instanceof Error ? evErr.message : String(evErr),
      });
    }
    // Persist the turn binding and the evidence NOW, not only alongside a
    // mapping. The window below is empty for the FIRST edit of a turn we just
    // discovered — that write is already inside the shadow we cut for it — and
    // the old "no diff, skip" return would have thrown the discovery away, so
    // the next edit would rediscover the same boundary and cut another shadow
    // over it, forever.
    saveSessionState(state, saveCwd, state.sessionTag);

    const capture = captureGitState(state.repoPath, captureBaseline, { fullContext: true });

    const filteredUncommitted = filterUncommittedDiff(
      capture.uncommittedDiff || '', uncommittedExcludeUnion(state),
    );
    // Windowed to the turn's own shadow, like the capture directly above.
    // Unwindowed, this mid-turn write replayed every commit the session had
    // made: prod 192cdf12 turn 3 was sent as 13 files / +244 -4 — its own
    // +125 plus turn 1's committed +119 — and the Stop that followed just
    // re-sent that mapping.
    const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state, captureBaseline);
    const fullDiff = (sessionCommitted + (filteredUncommitted ? '\n' + filteredUncommitted : '')).trim();
    if (!fullDiff) {
      debugLog('after-file-edit', 'no diff against shadow, skipping');
      return;
    }

    const filesChanged = new Set<string>();
    for (const m of fullDiff.matchAll(/^diff --git a\/(.*?) b\//gm)) {
      if (m[1]) filesChanged.add(m[1]);
    }
    // Filesystem path the hook reported, if any — useful when the diff lags.
    if (typeof input.file_path === 'string') filesChanged.add(input.file_path);
    if (typeof input.path === 'string') filesChanged.add(input.path);

    let commitSha: string | null = null;
    let treeSha: string | null = null;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* ignore */ }

    if (!state.completedPromptMappings) state.completedPromptMappings = [];
    const promptText = (state.prompts?.[promptIdx] || '').slice(0, 1000);
    const mapping = {
      promptIndex: promptIdx,
      promptText,
      filesChanged: Array.from(filesChanged),
      diff: fullDiff.slice(0, 200_000),
      uncommittedDiff: filteredUncommitted.slice(0, 200_000),
      commitSha,
      treeSha,
    };
    const existingIdx = state.completedPromptMappings.findIndex((m) => m.promptIndex === promptIdx);
    if (existingIdx >= 0) {
      state.completedPromptMappings[existingIdx] = mapping;
    } else {
      state.completedPromptMappings.push(mapping);
    }
    saveSessionState(state, saveCwd, state.sessionTag);
    debugLog('after-file-edit', 'updated mapping', {
      promptIndex: promptIdx,
      filesChanged: filesChanged.size,
      diffLen: fullDiff.length,
    });

    // Push to API immediately so the dashboard reflects the edit without
    // waiting for the next heartbeat tick.
    if (isConnectedMode() && state.sessionId) {
      try {
        await api.updateSession(state.sessionId, {
          promptChanges: buildLiveEditPromptChanges(state.completedPromptMappings),
          status: 'RUNNING',
        });
        debugLog('after-file-edit', 'api updated');
      } catch (apiErr: any) {
        debugLog('after-file-edit', 'api update failed (non-fatal)', { message: apiErr?.message });
      }
    }
  } catch (err: any) {
    debugLog('after-file-edit', 'capture failed (non-fatal)', { message: err?.message });
  }
}
