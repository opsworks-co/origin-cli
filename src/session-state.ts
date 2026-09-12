import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
// execFileSync, not execSync: a shell string makes Windows launch cmd.exe just
// to interpret it, so every `git rev-parse` here was two processes instead of
// one. These are the hottest git calls in the CLI — the watcher runs them for
// every live session on every poll, and every hook fire runs them too.
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { processInfo } from './utils/process-detect.js';
import { samePath } from './paths.js';
import type { PromptEdit } from './prompt-capture/types.js';
import { ensureOwnerStamp } from './session-owner.js';
import { debugLog } from './debug-log.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * One entry per pre-tool-use / post-tool-use pair. The historical name was
 * `SubagentRecord` but this tracks ALL tool calls (Bash, Read, Edit, Task,
 * etc.) — not just Task-spawned sub-agents. Renamed in the R2 audit cleanup.
 *
 * Real sub-agent spawns (Claude Code Task tool) need their own record type
 * with model/subagent_type fields — see docs/notes/SUBAGENT_AUDIT.md (R3).
 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  prompt?: string;
  result?: string;
}

/**
 * A REAL sub-agent spawn — recorded only for the `Task` tool (Claude Code's
 * child-agent launcher), not for every tool call (that's ToolCallRecord above).
 * `subagentType` is the configured agent invoked (`tool_input.subagent_type`,
 * e.g. "code-reviewer"); its model lives in that agent's own config, so we
 * capture the type/description/prompt and timing, and attribute it to the
 * prompt turn it ran under. Stored on SessionState.subagentSpawns[].
 * See docs/notes/SUBAGENT_AUDIT.md (R3).
 */
export interface SubagentSpawn {
  toolCallId: string;
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
  promptIndex: number;   // the parent turn this sub-agent ran under
  startedAt: string;
  endedAt?: string;
}

export interface TabCompletionStats {
  count: number;
  acceptedCount: number;
  totalCharsGenerated: number;
  avgAcceptanceRate: number;
}

export interface SessionState {
  sessionId: string;          // Origin API session ID
  // Set by `origin sessions sync` once it has successfully replayed
  // session/start for a queued local-* session: the REAL server session id,
  // persisted BEFORE session/end is attempted. If session/end then fails (or
  // the process dies), the next retry resumes at session/end with this id
  // instead of calling session/start again — which would create a second,
  // orphaned server row. Cleared implicitly when the file is removed on a
  // fully-successful upload.
  syncedSessionId?: string;
  // The agent's own session identifier, locked at session-start. Different
  // agents call it different things — Claude Code: session_id; Cursor:
  // session_id / conversation_id (matches the agent-transcripts/<id>/ dir);
  // Codex: thread_id (matches threads.id in ~/.codex/state_*.sqlite and the
  // rollout-<id>.jsonl filename); Gemini: session_id from stdin.
  //
  // Anchors EVERY downstream lookup: transcript discovery, rollout pickup,
  // and hook routing. We never fall back to "newest by mtime" or
  // "basename LIKE %x%" anymore — if the ID can't be matched, the hook
  // captures nothing and logs the miss instead of guessing.
  agentSessionId?: string;
  // Backward-compat field name — older state files predate `agentSessionId`
  // and key off this one. New code prefers `agentSessionId`; old readers
  // (findSessionByClaudeId, etc.) continue to work because session-start
  // mirrors the agent's session ID into both fields.
  claudeSessionId: string;
  transcriptPath: string;     // Path to JSONL transcript file
  model: string;
  startedAt: string;          // ISO timestamp
  prompts: string[];          // Accumulated user prompts
  // `<nativePromptIndex>:<imageIndex>` → the server's one-line caption of that
  // image. Kept OUT of `prompts` on purpose: `prompts` goes on the wire, where
  // the server maintains its own `[image:<id>]` rendering of the same slots, so
  // folding captions in there would have the two copies overwrite each other.
  // These are folded in only where words are what a reader needs — the session
  // memory written to git notes. Keyed in NATIVE (transcript) index space, like
  // every other index that comes off the transcript.
  promptImageDescriptions?: Record<string, string>;
  // Same keys, for images this session has already dealt with — uploaded, or
  // skipped for good. Stop fires once per turn and the transcript keeps every
  // image it ever held, so without this every screenshot is re-encoded and
  // re-POSTed on every turn for the life of the session. Separate from the
  // captions above because an image can be stored without one.
  uploadedImages?: string[];
  // The agent's id for the most recently saved prompt (stdin `prompt_id`).
  // Guards against a duplicate save when ONE prompt fires the user-prompt-
  // submit hook twice — which happens with the Devin CLI, whose runtime reads
  // BOTH ~/.claude (claude-code) and ~/.devin (devin) hook configs and so
  // invokes our hook once per config with the SAME payload. Same prompt_id
  // landing back-to-back on the same session = the collision, not a new turn.
  lastPromptId?: string;
  // The prompt_id + wall-clock of the most recently PROCESSED stop hook.
  // Same guard as lastPromptId but for the Stop lifecycle event: the Devin
  // CLI fires Stop once per hook-config (2-3× per turn, same session + same
  // prompt_id), each creating a redundant auto-snapshot + updateSession.
  // A stop whose prompt_id matches within a short window is the collision.
  lastStopPromptId?: string;
  lastStopAt?: string;
  // Per-prompt assistant responses, captured opportunistically when the
  // agent ships the reply on stdin (Gemini's `prompt_response`). Indexed
  // by prompt index so we can interleave them with `prompts` in the
  // synthesized transcript when no real JSONL is available.
  promptResponses?: string[];
  repoPath: string;           // Git repo root path OR working directory
  // Last cwd seen on a lifecycle hook (session-start, pre/post-tool-use).
  // Differs from repoPath when the harness moves the session into a linked
  // git worktree AFTER session-start: the state file stays registered under
  // the main repo's .git, but the session actually works in the worktree.
  // Bare git hooks (prepare-commit-msg, post-commit) get no stdin metadata,
  // so this is their only signal for matching a worktree commit to the
  // session that made it when several sessions share one repo.
  lastCwd?: string;
  // Did this session actually READ the repo's Origin memory? Set at
  // pre-tool-use the first time a tool call matches isMemoryReadCommand /
  // isMemoryReadToolName. Session-start injects a directive to do so; without
  // an observed tool call there is no way to tell a session that followed it
  // from one that ran blind, and the escalation below has nothing to trigger on.
  memoryChecked?: boolean;
  // Whether the one-time escalation (buildMemoryEscalationContext) has already
  // been injected. Once per session, not once per turn: an agent that has
  // decided memory is irrelevant to its task should not be told again on every
  // prompt for the rest of the session.
  memoryNudged?: boolean;
  // Keys of the memory records already retrieved into THIS session's context by
  // the prompt-scoped search (`s:<sessionId>` / `c:<sha>`). A conversation that
  // stays on one file would otherwise be handed the same three records on every
  // prompt — real context spent to tell the agent something it was told a turn
  // ago, and the fastest way to train it to skim past this block.
  memoryHitsInjected?: string[];
  headShaAtStart: string | null; // HEAD commit SHA when session started (null if no git)
  // Shadow commit (created by createShadowCommit at session start) that
  // snapshots the FULL working tree — tracked mods + untracked — as it was
  // when the session began. Unlike headShaAtStart (a clean commit), this
  // captures pre-existing uncommitted dirt, so the heartbeat can diff against
  // it to tell genuine session edits apart from dirt that was already there.
  // Null when the tree was clean at start (no shadow needed).
  sessionStartShadowSha?: string | null;
  headShaAtLastStop: string | null; // HEAD SHA after last prompt stop (for per-prompt diffs)
  prePromptSha: string | null;  // HEAD SHA before current prompt (for per-prompt git diffs)
  // Per-prompt shadow commits captured by the heartbeat daemon when it
  // detects a new user_message in the rollout (Codex etc. that don't fire
  // user-prompt-submit reliably). `promptShadows[i]` is the SHA of a
  // shadow commit reflecting the working tree state at the START of
  // prompt i. Per-prompt diff for prompt N = `git diff
  // promptShadows[N] → promptShadows[N+1]` (or → working tree for the
  // latest prompt). Lets us isolate per-turn work even when no hook fires
  // at prompt boundaries.
  // Baseline for the CURRENT turn, snapshotted in the working tree the
  // session is actually writing in (a linked worktree), when that differs
  // from repoPath.
  //
  // prePromptSha is deliberately NOT repointed: other paths diff it against
  // repoPath's tree, and a shadow taken in a different tree would report the
  // whole branch delta as the turn's work. So the worktree pair is carried
  // alongside and consumed only by the shell-window capture, which uses both
  // halves together. See session-worktree.ts.
  prePromptWorkTree?: { path: string; sha: string; promptIndex: number } | null;
  // Worktrees discovered from a shell command's own text mid-turn, each with a
  // baseline snapshotted at the moment of discovery (pre-tool-use, before that
  // command ran). Covers the agent that does `cd <worktree> && …` inside one
  // Bash call, which never moves lastCwd. See session-worktree.ts.
  discoveredWorkTrees?: Array<{ path: string; sha: string; promptIndex: number }>;
  // Fingerprints of each probed tree's dirty files, taken by pre-tool-use just
  // BEFORE a write-shaped shell command runs. post-tool-use re-probes and the
  // difference is what that command actually wrote — evidence, as opposed to
  // the turn window's inference. Cleared once resolved.
  // Path of this session's write journal, and the epoch-ms start of the turn
  // in flight. Together they let a turn claim the files WRITTEN during it,
  // which is the only evidence available for agents that expose no tool hooks
  // at all (Codex, Devin, Copilot). See write-journal.ts.
  // Session ids seen writing into this same working tree while this session
  // ran. Attribution between sessions sharing one checkout cannot be proven,
  // so a turn captured under contention is a weaker claim than one captured
  // alone — recorded rather than hidden. See checkout-contention.ts.
  contendingSessionIds?: string[];
  writeJournalPath?: string;
  /**
   * Content snapshots for this session's journal — see write-journal-store.ts.
   *
   * With these a turn's diff is READ (before-snapshot -> after-snapshot) rather
   * than reconstructed from a baseline nobody wrote down. Dropped when the
   * session ends; a missing directory simply means the turn falls back to the
   * previous path-and-window behaviour.
   */
  writeSnapshotDir?: string;
  currentTurnStartedAt?: number;
  // Wall-clock (ms) of the Stop that closed the most recent turn. Paired with
  // currentTurnStartedAt it tells the heartbeat whether a turn is OPEN — a
  // prompt submitted and not yet stopped — which is proof the agent is
  // working even when its transcript sits untouched (Cursor writes its
  // transcript only when a generation ends). Hook-written only.
  lastTurnClosedAt?: number;
  // Stamped on the archived copy when the heartbeat dropped the session
  // because the SERVER said it was archived or deleted. Archive recovery must
  // not bring such a row back on the chat's next prompt.
  serverTerminal?: boolean;
  shellProbes?: Array<{
    // The tool call that armed this probe, so post-tool-use resolves ITS OWN
    // window. Parallel tool calls interleave begin/end freely, and without an
    // id the list was overwritten by whichever began last and drained by
    // whichever ended first — see beginShellProbe. Absent for agents that do
    // not propagate an id through both hooks; those keep the drain-all path.
    toolCallId?: string;
    promptIndex: number;
    tree: string;
    baselineSha?: string;
    stamps: Array<{ file: string; mtimeMs: number; size: number }>;
    skipped?: boolean;
    // The command text that is about to run, clamped. Kept so the
    // post-tool-use side can tell a file OUR command named apart from one a
    // sibling happened to write inside the same window — see
    // fileNamedInCommand. Without it every probe edit is equally weak and a
    // contested file (13 sessions claim packages/cli/src/commands/hooks.ts)
    // gets excluded from the turn that really wrote it.
    command?: string;
  }>;


