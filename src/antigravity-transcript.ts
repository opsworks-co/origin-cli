import path from 'path';

// Parser for Antigravity (`agy`) transcripts.
//
// agy has no SessionStart/UserPromptSubmit hook events — only Stop / PreToolUse
// / PostToolUse, and those carry a `transcriptPath` to a JSONL file at
//   ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
// (older builds used ~/.gemini/antigravity-cli/brain; discovery scans both).
// Each line is one step: { type, source, content, step_index, created_at,
// tool_calls? }. We pull the user prompts and the model from it (agy does NOT
// expose token counts anywhere, so usage is estimated by the caller).

export interface AntigravityTranscript {
  prompts: string[];
  responses: string[];    // assembled assistant output per prompt (aligned with prompts[])
  // Epoch-ms of each prompt's `created_at` from the transcript, aligned with
  // prompts[]. null when the step carried no parseable timestamp. agy has no
  // UserPromptSubmit hook, so this transcript time is the ONLY real prompt time
  // — without it the server stamps the DB insert time (whenever the first Stop
  // fired), which drifts out of order across re-parses.
  promptTimes: (number | null)[];
  model: string | null;   // normalized slug, e.g. "gemini-3.5-flash"
  inputChars: number;     // user-side text (for token estimation)
  outputChars: number;    // model-side text (for token estimation)
  // Absolute paths of every file the session touched (edit/write/read tools),
  // pulled from tool_calls[].args. agy reports no reliable repo root — its
  // `workspacePaths[0]` is often the workspace/project NAME, not the folder the
  // edits landed in — so these paths are how the CLI recovers the TRUE git root
  // to attribute the session to (see deriveAgyRepoPath in commands/hooks.ts).
  filePaths: string[];
  // Absolute paths the session actually EDITED/WROTE (not reads/greps), so
  // files-changed isn't inflated by files it only inspected. Session union.
  filesEdited: string[];
  // Per-prompt edited paths, aligned with prompts[] — lets the watcher attribute
  // (and diff) file changes to the right turn.
  promptFilesEdited: string[][];
  // Per-prompt edit records WITH content (agy records CodeContent /
  // TargetContent+ReplacementContent), normalized for buildDiffFromEdits so agy
  // turns get real diffs and line counts.
  promptEditRecords: AgyEditRecord[][];
  // True for each prompt whose tool calls actually ran `git commit`. This is the
  // DETERMINISTIC signal for which turn produced a commit — inferring it from
  // "which turn edited a file the commit contains" is ambiguous when several
  // turns edit the same file (every commit then resolves to the same turn).
  promptRanCommit: boolean[];
}

