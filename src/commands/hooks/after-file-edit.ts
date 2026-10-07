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
import { combineApplyableTurnDiff } from '../../applyable-turn-diff.js';
import { closeTurn, getGitRoot, getHeadSha, getWorkingGitRoot, movePromptIdentities, reconcilePromptHistoryPlaced, recordPromptShadow, saveSessionState, stampCaptured } from '../../session-state.js';
import type { SessionState } from '../../session-state.js';
import { trimDiffText } from '../../ignore-patterns.js';
import { countDiffLines } from '../../transcript-adapters.js';
import { toRepoRelative } from '../../transcript-watch.js';
import { parseTranscript } from '../../transcript.js';
import { markTurn } from '../../write-journal-watch.js';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SHELL_PROBE_TOOL, ensureWriteJournal, filterUncommittedDiff, findStateForHook, findStateForHookInput, normalizeWorkspaceRoot, recordProbedShellEdits, sessionRepoRoots, sessionScopedCommittedDiff, uncommittedExcludeUnion } from '../hooks.js';
import { newCaptureStamp } from '../../capture-stamp.js';
import { budgetRowDiffs, withCutFiles } from '../../budgeted-row-diff.js';


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
 * attributed. The edit that revealed the boundary falls inside that shadow, so
 * the caller reads it against the OLD baseline twice: once as edit-hook
 * evidence, and once — when the window comes back empty, as it must on this
 * path — to build the mapping itself. Evidence alone was not enough. It
 * declines for a file too large for the ledger's content cap, and the mapping
 * was then never written at all: prod 2ecac40a turn 2 lost `session-state.ts`,
 * the 153 KB file it opened with, and committed five files while claiming four.
 * See rescueRevealingWrite.
 */