  promptShadows?: Array<{
    promptIndex: number;
    shadowSha: string;
    capturedAt: string; // ISO timestamp
  }>;
  // Prompts recovered after their start hook was missed. Their transcript can
  // prove the turn exists, but not the working-tree state it began from.
  // Keep that uncertainty explicit so a later capture never assigns a
  // cumulative diff or commit range to one of these historical turns.
  promptsWithoutBaseline?: number[];
  // The turn currently EXECUTING, bound when that turn STARTS rather than
  // derived from list position when an edit lands.
  //
  // Ownership used to be `prompts.length - 1`, resolved at capture time. That
  // is the same thing as "the turn that made this edit" only while nobody
  // types mid-turn: user-prompt-submit fires the instant the user hits enter,
  // including for a message QUEUED behind the running turn, so from that
  // moment every edit the still-running turn made resolved to the queued
  // prompt's index. User-reported: "I put prompt 5 in the middle of work of
  // prompt 4, all output went to prompt 4, prompt 5 is empty."
  //
  // A queued prompt appends to `prompts` but must NOT move this. Stop closes
  // the turn; the next capture opens the following one.
  // Commits this session made, bound to the turn that was ACTIVE when each
  // landed. Written by post-commit, which is the one moment the answer is
  // known rather than reconstructed.
  //
  // `sessionCommitShas` records WHICH commits are ours; it has never recorded
  // WHOSE TURN. post-commit had `activeTurn` in hand the whole time and threw
  // it away, so turn ownership was re-derived afterwards — twice, independently
  // and differently:
  //
  //   CLI     supplementUncoveredCommittedFiles picks "the highest-promptIndex
  //           turn that claims it", calling that the most defensible owner.
  //   server  commit-attribution.ts runs 9 time windows and 10 promptIntent()
  //           text checks over the prompt wording.
  //
  // Both are guesses at a fact that was observed. That is why the server ranks
  // its own guess ABOVE the capture's carrier ("a capture's commits[] is a
  // claim, not attestation") and why the same fix keeps being made: no amount
  // of tuning reconstructs something nobody wrote down.
  //
  // Keyed by turnId, not promptIndex: a position moves (a resume, a rolled
  // transcript, a mid-turn interjection), and a commit re-homed onto whatever
  // turn now holds that slot is the exact failure this attests against.
  //
  // `via` grades the observation, because the two sources are not equally
  // strong and the reader must be able to tell them apart:
  //
  //   post-commit  the hook fired as the commit landed and read activeTurn.
  //                Proof of WHEN and WHOSE.
  //   transcript   the agent printed the sha in its own output ("[branch
  //                73df467]") and the watcher paired it to the turn whose
  //                region it appeared in. Weaker: the sha is resolved and
  //                age-bounded, but it is the agent SAYING it committed rather
  //                than us watching it happen, and prose can carry an old sha
  //                ("reverted abc1234").
  //
  // Cursor needs the second one. Across this machine's whole log history its
  // worktree fired after-file-edit 30x, user-prompt-submit 29x and post-tool-use
  // 9x — and post-commit ZERO times, ever, with core.hooksPath correctly set and
  // the hook executable. Its commits do not invoke git hooks at all, so
  // commit-time attestation can never exist for it; discovery is the only
  // evidence available.
  commitTurns?: Array<{ sha: string; turnId: string; at: string; via: 'post-commit' | 'transcript' }>;
  // Shas whose Commit-row patch Stop already rescued via `git show` (post-commit's
  // PATCH never landed). Once per sha per session — the server keeps the first
  // patch it gets, so re-sending is spawn cost with no effect.
  rescuedCommitShas?: string[];
  activeTurn?: {
    index: number;
    turnId: string;
    // The prompt text as it read when the turn opened. Re-checked at capture
    // so a list that renumbered underneath us is caught instead of silently
    // moving this turn's diff onto another row.
    promptText: string;
    openedAt: string;
  } | null;
  // Highest turn index Stop has closed. Lets the next open pick index+1
  // rather than the list tail, so two prompts queued back-to-back run in
  // order instead of the first being skipped.
  lastClosedTurnIndex?: number;
  // How many turns of this conversation predate `prompts` — i.e. the offset
  // between our LOCAL turn numbering (always from 0) and the SERVER row a turn
  // belongs to (its native position in the transcript). 0 / absent on an
  // ordinary session, where the two spaces coincide.
  //
  // Non-zero after a resume, compaction or adoption, and that is exactly when
  // a hook that writes a raw local index aims at row 0 — a row that already
  // holds turn ONE. Stop derives the same number as `parsed.promptIndexBase`
  // every turn and refreshes this; it is cached here for the hooks that cannot
  // afford a transcript parse (see serverRowForLocalTurn in hooks.ts).
  promptIndexBase?: number;
  // Stable per-prompt identity, assigned at submit and never renumbered.
  // `promptTurnIds[i]` belongs to the turn stored at index i. The server keys
  // PromptChange rows on it, so a later renumbering of the list cannot slide
  // one turn's diff onto another turn's row.
  promptTurnIds?: string[];
  completedPromptMappings?: Array<{  // Accumulated per-prompt file change mappings
    promptIndex: number;
    promptText: string;
    filesChanged: string[];
    // Absolute paths the turn wrote OUTSIDE the repo (home collapsed to `~`).
    // Carried so a turn whose writes all landed elsewhere can explain its
    // empty filesChanged instead of reading as a broken capture.
    outOfRepoFiles?: string[];
    // Files the turn changed but whose content could not be retained.
    contentUnavailableFiles?: string[];
    diff: string;
    uncommittedDiff?: string;
    // The source and ownership guard for a stored diff. A ledger capture is
    // observed turn evidence and must not later be rebuilt from a commit.
    diffSource?: 'ledger';
    ledgerOwned?: boolean;
    linesAdded?: number;
    linesRemoved?: number;
    commitSha?: string | null;
    treeSha?: string | null;
    // True when Stop decided this prompt didn't touch code (no commits, no
    // transcript edits). Prevents the next user-prompt-submit retroactive
    // capture from sweeping in pre-existing dirty changes.
    chatOnly?: boolean;
    // True when this entry is NOT a turn capture but a producer's accumulator
    // of every file the session has touched, kept so commit attribution can
    // match staged files to a session. It carries a file list and no diff by
    // design. See registerAgySessionState, and capture-verify.ts's
    // `isFileSetRecord` for why the verifier has to be told.
    fileSetOnly?: boolean;
    // When this row was last WRITTEN, so the release gate can grade the turns
    // captured since the previous release instead of whole sessions.
    //
    // The gate used to window on session `startedAt`, which meant a session
    // that began before the last tag was never graded at all. With tags cut
    // minutes apart — two consecutive releases on 2026-09-10 were 50 and 40
    // minutes after their predecessor — almost nothing STARTS inside the
    // window, and both graded zero sessions while 25 contradictory turns sat
    // on the machine. A vacuous pass reads exactly like a real one.
    //
    // Windowing on the SESSION cannot fix that: a stored row is final, so any
    // widening drags a long session's old contradictions back into scope on
    // every release and wedges the gate for good — the deadlock that needed a
    // one-time waiver at cli-v0.20260910.630. Per-TURN time is what makes the
    // window advance honestly.
    //
    // Absent on every row written before this existed, and absence keeps a row
    // OUT of the window. That is deliberate: the backlog can never re-enter
    // and re-wedge releases, and the gate sharpens as new turns are captured.
    // Re-stamped whenever the row is rewritten, because a rewritten row is a
    // new capture and that is exactly when it should be graded again.
    capturedAt?: string;
  }>;
  // Live per-edit ledger appended by the post-tool-use hook as each
  // Edit / Write / MultiEdit fires, stamped with the prompt index active at
  // capture time. Authoritative: the exact tool inputs, caught in real time,
  // so they dodge the transcript's editsJson truncation, format drift, and
  // not-yet-flushed-at-Stop races. Merged with the transcript capture at
  // Stop/session-end (mergeLedgerWithTranscript) so shell/commit edits the
  // live hook never sees are still covered. Bounded by LIVE_EDIT_MAX_ENTRIES
  // and per-content clamping in hooks.ts. Disable with ORIGIN_LIVE_CAPTURE=0.
  liveEdits?: Array<{
    promptIndex: number;
    toolName: string;
    capturedAt: string;
    edits: PromptEdit[];
  }>;
  // Files this session is ABOUT to write, claimed by the PRE-tool-use hook
  // before the tool runs.
  //
  // liveEdits is written AFTER the write lands, which leaves a window where a
  // file is already dirty in the shared tree but no state file says whose it
  // is — and a concurrent session diffing in that window attributes it to
  // itself. Measured: session b629d2cb's row for "take it yourself" picked up
  // 97ad4482's `routes/sessions.ts` this way, seconds before 97ad4482's own
  // ledger recorded it. Claiming at pre-tool-use closes the ordering gap: the
  // claim is on disk before the bytes are.
  //
  // Pruned by age on read (PENDING_WRITE_TTL_MS) so a blocked or crashed tool
  // call cannot leave a permanent claim, and capped so a long session cannot
  // grow it without bound.
  pendingWrites?: Array<{ file: string; at: string }>;
  // Prompt indexes whose turn ran a WRITE-SHAPED shell command (a heredoc,
  // `sed -i`, `cp`, an interpreter invocation…). The post-tool-use hook sets
  // this; Stop reads it to decide whether to derive that turn's shell writes
  // from its git window (see shell-write-capture.ts). A turn that only ran
  // read-only commands is never in here, so it can never claim a file the
  // user changed in their editor while the agent was talking.
  shellWriteTurns?: number[];
  branch: string | null;      // Git branch at session start
  sessionTag?: string;        // Tag for concurrent session support
  // Ring buffer of tool-call pre/post records. Field kept as `subagents` for
  // backward compat with serialized session-state files. See R2 in
  // docs/notes/SUBAGENT_AUDIT.md.
  subagents?: ToolCallRecord[];
  // Real sub-agent spawns (Task tool only) — the honest "N sub-agents" count,
  // distinct from the `subagents` tool-call ring buffer above.
  subagentSpawns?: SubagentSpawn[];
  tabCompletions?: TabCompletionStats;
  agentSystemPrompt?: string; // Cached agent system prompt for session resume
  activePolicies?: string[];  // Cached active policies for session resume
  verboseCapture?: boolean;   // Opt-in flag from the repo: capture full tool inputs + tool_result bodies
  prePromptDirtyFiles?: string[]; // Files that were already dirty (uncommitted) before current prompt
  // Files that were uncommitted at session-start. Captured BEFORE the start-
  // shadow trick zeros out prePromptDirtyFiles. Persists for the life of the
  // session so the session-end snapshot can still filter out pre-existing
  // pollution (e.g. an earlier agent's leftover uncommitted edits) even
  // though prePromptDirtyFiles has since been rotated to per-prompt state.
  sessionStartDirtyFiles?: string[];
  // Commits made BY this session, as recorded by the post-commit hook. Used
  // to scope `committedDiff` to commits this session actually authored —
  // crucial when multiple agents run concurrently on the same repo: without
  // this, a `git diff prePromptSha...HEAD` heartbeat picks up commits made
  // by the OTHER session (HEAD has moved) and credits them to the wrong
  // agent in AI Blame.
  sessionCommitShas?: string[];
  // Commits a rebase rewrote, as (orphan → rewrite) pairs found by the amend/
  // rebase rescue. Sent with every gitCapture so the SERVER can move the
  // session off the orphan too: it used to union every incoming sha list
  // with what it had, and the orphan's Commit row stayed linked to the
  // session, so the same work counted twice however well the CLI deduped.
  rewrittenCommits?: Array<{ from: string; to: string }>;
  // policyId/ruleId/policyName ride along (sent by session/start since the
  // audit-reporting change) so hook-level blocks can report WHICH policy
  // fired; older state files lack them and degrade to type-only reports.
  enforcementRules?: Array<{
    type: string; condition: string; action: string; severity: string;
    policyId?: string; ruleId?: string; policyName?: string;
  }>;
  // When enforcementRules was last refreshed from the server (epoch ms).
  // The heartbeat rewrites the rules from each ping; pre-tool-use does a
  // TTL-bounded refetch when this is stale (or absent) so a policy created
  // mid-session is enforced without waiting for the next session start.
  // Absent on older state files → treated as "stale", triggers a refresh.
  enforcementRulesFetchedAt?: number;
  // Hard budget cap lockout. Set when the server reports a blocking cap
  // breached (session PATCH response or heartbeat ping), cleared when it
  // reports clear. user-prompt-submit and pre-tool-use consult this to
  // block new AI work; ORIGIN_BUDGET_OVERRIDE=1 bypasses.
  budgetBlocked?: boolean;
  budgetBlockReason?: string;
  // Why session/start failed and this session stayed local. Read by `origin
  // status` to report the REAL reason (repo-not-registered, agent-disabled, …)
  // instead of a canned "agent was disabled" string.
  syncBlock?: import('./sync-block.js').SyncBlock;
  // Scoped SOFT-cap warning (warn-only — nothing is locked). Persisted by
  // the heartbeat from ping payloads; user-prompt-submit surfaces it once
  // per distinct reason in the conversation and records it in
  // budgetWarnShownFor so the banner doesn't repeat on every prompt.
  budgetWarnReason?: string;
  budgetWarnShownFor?: string;
  // One audit report per lockout episode — set after the first blocked
  // prompt/tool reports to /violations, cleared when the lockout lifts.
  budgetBlockReported?: boolean;
  trailId?: string;           // Trail ID if session is linked to an active trail
  agentSlug?: string;         // Agent slug (claude-code, cursor, codex, gemini, etc.)
  // Files the agent loaded into context (deduped, capped). Populated lazily
  // in pre-tool-use whenever a Read-style tool fires. Persisted into git
  // notes at session-end as `filesRead` so the next agent can see what the
  // prior agent looked at — not just what it changed.
  filesRead?: string[];
  // Pointer to the previous session in this repo (captured at session-start
  // from refs/notes/origin-memory). Persisted into git notes so readers can
  // walk a chain of sessions across commits.
  previousSessionId?: string;
  // ISO timestamp the previous session started — used to scope the
  // acceptance backfill scan to only commits that session could have authored.
  previousSessionStartedAt?: string;
  status?: string;            // RUNNING | ENDED | COMPLETED
  endedAt?: string;           // ISO timestamp when session ended
  // Owning Origin account, stamped once at first save (see session-owner.ts).
  // ownerOrgId = the orgId that captured this session; ownerKeyHash = sha256
  // fingerprint (first 16 hex) of that account's API key — never the raw key.
  // Immutable after the first write so an account switch can't relabel a
  // previous account's session. Absent on legacy/standalone sessions.
  ownerOrgId?: string;
  ownerKeyHash?: string;
  // Canonical (main) repo path when repoPath is a linked worktree — the
  // identity sent to the server (repo naming, session/commit ingest) so a
  // worktree session attributes to the real project, while repoPath stays
  // the WORKING root all git capture runs against. Equal to repoPath (or
  // absent, on pre-worktree-fix states) for normal checkouts.
  canonicalRepoPath?: string;
  // Multi-repo support: when cwd contains multiple git repos
  repoPaths?: string[];       // All git repo roots discovered under cwd
  perRepoState?: Record<string, {
    headShaAtStart: string | null;
    headShaAtLastStop: string | null;
    prePromptSha: string | null;
    prePromptDirtyFiles: string[];
    branch: string | null;
  }>;
}

// ─── Git Directory ─────────────────────────────────────────────────────────

/**
 * The session's prompt history, reconciled against what the transcript can
 * still see.
 *
 * A turn's promptIndex is its POSITION in this list, and the server keys
 * PromptChange rows on that index. So the list may only ever GROW: if it
 * shrinks, index N silently starts meaning a different turn than the row
 * already stored under N, and each turn's diff lands on some earlier turn's
 * row. That is not hypothetical — prod session 0a8e2164 ran long enough for
 * Claude Code to roll its transcript, which left the CLI parsing 5 prompts
 * against 7 stored mappings: the turn that verified a number rendered the
 * previous turn's +327/−20, and three turns that really did edit files
 * rendered empty.
 *
 * Reading `parsed.prompts.length > 0 ? parsed.prompts : state.prompts` is what
 * allowed the shrink — a truncated transcript is non-empty, so it won.
 *
 * Rules, in order:
 * The mirror image is just as damaging and was the one left unhandled: the
 * stored list starting LATE. A resumed session builds a fresh state file, a
 * duplicate state file gets created mid-session, or the first
 * user-prompt-submit simply never fires — and then stored holds only the TAIL
 * of the conversation. It is not a prefix of parsed and parsed does not
 * overlap its tail, so the last rule fired and CONCATENATED the two: prod
 * session 3bfa24e6 stored 4 prompts against a 6-prompt transcript and got a
 * 10-entry list with every prompt twice, reporting the current turn as index 9
 * when it was index 5. Every index derived from it pointed at some earlier
 * turn's row — which is how a read-only investigation turn came to own +665
 * lines and a commit from a different session's branch, and how upplabs
 * session c5c94af7 turn 1 (eight read-only commands) ended up holding turn 5's
 * 81KB article-editor diff and a commit made 88 minutes later.
 *
 * Rules, in order:
 *   - nothing stored yet → take the transcript's view
 *   - stored is a prefix of parsed → ordinary growth, take parsed
 *   - every stored prompt still appears in parsed, IN ORDER → the transcript
 *     holds the complete history (we started late, or it records turns we
 *     never saw, like an interrupt marker). Take parsed: it owns the
 *     numbering. A subsequence test, not a contiguous one, because the
 *     transcript legitimately carries entries the hook never recorded.
 *   - all but the newest stored prompt appear in parsed → same, plus the
 *     prompt the transcript has not flushed yet, appended so it keeps the
 *     next index rather than overwriting the last one
 *   - parsed overlaps the TAIL of stored → the transcript lost its head; keep
 *     our numbering and append only what is genuinely new
 *   - no overlap → keep stored and append parsed. Renumbering is the one
 *     outcome that corrupts already-written rows, so never do it.
 */
