// ─── Authoritative per-prompt capture ─────────────────────────────────────
//
// One canonical data shape per agent. The legacy pipelines
// (buildDiffFromEdits, heartbeat pushInflightDiff, codex-prompt-mapping)
// each emitted a unified diff string with subtly different scopes; the
// dashboard then ran fuzzy block matching to recover attribution. Both
// halves of that arrangement leaked across prompts and sessions.
//
// The new pipeline emits a structured edit list per prompt. Each PromptEdit
// records ONE file operation the agent performed with enough context for
// the server to render an exact per-prompt diff without any cross-session
// inference. The server runs LCS over (oldContent, newContent) to produce
// the displayed diff, then attributes each `+` line to the prompt that
// owns the edit. No baselines, no shadows, no heuristics.
//
// Per-agent rules for populating this:
//   • Claude Code / Cursor       — extract from transcript tool calls
//                                  (Edit / MultiEdit / Write / replace /
//                                   write_file). `oldContent` /
//                                  `newContent` come straight from the
//                                  tool's input. `source: 'tool_call'`.
//   • Gemini                     — same, from the rollout's function
//                                  calls (replace, write_file).
//   • Codex                      — agent edits files via shell, so
//                                  tool-call extraction misses them.
//                                  Instead, walk the rollout's
//                                  [branch sha] markers to map commit →
//                                  prompt, then `git show <sha>` per
//                                  commit and emit one PromptEdit per
//                                  file in that commit. Uncommitted
//                                  Codex work folds into the last
//                                  commit-producing prompt as edits
//                                  derived from `git diff HEAD`.

export type PromptEditSource = 'tool_call' | 'commit' | 'uncommitted';

/**
 * HOW an edit came to be attributed — proof versus inference.
 *
 * `source` says where the CONTENT came from; it does not say how confident we
 * are that this turn wrote it, and those are different questions. A tool call
 * was watched happening. A turn-window edit was merely dirty in the tree when
 * we looked, which in a shared checkout means it may belong to a sibling
 * agent, to the user's own hand-editing, or to a turn that ran an hour ago.
 *
 *   • `tool_call`     — the agent's own edit payload. Proof.
 *   • `command_probe` — the file was seen CHANGING across a single shell
 *                       command (fingerprint before, fingerprint after). Proof,
 *                       scoped to that command rather than the whole turn.
 *   • `edit_hook`     — the agent's own post-edit hook named this exact file
 *                       as the one it just wrote (Cursor's afterFileEdit).
 *                       Proof: the agent is telling us, not us deducing it.
 *   • `write_journal` — the filesystem watcher observed the file changing at a
 *                       moment inside this turn. Proof of WHEN, and the only
 *                       evidence available for an agent that exposes no hooks
 *                       at all. It cannot name the process behind the write,
 *                       so it does not separate two agents sharing a checkout.
 *   • `turn_window`   — the file was dirty somewhere in the turn's window.
 *                       INFERENCE. Keep it, label it, do not present it as
 *                       equal to the two above.
 *
 * Deliberately a SEPARATE field rather than another `source` value: the server
 * filters edits by source against a fixed allowlist
 * (`source !== 'tool_call' && source !== 'uncommitted'` → dropped), so a new
 * source would be discarded outright, and a newer CLI talking to an older
 * server would silently lose every shell edit. An unknown extra field is
 * carried through untouched instead.
 */
// How firmly an edit is attributed to the turn that carries it, strongest
// first. `command_named` sits just under `tool_call`: the file changed inside
// one shell command's before/after window AND that command's own text names
// it, which a sibling's concurrent write cannot satisfy. `command_probe` is
// the same window without the naming, and `turn_window` is a whole-turn dirty
// diff — the weakest, and on a shared checkout mostly other agents' work.
export type PromptEditEvidence = 'tool_call' | 'command_named' | 'command_probe' | 'edit_hook' | 'write_journal' | 'turn_window';

export type PromptEditOp = 'edit' | 'write' | 'create' | 'delete' | 'rename';

export interface PromptEdit {
  // Repo-relative file path (forward slashes). For renames, this is the
  // NEW path; oldPath carries the previous one.
  file: string;
  op: PromptEditOp;
  // Content of the file (or affected region for tool-call edits) BEFORE
  // this operation. Empty for `create`. For `write` this is the file's
  // prior content if known; otherwise undefined and the server treats
  // the whole new file as added.
  oldContent?: string;
  // Content AFTER this operation. Empty for `delete`.
  newContent?: string;
  // For rename ops.
  oldPath?: string;
  // Whether this edit's content came from an agent tool call, a git
  // commit, or working-tree state at session end. The server uses this
  // to render the committed/uncommitted badge per edit.
  source: PromptEditSource;
  // How firmly this edit is attributed to this turn — see PromptEditEvidence.
  // Optional so older captures (and older servers) stay valid; absent means
  // "not recorded", not "inferred".
  evidence?: PromptEditEvidence;
  // Set when source === 'commit'. The commit that landed this edit.
  commitSha?: string;
  // 1-based line in the file where this edit's region begins, captured
  // against the ACTUAL file at edit time (the post-edit working tree for
  // tool calls, the commit for `git show`-derived edits). This is the
  // ground truth for the displayed gutter: tool-call payloads
  // (old_string / new_string) carry no position, so without this the
  // server's synthesized diff anchors every hunk at line 1 and the AI
  // Blame / Session Diff gutters show wrong line numbers (a change at
  // line 23 rendered as `@@ -1,1 +1,2 @@`). Absent when the position
  // couldn't be resolved (e.g. a deletion whose content is gone, or an
  // edit overwritten before capture) — the server then falls back to its
  // synthetic cursor, so this is always safe to omit.
  oldStart?: number;
  newStart?: number;
  // Where a content-less write's newContent was recovered from
  // (backfillContentLessWrites): 'commit-blob' / 'live-file', with a
  // '+reversed-N' suffix when N later edits were reverse-applied to walk
  // the file back to THIS turn's state, or 'skipped-later-rewrite' when a
  // later whole-file write made the state unrecoverable. Diagnostic --
  // the server ignores it, but it makes bad backfills attributable.
  backfillSource?: string;
}