// PascalCase (and a few snake_case) keys agy uses for file arguments across its
// edit/write/read/glob tools. Mirrors agyToolArg / agyToolPaths.
const AGY_FILE_ARG_KEYS = ['TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'file_path', 'file', 'path', 'DirectoryPath'];

// Collect ABSOLUTE file paths from one step's tool_calls. Relative paths are
// dropped — only an absolute path can be resolved back to a git root without
// knowing the (unreliable) cwd.
function stepFilePaths(step: any): string[] {
  const out: string[] = [];
  for (const tc of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
    const a = (tc && tc.args) || {};
    for (const k of AGY_FILE_ARG_KEYS) {
      const v = a[k];
      if (typeof v === 'string' && v.trim() && path.isAbsolute(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

// agy tool names whose category is a file mutation (edit/write) — used to tell
// files the session CHANGED from files it merely READ, so files-changed isn't
// inflated by reads. Keyed off the same AGY_TOOL_LABEL map the UI colors by.
const AGY_EDIT_LABELS = new Set(['Edit', 'Write']);

// agy DOES record the content it writes, under PascalCase keys:
//   write_to_file       → CodeContent (the whole new file)
//   replace_file_content→ TargetContent (old) / ReplacementContent (new)
// Normalize those into the same {file, toolName, input} shape the shared
// buildDiffFromEdits() consumes, so agy gets real per-prompt diffs and line
// counts instead of file-names-only.
export interface AgyEditRecord { file: string; toolName: string; input: Record<string, unknown> }

function stepEditRecords(step: any): AgyEditRecord[] {
  const out: AgyEditRecord[] = [];
  for (const tc of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
    const label = AGY_TOOL_LABEL[tc?.name] || '';
    if (!AGY_EDIT_LABELS.has(label)) continue;
    const a = (tc && tc.args) || {};
    const file = AGY_FILE_ARG_KEYS.map((k) => a[k]).find((v) => typeof v === 'string' && v.trim() && path.isAbsolute(v.trim()));
    if (typeof file !== 'string') continue;
    if (typeof a.CodeContent === 'string') {
      // Whole-file write/create.
      out.push({ file: file.trim(), toolName: 'Write', input: { content: a.CodeContent } });
    } else if (typeof a.ReplacementContent === 'string' || typeof a.TargetContent === 'string') {
      // Region replace — maps onto the Edit (old_string/new_string) shape.
      out.push({
        file: file.trim(),
        toolName: 'Edit',
        input: { old_string: typeof a.TargetContent === 'string' ? a.TargetContent : '', new_string: typeof a.ReplacementContent === 'string' ? a.ReplacementContent : '' },
      });
    }
  }
  return out;
}

// Did this step run `git commit`? agy records shell invocations as run_command
// with the command line in `CommandLine`. This is the ground truth for which
// turn produced a commit.
function stepRanGitCommit(step: any): boolean {
  for (const tc of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
    const a = (tc && tc.args) || {};
    const cmd = typeof a.CommandLine === 'string' ? a.CommandLine : '';
    if (/git\s+commit/.test(cmd)) return true;
  }
  return false;
}

// ABSOLUTE paths from a step's EDIT/WRITE tool_calls only (not reads/greps).
function stepEditedFilePaths(step: any): string[] {
  const out: string[] = [];
  for (const tc of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
    const label = AGY_TOOL_LABEL[tc?.name] || '';
    if (!AGY_EDIT_LABELS.has(label)) continue;
    const a = (tc && tc.args) || {};
    for (const k of AGY_FILE_ARG_KEYS) {
      const v = a[k];
      if (typeof v === 'string' && v.trim() && path.isAbsolute(v.trim())) out.push(v.trim());
    }
  }
  return out;
}

// Per-prompt cap on assembled assistant text — keeps the synthesized transcript
// payload bounded even for very long agentic turns (the server caps the whole
// transcript at 10MB, but a single runaway turn shouldn't eat that alone).
const MAX_RESPONSE_LEN = 100_000;

// "Gemini 3.5 Flash" → "gemini-3.5-flash"; "Claude Sonnet 4.5" → "claude-sonnet-4.5".
export function normalizeAntigravityModel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return s || null;
}

function extractUserRequest(content: string): string | null {
  // The user prompt is wrapped: <USER_REQUEST>\n...\n</USER_REQUEST>
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (m) return m[1].trim();
  // Fallback: the whole content minus any <...METADATA...>/<...SETTINGS...> blocks.
  const stripped = content.replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, '').trim();
  return stripped || null;
}

function extractModel(content: string): string | null {
  // USER_INPUT records model picks inline, with the effort in parens:
  //   "...`Model Selection` from None to Gemini 3.5 Flash (Medium). No need..."
  // Capture the name up to the " (effort)" / newline / backtick — NOT the
  // internal "." in "3.5".
  const m = content.match(/Model Selection`?\s+from\s+.+?\s+to\s+(.+?)\s*(?:\(|\n|`|$)/);
  if (m) return normalizeAntigravityModel(m[1]);
  return null;
}

// Map agy's internal tool names to the canonical labels the web's
// FormattedMessage colors by category (Read=sky, Bash=emerald, Edit/Write=amber,
// …). Unknown names pass through and render in the neutral "meta" style.
const AGY_TOOL_LABEL: Record<string, string> = {
  list_dir: 'Read', view_file: 'Read', read_file: 'Read', view_code_item: 'Read',
  find_by_name: 'Glob', grep_search: 'Grep', codebase_search: 'Grep',
  run_command: 'Bash', run_terminal_cmd: 'Bash',
  replace_file_content: 'Edit', edit_file: 'Edit', apply_patch: 'Edit',
  write_to_file: 'Write', create_file: 'Write',
  search_web: 'WebSearch', read_url_content: 'WebFetch', view_web: 'WebFetch',
};
function agyToolLabel(name: unknown): string {
  if (typeof name !== 'string' || !name) return 'Tool';
  return AGY_TOOL_LABEL[name] || name;
}

// What to show next to the tool chip. Match the agy terminal, which shows the
// REAL invocation — `Bash(git diff -- README.md)`, `Create(.../file.md)` — not
// the generic `toolSummary` ("Git diff"). Prefer the actual command, then the
// file/dir (basename, so the meaningful part survives truncation), and only
// fall back to the human summary when neither exists.
function agyToolArg(tc: any): string {
  const a = (tc && tc.args) || {};
  if (typeof a.CommandLine === 'string' && a.CommandLine.trim()) return a.CommandLine.trim();
  for (const k of ['TargetFile', 'AbsolutePath', 'FilePath', 'Path', 'file_path', 'DirectoryPath']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim().split(/[\\/]/).pop() || v.trim();
  }
  return (typeof a.toolSummary === 'string' && a.toolSummary.trim()) || '';
}

// Assemble the agent-visible output from a single PLANNER_RESPONSE step, using
// the marker format the web's FormattedMessage renders richly:
//   [Reasoning] …      → dimmed reasoning box   (from `thinking`)
//   [Tool: <label>] …  → colored tool-call chip (name + `toolSummary`)
//   <markdown>         → headings/lists/code     (the final `content` answer)
// Tool OUTPUT bodies (VIEW_FILE/RUN_COMMAND/CODE_ACTION) are intentionally
// skipped — they're verbose and the code changes already show in the diff.
function plannerStepText(step: any): string {
  const parts: string[] = [];
  if (typeof step?.thinking === 'string' && step.thinking.trim()) {
    // Collapse internal blank lines so the whole thought stays in one
    // [Reasoning] block (the web's reasoning parser ends at a blank line).
    parts.push('[Reasoning] ' + step.thinking.trim().replace(/\n{2,}/g, '\n'));
  }
  for (const tc of Array.isArray(step?.tool_calls) ? step.tool_calls : []) {
    const label = agyToolLabel(tc?.name);
    const arg = agyToolArg(tc);
    parts.push(arg ? `[Tool: ${label}] ${arg}` : `[Tool: ${label}]`);
  }
  if (typeof step?.content === 'string' && step.content.trim()) parts.push(step.content.trim());
  return parts.join('\n\n');
}

// One user turn plus the assistant output assembled under it. Kept together so
// that when we sort by prompt time, text + response + timestamp move as a unit
// (see the sort at the end of parseAntigravityTranscript).
interface AgyTurn { text: string; createdAt: number | null; buf: string[]; editedFiles: string[]; editRecords: AgyEditRecord[]; ranCommit: boolean }

export function parseAntigravityTranscript(jsonl: string): AntigravityTranscript {
  const turns: AgyTurn[] = [];
  let model: string | null = null;
  let inputChars = 0;
  let outputChars = 0;
  // Preserve first-seen order (a read/edit early in the session is the best
  // repo-root signal); dedup via the Set.
  const filePathSet = new Set<string>();
  // When agy compacts a long session it drops a CHECKPOINT step ("Resuming from
  // a compaction") and then RE-INJECTS the original user request as a fresh
  // USER_EXPLICIT step. That is not a new prompt — counting it produces a
  // phantom duplicate turn. Track whether a compaction happened since the last
  // real prompt so we can collapse the re-injection.
  let sawCompaction = false;

  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let step: any;
    try { step = JSON.parse(t); } catch { continue; }
    const content: string = typeof step?.content === 'string' ? step.content : '';

    if (step?.type === 'CHECKPOINT' && /resuming from a compaction/i.test(content)) {
      sawCompaction = true;
      continue;
    }

    if (step?.type === 'USER_INPUT' && step?.source === 'USER_EXPLICIT') {
      const req = extractUserRequest(content);
      if (req) {
        // Skip a compaction re-injection: same text as the previous prompt,
        // with a compaction checkpoint in between. Its model steps stay in the
        // current turn's buffer (same logical request).
        const isReinjection = sawCompaction && turns.length > 0 && turns[turns.length - 1].text === req;
        if (!isReinjection) {
          const ms = typeof step?.created_at === 'string' ? Date.parse(step.created_at) : NaN;
          turns.push({ text: req, createdAt: Number.isFinite(ms) ? ms : null, buf: [], editedFiles: [], editRecords: [], ranCommit: false });
          inputChars += req.length;
        }
      }
      sawCompaction = false;
      if (!model) model = extractModel(content);
    } else if (step?.source === 'MODEL') {
      // Planner reasoning + tool output text — the model's side of the work.
      outputChars += content.length;
      if (typeof step?.thinking === 'string') outputChars += step.thinking.length;
      if (step?.type === 'PLANNER_RESPONSE') {
        const text = plannerStepText(step);
        if (text && turns.length > 0) turns[turns.length - 1].buf.push(text);
      }
      for (const p of stepFilePaths(step)) filePathSet.add(p);
      if (turns.length > 0) {
        for (const p of stepEditedFilePaths(step)) turns[turns.length - 1].editedFiles.push(p);
        for (const r of stepEditRecords(step)) turns[turns.length - 1].editRecords.push(r);
        if (stepRanGitCommit(step)) turns[turns.length - 1].ranCommit = true;
      }
    }
  }

  // Order turns by their REAL prompt time so the array index (which the server
  // uses as the stable promptIndex, and which the CLI uses to attach each
  // prompt's diff) is deterministic across re-parses. agy rewrites/reorders its
  // brain log mid-session — a prompt queued during a long turn, or the
  // compaction re-injection — so file order alone is NOT stable, and an
  // unstable index decouples promptText from its timestamp and diff (the bug
  // this fixes). Only reorder when EVERY turn is timed: a partial sort could
  // float an untimed turn to the front. Array.sort is stable, so equal
  // timestamps keep file order. When any timestamp is missing we keep file
  // order wholesale — the pre-existing behaviour, so no regression.
  if (turns.length > 1 && turns.every((t) => t.createdAt !== null)) {
    turns.sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
  }

  const prompts = turns.map((t) => t.text);
  const promptTimes = turns.map((t) => t.createdAt);
  const responses = turns.map((t) => t.buf.join('\n\n').trim().slice(0, MAX_RESPONSE_LEN));
  // Per-prompt EDITED files (dedup), aligned with prompts[]; and the session union.
  const promptFilesEdited = turns.map((t) => [...new Set(t.editedFiles)]);
  const promptEditRecords = turns.map((t) => t.editRecords);
  const promptRanCommit = turns.map((t) => t.ranCommit);
  const filesEdited = [...new Set(turns.flatMap((t) => t.editedFiles))];

  return { prompts, responses, promptTimes, model, inputChars, outputChars, filePaths: [...filePathSet], filesEdited, promptFilesEdited, promptEditRecords, promptRanCommit };
}

// agy exposes no token counts, so we estimate from text length (~4 chars/token,
// the common rough rule). Callers must label these as ESTIMATED — the server
// turns them into an (also estimated) cost via its pricing table.
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

export interface EstimatedUsage { inputTokens: number; outputTokens: number; totalTokens: number; estimated: true }
export function estimateAntigravityUsage(t: Pick<AntigravityTranscript, 'inputChars' | 'outputChars'>): EstimatedUsage {
  const inputTokens = estimateTokens(t.inputChars);
  const outputTokens = estimateTokens(t.outputChars);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
}