/**
 * Normalize a prompt for comparison across the places it is recorded.
 *
 * Exported so the transcript watcher compares turn identity the SAME way the
 * hook path does. Two normalizers would be two definitions of "the same
 * prompt", and the paths would then disagree about which turn a capture
 * belongs to — which is the class of bug this mechanism exists to stop.
 */
export function promptKey(text: string): string {
  // Peel the envelopes Cursor puts around the typed words BEFORE collapsing
  // whitespace. The hook used to store `<timestamp>…` / `<image_files>…` /
  // a leading `[Image]` line, while Stop's transcript parser stored the inner
  // text (session 562314d8: every illustrated turn and several plain ones
  // rendered twice). The first 200 chars of the envelope never prefix-match
  // the user's sentence, so `samePromptText` treated them as different turns.
  // Image-only prompts have nothing left after the peel — keep the original
  // so two captionless screenshots don't collapse into one empty key.
  const peeled = String(text || '')
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, ' ')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, ' ')
    .replace(/<user_query>([\s\S]*?)<\/user_query>/gi, '$1')
    .replace(/\[image\]/gi, ' ');
  const withoutMarks = peeled.replace(/\s+/g, ' ').trim();
  if (withoutMarks) return withoutMarks.slice(0, 200);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Do two records describe the same typed prompt?
 *
 * There are TWO producers of prompt text and they do not agree byte for byte.
 * The prompt-submit hook stores what the agent handed it — for Claude Code
 * that string renders each attached image as a trailing `[image]`
 * placeholder. The Stop-time transcript parser rebuilds the same prompt from
 * the JSONL, where images are separate blocks (so no placeholder) and a long
 * prompt is cut at 1000 characters with `...`. Session 2a93541b: a prompt with
 * two screenshots was stored as `…agent\n[image] [image]` and parsed back as
 * `…agent`; a 1398-char prompt was parsed back as its first 1000 chars.
 *
 * Compared with `===`, each of those is a NEW prompt. `reconcilePromptHistory`
 * appended it, the Stop captured the turn a second time under the phantom
 * index, and the dashboard showed 7 turns for 5 prompts with the work
 * double-counted. Short plain prompts matched exactly and were fine, which is
 * why it only bit the two long/illustrated ones.
 *
 * The rule here is the one `homePromptIndexByText` already trusted for
 * re-homing a write: same normalised key, or one key a prefix of the other —
 * which absorbs both a trailing placeholder and a truncation.
 */
export function samePromptText(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = promptKey(a || '');
  const kb = promptKey(b || '');
  if (!ka || !kb) return ka === kb;
  return ka === kb || ka.startsWith(kb) || kb.startsWith(ka);
}

/**
 * Confirm the index we are about to write actually belongs to the prompt we
 * think we are capturing — and re-home it, or refuse, when it does not.
 *
 * The transcript owns prompt NUMBERING: its mappings are parsed from the whole
 * ordered conversation, while the hook's index is a length counter over a list
 * that can start late or miss turns. `reconcilePromptHistory` realigns the
 * common shapes, but duplicate state files and repeated prompt text can still
 * put the counter out of step — and writing at a wrong index does not lose a
 * turn's diff, it hands that diff to a DIFFERENT turn, which reads as a
 * confident lie rather than missing data.
 *
 * Returns the index to write at, or null meaning "don't write": the transcript
 * says this index belongs to some other prompt and no row matches ours. The
 * turn's own capture is retried on the next Stop; an overwritten row is not
 * recoverable.
 */
export function homePromptIndexByText(
  idx: number,
  text: string,
  mappings: Array<{ promptIndex: number; promptText?: string }> | undefined | null,
): number | null {
  const list = Array.isArray(mappings) ? mappings : [];
  if (list.length === 0) return idx;
  const at = list.find((m) => m.promptIndex === idx);
  // No mapping at this index: the transcript never described this turn (the
  // case the Stop safety net exists for), so the counter is all we have.
  if (!at) return idx;
  if (!promptKey(text)) return idx;
  if (promptKey(at.promptText || '') && samePromptText(at.promptText, text)) return idx;
  // Out of step. Prefer the LAST matching row: prompt text repeats ("Try
  // again"), and the newest occurrence is the turn being captured now.
  for (let i = list.length - 1; i >= 0; i--) {
    if (promptKey(list[i].promptText || '') && samePromptText(list[i].promptText, text)) return list[i].promptIndex;
  }
  return null;
}

/**
 * The index of the turn that is currently RUNNING — the one an edit landing
 * right now belongs to.
 *
 * Opens a turn if none is open, closes nothing (Stop does that). The opened
 * index is the one after the last CLOSED turn, not the tail of the list: with
 * two prompts queued behind a running turn the tail would skip straight to the
 * second and leave the first permanently empty.
 *
 * Re-verifies an already-open turn against the prompt list every time. If the
 * list renumbered underneath the turn (a rolled transcript, a late-starting
 * state file, a resume) the recorded text no longer sits at the recorded
 * index; we re-home by text, and when the text cannot be found at all we
 * REFUSE — returning null so the caller drops the capture rather than writing
 * it onto whichever turn now occupies that slot. A missing diff is a visible
 * gap; a diff on the wrong turn is a false accusation.
 */