export function adoptUnannouncedPrompts(
  state: SessionState,
  parsedPrompts: string[],
  anchorShadow: () => string | null,
  opts?: { now?: () => number; newId?: () => string; revealedBy?: string[] },
): number {
  const before = state.prompts?.length || 0;
  const { prompts: merged, placed } = reconcilePromptHistoryPlaced(state.prompts, parsedPrompts, {
    collapseTrailingRepeat: state.agentSlug === 'cursor',
  });
  if (merged.length <= before) return before - 1;

  const newId = opts?.newId || (() => `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`);
  // The transcript's numbering can put a prompt no hook saw AHEAD of the ones
  // we store. Their turn ids, shadows and rows move with them — see
  // movePromptIdentities.
  if (movePromptIdentities(state, placed, merged.length, newId)) {
    debugLog('after-file-edit', 'prompt list renumbered — each prompt kept its turn id and records', {
      stored: before, now: merged.length, placed,
    });
  }
  state.prompts = [...merged];
  const idx = merged.length - 1;
  // Where the announced turn sits now.
  const announced = before > 0 ? placed[before - 1] : -1;
  if (announced === idx) {
    // Nothing new at the tail: the transcript only filled in a prompt BEHIND
    // the open turn (or has not flushed the open one yet). The edit is still
    // the open turn's — closing it and anchoring a "discovered" turn here
    // would split one turn in two.
    return idx;
  }

  // The turn that was open belonged to the prompt before this one; close it so
  // any later `currentTurnIndex` binds the turn we just found instead.
  if (before > 0) closeTurn(state, announced);

  if (!state.promptTurnIds) state.promptTurnIds = [];
  for (let i = announced + 1; i <= idx; i++) {
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
    // Cut now, AFTER the edit that revealed the turn — already in this tree.
    recordPromptShadow(state, idx, shadow, { completeBaseline: false, cutAfterTurnStart: true });
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
      ...pm,
      // Persisted mappings use an ISO `capturedAt` for the release gate.
      // The wire contract is epoch milliseconds, so the stamp for THIS send
      // must win over anything the saved row carries.
      ...captureStamp,
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

/**
 * HEAD, if a commit landed on top of the tree the turn started from; null when
 * HEAD is still that commit (or cannot be resolved).
 *
 * `baselineSha` is the turn's shadow — a commit whose subject starts
 * `origin shadow ` and whose first parent is the real commit it was cut on —
 * or, for a clean tree, that commit itself (as `inheritedWindowDeps` reads
 * them in commands/hooks.ts). HEAD must be a strict descendant of it: equal
 * means nothing was committed during the turn, and a HEAD outside its
 * ancestry (a checkout elsewhere) is no commit of this turn's either.
 */
/**
 * Undo git's C-style path quoting: `"a/caf\303\251.ts"` -> `a/café.ts`.
 *
 * Git quotes a path holding a byte it considers unusual — non-ASCII under the
 * default `core.quotePath`, and `"`, `\`, tab or newline always — and escapes
 * those bytes octally. The escapes are BYTES: a multi-byte UTF-8 character
 * arrives as several of them and is decoded as a whole.
 */
export function unquoteGitPath(quoted: string): string {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const body = quoted.slice(1, -1);
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const oct = body[i] === '\\' ? /^[0-7]{3}/.exec(body.slice(i + 1, i + 4)) : null;
    if (oct) { bytes.push(parseInt(oct[0], 8) & 0xff); i += 3; continue; }
    if (body[i] === '\\' && body[i + 1] in named) { bytes.push(named[body[i + 1]]); i += 1; continue; }
    bytes.push(...Buffer.from(body[i], 'utf-8'));
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * The two paths a `diff --git` header names, unquoted — null when the line
 * cannot be read as one. Each side is either C-quoted (`"a/…"`, see
 * unquoteGitPath) or bare; a bare pair splits at the first ` b/`, as before.
 */
export function parseDiffGitHeader(line: string): { a: string; b: string } | null {
  const rest = /^diff --git (.+)$/.exec(line)?.[1];
  if (!rest) return null;
  // One side: a C-quoted string (escapes skipped) or bare text.
  const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
  const m = new RegExp(`^(${QUOTED}|a/.*?) (${QUOTED}|b/.+)$`).exec(rest);
  if (!m) return null;
  const a = unquoteGitPath(m[1]);
  const b = unquoteGitPath(m[2]);
  if (!a.startsWith('a/') || !b.startsWith('b/')) return null;
  return { a: a.slice(2), b: b.slice(2) };
}

/** The `diff --git` sections of `diffText` covering `files`, in order. */
export function diffSectionsFor(diffText: string, files: ReadonlySet<string>): string {
  if (!diffText || files.size === 0) return '';
  const kept: string[] = [];
  for (const section of diffText.split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const names = parseDiffGitHeader(section.split('\n', 1)[0] || '');
    // A header that cannot be read is KEPT: dropping it loses a real write
    // outright, keeping it can at worst over-report one section.
    if (names && !files.has(names.b) && !files.has(names.a)) continue;
    // Newlines only, never trimEnd(). A file ending in a blank line ends its
    // fullContext section with a lone-space context line; trimEnd() ate it,
    // the hunk came up one line short of its @@ header, and `git apply`
    // rejected the stored patch as corrupt.
    kept.push(section.replace(/\n+$/, ''));
  }
  return trimDiffText(kept.join('\n'));
}

/**
 * Files this producer has direct evidence for in one turn.
 *
 * The working-tree window is deliberately NOT evidence. It can contain a
 * sibling session's write, or a file the transcript extractor missed. Before
 * this scope existed, after-file-edit stored that whole window in `diff` and
 * `uncommittedDiff`; `filesChanged` was the only boundary, so any later reader
 * that inspected the blob directly could resurrect an unowned file.
 *
 * Three sources, all this turn's own:
 *
 *   • every path an after-file-edit call named this turn (`editHookPathsByTurn`),
 *     plus the current payload. Paths only, never content, so no size cap: the
 *     ledger declines an edit over LIVE_EDIT_CONTENT_MAX (96 KB) or past its
 *     6 MB total, and scoping by the ledger alone dropped a big file edited
 *     earlier in the turn from diff, uncommittedDiff AND filesChanged;
 *   • edit-hook ledger entries (a state written before the path list existed);
 *   • this turn's SHELL PROBE entries that are proof, not inference: a file
 *     the command itself named (`command_named`), or one that changed inside
 *     a write-shaped command's before/after window (`command_probe` on a turn
 *     in `shellWriteTurns` — the rule user-prompt-submit already applies). A
 *     forked Cursor subagent fires no Stop, so a sed / codegen / `git mv`
 *     write left out here is never put back. A bare `command_probe` on a turn
 *     that ran no write-shaped command stays out: on a shared checkout it is
 *     a sibling's write that landed during one of our reads (6e9947a5).
 *
 * Another turn's entries, and the inferred slots (write journal, shell
 * window), are never evidence here.
 */
export function afterFileEditFilesForTurn(
  state: Pick<SessionState, 'liveEdits' | 'editHookPathsByTurn' | 'shellWriteTurns'>,
  promptIndex: number,
  currentFiles: readonly string[],
): Set<string> {
  const files = new Set(currentFiles.filter(Boolean));
  for (const entry of state.editHookPathsByTurn || []) {
    if (entry?.promptIndex !== promptIndex) continue;
    for (const p of entry.paths || []) if (p) files.add(p);
  }
  const shellWrote = (state.shellWriteTurns || []).includes(promptIndex);
  for (const entry of state.liveEdits || []) {
    if (entry.promptIndex !== promptIndex) continue;
    const hook = entry.toolName === EDIT_HOOK_TOOL;
    if (!hook && entry.toolName !== SHELL_PROBE_TOOL) continue;
    for (const edit of entry.edits || []) {
      if (!edit?.file) continue;
      if (hook || edit.evidence === 'command_named' || (edit.evidence === 'command_probe' && shellWrote)) {
        files.add(edit.file);
      }
    }
  }
  return files;
}

/** Paths per-turn lists are kept for; older turns' lists are dropped. */
const EDIT_HOOK_PATH_TURNS = 64;

/**
 * Remember, against turn `promptIndex`, the paths this after-file-edit call
 * named. Content-free, so nothing is ever declined for size — see
 * afterFileEditFilesForTurn.
 */
export function recordEditHookPaths(
  state: Pick<SessionState, 'editHookPathsByTurn'>,
  promptIndex: number,
  paths: readonly string[],
): void {
  if (!Number.isInteger(promptIndex) || promptIndex < 0 || paths.length === 0) return;
  const all = state.editHookPathsByTurn || [];
  const prev = all.find((e) => e.promptIndex === promptIndex)?.paths || [];
  const keep = all.filter((e) => e.promptIndex !== promptIndex).slice(-(EDIT_HOOK_PATH_TURNS - 1));
  state.editHookPathsByTurn = [...keep, { promptIndex, paths: [...new Set([...prev, ...paths.filter(Boolean)])] }];
}

export function scopeAfterFileEditDiffs(
  state: Pick<SessionState, 'liveEdits' | 'editHookPathsByTurn' | 'shellWriteTurns'>,
  promptIndex: number,
  currentFiles: readonly string[],
  diff: string,
  uncommittedDiff: string,
): { files: Set<string>; diff: string; uncommittedDiff: string } {
  const files = afterFileEditFilesForTurn(state, promptIndex, currentFiles);
  return {
    files,
    diff: diffSectionsFor(diff, files),
    uncommittedDiff: diffSectionsFor(uncommittedDiff, files),
  };
}

/**
 * The turn's first write, recovered from the tree it actually changed.
 *
 * When this hook is the thing that DISCOVERS a turn, `adoptUnannouncedPrompts`
 * cuts that turn's shadow from the working tree — which already holds the write
 * that revealed it. The turn's own window is then empty by construction, and
 * the caller used to return on that, so the file never reached the mapping at
 * all. Prod 2ecac40a turn 2 opened by editing `session-state.ts`; the hook
 * logged `no diff against shadow, skipping`, and that file alone of the turn's
 * five was missing from `filesChanged` when the turn committed all five.
 *
 * `editBaseline` is the tree that was open when Cursor wrote the file — the
 * before-state this content actually changed, and the same baseline the
 * evidence call on this branch already trusts. Scoped to the named files, so
 * nothing else that happens to differ between the two baselines rides along.
 */
export function rescueRevealingWrite(
  editBaseline: string | undefined,
  files: readonly string[],
  capture: (baseline: string) => { workingTreeDiff?: string | null; uncommittedDiff?: string | null },
): string {
  if (!editBaseline || files.length === 0) return '';
  try {
    const against = capture(editBaseline);
    const scope = new Set(files);
    return diffSectionsFor(against.workingTreeDiff || against.uncommittedDiff || '', scope);
  } catch { return ''; }
}

export function headCommitMadeSince(repoPath: string, baselineSha: string | null | undefined): string | null {
  if (!repoPath || !baselineSha || !/^[a-fA-F0-9]{7,40}$/.test(baselineSha)) return null;
  const git = (args: string[]): string => execFileSync('git', args, {
    windowsHide: true, cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  try {
    const record = git(['show', '-s', '--format=%s%n%P', baselineSha]).split('\n');
    const start = git(['rev-parse', record[0].startsWith('origin shadow ') ? (record[1] || '').split(' ')[0] : baselineSha]);
    const head = git(['rev-parse', 'HEAD']);
    if (!start || !head || head === start) return null;
    try { git(['merge-base', '--is-ancestor', start, head]); } catch { return null; }
    return head;
  } catch {
    return null;
  }
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
  const found = findStateForHookInput(hookCwd, input, agentSlug);
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
    // Repo-relative, or not at all. The raw hook path is absolute and, for a
    // linked worktree, names a tree the diff never mentions: Cursor session
    // c1e361a4 stored `/Users/…/.cursor/worktrees/origin/z83u/apps/api/…`
    // beside five repo-relative files, and verify-capture flagged the turn
    // for claiming a file absent from its own diff.
    const edited = [input.file_path, input.path]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => toRepoRelative(state.repoPath!, p))
      .filter((p) => p && !path.isAbsolute(p));
    // Before the ledger, which can decline the content for size: the path is
    // this turn's regardless. See afterFileEditFilesForTurn.
    recordEditHookPaths(state, promptIdx, edited);
    try {
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

    let filteredUncommitted = filterUncommittedDiff(
      capture.uncommittedDiff || '', uncommittedExcludeUnion(state),
    );
    // Windowed to the turn's own shadow, like the capture directly above.
    // Unwindowed, this mid-turn write replayed every commit the session had
    // made: prod 192cdf12 turn 3 was sent as 13 files / +244 -4 — its own
    // +125 plus turn 1's committed +119 — and the Stop that followed just
    // re-sent that mapping.
    const sessionCommitted = sessionScopedCommittedDiff(state.repoPath, state, captureBaseline);
    let fullDiff = combineApplyableTurnDiff({
      committedDiff: sessionCommitted,
      uncommittedDiff: filteredUncommitted,
      workingTreeDiff: capture.workingTreeDiff || '',
    });
    // The capture above is a whole-tree window. Cursor gave this hook a much
    // stronger boundary: the exact file it wrote, accumulated with the exact
    // files earlier after-file-edit calls named for this turn. Scope the BYTES,
    // not only filesChanged. Otherwise a missed extractor path remains hidden
    // inside both stored blobs and can be attributed later by a reader that
    // does not re-apply the file list.
    const scoped = scopeAfterFileEditDiffs(
      state, promptIdx, edited, fullDiff, filteredUncommitted,
    );
    const editHookFiles = scoped.files;
    fullDiff = scoped.diff;
    filteredUncommitted = scoped.uncommittedDiff;
    // An empty window on the invocation that DISCOVERED this turn is not "no
    // work" — it is the shadow we just cut swallowing the write that revealed
    // the turn. Recover it against the tree it actually changed rather than
    // returning; see rescueRevealingWrite. Any other empty window really is
    // nothing to file.
    const shadowSwallowedThisWrite = promptIdx > announcedIdx && announcedIdx >= 0;
    let contentUnavailable: string[] = [];
    if (!fullDiff && shadowSwallowedThisWrite && edited.length > 0) {
      fullDiff = rescueRevealingWrite(
        editBaseline, edited,
        (baseline) => captureGitState(state.repoPath!, baseline),
      );
      // Still nothing recoverable — a file too large for the content path, or
      // a baseline git cannot read. The hook NAMED it, so the turn changed it:
      // say so and say the bytes are missing, which is what
      // `contentUnavailableFiles` is for. Dropping it is how the turn came to
      // look like it had never touched the file at all.
      if (!fullDiff) contentUnavailable = [...edited];
      debugLog('after-file-edit', 'window swallowed the revealing write', {
        promptIndex: promptIdx, files: edited, recovered: fullDiff.length,
      });
    }
    if (!fullDiff && contentUnavailable.length === 0) {
      debugLog('after-file-edit', 'no diff against shadow, skipping');
      return;
    }

    const filesChanged = new Set<string>();
    for (const section of fullDiff.split(/^(?=diff --git )/m)) {
      const names = parseDiffGitHeader(section.split('\n', 1)[0] || '');
      if (!names) continue;
      // A rename can be named by either side. Keep only names the hook itself
      // observed; the scoped section cannot introduce a third file.
      if (editHookFiles.has(names.a)) filesChanged.add(names.a);
      if (editHookFiles.has(names.b)) filesChanged.add(names.b);
    }
    // Preserve the hook's direct path evidence when git's diff lags the write.
    // Do not do this for every historical ledger file: a later write may have
    // reverted one to its baseline, leaving no section to carry.
    for (const p of edited) filesChanged.add(p);
    for (const p of contentUnavailable) filesChanged.add(p);

    if (!state.completedPromptMappings) state.completedPromptMappings = [];
    // HEAD is this turn's commit only when the turn moved it. Stamping HEAD
    // unconditionally put the commit the turn STARTED from on every edited
    // turn: capture-e2e-cursor-binary turn 1 was sent — and, the server's
    // sha being fill-only, stored — with `commit: base`, the repo's
    // pre-session commit. An unmoved HEAD keeps whatever the mapping already
    // carries (post-commit's attestation, if it ran).
    const prior = state.completedPromptMappings.find((m) => m.promptIndex === promptIdx) as { commitSha?: string | null; treeSha?: string | null } | undefined;
    const madeSince = headCommitMadeSince(state.repoPath, captureBaseline);
    let commitSha: string | null = prior?.commitSha ?? null;
    let treeSha: string | null = prior?.treeSha ?? null;
    if (madeSince) {
      commitSha = madeSince;
      try {
        treeSha = execFileSync('git', ['rev-parse', `${madeSince}^{tree}`], { windowsHide: true, cwd: state.repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* keep the prior tree */ }
    }
    // Which commit this row goes out with, and why. A stamp here is sent
    // before Stop and the server fills a null sha from it, so a wrong one
    // sticks; without this line the row's commit had no stated source.
    if (commitSha) {
      debugLog('after-file-edit', 'row commit', {
        promptIndex: promptIdx,
        commit: commitSha.slice(0, 8),
        from: madeSince ? 'head moved since the baseline' : 'the mapping already held it',
        baseline: (captureBaseline || '').slice(0, 12),
      });
    }

    const promptText = (state.prompts?.[promptIdx] || '').slice(0, 1000);
    // The rescued write is an uncommitted working-tree change; the window it
    // was recovered from produced none, so the row would otherwise carry a
    // diff with no uncommitted half to match it.
    const uncommitted = (!filteredUncommitted && shadowSwallowedThisWrite)
      ? fullDiff : filteredUncommitted;
    const budgeted = budgetRowDiffs(fullDiff, uncommitted);
    const mapping = {
      promptIndex: promptIdx,
      promptText,
      filesChanged: [...new Set([...filesChanged, ...budgeted.cutFiles])],
      diff: budgeted.diff,
      uncommittedDiff: budgeted.uncommittedDiff,
      commitSha,
      treeSha,
      ...withCutFiles(contentUnavailable, budgeted.cutFiles),
    };
    const existingIdx = state.completedPromptMappings.findIndex((m) => m.promptIndex === promptIdx);
    if (existingIdx >= 0) {
      state.completedPromptMappings[existingIdx] = stampCaptured(mapping);
    } else {
      state.completedPromptMappings.push(stampCaptured(mapping));
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