export interface PromptCapture {
  promptIndex: number;
  promptText: string;
  agent: CaptureAgent;
  edits: PromptEdit[];
  // Commit SHAs attributed to this prompt. A commit appears here when at
  // least one of its file changes belongs to this prompt's edits with
  // source === 'commit'. Lets the dashboard link prompt → commit without
  // re-deriving the relationship from per-edit fields.
  commits: string[];
  // How many edit tool calls this turn ISSUED and had REJECTED — captured
  // before the is_error guard existed, and the reason a stored turn can read
  // higher than git. `origin recapture` uses it as its safety gate: a turn
  // with none of these has nothing for a re-capture to correct, and re-sending
  // it would overwrite good data with a transcript that cannot see shell
  // writes. Absent on captures from agents whose transcript has no result
  // blocks to read.
  droppedFailedEdits?: number;
  /**
   * Absolute paths this turn wrote that landed OUTSIDE the repo — a Cursor
   * canvas, `~/.cursor/projects/…` scratch, `/tmp`, a sibling checkout. Home
   * is collapsed to `~`. Present so a turn whose `edits` are empty can say
   * WHY, instead of reading as a broken capture. Absent/empty means none
   * were recorded, not that none happened.
   */
  outOfRepoFiles?: string[];
}


// ─── Which agents can produce proof-grade edits, and from where ───────────
//
// Every agent Origin supports appears here. That is the point: the previous
// arrangement had no such list, and each capture path invented its own
// fallback for an agent it did not know about. The two disagreed, and both
// were wrong in different directions:
//
//   • the hook path coerced every unlisted slug to 'claude' and fed its
//     transcript to the Claude Code JSONL parser — a parser for a format
//     those agents do not write;
//   • the watcher path left the label undefined and hit `default: return []`,
//     producing nothing at all.
//
// Neither said anything. An agent could be added to the product, ship hooks,
// capture sessions, and never emit a single structured edit — which is the
// state Copilot is in today.
//
// 'transcript' — a per-agent extractor reads the agent's own session file.
// 'ledger'     — no extractor, but the agent fires a tool-level hook, so
//                edits are recorded live as they happen (buildCapturesFromLedger).
//                Returning no transcript captures is CORRECT for these.
// 'none'       — neither. Turns can only be rendered from working-tree
//                inference, which cannot tell the agent's writes from a
//                sibling's or the user's. A gap, not a configuration.
export type EditSourceKind = 'transcript' | 'ledger' | 'none';

export interface AgentEditSource {
  kind: EditSourceKind;
  /** The extractor label, when kind === 'transcript'. */
  captureAgent?: CaptureAgent;
}

export type CaptureAgent = 'claude' | 'cursor' | 'codex' | 'gemini' | 'copilot';

// Keyed by the canonical AgentType slug (see commands/enable.ts). Adding an
// agent there without adding it here is a type error, which is the whole
// mechanism: a new agent cannot be silently captured by the wrong parser.
export const AGENT_EDIT_SOURCES: Record<string, AgentEditSource> = {
  'claude-code':  { kind: 'transcript', captureAgent: 'claude' },
  'cursor':       { kind: 'transcript', captureAgent: 'cursor' },
  'gemini':       { kind: 'transcript', captureAgent: 'gemini' },
  'codex':        { kind: 'transcript', captureAgent: 'codex' },
  // Fires PostToolUse, so every edit is recorded live; it has no transcript
  // extractor and does not need one.
  'antigravity':  { kind: 'ledger' },
  'devin':        { kind: 'ledger' },
  // Registers sessionStart / userPromptSubmitted / agentStop / sessionEnd and
  // nothing at tool level, and has no extractor — so no edit is ever witnessed.
  'copilot':      { kind: 'transcript', captureAgent: 'copilot' },
  'aider':        { kind: 'none' },
};

/**
 * Where this agent's edits come from. Unknown slugs are 'none' — honestly
 * unsupported — rather than being quietly handed to the Claude parser.
 */
export function editSourceForAgent(slug: string | undefined): AgentEditSource {
  return AGENT_EDIT_SOURCES[(slug || '').toLowerCase()] || { kind: 'none' };
}