export function currentTurnIndex(
  state: {
    prompts?: string[];
    activeTurn?: { index: number; turnId: string; promptText: string; openedAt: string } | null;
    lastClosedTurnIndex?: number;
    promptTurnIds?: string[];
  },
  opts?: { now?: () => string; newId?: () => string },
): number | null {
  const prompts = Array.isArray(state.prompts) ? state.prompts : [];
  if (prompts.length === 0) return null;
  const last = prompts.length - 1;

  const open = state.activeTurn;
  if (open && Number.isInteger(open.index)) {
    const at = prompts[open.index];
    const want = promptKey(open.promptText || '');
    const has = promptKey(at || '');
    // Still where we left it (or we never had text to check against).
    if (!want || (has && (has === want || has.startsWith(want) || want.startsWith(has)))) {
      return open.index;
    }
    // Renumbered underneath us — find the turn by what it SAID.
    for (let i = prompts.length - 1; i >= 0; i--) {
      const k = promptKey(prompts[i] || '');
      if (k && (k === want || k.startsWith(want) || want.startsWith(k))) {
        state.activeTurn = { ...open, index: i };
        return i;
      }
    }
    return null; // gone entirely — refuse rather than mis-attribute
  }

  // Nothing open: bind the next turn in sequence.
  const nextAfterClosed = Number.isInteger(state.lastClosedTurnIndex as number)
    ? (state.lastClosedTurnIndex as number) + 1
    : last;
  const index = Math.max(0, Math.min(nextAfterClosed, last));
  const newId = opts?.newId || (() => `t_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);
  if (!state.promptTurnIds) state.promptTurnIds = [];
  if (!state.promptTurnIds[index]) state.promptTurnIds[index] = newId();
  state.activeTurn = {
    index,
    turnId: state.promptTurnIds[index],
    promptText: prompts[index] || '',
    openedAt: (opts?.now || (() => new Date().toISOString()))(),
  };
  return index;
}

/**
 * Stop finished the running turn. The next capture binds the following one.
 */
export function closeTurn(
  state: { activeTurn?: { index: number } | null; lastClosedTurnIndex?: number },
  index?: number,
): void {
  const closed = Number.isInteger(index as number) ? (index as number) : state.activeTurn?.index;
  if (Number.isInteger(closed as number)) {
    state.lastClosedTurnIndex = Math.max(state.lastClosedTurnIndex ?? -1, closed as number);
  }
  state.activeTurn = null;
}

/**
 * How many of `prev`, from the start, appear in `next` in order (gaps in
 * `next` allowed). `prev.length` means every stored prompt survives in the
 * transcript, so the transcript's list is a superset and safe to adopt.
 */
function subsequencePrefixLength(prev: string[], next: string[]): number {
  let i = 0;
  for (const candidate of next) {
    if (i < prev.length && samePromptText(prev[i], candidate)) i++;
  }
  return i;
}

/**
 * The transcript's numbering with the STORED text kept wherever the two
 * describe the same prompt. The stored copy is the hook's — the full text,
 * placeholders included — and the transcript's is the one that was cut at
 * 1000 chars; adopting the transcript wholesale would trade the richer record
 * for the poorer one on every reconcile.
 */
function adoptNumberingKeepingStored(prev: string[], next: string[]): string[] {
  let i = 0;
  return next.map((candidate) => (i < prev.length && samePromptText(prev[i], candidate)) ? prev[i++] : candidate);
}

export function reconcilePromptHistory(
  stored: string[] | undefined | null,
  parsed: string[] | undefined | null,
  opts?: { collapseTrailingRepeat?: boolean },
): string[] {
  const prev = Array.isArray(stored) ? stored : [];
  const next = Array.isArray(parsed) ? parsed : [];
  if (prev.length === 0) return [...next];
  if (next.length === 0) return [...prev];

  const collapseExtra = (extra: string[]): string[] => {
    if (!opts?.collapseTrailingRepeat || prev.length === 0) return extra;
    const out = [...extra];
    while (out.length && samePromptText(out[0], prev[prev.length - 1])) out.shift();
    return out;
  };

  // Ordinary growth: everything we already recorded is still at the head.
  if (next.length >= prev.length && prev.every((p, i) => samePromptText(p, next[i]))) {
    return [...prev, ...collapseExtra(next.slice(prev.length))];
  }

  // We started LATE: the transcript still contains everything we stored, in
  // order, plus turns we never saw (the ones before we existed, and entries
  // like an interrupt marker that fire no hook). The transcript is the
  // complete history, so adopt its numbering wholesale.
  const matched = subsequencePrefixLength(prev, next);
  if (matched === prev.length) return adoptNumberingKeepingStored(prev, next);
  // Same, except the newest prompt hasn't reached the transcript yet — keep it
  // at the END so it takes the next index instead of colliding with the last
  // turn the transcript does know about.
  if (matched === prev.length - 1) return [...adoptNumberingKeepingStored(prev.slice(0, -1), next), prev[prev.length - 1]];

  // Transcript dropped earlier turns: find where its first surviving prompt
  // sits in our history, and append only the tail beyond the overlap.
  for (let start = 0; start < prev.length; start++) {
    let k = 0;
    while (start + k < prev.length && k < next.length && samePromptText(prev[start + k], next[k])) k++;
    if (k > 0 && start + k === prev.length) return [...prev, ...next.slice(k)];
  }

  // Last resort: the transcript and our history disagree in a way none of the
  // shapes above describe — most often because the transcript LOST a prompt
  // from the MIDDLE while gaining a new one at the end. Cursor session
  // a46eb6b6 is the worked example: stored `[A…H, X, Y]`, parsed `[A…H, Y, Z]`,
  // where X had vanished from the transcript. The subsequence walk stops at 8
  // of 10 and the tail-overlap loop needs a match running to the END of prev,
  // so both decline, and this used to `return [...prev, ...next]`.
  //
  // That concat is the worst possible answer. promptIndex is POSITIONAL and
  // the server keys its rows on it, so re-appending prompts we already have
  // does not just look untidy — it writes a second row for every turn. That
  // session holds 20 rows for 11 prompts: prompts 0-9 repeated as 10-19, each
  // duplicate a turn with no work attached.
  //
  // Append only what the transcript has that our history does not, counted as
  // a MULTISET so a genuinely re-sent prompt still lands. `prev` is never
  // reordered or renumbered — an already-written row must keep its index.
  // Each stored entry can account for ONE transcript entry, matched by
  // `samePromptText` rather than byte equality (see that function for why).
  const unaccounted = [...prev];
  const fresh: string[] = [];
  for (const candidate of next) {
    const at = unaccounted.findIndex((p) => samePromptText(p, candidate));
    if (at >= 0) unaccounted.splice(at, 1); // already have a row for it
    else if (opts?.collapseTrailingRepeat && prev.length && samePromptText(candidate, prev[prev.length - 1])) {
      // Cursor transcripts re-emit the last user prompt; the hook already
      // stored it. Appending would mint a turnId-less empty twin (c7cc460f).
    } else {
      fresh.push(candidate);
    }
  }
  return [...prev, ...fresh];
}

/**
 * Transcript parsers number every user JSONL entry, including Cursor's
 * trailing re-emit of the last prompt. After `reconcilePromptHistory` that
 * echo is not a turn — but `extractPromptFileMappings` still emits a row for
 * it, and the first non-empty `promptText` on that index wins server-side
 * (prod c7cc460f: the echo stored "open PR" at index 4, so the illustrated
 * prompt that actually occupied that slot never appeared).
 *
 * Clip to the reconciled list. Keep the longer copy when hook and
 * transcript describe the same prompt (`[image]` placeholders, 1000-char
 * cap). Do not rewrite a different sentence onto the slot — a compact
 * restatement in the JSONL would then steal the next turn's identity.
 */
export function clipMappingsToPromptHistory<T extends { promptIndex: number; promptText?: string }>(
  mappings: T[],
  prompts: string[],
  // `prompts` is THIS LAUNCH's list, numbered from 0; the mappings are
  // numbered by the transcript. On a resumed conversation the two differ by
  // the base, and clipping the server rows against the local length kept
  // exactly the rows that belong to OTHER turns (prod 8a626742: base 21, one
  // prompt — row 21 was dropped and row 0, turn one from the day before, was
  // the only mapping left to send).
  promptIndexBase: number | undefined | null = 0,
): T[] {
  if (!Array.isArray(prompts) || prompts.length === 0) return mappings;
  const base = Number.isFinite(promptIndexBase as number) && (promptIndexBase as number) > 0
    ? (promptIndexBase as number)
    : 0;
  const localOf = (m: T): number => m.promptIndex - base;
  return mappings
    .filter((m) => {
      if (!Number.isInteger(m.promptIndex) || m.promptIndex < 0) return false;
      const local = localOf(m);
      if (local >= 0) return local < prompts.length;
      // BELOW the base: a row for a turn that ran before this launch, which
      // `prompts` says nothing about.
      //
      // An EMPTY one is this launch's own numbering artifact — Stop
      // synthesizes a chat-only mapping per turn, and on a resumed session
      // one lands here. Sending it would tell the server that a real earlier
      // turn authored nothing, erasing what that turn actually did; that is
      // strictly worse than dropping it, so it goes.
      //
      // One that CARRIES work is kept, and left exactly as it is. It is
      // either a genuine earlier capture or a row a pre-fix build misnumbered
      // — and this function persists what it returns, so dropping it would
      // delete the only local copy. The server's cross-turn guards decide
      // whether it may land; losing it here is not recoverable.
      return mappingCarriesWork(m as RenumberableMapping);
    })
    .map((m) => {
      const hook = localOf(m) >= 0 ? (prompts[localOf(m)] || '') : '';
      if (!hook) return m;
      const mapped = m.promptText || '';
      if (!mapped) return { ...m, promptText: hook.slice(0, 1000) };
      // Same prompt, different producers (hook vs transcript `[image]` /
      // truncation). Keep the richer copy. Different sentences stay as the
      // transcript numbered them — rewriting would slide a compact-restated
      // illustrated prompt onto the next turn.
      if (samePromptText(mapped, hook) && hook.length > mapped.length) {
        return { ...m, promptText: hook.slice(0, 1000) };
      }
      return m;
    });
}

/**
 * The prompt history to carry into a re-attached session.
 *
 * Prefers the stored list. Falls back to reconstructing it from
 * `completedPromptMappings`, which carry `promptText` alongside the index the
 * server keyed its rows on — so a state whose prompts were already lost to an
 * earlier reset still rebuilds, and the numbering resumes where it left off
 * rather than restarting at 0.
 *
 * Gaps are filled with empty strings so an index never shifts: mapping index 4
 * has to stay index 4 even when 0-3 are missing.
 */
export function promptHistoryFromPriorState(
  prior: { prompts?: string[]; completedPromptMappings?: Array<{ promptIndex?: number; promptText?: string }> } | null | undefined,
): string[] {
  if (!prior) return [];
  if (Array.isArray(prior.prompts) && prior.prompts.length > 0) return [...prior.prompts];

  const mappings = Array.isArray(prior.completedPromptMappings) ? prior.completedPromptMappings : [];
  let highest = -1;
  for (const m of mappings) {
    const i = Number(m?.promptIndex);
    if (Number.isInteger(i) && i > highest) highest = i;
  }
  if (highest < 0) return [];

  const out: string[] = new Array(highest + 1).fill('');
  for (const m of mappings) {
    const i = Number(m?.promptIndex);
    if (!Number.isInteger(i) || i < 0 || i > highest) continue;
    if (typeof m?.promptText === 'string' && m.promptText) out[i] = m.promptText;
  }
  return out;
}

export function getGitDir(cwd?: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getGitRoot(cwd?: string): string | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!top) return null;
    // Linked git worktrees report their own --show-toplevel — e.g.
    // <repo>/.claude/worktrees/quirky-albattani-c9f7c3. The basename then
    // becomes the "repo name" on the dashboard, which is wrong: the
    // worktree is just a working copy of the SAME repo. Detect via
    // --git-common-dir (points at the MAIN repo's .git for linked
    // worktrees, equals "<top>/.git" otherwise) and walk back to the
    // actual repo so Origin attributes sessions to the canonical project.
    //
    // NOTE: this is the CANONICAL/identity root — the right thing to send
    // to the server (repo naming, session/commit ingest) and to locate
    // repo-level resources shared across worktrees (.git/hooks). It is the
    // WRONG cwd for capturing a worktree session's work: diffs/HEAD/staged
    // files must be read from the worktree itself (its files only show up
    // here as untracked `.claude/worktrees/<id>/…` dirt, and its commits
    // never move this HEAD). Use getWorkingGitRoot for git operations.
    return getCanonicalRepoPath(top);
  } catch {
    return null;
  }
}

// The WORKING git root: the top of the working tree that actually contains
// cwd — for a linked worktree, the worktree itself (NOT the main repo).
// This is the correct cwd for every git operation that captures a session's
// work: diff/HEAD/staged-file reads, shadow commits, restore. Verified on
// production session 5606d120 (Claude Code worktree): capturing from the
// collapsed main root recorded the session's edits as untracked
// `.claude/worktrees/<id>/…` files, never saw its commits (main HEAD does
// not move), and broke staged-file commit attribution.
export function getWorkingGitRoot(cwd?: string): string | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return top || null;
  } catch {
    return null;
  }
}

// Collapse a working-tree top to the canonical (main) repo path when it is a
// linked worktree; returns the input path unchanged otherwise. Split out of
// getGitRoot so callers holding a working root can derive the identity root
// without re-running discovery.
export function getCanonicalRepoPath(workRoot: string): string {
  try {
    const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { windowsHide: true,
      encoding: 'utf-8', cwd: workRoot, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (commonDirRaw) {
      const absCommonDir = path.isAbsolute(commonDirRaw)
        ? commonDirRaw
        : path.resolve(workRoot, commonDirRaw);
      const mainRepo = path.dirname(absCommonDir);
      // Sanity: only collapse when the main repo path is a different,
      // non-empty directory that actually exists. Anything weird → keep
      // the working root so we don't accidentally hide the worktree session.
      if (mainRepo && mainRepo !== workRoot && fs.existsSync(mainRepo)) {
        return mainRepo;
      }
    }
  } catch { /* fall through */ }
  return workRoot;
}

// Path of a file inside the git dir that governs `repoPath` — worktree-aware:
// a linked worktree's `.git` is a FILE pointing at the per-worktree git dir
// (<main>/.git/worktrees/<name>), so `path.join(repoPath, '.git', name)` is
// wrong there. Resolves via `git rev-parse --git-dir`; falls back to the
// plain join when git can't run (deleted repo — callers stat/read and treat
// a miss as "no signal"). Use for files git itself keeps PER worktree
// (COMMIT_EDITMSG); session state lives in the COMMON dir — see below.
export function gitDirFilePath(repoPath: string, filename: string): string {
  const gitDir = getGitDir(repoPath);
  if (gitDir) {
    const resolved = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
    return path.join(resolved, filename);
  }
  return path.join(repoPath, '.git', filename);
}

export function getGitCommonDir(cwd?: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(cwd || process.cwd(), out);
  } catch {
    return null;
  }
}

// Session state files live in the COMMON git dir — one place per repo,
// shared by the main checkout and every linked worktree. Worktree sessions
// (repoPath = the worktree top) must still be visible to repo-scoped
// lookups (zombie sweeps, `origin sessions`, pre-commit policy/violation
// session resolution, concurrent-session isolation), all of which resolve
// from the main checkout or via the collapsing getGitRoot. Cross-worktree
// ATTRIBUTION safety comes from lastCwd narrowing in listSessionsForGitHook,
// not from hiding the files in per-worktree dirs.
export function gitCommonDirFilePath(repoPath: string, filename: string): string {
  const common = getGitCommonDir(repoPath);
  if (common) return path.join(common, filename);
  return path.join(repoPath, '.git', filename);
}

/**
 * Try harder to find a git repo when the cwd itself isn't one.
 * Checks immediate subdirectories and common workspace patterns.
 * Useful when Claude Code reports a project root that's a parent of the actual repo.
 */
export function discoverGitRoot(cwd?: string): string | null {
  const dir = cwd || process.cwd();

  // 1. Direct check
  const direct = getGitRoot(dir);
  if (direct) return direct;

  // 2. Check common workspace patterns (e.g. .openclaw/workspace/*)
  const workspacePatterns = [
    path.join(dir, '.openclaw', 'workspace'),
    path.join(dir, 'workspace'),
  ];
  for (const wsDir of workspacePatterns) {
    try {
      if (!fs.existsSync(wsDir)) continue;
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(wsDir, entry.name);
        const found = getGitRoot(candidate);
        if (found) return found;
      }
    } catch { /* ignore */ }
  }

  // 3. Scan immediate subdirectories (one level deep)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(dir, entry.name);
      if (fs.existsSync(path.join(candidate, '.git'))) {
        return getGitRoot(candidate);
      }
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Discover git repos in known multi-repo workspace layouts.
 *
 * Only matches the intentional cowork pattern (`.openclaw/workspace/*` or
 * `workspace/*`). We deliberately do NOT scan arbitrary subdirectories —
 * running an agent from a parent dir like `~` or `~/projects` used to attach
 * every unrelated repo under it to the session. Repos that aren't part of
 * a workspace get attached lazily when the agent actually touches a file in
 * them (see `handlePreToolUse` / `handlePostToolUse` in hooks.ts).
 */
export function discoverAllGitRoots(cwd?: string): string[] {
  const dir = cwd || process.cwd();

  // If the directory itself is a git repo, return just that
  const direct = getGitRoot(dir);
  if (direct) return [direct];

  const roots: string[] = [];

  // Known multi-repo workspace patterns
  const workspacePatterns = [
    path.join(dir, '.openclaw', 'workspace'),
    path.join(dir, 'workspace'),
  ];
  for (const wsDir of workspacePatterns) {
    try {
      if (!fs.existsSync(wsDir)) continue;
      const entries = fs.readdirSync(wsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(wsDir, entry.name);
        const found = getGitRoot(candidate);
        if (found && !roots.includes(found)) roots.push(found);
      }
    } catch { /* ignore */ }
  }

  return roots;
}

/**
 * True when `p` is the bare openclaw cowork CONTAINER directory
 * (`…/.openclaw/workspace`) itself, not a repo inside it.
 *
 * The openclaw harness repeatedly relaunches a bare `claude` at this container
 * — no git repo, no repos inside — as warm-up / health-check probes that send
 * no prompt and touch no file. session-start uses this to skip registering a
 * throwaway non-git "workspace" session for those launches. Real work in the
 * harness launches from a repo SUBDIR under the container
 * (`…/.openclaw/workspace/<repo>`), which resolves to that repo and is tracked
 * normally — so only the empty container launch is dropped.
 *
 * Deliberately matches ONLY the intentional `.openclaw/workspace` cowork
 * pattern — NOT a bare `~/workspace`, which is commonly a real project dir.
 */
export function isCoworkContainerPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const norm = p.replace(/[\\/]+$/, '');
  return /(^|[\\/])\.openclaw[\\/]workspace$/.test(norm);
}

/**
 * True when `p` is a filesystem ROOT (`/`, `C:\`). No real coding session
 * runs at the root of the filesystem — but agent apps' own internal LLM
 * subroutines do: the Codex app fires its ambient-suggestion safety filter /
 * title-generation meta-calls with `cwd: "/"`, and each one fired the full
 * session-start → user-prompt-submit → stop hook trio, registering a
 * repo-less junk session (e.g. "gpt-5.4-mini / 0 files / 'You are an expert
 * at upholding safety and compliance standards for Codex ambient
 * suggestions…'"). session-start uses this to skip registering any non-git
 * session anchored at a bare filesystem root.
 */
export function isFilesystemRootPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

export function getHeadSha(cwd?: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function getBranch(cwd?: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, encoding: 'utf-8', cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    return null;
  }
}

// Resolve the branch the session is ACTUALLY on. `repoPath` is collapsed to
// the MAIN repo for linked worktrees (getGitRoot does this so the dashboard
// attributes the session to the canonical project, not the worktree's
// basename). But the agent works on the worktree's OWN branch — reading the
// branch from repoPath returns the MAIN checkout's branch ("main") for every
// worktree session, which is the "all sessions show main" bug.
//
// Always prefer the live working directory (the hook's cwd, or the last cwd
// seen on a lifecycle hook) where `git rev-parse HEAD` resolves the worktree's
// branch; fall back to repoPath only when no working-dir cwd is known. Each
// candidate is guarded so we never run getBranch() against process.cwd()
// (an undefined cwd), which could be an unrelated directory.
export function resolveSessionBranch(
  state: { lastCwd?: string; repoPath?: string },
  cwdHint?: string,
): string | null {
  for (const dir of [cwdHint, state.lastCwd, state.repoPath]) {
    if (!dir) continue;
    const b = getBranch(dir);
    if (b) return b;
  }
  return null;
}

// ─── Session State Persistence ─────────────────────────────────────────────

/**
 * Get the path for storing session state.
 * Prefers .git/origin-session.json if in a git repo.
 * Falls back to ~/.origin/sessions/<cwd-hash>.json otherwise.
 */
export function getStatePath(cwd?: string, sessionTag?: string): string {
  const suffix = sessionTag ? `origin-session-${sessionTag}.json` : 'origin-session.json';

  // Try git dir first — the COMMON dir, so a worktree session's state is
  // discoverable by repo-scoped lookups from any checkout (see
  // gitCommonDirFilePath). Falls back to --git-dir (identical outside
  // worktrees) for odd setups where --git-common-dir fails.
  const gitDir = getGitCommonDir(cwd) || getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    return path.join(resolvedGitDir, suffix);
  }

  // Fallback: store in ~/.origin/sessions/ keyed by cwd hash
  return getGlobalFallbackStatePath(cwd, sessionTag);
}

// Sandbox-safe state location, OUTSIDE the repo's .git — keyed by cwd (+ tag)
// so save and load agree. Codex's workspace-write sandbox forbids writes inside
// .git, so a hook that can't persist state into .git lands it here instead.
// This is also the path getStatePath returns when there's no git dir at all.
export function getGlobalFallbackStatePath(cwd?: string, sessionTag?: string): string {
  const effectiveCwd = cwd || process.cwd();
  const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const basename = sessionTag ? `${cwdHash}-${sessionTag}.json` : `${cwdHash}.json`;
  return path.join(sessionsDir, basename);
}

