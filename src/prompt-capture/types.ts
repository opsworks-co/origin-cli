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
}

export interface PromptCapture {
  promptIndex: number;
  promptText: string;
  agent: 'claude' | 'cursor' | 'codex' | 'gemini';
  edits: PromptEdit[];
  // Commit SHAs attributed to this prompt. A commit appears here when at
  // least one of its file changes belongs to this prompt's edits with
  // source === 'commit'. Lets the dashboard link prompt → commit without
  // re-deriving the relationship from per-edit fields.
  commits: string[];
}