/**
 * Drop mappings a LOST `promptIndexBase` wrote at the wrong row.
 *
 * When the base goes missing, this session's turns are captured at 0..N as
 * well as at base..base+N, and `completedPromptMappings` ends up holding both
 * — the same promptText under two indices. Every Stop re-sends the whole list,
 * so the low copies overwrite rows belonging to earlier turns on EVERY write,
 * forever. Restoring the base stops new misnumbering and does nothing about
 * the copies already in the file.
 *
 * Prod f7881a6e: rows 0, 1 and 2 were reset to this session's turns minutes
 * after being repaired, three separate times, because idx 0/1/2 duplicated
 * idx 6/7/8 in local state. A repair cannot hold while its own client is
 * replaying the thing it repaired.
 *
 * Only a duplicate is dropped — same prompt text, one copy at or above the
 * base and one below it. Mappings below the base that are NOT duplicated are
 * this conversation's genuine earlier turns, carried across a re-attach, and
 * are left exactly as they are.
 */
interface RenumberableMapping {
  promptIndex: number;
  promptText?: string;
  filesChanged?: string[];
  diff?: string;
  uncommittedDiff?: string;
  commitSha?: string | null;
}

/** Does this mapping carry a capture, or is it an empty shell? */
function mappingCarriesWork(m: RenumberableMapping): boolean {
  return (m.filesChanged || []).length > 0
    || (m.diff || '').length > 0
    || (m.uncommittedDiff || '').length > 0
    || !!m.commitSha;
}

/**
 * Drop WORKLESS twins a renumbering left behind, whatever the base says.
 *
 * The base rule below cannot reach prod 8a626742: seven prompts stored twice,
 * once at 0..6 carrying every diff and turnId, and once at 8..14 empty and
 * turnId-less — `buildSessionWriteData`'s `m.promptIndex + 1` on top of a base
 * of 7, after all seven turns were miscounted as pre-session. Two things went
 * wrong there that the base rule makes worse rather than better:
 *
 *   - it returns early on `base <= 0`, so a LOST base — the very condition it
 *     documents — disables it;
 *   - it keeps whichever copy sits at or above the base. Here that is the
 *     EMPTY set, so had it fired it would have deleted every real capture.
 *
 * Choosing by index is the mistake. A renumbering produces one row holding the
 * work and one holding nothing, and which of them got the higher number is an
 * artifact. So this pass keeps the copy that carries a capture.
 *
 * SAFETY: a user may legitimately send the same prompt twice ("deploy it"),
 * and the second may genuinely be chat-only — dropping that would delete a real
 * turn. Text plus emptiness is therefore NOT enough. A renumbering shifts the
 * whole conversation by one constant, so this only fires where at least two
 * duplicate pairs share the SAME offset. Two coincidental repeats do not form
 * an arithmetic series; seven pairs at +8 do.
 */
function dropWorklessRenumberedTwins(maps: RenumberableMapping[]): RenumberableMapping[] {
  const key = (m: RenumberableMapping) => (m.promptText || '').slice(0, 200);
  const byText = new Map<string, RenumberableMapping[]>();
  for (const m of maps) {
    const k = key(m);
    if (!k) continue;
    const list = byText.get(k);
    if (list) list.push(m); else byText.set(k, [m]);
  }

  // Candidate pairs: exactly one copy with work, the rest without.
  const pairs: Array<{ offset: number; drop: RenumberableMapping[] }> = [];
  for (const group of byText.values()) {
    if (group.length !== 2) continue;
    const workers = group.filter(mappingCarriesWork);
    if (workers.length !== 1) continue;
    const keep = workers[0];
    const drop = group.find((m) => m !== keep)!;
    pairs.push({ offset: (drop.promptIndex ?? 0) - (keep.promptIndex ?? 0), drop: [drop] });
  }
  if (pairs.length < 2) return maps;

  // The offset shared by the most pairs, and only if at least two agree.
  const tally = new Map<number, number>();
  for (const p of pairs) tally.set(p.offset, (tally.get(p.offset) || 0) + 1);
  let bestOffset = 0;
  let bestCount = 0;
  for (const [off, n] of tally) if (n > bestCount) { bestCount = n; bestOffset = off; }
  if (bestCount < 2 || bestOffset === 0) return maps;

  const condemned = new Set(pairs.filter((p) => p.offset === bestOffset).flatMap((p) => p.drop));
  return maps.filter((m) => !condemned.has(m));
}

export function dropRenumberedDuplicateMappings(state: {
  promptIndexBase?: number;
  completedPromptMappings?: RenumberableMapping[];
}): number {
  const maps = state.completedPromptMappings;
  if (!Array.isArray(maps) || maps.length === 0) return 0;

  // Content first: it needs no base, and it is right about WHICH copy to keep.
  let kept = dropWorklessRenumberedTwins(maps);

  // Then the original base rule, for the pairs where both copies carry work
  // (prod f7881a6e: low copies were live resets of this session's turns, not
  // empty shells) and the base is known.
  const base = state.promptIndexBase || 0;
  if (base > 0) {
    const key = (m: RenumberableMapping) => (m.promptText || '').slice(0, 200);
    const atOrAboveBase = new Set(
      kept.filter((m) => (m.promptIndex ?? 0) >= base).map(key).filter((k) => k.length > 0),
    );
    if (atOrAboveBase.size > 0) {
      kept = kept.filter((m) => (m.promptIndex ?? 0) >= base || !atOrAboveBase.has(key(m)));
    }
  }

  const dropped = maps.length - kept.length;
  if (dropped > 0) state.completedPromptMappings = kept;
  return dropped;
}

export function saveSessionState(state: SessionState, cwd?: string, sessionTag?: string): void {
  // First-write-wins ownership stamp so a later account switch can't pull this
  // session into a different account (see session-owner.ts).
  ensureOwnerStamp(state);
  // Never persist a renumbering duplicate: it would be re-sent on every
  // subsequent write and silently overwrite an earlier turn's row.
  dropRenumberedDuplicateMappings(state);
  // A reservation adopted mid-registration must not write its provisional id
  // back over the one session-start has registered since it was read.
  const adoption = adoptRegisteredReservation(state, cwd, sessionTag);
  if (adoption) {
    debugLog('session-state', 'reservation was registered while this hook held it — saving under the registered id', {
      from: adoption.from, to: adoption.to, sessionTag: sessionTag || state.sessionTag,
    });
  }
  const statePath = getStatePath(cwd, sessionTag || state.sessionTag);
  try {
    const tmpStatePath = statePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpStatePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpStatePath, statePath);
  } catch (err: any) {
    // Sandboxed agents (Codex's workspace-write) forbid writes INSIDE .git →
    // EPERM/EACCES. A thrown save aborts the whole Stop hook, which the agent
    // then surfaces as "hook timed out after 10s". Persist to the sandbox-safe
    // fallback the loader also checks instead of failing the hook.
    if (err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EROFS') {
      const fb = getGlobalFallbackStatePath(cwd, sessionTag || state.sessionTag);
      if (fb !== statePath) {
        const tmpFb = fb + '.tmp.' + process.pid;
        fs.writeFileSync(tmpFb, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.renameSync(tmpFb, fb);
      }
    } else {
      throw err;
    }
  }

  // Also mirror to ~/.origin/sessions/ for global discovery (origin sessions --all)
  // Always mark as RUNNING since this is an active save
  try {
    const globalDir = path.join(os.homedir(), '.origin', 'sessions');
    fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
    const globalPath = path.join(globalDir, `${state.sessionId.slice(0, 12)}.json`);
    const globalState = { ...state, status: 'RUNNING' };
    const tmpGlobalPath = globalPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpGlobalPath, JSON.stringify(globalState, null, 2), { mode: 0o600 });
    fs.renameSync(tmpGlobalPath, globalPath);
  } catch (err: unknown) {
    // Non-fatal — the in-repo file is the primary — but never silent: the
    // mirror is what `origin sessions --all` and cross-repo discovery read,
    // and a session missing from it looked like a session that never ran.
    debugLog('session-state', 'global mirror write failed (non-fatal)', {
      sessionId: state.sessionId, message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Remove the ~/.origin/sessions mirror written under a session id this
 * conversation no longer uses.
 *
 * The mirror is keyed by SESSION ID, not by tag. session-start reserves a
 * provisional `local-` id before calling `session/start` and saves state under
 * it, so the mirror gets a `local-<uuid>.json`; the registered id is then
 * saved under its own name and the reservation's mirror is simply left
 * behind — RUNNING, `pendingRegistration: true`, forever. This machine had 40
 * of them beside 95 real sessions, one per session-start, and `origin
 * sessions --all` listed every one as a live local session.
 *
 * Only the global mirror is touched. The per-repo state file is keyed by tag
 * and was overwritten in place by the promotion.
 */
export function dropSessionMirror(sessionId: string | undefined | null): void {
  if (typeof sessionId !== 'string' || !sessionId) return;
  try {
    const globalPath = path.join(os.homedir(), '.origin', 'sessions', `${sessionId.slice(0, 12)}.json`);
    fs.unlinkSync(globalPath);
  } catch { /* already gone, or never mirrored */ }
}

/**
 * The state-file tag for a conversation.
 *
 * The tag decides the FILE PATH, so it is the only thing that makes two hooks
 * racing to create a session converge on one row instead of two. session-start
 * derived it from `claudeSessionId` — empty for every agent that isn't in
 * STABLE_SESSION_ID_AGENTS — and fell through to a timestamp, while
 * user-prompt-submit's auto-create derived its own from the stdin session id.
 * For Cursor that meant `smtfv1cat` and `ceb22e9b-221` for one chat: two files,
 * two sessions, and no ordering either hook could win.
 *
 * Reserving early does not fix that on its own. Measured on the real hooks with
 * no network at all, user-prompt-submit reaches its mint 236ms BEFORE
 * session-start finishes resolving the repo — and in the prod trace
 * session-start was 16s behind. Agreeing on the path removes the race instead
 * of trying to win it: whoever arrives first creates the file, and the other
 * finds it there and merges.
 */
/**
 * Stamp a per-turn mapping with the moment it was written.
 *
 * Every producer that appends to or replaces an entry in
 * `completedPromptMappings` goes through this, so the release gate can ask
 * "which turns were captured since the last release?" instead of "which
 * SESSIONS started since it?" — see the `capturedAt` note on the type for why
 * the session-level question cannot be answered without deadlocking the gate.
 *
 * Overwrites any existing value on purpose: a row being rewritten is a fresh
 * capture, and the gate should grade it again.
 */
export function stampCaptured<T extends object>(mapping: T, now: Date = new Date()): T & { capturedAt: string } {
  return Object.assign(mapping as T & { capturedAt: string }, { capturedAt: now.toISOString() });
}

export function sessionTagFor(
  claudeSessionId: string | undefined,
  agentSessionId?: string,
  now: number = Date.now(),
): string {
  const anchor = (claudeSessionId || agentSessionId || '').trim();
  return anchor ? anchor.slice(0, 12) : `s${now.toString(36)}`;
}

/** A `local-` id is a placeholder the server has never seen. */
export function isProvisionalSessionId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('local-');
}

/**
 * How long a session-start reservation is treated as "registration in flight".
 *
 * Long enough to cover a slow `session/start` — the prod trace that motivated
 * the reservation took 8.2s to fail, and the pricing calls ahead of it another
 * 8s. Short enough that a start hook which died mid-call cannot suppress
 * registration for the rest of the conversation.
 */
export const RESERVATION_PENDING_MS = 60_000;

/**
 * A reservation whose owner is still expected to finish registering it.
 *
 * session-start writes `pendingRegistration` before calling `session/start` and
 * clears it once the id is settled. A hook that adopts the row meanwhile must
 * not register it too — that is a second row for one conversation. The age
 * bound is what keeps the flag from becoming permanent when the start hook
 * never returns: past it, the row is a normal local session and every prompt
 * is a retry point again.
 */
export function isPendingReservation(state: unknown, now: number = Date.now()): boolean {
  const s = state as { pendingRegistration?: boolean; startedAt?: string } | null;
  if (!s?.pendingRegistration) return false;
  const started = s.startedAt ? new Date(s.startedAt).getTime() : NaN;
  // No usable timestamp: treat as pending rather than racing a live start.
  if (!Number.isFinite(started)) return true;
  return now - started < RESERVATION_PENDING_MS;
}

/**
 * Of two ids for the SAME session, the one the server has actually registered.
 *
 * session-start publishes a provisional `local-` id before calling
 * `session/start`, so a concurrent hook can find the session instead of minting
 * a second one. That hook may then register it first. When session-start's own
 * call fails and falls back to local, saving its placeholder would demote a
 * live session back to local and strand every prompt already filed against the
 * real row — the "Session not found" in the prod trace.
 *
 * Registered always wins. Between two provisional ids the incumbent wins, so a
 * re-fired start cannot renumber a session a hook is already writing to.
 */
export function preferRegisteredSessionId(
  ours: string,
  onDisk: string | undefined | null,
): string {
  if (!onDisk || onDisk === ours) return ours;
  // Only ever defer to the file when IT holds the registered id.
  if (isProvisionalSessionId(ours) && !isProvisionalSessionId(onDisk)) return onDisk;
  return ours;
}

/**
 * The state file at `tag`, whatever conversation id it carries.
 *
 * `loadSessionState` refuses a row whose `claudeSessionId` is empty — and a
 * Cursor row's IS empty (Cursor is not a stable-id agent; its conversation
 * lives on `agentSessionId`). So every reservation-race check that went
 * through `loadSessionState` was blind for Cursor: session-start could not
 * see that a concurrent hook had registered its reservation, and could not
 * see a live file at its own tag before reserving over it. Reads the same
 * two locations, gated on `sessionId` alone.
 */
export function readStateAtTag(cwd?: string, sessionTag?: string): SessionState | null {
  const tryRead = (p: string): SessionState | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
      return parsed as SessionState;
    } catch {
      return null;
    }
  };
  const statePath = getStatePath(cwd, sessionTag);
  const primary = tryRead(statePath);
  if (primary) return primary;
  const fb = getGlobalFallbackStatePath(cwd, sessionTag);
  if (fb !== statePath) return tryRead(fb);
  return null;
}

/**
 * A hook holding a session-start reservation in memory re-reads the file
 * before writing it, and takes the id session-start registered meanwhile.
 *
 * The reservation is adoptable on purpose: a prompt that lands while
 * `session/start` is in flight finds the provisional row instead of minting
 * its own. But the adopter then keeps writing the copy it READ — provisional
 * id, `pendingRegistration` still set — and each of those writes lands over
 * session-start's registered row. Prod 2026-09-09, one Cursor chat: the
 * prompt hook read the reservation 150ms before session-start saved
 * `5431ff0f`, restamped its copy onto the worktree, and wrote `local-…` back
 * over the registered id. Its migration then minted `e24477e2` for the same
 * chat; the first row kept a heartbeat that fed it the second row's turns.
 *
 * Registered always wins (preferRegisteredSessionId). A settled reservation
 * — registered, or local after a failed call — also clears the flag, so a
 * stale in-memory copy cannot re-arm it. Returns the swap when one happened.
 */
export function adoptRegisteredReservation(
  state: SessionState,
  cwd?: string,
  sessionTag?: string,
): { from: string; to: string } | null {
  const pending = state as SessionState & { pendingRegistration?: boolean };
  if (!pending.pendingRegistration || !isProvisionalSessionId(state.sessionId)) return null;
  const onDisk = readStateAtTag(cwd, sessionTag || state.sessionTag) as (SessionState & { pendingRegistration?: boolean }) | null;
  if (!onDisk) return null;
  if (!onDisk.pendingRegistration) delete pending.pendingRegistration;
  const promoted = preferRegisteredSessionId(state.sessionId, onDisk.sessionId);
  if (promoted === state.sessionId) return null;
  const from = state.sessionId;
  state.sessionId = promoted;
  // The registered row on disk is session-start's full row: the enforcement
  // rules and policies the server handed back, the system prompt, the
  // previous-session link, the baseline it captured. The copy this hook holds
  // is the bare reservation plus its own work. Ours wins on everything it
  // set (its prompt, the identity it restamped); what it never had comes from
  // the row it is about to replace.
  const ours = state as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(onDisk as unknown as Record<string, unknown>)) {
    if (k === 'pendingRegistration' || k === 'sessionId') continue;
    if (ours[k] === undefined) ours[k] = v;
  }
  // The reservation's mirror is keyed by the provisional id; the save that
  // follows lands under the registered one, so the placeholder would stay
  // listed as a live local session.
  dropSessionMirror(from);
  return { from, to: promoted };
}

/**
 * RUNNING sessions from the durable ~/.origin/sessions mirror whose work tree
 * is `tree`.
 *
 * `.git` is not a safe home for session state: it belongs to the very agents
 * being captured, and they delete it. Prod a5c2570c — an agent decided the
 * worktree's git config was broken (it was not), ran `git init` in the work
 * tree root, and the fresh `.git` took the session's state file with it. The
 * commit that followed fired every hook correctly and then found no session to
 * attach to, so it was ingested as a new repo row and the turn showed nothing.
 *
 * The mirror survives that, because it lives outside the repo. This is the
 * last-resort lookup for a git hook that found nothing in `.git`.
 *
 * Deliberately strict about ownership: the mirror is global, so matching must
 * be on THIS tree (repoPath or the last cwd), never "any running session".
 */
export function listMirroredSessionsForTree(tree: string): SessionState[] {
  if (!tree) return [];
  const dir = path.join(os.homedir(), '.origin', 'sessions');
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: SessionState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let st: SessionState | null = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8')); } catch { continue; }
    if (!st || !st.sessionId) continue;
    if ((st as any).status === 'ENDED' || st.endedAt) continue;
    // samePath, never raw identity — see paths.ts and the comparison guard.
    const claims = [st.repoPath, (st as any).lastCwd, (st as any).canonicalRepoPath]
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (!claims.some((c) => samePath(c, tree))) continue;
    // Attach the file we loaded from, exactly as listActiveSessions does.
    // isSessionAlive's FIRST signal is the `.git` state file's mtime — which is
    // precisely what the wipe destroyed, so without `__statePath` the fallback
    // recovers the session and the zombie filter discards it a line later. The
    // mirror's own mtime is the freshest liveness signal that survives.
    (st as unknown as { __statePath?: string }).__statePath = path.join(dir, entry);
    out.push(st);
  }
  return out;
}

export function loadSessionState(cwd?: string, sessionTag?: string): SessionState | null {
  const statePath = getStatePath(cwd, sessionTag);
  const tryRead = (p: string): SessionState | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.sessionId || !parsed.claudeSessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const primary = tryRead(statePath);
  if (primary) return primary;
  // Sandbox couldn't write .git → the state landed in the global fallback.
  const fb = getGlobalFallbackStatePath(cwd, sessionTag);
  if (fb !== statePath) return tryRead(fb);
  return null;
}

/** An (orphan → rewrite) pair, as the rescue or git's post-rewrite hook records it. */
export type RewritePair = { from: string; to: string };

/**
 * The sha a commit was ultimately rewritten to, following the chain of pairs.
 *
 * A rewrite is rarely one hop. Session 8a06aaf6 (2026-09-09) took one PR
 * through a conflicting rebase, two amends, a second rebase and GitHub's
 * squash: five pairs, one survivor. Every consumer that applied a pair once
 * — the sha list, the turn attestation, the server's badge — stopped one
 * hop short and kept an intermediate copy alive. Cycle-safe; a sha nothing
 * rewrote is its own answer. Prefix-tolerant in both directions, because
 * recorded shas may be short.
 */
export function finalRewriteOf(sha: string, pairs: ReadonlyArray<RewritePair> | null | undefined): string {
  if (!sha || !Array.isArray(pairs) || pairs.length === 0) return sha;
  const same = (a: string, b: string) => {
    const x = a.toLowerCase(); const y = b.toLowerCase();
    return x === y || x.startsWith(y) || y.startsWith(x);
  };
  let cur = sha;
  const seen = new Set<string>([cur.toLowerCase()]);
  for (let hops = 0; hops < 32; hops++) {
    const next = pairs.find((p) => p?.from && p?.to && same(p.from, cur) && !same(p.to, cur))?.to;
    if (!next || seen.has(next.toLowerCase())) return cur;
    seen.add(next.toLowerCase());
    cur = next;
  }
  return cur;
}

/**
 * Record rewrite pairs on the session and move every local reading of an
 * orphan onto its final survivor: the sha list (deduped) and the turn
 * attestation (`commitTurns`, keeping the earliest observation per survivor).
 * `rewrittenCommits` keeps every pair ever seen — the server follows the
 * chain itself — but never a self-map or a duplicate `from`.
 *
 * Returns true when anything changed. Does not save.
 */
export function applyRewritePairsToState(
  state: Pick<SessionState, 'sessionCommitShas' | 'rewrittenCommits' | 'commitTurns'>,
  incoming: ReadonlyArray<RewritePair>,
): boolean {
  const pairs: RewritePair[] = Array.isArray(state.rewrittenCommits) ? [...state.rewrittenCommits] : [];
  let changed = false;
  for (const p of incoming) {
    if (!p?.from || !p?.to || p.from.toLowerCase() === p.to.toLowerCase()) continue;
    const at = pairs.findIndex((q) => q.from.toLowerCase() === p.from.toLowerCase());
    if (at >= 0) {
      // The same sha rewritten again — after a reset back to it, or an amend
      // that reproduced a byte-identical commit. git's LATEST word for a sha
      // is the truth; keeping the first left a stale hop (and, with the
      // identical-commit case, a cycle) that stopped every chain short.
      if (pairs[at].to.toLowerCase() === p.to.toLowerCase()) continue;
      pairs[at] = { from: p.from, to: p.to };
    } else {
      pairs.push({ from: p.from, to: p.to });
    }
    changed = true;
  }
  if (!changed) return false;
  state.rewrittenCommits = pairs;
  if (Array.isArray(state.sessionCommitShas)) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of state.sessionCommitShas) {
      const f = finalRewriteOf(s, pairs);
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(f);
    }
    state.sessionCommitShas = out;
  }
  if (Array.isArray(state.commitTurns) && state.commitTurns.length > 0) {
    type CommitTurn = NonNullable<SessionState['commitTurns']>[number];
    const bySha = new Map<string, CommitTurn>();
    for (const ct of state.commitTurns) {
      if (!ct?.sha) continue;
      const sha = finalRewriteOf(ct.sha, pairs);
      const prev = bySha.get(sha.toLowerCase());
      if (!prev || (ct.at && prev.at && ct.at < prev.at)) bySha.set(sha.toLowerCase(), { ...ct, sha });
    }
    state.commitTurns = [...bySha.values()];
  }
  return true;
}

/**
 * The most recent state file — ENDED or not — that belongs to this
 * conversation, when the tag-addressed lookup found nothing.
 *
 * A re-attach after an idle end rebuilds `state` from the prior file under
 * the conversation-derived tag. That is the wrong address for a session the
 * desktop app started on the primary checkout and Origin then adopted into a
 * worktree: its file was minted under the HANDSHAKE's tag and only its
 * `claudeSessionId` says which conversation it is. Session 8a06aaf6
 * (2026-09-09): ended under tag 2e5b67ac after an 11h gap, the next prompt
 * looked under tag 46012a70, found nothing, and started from scratch — the
 * recorded commits, the rewrite pairs, the turn ids and the turn counter all
 * gone, the header rebuilt from a baseline that postdated the work.
 *
 * Matches by the server's session id first (the API deduped the re-attach to
 * it, so it is the strongest key), then by conversation id. Newest file wins.
 * Both places a state can land are read: the git common dir and the global
 * fallback for this cwd.
 */
export function findPriorStateForConversation(
  cwd: string | undefined,
  conversationIds: ReadonlyArray<string | undefined | null>,
  sessionId?: string | null,
): SessionState | null {
  const ids = new Set(conversationIds.filter((v): v is string => typeof v === 'string' && v.length > 0));
  const wantSession = typeof sessionId === 'string' && sessionId.length > 0 && !sessionId.startsWith('local-') ? sessionId : null;
  if (ids.size === 0 && !wantSession) return null;
  const dirs = new Set<string>();
  const primary = getStatePath(cwd, 'probe');
  dirs.add(path.dirname(primary));
  const fallback = getGlobalFallbackStatePath(cwd, 'probe');
  const cwdHash = path.basename(fallback).split('-')[0];
  dirs.add(path.dirname(fallback));
  let best: { state: SessionState; rank: number; at: number } | null = null;
  for (const dir of dirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const inGitDir = entry.startsWith('origin-session-');
      const inFallback = entry.startsWith(`${cwdHash}-`);
      if (!inGitDir && !inFallback) continue;
      let st: SessionState | null = null;
      try { st = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf-8')); } catch { continue; }
      if (!st || typeof st !== 'object' || !st.sessionId) continue;
      const convo = [st.claudeSessionId, (st as { agentSessionId?: string }).agentSessionId];
      const bySession = !!wantSession && st.sessionId === wantSession;
      const byConversation = convo.some((c) => typeof c === 'string' && ids.has(c));
      if (!bySession && !byConversation) continue;
      const rank = bySession ? 2 : 1;
      const stamp = (st as { lastStopAt?: string; endedAt?: string }).lastStopAt
        || (st as { endedAt?: string }).endedAt || st.startedAt || '';
      const at = Date.parse(stamp) || 0;
      if (!best || rank > best.rank || (rank === best.rank && at > best.at)) best = { state: st, rank, at };
    }
  }
  return best?.state ?? null;
}

export function clearSessionState(cwd?: string, sessionTag?: string): void {
  const statePath = getStatePath(cwd, sessionTag);
  const fbPath = getGlobalFallbackStatePath(cwd, sessionTag);
  // The active state lives in .git normally, or in the global fallback when a
  // sandbox blocked the .git write — read from wherever it actually landed.
  let raw: string | null = null;
  for (const p of (fbPath !== statePath ? [statePath, fbPath] : [statePath])) {
    try { raw = fs.readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
  }
  try {
    if (raw) {
      // Instead of deleting, mark as ended and archive to ~/.origin/sessions/
      const state = JSON.parse(raw);
      state.status = 'ENDED';
      state.endedAt = new Date().toISOString();

      // Archive to ~/.origin/sessions/ so origin sessions --all can find it
      const archiveDir = path.join(os.homedir(), '.origin', 'sessions');
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      const archivePath = path.join(archiveDir, `${state.sessionId.slice(0, 12)}.json`);
      const tmpArchivePath = archivePath + '.tmp.' + process.pid;
      fs.writeFileSync(tmpArchivePath, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmpArchivePath, archivePath);
    }
  } catch { /* corrupt state — fall through to plain delete */ }
  // Remove the active state file from both possible locations.
  try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  if (fbPath !== statePath) { try { fs.unlinkSync(fbPath); } catch { /* ignore */ } }
}

// ─── Concurrent Session Support ──────────────────────────────────────────

// Idle cutoff for treating a non-ENDED session as actually-alive. A session
// with no fresh git-state-file write, no live heartbeat, and no recent state
// file touch within this window is a zombie (the agent process died without a
// clean end) and must not be considered for commit attribution etc.
const SESSION_STALE_MS = 3 * 60 * 60 * 1000; // 3 hours — matches findSessionByClaudeId / listAllActiveSessions

/**
 * Is this session's heartbeat daemon both RUNNING and still pinging?
 *
 * A bare live PID is not proof of health: a heartbeat whose ping loop hung
 * (unresolved await, wedged fs/network) stays alive as a process but stops
 * pinging and stops writing state — the server then marks the session
 * COMPLETED via its no-ping sweep, while a naive pid check keeps reporting it
 * "alive" forever (observed: a bake-off session pinned active 16h after the
 * server ended it). The heartbeat re-touches its pid file every tick, so
 * require that mtime to be within the stale window: a healthy daemon stays
 * fresh, a hung one goes stale and reads as dead. (Older heartbeats predating
 * the per-tick touch self-heal once they restart onto the new binary; a
 * connected session's git-state bump covers them meanwhile.)
 *
 * Split out of isSessionAlive so a caller about to do something destructive
 * can ask for this signal alone — it is the only one backed by a live process
 * rather than a file mtime, and `origin sessions clean` refuses to end a
 * session that has it, at any age.
 */
export function hasHealthyHeartbeat(sessionId: string): boolean {
  try {
    const pidFile = getHeartbeatPidFile(sessionId);
    if (!fs.existsSync(pidFile)) return false;
    const fresh = Date.now() - fs.statSync(pidFile).mtimeMs < SESSION_STALE_MS;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid > 0 && fresh) { process.kill(pid, 0); return true; }
  } catch { /* process dead */ }
  return false;
}

/**
 * Is this session genuinely still alive? An ENDED session is dead. Otherwise it
 * counts as alive only if there's a fresh signal: the repo's git-state file was
 * written recently, its heartbeat daemon is running AND still pinging, or the
 * state file the session was loaded from was touched recently. Zombie sessions
 * (process died without a clean end — common for Cursor / stale-file agents)
 * fail all three.
 *
 * `statePath` is the file the state was read from (attached by listActiveSessions
 * as `__statePath`); pass it for the freshest signal.
 */
export function isSessionAlive(state: SessionState, statePath?: string): boolean {
  if (!state) return false;
  if ((state as any).status === 'ENDED' || state.endedAt) return false;

  // 1. The repo's live git-state file was updated within the window.
  // gitCommonDirFilePath: state.repoPath is the WORKING root, which for a
  // linked worktree has a `.git` FILE — the state json lives in the COMMON
  // git dir, not at <repoPath>/.git/.
  if (state.repoPath && state.sessionTag) {
    try {
      const gitStateFile = gitCommonDirFilePath(state.repoPath, `origin-session-${state.sessionTag}.json`);
      if (Date.now() - fs.statSync(gitStateFile).mtimeMs < SESSION_STALE_MS) return true;
    } catch { /* file gone */ }
  }
  // 2. The heartbeat daemon is alive AND still pinging — see hasHealthyHeartbeat
  // for why a bare live PID does not count.
  if (hasHealthyHeartbeat(state.sessionId)) return true;
  // 3. The state file we loaded from was touched recently.
  const p = statePath || (state as any).__statePath;
  if (p) {
    try { if (Date.now() - fs.statSync(p).mtimeMs < SESSION_STALE_MS) return true; } catch { /* gone */ }
  }
  return false;
}

/**
 * Permanently close a session locally: mark it ENDED and persist to the file it
 * was loaded from (plus the ~/.origin/sessions global mirror). Used to
 * auto-close zombie sessions so they don't linger "RUNNING" and keep getting
 * picked for commit attribution. Returns true if it changed anything.
 */
export function markSessionEnded(state: SessionState): boolean {
  if (!state || (state as any).status === 'ENDED') return false;
  (state as any).status = 'ENDED';
  state.endedAt = state.endedAt || new Date().toISOString();
  // The return value is the caller's ONLY signal. This used to swallow both
  // writes and answer true regardless, so a session whose file could not be
  // written was reported closed while its file still said RUNNING — and kept
  // being picked for commit attribution, the exact zombie this exists to end.
  const writeAtomic = (p: string): boolean => {
    try {
      const tmp = `${p}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, p);
      return true;
    } catch (err: unknown) {
      debugLog('session-state', 'markSessionEnded: could not persist ENDED', {
        path: p, message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
  const loadedFrom = (state as any).__statePath as string | undefined;
  // Without a known file there is nothing durable to change; say so.
  let durable = loadedFrom ? writeAtomic(loadedFrom) : false;
  // Keep the global mirror in sync (the file may have been read from .git).
  try {
    if (state.repoPath && state.sessionTag) {
      const cwdHash = crypto.createHash('md5').update(state.repoPath).digest('hex').slice(0, 12);
      const mirror = path.join(os.homedir(), '.origin', 'sessions', `${cwdHash}-${state.sessionTag}.json`);
      if (mirror !== loadedFrom && fs.existsSync(mirror)) {
        // The mirror counts when it is the only copy we could reach.
        if (writeAtomic(mirror) && !loadedFrom) durable = true;
      }
    }
  } catch (err: unknown) {
    debugLog('session-state', 'markSessionEnded: mirror lookup failed', { message: err instanceof Error ? err.message : String(err) });
  }
  return durable;
}

/**
 * List all active sessions in a git repo (or cwd).
 * Scans for all origin-session*.json files.
 */
export function listActiveSessions(cwd?: string): SessionState[] {
  const sessions: SessionState[] = [];
  // A session whose own state file says ENDED is not active. This function
  // did NO filtering at all, so `origin status` listed sessions that had
  // already ended — user-reported: two `.openclaw/workspace` rows showing
  // "Active" at 291h/601h with 0 prompts, both marked status:ENDED on disk,
  // while genuinely live sessions elsewhere were invisible.
  const isEnded = (st: any) => String(st?.status || '').toUpperCase() === 'ENDED';

  // Check git dir (COMMON dir — matches getStatePath, so a lookup from a
  // worktree and one from the main checkout read the same directory)
  const gitDir = getGitCommonDir(cwd) || getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try {
            const fullPath = path.join(resolvedGitDir, entry);
            const state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            if (!state || typeof state !== 'object' || !state.sessionId) continue;
            // Extract sessionTag from filename: origin-session-TAG.json or origin-session.json
            if (!state.sessionTag) {
              const tagMatch = entry.match(/^origin-session-(.+)\.json$/);
              if (tagMatch) state.sessionTag = tagMatch[1];
            }
            if (isEnded(state)) continue;
            Object.defineProperty(state, '__statePath', { value: fullPath, enumerable: false });
            sessions.push(state);
          } catch { /* skip corrupt files */ }
        }
      }
    } catch { /* ignore */ }
    return sessions;
  }

  // Check fallback dir
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const effectiveCwd = cwd || process.cwd();
    const cwdHash = crypto.createHash('md5').update(effectiveCwd).digest('hex').slice(0, 12);
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.startsWith(cwdHash) && entry.endsWith('.json')) {
        try {
          const fullPath = path.join(sessionsDir, entry);
          const state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          if (isEnded(state)) continue;
          Object.defineProperty(state, '__statePath', { value: fullPath, enumerable: false });
          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * When did this session last show ANY sign of life?
 *
 * The companion to isSessionAlive, which answers only yes/no against a fixed
 * 3h window. A caller deciding whether to do something destructive needs the
 * magnitude too — "silent for 19 days" and "silent for 4 hours" are both
 * `false` from isSessionAlive and want very different treatment.
 *
 * Reads the same three signals in the same order, and returns the most recent
 * of them. null means no signal exists at all, which is NOT the same as "long
 * dead": a hook-only agent that never ran a heartbeat, in a repo whose state
 * file has been cleaned, looks exactly like this. Callers must decide for
 * themselves whether absence of evidence justifies acting.
 */
export function sessionLastSignMs(state: SessionState, statePath?: string): number | null {
  let last: number | null = null;
  const note = (ms: number) => { if (last === null || ms > last) last = ms; };

  if (state?.repoPath && state?.sessionTag) {
    try {
      const gitStateFile = gitCommonDirFilePath(state.repoPath, `origin-session-${state.sessionTag}.json`);
      note(fs.statSync(gitStateFile).mtimeMs);
    } catch { /* file gone */ }
  }
  if (state?.sessionId) {
    try {
      note(fs.statSync(getHeartbeatPidFile(state.sessionId)).mtimeMs);
    } catch { /* no heartbeat */ }
  }
  const p = statePath || (state as any)?.__statePath;
  if (p) {
    try { note(fs.statSync(p).mtimeMs); } catch { /* gone */ }
  }
  return last;
}

/**
 * List sessions from ALL repos (for --all/--global flag).
 * Scans ~/.origin/sessions/ for both active and archived sessions.
 */
export function listAllActiveSessions(): SessionState[] {
  const sessions: SessionState[] = [];
  const seen = new Set<string>();

  // Scan ~/.origin/sessions/ — ALL files (active + archived)
  const sessionsDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (entry.endsWith('.json')) {
        try {
          const filePath = path.join(sessionsDir, entry);
          const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (!state || typeof state !== 'object' || !state.sessionId) continue;
          if (seen.has(state.sessionId)) continue;
          seen.add(state.sessionId);

          // Auto-expire RUNNING sessions that are stale:
          // If status is not ENDED, check if the session is actually still alive
          if (state.status !== 'ENDED') {
            // One liveness rule for the whole CLI. This was a second copy of
            // isSessionAlive's three checks, inline and subtly weaker: it
            // lacked the pid-freshness guard, so a HUNG heartbeat read as
            // alive here and dead there.
            if (!isSessionAlive(state, filePath)) {
              state.status = 'ENDED';
              state.endedAt = state.endedAt || new Date().toISOString();
              // Persist the correction
              try {
                const tmpFilePath = filePath + '.tmp.' + process.pid;
                fs.writeFileSync(tmpFilePath, JSON.stringify(state), { mode: 0o600 });
                fs.renameSync(tmpFilePath, filePath);
              } catch { /* best effort */ }
            }
          }

          sessions.push(state);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  return sessions;
}

/**
 * Find a session by its Claude session ID.
 *
 * Searches both the local repo's state files and the global mirror
 * (`~/.origin/sessions/`), which catches multi-repo workspaces where a nested
 * `.git/` dir belonged to a different hookCwd than session-start saw. Stale
 * `.git/origin-session-*.json` files whose mtime is older than FRESH_MS are
 * skipped so a previous day's crashed session can't hijack a resumed Claude
 * session that reuses the same claudeSessionId.
 */
export function findSessionByClaudeId(claudeSessionId: string, cwd?: string): SessionState | null {
  const FRESH_MS = 3 * 60 * 60 * 1000; // 3 hours — matches listAllActiveSessions staleness
  const candidates: Array<{ state: SessionState; mtime: number }> = [];

  const pushIfFresh = (filePath: string, state: unknown) => {
    const s = state as SessionState | null;
    if (!s || s.claudeSessionId !== claudeSessionId) return;
    if (s.status === 'ENDED') return;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    if (mtime && Date.now() - mtime > FRESH_MS) return;
    candidates.push({ state: s, mtime });
  };

  // Local .git / hashed fallback — both default and tagged files
  const defaultPath = getStatePath(cwd);
  try { pushIfFresh(defaultPath, JSON.parse(fs.readFileSync(defaultPath, 'utf-8'))); } catch { /* ignore */ }
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      for (const entry of fs.readdirSync(resolvedGitDir)) {
        if (!entry.startsWith('origin-session') || !entry.endsWith('.json')) continue;
        const p = path.join(resolvedGitDir, entry);
        try { pushIfFresh(p, JSON.parse(fs.readFileSync(p, 'utf-8'))); } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // Global mirror — catches nested-repo / multi-repo cases where the active
  // session was saved under a different cwd's git dir.
  const globalDir = path.join(os.homedir(), '.origin', 'sessions');
  try {
    for (const entry of fs.readdirSync(globalDir)) {
      if (!entry.endsWith('.json')) continue;
      const p = path.join(globalDir, entry);
      try { pushIfFresh(p, JSON.parse(fs.readFileSync(p, 'utf-8'))); } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  if (candidates.length === 0) return null;
  // Prefer the most recently-written candidate — that's the live session.
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].state;
}

/**
 * Clear all session state files (e.g., after session-end).
 */
// ─── Heartbeat Daemon ───────────────────────────────────────────────────────

function getHeartbeatPidFile(sessionId: string): string {
  const dir = path.join(os.homedir(), '.origin', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${sessionId}.pid`);
}

/**
 * Walk up the process tree to find an ancestor whose command matches a pattern.
 * Returns the PID of the matching ancestor, or 0 if not found.
 * Used to find the actual agent process (e.g. Codex, Gemini) since hooks are
 * spawned via shell wrappers that die immediately after the hook exits.
 */
// Heuristic to recognize Origin's own hook subprocesses so we DON'T
// pick them as the "agent" PID. The command line of a hook invocation
// is something like
//   node /path/to/origin/dist/index.js hooks claude-code stop
// which contains "claude-code" and would happily satisfy a
// /claude/i ancestor search — but the hook subprocess dies seconds
// after it returns. Heartbeat would then think Claude exited and
// end the session ~30s into the user's first real prompt.
//
// Recognized markers (in priority order):
//   - "origin hooks" / "origin-cli" command path → almost certainly
//     us. The CLI's binary directory tends to contain "origin" too.
//   - "origin-cli" anywhere in the argv (npm install paths, dev
//     symlinks).
// Conservative — we'd rather walk past one of our own subprocesses
// and find the real agent than match the wrong PID.
const ORIGIN_HOOK_MARKER = /origin[-/](?:cli|hooks?)|origin\s+hooks?\b|@origin\/cli/i;

function findAncestorPid(pattern: RegExp, maxDepth = 10): number {
  try {
    let pid = process.ppid || 0;
    for (let i = 0; i < maxDepth && pid > 1; i++) {
      // Parent + command line for this PID, cross-platform (ps on Unix,
      // Win32_Process CIM on Windows) — see utils/process-detect.ts.
      const info = processInfo(pid);
      if (!info) break;
      const commandPart = info.command;
      // Skip Origin's own hook subprocesses — they match every
      // agent pattern via their argv but die after the hook
      // returns. Walking past them gets us to the real agent.
      const isOriginSelf = ORIGIN_HOOK_MARKER.test(commandPart);
      if (!isOriginSelf && pattern.test(commandPart)) return pid;
      // Move to parent
      const ppid = info.ppid;
      if (isNaN(ppid) || ppid <= 1 || ppid === pid) break;
      pid = ppid;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Spawn a detached background process that pings the API every 30s.
 * Keeps the session marked as RUNNING even when idle between prompts.
 * Passes the parent PID and session state file path so the daemon can
 * self-terminate when the agent process dies or the session ends.
 */
export function startHeartbeat(sessionId: string, apiUrl: string, apiKey: string, stateFile?: string, agentSlug?: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);

  // One daemon per session. A LIVE daemon for this exact id is already doing
  // the job, so respawning gains nothing — and costs the session.
  //
  // The kill below is a SIGTERM, and the daemon's signal handler ends the
  // session on the way out. When two hooks mint the same session concurrently
  // they both land here: the second SIGTERMs the first, that daemon calls
  // /session/end, and the server's empty-session cleanup HARD-DELETES a row
  // whose first PromptChange hasn't been sent yet. Every later write then 404s
  // `Session not found` until handleStop re-mints a different id.
  //
  // Copilot makes this routine rather than rare: it fires `userPromptSubmitted`
  // BEFORE `sessionStart`, so user-prompt-submit's auto-create and
  // handleSessionStart both run for a chat's first prompt. Prod 2026-08-25,
  // session b567ee4f: created 13:27:35.707, second startHeartbeat 13:27:36.343,
  // 404 at 13:27:36.466, re-minted as 8b25cb05 seven seconds later.
  //
  // Only skips a daemon that is actually ALIVE — a dead one still falls through
  // to the respawn below, which is what the "restarted (was dead)" callers want.
  if (isHeartbeatAlive(sessionId)) return;

  // Kill any existing heartbeat for this session
  stopHeartbeat(sessionId);

  try {
    // Resolve the heartbeat script path (sibling to this file in dist/)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const heartbeatScript = path.join(__dirname, 'heartbeat.js');

    if (!fs.existsSync(heartbeatScript)) {
      // Fallback: script not found (dev mode or missing build)
      return;
    }

    // Agent → liveness-detection strategy.
    //
    // LONG_RUNNING_AGENTS: process.ppid IS the agent (heartbeat watches
    //   that single PID). Only works when the agent runs the hook in its
    //   own process and stays alive between hook fires.
    // STALE_FILE_ONLY_AGENTS: parent PID is unreliable, so the heartbeat
    //   relies on state-file mtime instead. Used for IDE/Electron agents
    //   whose process tree is full of short-lived helpers.
    // AGENT_PROCESS_PATTERNS: walk up the tree and match by command
    //   substring. Last-resort — fragile against OS wrappers.
    //
    // Why Claude Code is now stale-file-only:
    // On macOS the Claude Desktop app launches the real `claude` CLI via
    // `/Applications/Claude.app/Contents/Helpers/disclaimer`, which
    // exec-launches the binary and exits shortly after. When the hook
    // fires from a descendant of `claude`, walking up matches the
    // `disclaimer` wrapper first (its argv contains the absolute path
    // `.../claude.app/Contents/MacOS/claude`, satisfying /claude/i). The
    // wrapper then dies, the heartbeat sees the captured PID gone, and
    // ends the session at ~19 minutes while the Claude tab is still
    // open. The same trap exists for Squirrel's `ShipIt` auto-updater,
    // which also matches /claude/i but is transient. Per-OS wrapper
    // carve-outs are an endless game of whack-a-mole; the only durable
    // signal we have is "did any Claude hook fire recently" — that
    // updates the state file via saveSessionState on every
    // UserPromptSubmit / PreToolUse / Stop / etc., so a fresh file mtime
    // means Claude is alive. Staleness threshold is raised to 90 min in
    // heartbeat.ts so a long read of a single response doesn't false-end.
    const LONG_RUNNING_AGENTS = ['devin'];
    // Copilot: the desktop app's process tree is the same shape as Cursor's —
    // short-lived helpers around a GUI host — so the ancestor walk never finds a
    // durable "copilot" process to watch. It also cost real time on the BLOCKING
    // prompt-submit path: findAncestorPid climbs up to 10 levels, each level a
    // Win32_Process WMI query (~100-250ms on Windows), and for copilot it ran
    // TWICE because the pattern lookup missed and then the bash/zsh/sh fallback
    // ran too — up to 20 WMI queries, measured as 0.8-2.6s of the hook. Copilot
    // fires session-start/stop/session-end reliably, so the state-file mtime
    // signal (which is what stale-file-only uses) is the better liveness source
    // anyway.
    //
    // Cursor: Electron helpers die immediately, can't track parent PID.
    // Claude Code: macOS wrapper trap (see above). Treat both as
    // stale-file-only.
    const STALE_FILE_ONLY_AGENTS = ['cursor', 'claude-code', 'copilot'];
    const AGENT_PROCESS_PATTERNS: Record<string, RegExp> = {
      'gemini': /gemini/i,
      'aider': /aider/i,
      'codex': /codex/i,
    };

    let parentPid: number;
    if (agentSlug && LONG_RUNNING_AGENTS.includes(agentSlug)) {
      // For Claude Code / Windsurf, process.ppid is the agent itself
      parentPid = process.ppid || 0;
      // Verify the parent is actually alive
      if (parentPid > 0) {
        try { process.kill(parentPid, 0); } catch { parentPid = 0; }
      }
    } else if (agentSlug && STALE_FILE_ONLY_AGENTS.includes(agentSlug)) {
      // Cursor: can't reliably detect parent — use stale file check only
      parentPid = 0;
    } else {
      // For all other agents, walk the process tree to find the agent process.
      // If we find it, heartbeat monitors that PID. If not, fall back to stale file check.
      const pattern = agentSlug ? AGENT_PROCESS_PATTERNS[agentSlug] : undefined;
      parentPid = pattern ? findAncestorPid(pattern) : 0;
      // If pattern search failed, try to find the shell/terminal as a fallback
      // so the heartbeat dies when the terminal is closed
      if (parentPid <= 0) {
        parentPid = findAncestorPid(/bash|zsh|fish|sh$/i) || 0;
      }
    }

    const child = spawn(process.execPath, [heartbeatScript, sessionId, apiUrl, '', pidFile, String(parentPid), stateFile || ''], {
      detached: true,
      stdio: 'ignore',
      // Windows: `detached` maps to DETACHED_PROCESS, so the child does NOT
      // inherit the parent's console — node.exe (a console app) then allocates
      // its OWN, which appears as a terminal window. The heartbeat lives for
      // hours, so that window STAYS OPEN, and a new one appears on every
      // session-start. Codex Desktop fires session-start constantly, so the
      // user ended up with an endless pile of console windows. CREATE_NO_WINDOW
      // (windowsHide) suppresses it. No-op on macOS/Linux.
      windowsHide: true,
      env: { ...process.env, ORIGIN_HEARTBEAT_API_KEY: apiKey },
    });
    child.unref();
  } catch {
    // Non-fatal — session tracking still works, just no keepalive
  }
}

/**
 * Kill the heartbeat daemon for a session.
 */
export function stopHeartbeat(sessionId: string): void {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Ignore
  }
}

/**
 * Check if the heartbeat daemon is still alive for a session.
 */
export function isHeartbeatAlive(sessionId: string): boolean {
  const pidFile = getHeartbeatPidFile(sessionId);
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (pid <= 0) return false;
    // signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a retired (ENDED) state file is kept before being pruned.
 *
 * The heartbeat marks state files ENDED rather than deleting them, so a
 * conversation resumed after an idle gap can pick its prompt numbering back up
 * (see the retirement comment in heartbeat.ts). They still have to go
 * eventually — this is the delay the delete never had.
 *
 * A week comfortably covers "left it overnight / over the weekend and came
 * back", which is the whole point of keeping them.
 */
export const RETIRED_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete ENDED state files older than RETIRED_STATE_TTL_MS.
 *
 * Only touches files that are BOTH marked ENDED and past the TTL: a live
 * session's file is never a candidate, whatever its mtime says, and a recently
 * retired one stays readable for a resume.
 */
export function pruneRetiredStateFiles(dir: string, now = Date.now()): number {
  let pruned = 0;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.startsWith('origin-session') || !entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (String(data?.status || '').toUpperCase() !== 'ENDED') continue;
      const age = now - fs.statSync(filePath).mtimeMs;
      if (age <= RETIRED_STATE_TTL_MS) continue;
      fs.unlinkSync(filePath);
      pruned++;
    } catch { /* corrupt or vanished — leave it */ }
  }
  return pruned;
}

export function clearAllSessionStates(cwd?: string): void {
  const gitDir = getGitDir(cwd);
  if (gitDir) {
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd || process.cwd(), gitDir);
    try {
      const entries = fs.readdirSync(resolvedGitDir);
      for (const entry of entries) {
        if (entry.startsWith('origin-session') && entry.endsWith('.json')) {
          try { fs.unlinkSync(path.join(resolvedGitDir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

// ─── Per-turn baselines ────────────────────────────────────────────────────
// `promptShadows[i]` means "the working tree at the START of prompt i". It is
// the only per-turn baseline we keep; `prePromptSha` is a single rolling value
// that describes the most recent turn only.
//
// That distinction is invisible until something processes SEVERAL turns in one
// pass. Stop does exactly that, so it had no per-turn baseline to look up and
// fell back to session-start — and a file two turns both touched then counted
// the earlier turn's lines a second time against the later turn. Measured on
// prod session fc4eb13c re-captured from its transcript: src/index.js came out
// +75/-60 against git's +74/-59, the extra line being the one turn 2 changed
// before turn 3 rewrote the file.
//
// Until now only the heartbeat daemon (Codex/Gemini) populated promptShadows,
// so it was empty on every hook-driven session on disk.

interface ShadowBearingState {
  promptShadows?: Array<{ promptIndex: number; shadowSha: string; capturedAt: string }>;
  /**
   * Prompts this launch WATCHED arrive without ever anchoring a start-state —
   * see `markSkippedPromptBaselines`. Distinct from an index that is simply
   * absent, which stays "unknown" and keeps its session-start fallback.
   */
  promptsWithoutBaseline?: number[];
  sessionStartShadowSha?: string | null;
  headShaAtStart?: string | null;
}

/**
 * Remember `shadowSha` as the start-state of prompt `promptIndex`.
 * First write wins: a turn's start-state cannot be re-decided later, and a
 * re-fired hook must not overwrite it with a tree that has since moved on.
 */
export function recordPromptShadow(
  state: ShadowBearingState,
  promptIndex: number,
  shadowSha: string | null | undefined,
  opts?: { now?: () => string },
): void {
  if (!shadowSha || !Number.isInteger(promptIndex) || promptIndex < 0) return;
  if (!state.promptShadows) state.promptShadows = [];
  if (state.promptShadows.some((s) => s.promptIndex === promptIndex)) return;
  state.promptShadows.push({
    promptIndex,
    shadowSha,
    capturedAt: (opts?.now ?? (() => new Date().toISOString()))(),
  });
}

/**
 * The baseline to diff prompt `promptIndex` against: its own start-state when
 * we recorded one, else the session's start. Never the rolling `prePromptSha`
 * — by the time a multi-turn pass runs, that has already advanced.
 */
export function turnBaseline(
  state: ShadowBearingState,
  promptIndex: number,
): string | null {
  const own = (state.promptShadows || []).find((s) => s.promptIndex === promptIndex)?.shadowSha;
  if (own) return own;
  // A prompt we WATCHED arrive unanchored has no start-state, and the
  // session's is not a substitute: diffing from there spans every turn since,
  // so the row re-states earlier turns' work. Session d5cc625b turns 2 and 8
  // did exactly that — their hops duplicated turn 1's byte for byte, the read
  // path's echo detector correctly refused them, and both rendered empty.
  // Null says "unknown", which the callers already handle; the session start
  // says "this turn began at the dawn of the session", which is false.
  //
  // Only for an index MARKED as skipped. A merely absent one is still unknown
  // in the old sense — a row from before this launch adopted the conversation
  // — and keeps the documented session-start fallback.
  if ((state.promptsWithoutBaseline || []).includes(promptIndex)) return null;
  return state.sessionStartShadowSha || state.headShaAtStart || null;
}

/**
 * Mark every prompt that appeared between the last anchored one and
 * `throughIndex` as having no start-state.
 *
 * `recordPromptShadow` is only ever called from user-prompt-submit, for the
 * prompt that fired it. When two prompts arrive between hook runs — the count
 * jumps, which it did twice on session d5cc625b (8→10 and 10→14) — the earlier
 * ones are never anchored and nothing records that they were missed. They then
 * look identical to a turn we simply have no shadow for, and take the
 * session-start fallback, which is how an unanchored turn comes to claim every
 * turn before it.
 *
 * The gap CANNOT be filled retroactively: a shadow made now is the tree as it
 * is now, not as that prompt found it, and a wrong baseline mis-scopes the turn
 * silently where a missing one merely empties it. So this records the absence
 * rather than inventing a value.
 *
 * Bounded to the span after the highest anchored index on purpose. Before the
 * first anchor there is nothing to infer from: an adopted conversation's
 * earlier turns ran before this launch existed, and they keep the fallback
 * they have always had.
 */
export function markSkippedPromptBaselines(
  state: ShadowBearingState,
  throughIndex: number,
): number[] {
  if (!Number.isInteger(throughIndex) || throughIndex <= 0) return [];
  const anchored = (state.promptShadows || []).map((s) => s.promptIndex);
  if (anchored.length === 0) return [];
  const marked: number[] = [];
  // From the FIRST anchor, not the last. A batch that arrived together leaves
  // several holes at once, and Stop fills only the earliest of them (the one
  // that owns the baseline it is about to replace) — the rest sit BELOW the
  // highest anchored index and a max()-based scan would walk straight past
  // them. Everything before the first anchor is still left alone.
  for (let i = Math.min(...anchored) + 1; i < throughIndex; i++) {
    if (anchored.includes(i)) continue;
    if ((state.promptsWithoutBaseline || []).includes(i)) continue;
    if (!state.promptsWithoutBaseline) state.promptsWithoutBaseline = [];
    state.promptsWithoutBaseline.push(i);
    marked.push(i);
  }
  return marked;
}

/**
 * The prompt that owns the CURRENT rolling baseline: the first one since the
 * last anchor with no start-state of its own.
 *
 * `state.prePromptSha` is re-anchored at the end of every Stop, so while a Stop
 * is running it still holds the shadow cut at the end of the previous turn —
 * which is exactly the start-state of the turn now closing. When that turn's
 * own hook never ran (killed mid-git-work, so the prompt is recovered from the
 * transcript instead), this is the one baseline that can still be recovered
 * rather than marked lost.
 *
 * The FIRST unanchored index, not the last, and the distinction is load-bearing
 * only when several prompts arrived without a Stop between them. If Stop ran
 * for each turn, the earlier holes were already filled by those Stops and the
 * first unanchored one IS the closing turn — the two readings converge, which
 * is what makes this safe to apply without knowing which happened.
 *
 * Null when everything is anchored, or when nothing is yet — with no anchor at
 * all this launch has watched nothing arrive, and the rolling baseline says
 * nothing about a turn that ran before it.
 */
export function firstUnanchoredPrompt(
  state: ShadowBearingState,
  throughIndex: number,
): number | null {
  if (!Number.isInteger(throughIndex) || throughIndex <= 0) return null;
  const anchored = (state.promptShadows || []).map((s) => s.promptIndex);
  if (anchored.length === 0) return null;
  for (let i = Math.min(...anchored) + 1; i < throughIndex; i++) {
    if (!anchored.includes(i)) return i;
  }
  return null;
}
