// Per-agent prompt-capture extractors. Each function takes the raw
// session inputs for one agent and produces a `PromptCapture[]` — the
// authoritative per-prompt edit list that the API stores in
// `PromptChange.editsJson` and the dashboard renders directly.
//
// Add a new agent: extend the dispatch table in `capturePromptEdits`,
// implement an extractor that returns `PromptCapture[]`, done. Each
// extractor is self-contained and side-effect-free (pure transforms over
// transcript / rollout / git state), so they're easy to unit-test.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fzstd from 'fzstd';
import type { PromptCapture, PromptEdit, PromptEditOp } from './types.js';

export type { PromptCapture, PromptEdit, PromptEditOp } from './types.js';

const HEX = /^[0-9a-f]{4,64}$/i;

// ─── Public entrypoint ────────────────────────────────────────────────────

export interface CaptureInputs {
  agent: 'claude' | 'cursor' | 'codex' | 'gemini';
  repoPath: string;
  // Path to the agent's transcript/rollout file (Claude/Cursor JSONL,
  // Gemini single JSON, Codex rollout JSONL.zst). Optional for Codex if
  // commit-walking is used directly.
  transcriptPath?: string;
  // Codex-only: pre-parsed timeline of (promptText, ms-timestamp) from
  // the rollout. Optional; when omitted, the extractor reads timestamps
  // from the rollout file itself.
  codexPrompts?: Array<{ text: string; timestamp: number }>;
  // Commits the session authored, oldest-first. Used by the Codex
  // extractor to attribute commits to prompts and read their per-file
  // diffs. Other extractors use this only to flag tool-call edits whose
  // file later landed in a session commit.
  sessionCommitShas?: string[];
  // Repo HEAD when session started. Used by Codex commit walker to
  // bound the search range and by uncommitted fold-in to compute the
  // working-tree diff.
  headShaAtStart?: string;
  // Repo HEAD at session end.
  headShaAtEnd?: string;
}

export function capturePromptEdits(opts: CaptureInputs): PromptCapture[] {
  switch (opts.agent) {
    case 'claude':
    case 'cursor':
      return extractFromJsonlTranscript(opts);
    case 'gemini':
      return extractFromGeminiTranscript(opts);
    case 'codex':
      return extractFromCodexRollout(opts);
    default:
      return [];
  }
}

// ─── Claude Code / Cursor ─────────────────────────────────────────────────
//
// Both write the same JSONL shape: one event per line, each event has a
// `type` (or top-level `role` for Cursor) and a nested `message.content`
// array. User events with non-empty text content start a new turn.
// Assistant events carry `tool_use` blocks where `block.name` is the
// agent's tool (Edit / MultiEdit / Write / replace / write_file …).
//
// Each tool call yields ONE or more PromptEdits:
//   • Edit               → { op: 'edit',  old_string, new_string }
//   • MultiEdit          → multiple edits in `edits[]`
//   • Write              → { op: 'write', content }
//   • write_file/create  → { op: 'write' or 'create', content }
//   • replace            → { op: 'edit',  old_string, new_string }
//   • NotebookEdit       → cells become edits keyed by source

// Default tool-name allow-lists, mergeable with user config at
// ~/.origin/tool-aliases.json:
//   { "edit": ["NewToolName"], "write": [...], "applyPatch": [...], "multiEdit": [...] }
// User entries are UNION-ed with the defaults — config can only EXTEND
// recognition, never REMOVE built-in names, so an unparseable config
// can't accidentally disable existing capture. See loadToolAliases.
const DEFAULT_EDIT_TOOLS = [
  'Edit',
  'mcp__acp__Edit',
  'replace',
  'edit',
  'apply_diff',
  // Cursor's tool name for old_string → new_string edits. Shape
  // matches Claude's Edit exactly (path / old_string / new_string).
  'StrReplace',
];
const DEFAULT_WRITE_TOOLS = [
  'Write',
  'mcp__acp__Write',
  'write_file',
  'WriteFile',
  'write',
  'create',
];
// Tools that pass a multi-file apply_patch payload in `input` (string)
// or `args.command[1]`. Shared by Cursor and any other agent that
// exposes Codex-style apply_patch.
const DEFAULT_APPLY_PATCH_TOOLS = ['ApplyPatch', 'apply_patch'];
const DEFAULT_MULTI_EDIT_TOOLS = ['MultiEdit', 'mcp__acp__MultiEdit'];

// Read-only knobs derived once at module load. If the user wants to
// teach the extractor about a tool a new agent version shipped, they
// drop a name into ~/.origin/tool-aliases.json without waiting for a
// CLI release.
const { CLAUDE_EDIT_TOOLS, CLAUDE_WRITE_TOOLS, APPLY_PATCH_TOOLS, CLAUDE_MULTI_EDIT_TOOLS } = loadToolAliases();

function loadToolAliases(): {
  CLAUDE_EDIT_TOOLS: Set<string>;
  CLAUDE_WRITE_TOOLS: Set<string>;
  APPLY_PATCH_TOOLS: Set<string>;
  CLAUDE_MULTI_EDIT_TOOLS: Set<string>;
} {
  const make = (defaults: string[], extras?: unknown): Set<string> => {
    const out = new Set(defaults);
    if (Array.isArray(extras)) {
      for (const v of extras) if (typeof v === 'string' && v.length > 0) out.add(v);
    }
    return out;
  };
  let cfg: any = null;
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      const p = `${home}/.origin/tool-aliases.json`;
      if (fs.existsSync(p)) {
        cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    }
  } catch { /* malformed config — fall back to defaults silently */ }
  return {
    CLAUDE_EDIT_TOOLS: make(DEFAULT_EDIT_TOOLS, cfg?.edit),
    CLAUDE_WRITE_TOOLS: make(DEFAULT_WRITE_TOOLS, cfg?.write),
    APPLY_PATCH_TOOLS: make(DEFAULT_APPLY_PATCH_TOOLS, cfg?.applyPatch),
    CLAUDE_MULTI_EDIT_TOOLS: make(DEFAULT_MULTI_EDIT_TOOLS, cfg?.multiEdit),
  };
}

// Tool names we've already warned about in this process — dedupes
// warnings so a session with 50 calls to an unknown tool only logs
// once. Cleared per-process; warnings re-emit on next session.
const warnedUnknownTools = new Set<string>();

// Log when an extractor sees a tool with a file-shaped input but the
// tool name doesn't match any recognized set. This is the early-warning
// signal for "an agent renamed something and we'd otherwise miss every
// edit silently." Writes to stderr so the CLI's debug log captures it
// without polluting stdout (which carries hook protocol JSON).
function noteUnknownTool(agent: string, toolName: string, argsPreview: string): void {
  if (!toolName || warnedUnknownTools.has(toolName)) return;
  warnedUnknownTools.add(toolName);
  try {
    process.stderr.write(
      `[origin] prompt-capture: ${agent} used unknown tool "${toolName}" (file-arg). ` +
        `If this is a file edit, add it to ~/.origin/tool-aliases.json under "edit"/"write"/"applyPatch". ` +
        `args=${argsPreview.slice(0, 120)}\n`,
    );
  } catch { /* stderr might be closed in some shells — ignore */ }
}

function extractFromJsonlTranscript(opts: CaptureInputs): PromptCapture[] {
  if (!opts.transcriptPath || !fs.existsSync(opts.transcriptPath)) return [];
  const raw = fs.readFileSync(opts.transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());

  const turns: PromptCapture[] = [];
  const startTurn = (text: string): PromptCapture => ({
    promptIndex: turns.length,
    promptText: text.slice(0, 1000),
    agent: opts.agent === 'cursor' ? 'cursor' : 'claude',
    edits: [],
    commits: [],
  });

  let current: PromptCapture | null = null;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type: string =
      entry.type ||
      (entry as any).role ||
      entry.message?.role ||
      '';

    if (type === 'user') {
      const prompt = extractUserPromptText(entry);
      if (prompt) {
        if (current) turns.push(current);
        current = startTurn(prompt);
      }
      continue;
    }

    if (type !== 'assistant') continue;
    if (!current) current = startTurn('');

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const name = String(block.name || '');
      const input = block.input || {};

      // ApplyPatch handed in `input` as a raw apply_patch string (Cursor)
      // or in `input.command[1]` (Codex shell wrapper). Parse before the
      // pickFilePath bail-out — the patch carries its own file paths
      // inside `*** Update File:` markers, not in input.path.
      if (APPLY_PATCH_TOOLS.has(name)) {
        const patchText = typeof input === 'string'
          ? input
          : typeof input.input === 'string' ? input.input
            : Array.isArray(input.command) && typeof input.command[1] === 'string' ? input.command[1]
              : '';
        for (const e of parseApplyPatch(patchText, opts.repoPath)) {
          current.edits.push(e);
        }
        continue;
      }

      const file = pickFilePath(input);
      if (!file) continue;
      const repoRelative = makeRepoRelative(file, opts.repoPath);

      if (CLAUDE_EDIT_TOOLS.has(name)) {
        current.edits.push({
          file: repoRelative,
          op: 'edit',
          oldContent: typeof input.old_string === 'string' ? input.old_string : '',
          newContent: typeof input.new_string === 'string' ? input.new_string : '',
          source: 'tool_call',
        });
      } else if (CLAUDE_WRITE_TOOLS.has(name)) {
        const content = typeof input.content === 'string'
          ? input.content
          : typeof input.file_text === 'string'
            ? input.file_text
            : '';
        current.edits.push({
          file: repoRelative,
          op: 'write',
          newContent: content,
          source: 'tool_call',
        });
      } else if (CLAUDE_MULTI_EDIT_TOOLS.has(name) && Array.isArray(input.edits)) {
        for (const e of input.edits) {
          if (!e || typeof e !== 'object') continue;
          current.edits.push({
            file: repoRelative,
            op: 'edit',
            oldContent: typeof e.old_string === 'string' ? e.old_string : '',
            newContent: typeof e.new_string === 'string' ? e.new_string : '',
            source: 'tool_call',
          });
        }
      } else {
        // Tool we don't recognize but its input carries a file path —
        // possibly a renamed edit tool we should know about. Log once.
        noteUnknownTool(opts.agent, name, JSON.stringify(input));
      }
    }
  }

  if (current) turns.push(current);
  attributeCommitsToPrompts(turns, opts);
  return turns;
}

function extractUserPromptText(entry: any): string {
  // Cursor: { role: 'user', content: '...' }
  if (typeof entry.content === 'string' && (entry.role === 'user' || entry.role === 'human')) {
    return entry.content.trim();
  }
  const msg = entry.message;
  if (!msg) return '';
  // Old Claude: { message: { role: 'user', content: '...' } }
  if (typeof msg.content === 'string') return msg.content.trim();
  if (!Array.isArray(msg.content)) return '';
  // New Claude: { type:'user', message:{content:[{type:'text', text:'...'}, ...]} }
  // Skip tool_result blocks — they aren't user text.
  const parts: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') return ''; // not a real prompt
    if (typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('').trim();
}

function pickFilePath(input: Record<string, any>): string | null {
  const candidates = [
    input.file_path,
    input.path,
    input.filepath,
    input.notebook_path,
    input.target_file,
    input.filename,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

function makeRepoRelative(filePath: string, repoPath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const repoNorm = repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.startsWith(repoNorm + '/')) return norm.slice(repoNorm.length + 1);
  return norm;
}

// ─── Gemini ───────────────────────────────────────────────────────────────
//
// Gemini history lives in a single JSON file with a top-level `messages`
// (or `history`) array. Each message has `role` and `parts` where each
// part is either text or a `functionCall` with `name` + `args`.
// File-editing function names mirror Claude/Cursor: write_file, replace,
// edit, write. Args carry { file_path | path, old_string, new_string,
// content }.

// Gemini's chat transcript is a JSONL stream (NOT a single JSON object
// with `messages` / `history` like older Gemini CLI versions wrote).
// Line 1 is a metadata header with `sessionId`/`kind`; subsequent lines
// are turn events:
//   user:   {"type":"user",   "content":[{"text":"..."}]}
//   model:  {"type":"gemini", "toolCalls":[{"name":"replace", "args":{
//             file_path, old_string, new_string }}, ...]}
//
// Tool names: `replace` (Edit-equivalent), `write_file`, plus non-edit
// tools like `run_shell_command`, `update_topic`, `update_plan`. We
// walk tool calls and emit a PromptEdit for the file-touching ones.
function extractFromGeminiTranscript(opts: CaptureInputs): PromptCapture[] {
  if (!opts.transcriptPath || !fs.existsSync(opts.transcriptPath)) return [];
  let raw: string;
  try { raw = fs.readFileSync(opts.transcriptPath, 'utf-8'); } catch { return []; }

  const turns: PromptCapture[] = [];
  const startTurn = (text: string): PromptCapture => ({
    promptIndex: turns.length,
    promptText: text.slice(0, 1000),
    agent: 'gemini',
    edits: [],
    commits: [],
  });
  let current: PromptCapture | null = null;

  // Trim the metadata-header line up front so we don't misclassify it.
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    const t = evt?.type || '';

    if (t === 'user' || t === 'human') {
      const parts = Array.isArray(evt?.content) ? evt.content : [];
      const text = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
      if (!text) continue;
      if (current) turns.push(current);
      current = startTurn(text);
      continue;
    }

    // Treat anything else as model output (Gemini's events use
    // type='gemini'; future variants may use 'model'/'assistant').
    if (t !== 'gemini' && t !== 'model' && t !== 'assistant') continue;
    if (!current) current = startTurn('');

    const toolCalls = Array.isArray(evt?.toolCalls) ? evt.toolCalls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const name = String(tc.name || '');
      const args = tc.args || {};
      const file = pickFilePath(args);
      if (!file) continue;
      const repoRelative = makeRepoRelative(file, opts.repoPath);
      if (CLAUDE_EDIT_TOOLS.has(name)) {
        current.edits.push({
          file: repoRelative,
          op: 'edit',
          oldContent: typeof args.old_string === 'string' ? args.old_string : '',
          newContent: typeof args.new_string === 'string' ? args.new_string : '',
          source: 'tool_call',
        });
      } else if (CLAUDE_WRITE_TOOLS.has(name)) {
        const content = typeof args.content === 'string'
          ? args.content
          : typeof args.file_text === 'string' ? args.file_text : '';
        current.edits.push({
          file: repoRelative,
          op: 'write',
          newContent: content,
          source: 'tool_call',
        });
      } else if (CLAUDE_MULTI_EDIT_TOOLS.has(name) && Array.isArray(args.edits)) {
        for (const e of args.edits) {
          if (!e || typeof e !== 'object') continue;
          current.edits.push({
            file: repoRelative,
            op: 'edit',
            oldContent: typeof e.old_string === 'string' ? e.old_string : '',
            newContent: typeof e.new_string === 'string' ? e.new_string : '',
            source: 'tool_call',
          });
        }
      } else {
        noteUnknownTool(opts.agent, name, JSON.stringify(args));
      }
    }
  }

  if (current) turns.push(current);
  attributeCommitsToPrompts(turns, opts);
  return turns;
}

// ─── Codex ────────────────────────────────────────────────────────────────
//
// Codex edits files by running shell commands (sed, cat, apply_patch,
// etc.), so transcript-only extraction misses the actual file changes.
// We instead walk the rollout's `function_call_output` events: each
// `git commit` emits `[branch <short-sha>] message` and Codex's
// `apply_patch` tool reports its target file. We use the commit markers
// to map each commit → prompt (the user_message event that preceded
// it), then `git show <sha>` per commit to produce one PromptEdit per
// file. Uncommitted Codex work folds into the last commit-producing
// prompt as edits derived from `git diff HEAD`.

function extractFromCodexRollout(opts: CaptureInputs): PromptCapture[] {
  if (!opts.repoPath) return [];
  const rolloutText = readCodexRolloutText(opts);
  if (!rolloutText) return [];
  const gitOpts = { cwd: opts.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 10 * 1024 * 1024 };

  // Walk the rollout chronologically. Each real user-role `message` event
  // advances the current prompt index. Each `custom_tool_call` named
  // `apply_patch` is parsed and attributed to the CURRENT prompt — its
  // patch text is the ground truth for which files Codex actually
  // modified, so pre-existing working-tree dirt (other agents' leftover
  // edits, manual user changes, etc.) is automatically excluded.
  // function_call_output events with git commit SHAs flag commits to the
  // current prompt; we then read each commit via `git show` to add
  // commit-derived edits.
  const turns: PromptCapture[] = [];
  let currentPromptIdx = -1;
  const seenShas = new Set<string>();

  const startTurn = (text: string, timestamp: number): void => {
    const idx = turns.length;
    turns.push({
      promptIndex: idx,
      promptText: (text || '').slice(0, 1000),
      agent: 'codex',
      edits: [],
      commits: [],
    });
    currentPromptIdx = idx;
    // Avoid unused-var TS warning; timestamps may be read later by
    // attributors that haven't been wired yet.
    void timestamp;
  };

  for (const line of rolloutText.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event?.payload;
    const payloadType = payload?.type || '';

    if (payloadType === 'message' && (payload.role === 'user' || payload.role === 'human')) {
      const text = extractCodexMessageText(payload);
      if (!isRealCodexUserPrompt(text)) continue;
      const ts = readCodexEventTimestamp(event, payload);
      startTurn(text, ts);
      continue;
    }

    if (currentPromptIdx < 0) continue;

    // apply_patch is Codex's primary edit tool. The rollout records it
    // as a `custom_tool_call` with name="apply_patch" and the patch text
    // in `input`. Parsing this gives us the EXACT files and lines Codex
    // changed — independent of whatever junk the working tree carries.
    if (
      (payloadType === 'custom_tool_call' || payloadType === 'function_call') &&
      payload?.name === 'apply_patch'
    ) {
      const patchText = typeof payload.input === 'string'
        ? payload.input
        : typeof payload.arguments === 'string' ? payload.arguments : '';
      const edits = parseApplyPatch(patchText, opts.repoPath);
      for (const e of edits) turns[currentPromptIdx].edits.push(e);
      continue;
    }

    // function_call_output / local_shell_call_output may contain git
    // commit SHAs in their stdout — attribute those commits to the
    // current prompt and pull their per-file edits from `git show`.
    if (payloadType === 'function_call_output' || payloadType === 'local_shell_call_output') {
      const out = stringifyCodexOutput(payload?.output);
      if (!out) continue;
      for (const sha of extractGitShasFromOutput(out)) {
        if (seenShas.has(sha)) continue;
        // Constrain to commits this session authored when the post-commit
        // hook gave us that list; otherwise trust the output marker.
        const ownShas = new Set((opts.sessionCommitShas || []).filter((s) => HEX.test(s)));
        if (ownShas.size > 0 && !ownShas.has(sha)) continue;
        seenShas.add(sha);
        turns[currentPromptIdx].commits.push(sha);
        appendCommitEdits(turns[currentPromptIdx], sha, opts.repoPath, gitOpts);
      }
    }
  }

  return turns;
}

// Read a Codex rollout file (handles both `.jsonl` and `.jsonl.zst`).
function readCodexRolloutText(opts: CaptureInputs): string {
  if (!opts.transcriptPath || !fs.existsSync(opts.transcriptPath)) return '';
  try {
    if (opts.transcriptPath.endsWith('.zst') || opts.transcriptPath.endsWith('.zstd')) {
      const compressed = fs.readFileSync(opts.transcriptPath);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      return Buffer.from(decompressed).toString('utf-8');
    }
    return fs.readFileSync(opts.transcriptPath, 'utf-8');
  } catch {
    return '';
  }
}

// True only for messages that represent the human user typing in the
// chat box. Codex replays AGENTS.md, <INSTRUCTIONS>, and
// <environment_context> blocks as the FIRST user-role event in every
// rollout — without this filter those wrappers become bogus prompt 0
// and shift every real prompt's index by one.
function isRealCodexUserPrompt(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (text.includes('<!-- origin-managed -->')) return false;
  if (/^#\s+AGENTS\.md instructions for /m.test(text)) return false;
  const stripped = text
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .trim();
  return stripped.length > 0;
}

function readCodexEventTimestamp(event: any, payload: any): number {
  const candidates = [event?.timestamp, event?.created_at, payload?.timestamp, payload?.created_at];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c > 1e12 ? c : c * 1000;
    if (typeof c === 'string') {
      const n = Date.parse(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function stringifyCodexOutput(out: any): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object') {
    if (typeof out.content === 'string') return out.content;
    if (typeof out.stdout === 'string') return out.stdout;
    try { return JSON.stringify(out); } catch { return ''; }
  }
  return String(out);
}

function extractGitShasFromOutput(out: string): string[] {
  const shas: string[] = [];
  // `[branch <short-sha>] message` is git commit's canonical stdout line.
  for (const m of out.matchAll(/\[\S+\s+([0-9a-f]{7,40})\]/gi)) {
    shas.push(m[1]);
  }
  // `commit <sha>` from `git show`-style output.
  for (const m of out.matchAll(/^commit\s+([0-9a-f]{7,40})/gim)) {
    shas.push(m[1]);
  }
  return shas;
}

// Parse Codex's apply_patch format and emit ONE PromptEdit per hunk
// inside each file section (not per file). A hunk is a contiguous
// run of context + `+`/`-` lines bounded by `@@` markers or file
// boundaries. The format is:
//
//   *** Begin Patch
//   *** Update File: path/to/file
//   @@ optional anchor
//    unchanged line
//   -removed line
//   +added line
//   @@ next hunk
//    other context
//   +another added line
//   *** End Patch
//
// Why per-hunk: the server's git-style position-replay anchor needs
// `oldContent` to be a CONTIGUOUS slice of the source file. When a
// single `*** Update File:` describes multiple non-adjacent hunks,
// merging them into one oldContent string yields a fragmented
// "before image" whose lines are NOT contiguous in the file — the
// replay's findSubsequence then never matches. Per-hunk emission
// keeps each oldContent a real contiguous excerpt.
//
// `*** Add File:` and `*** Delete File:` are file-level ops (whole
// file create/delete) — emit ONE edit each, as before.
function parseApplyPatch(patchText: string, repoPath: string): PromptEdit[] {
  if (!patchText) return [];
  const edits: PromptEdit[] = [];
  const lines = patchText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const updateMatch = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (!updateMatch) { i++; continue; }
    const op: PromptEditOp =
      updateMatch[1] === 'Add' ? 'create'
      : updateMatch[1] === 'Delete' ? 'delete'
      : 'edit';
    const filePath = updateMatch[2].trim();
    const repoRelative = makeRepoRelative(filePath, repoPath);
    i++;
    // Add/Delete are whole-file ops — collect the full body without
    // splitting on `@@`. There aren't real hunks within these.
    if (op === 'create' || op === 'delete') {
      const oldParts: string[] = [];
      const newParts: string[] = [];
      while (i < lines.length) {
        const ln = lines[i];
        if (/^\*\*\* (Update|Add|Delete) File: /.test(ln)) break;
        if (/^\*\*\* End Patch/.test(ln)) break;
        if (/^\*\*\* End of File$/.test(ln)) { i++; continue; }
        if (ln.startsWith('@@')) { i++; continue; }
        if (ln.startsWith('+')) newParts.push(ln.slice(1));
        else if (ln.startsWith('-')) oldParts.push(ln.slice(1));
        else if (ln.startsWith(' ') || ln === '') {
          const ctx = ln.startsWith(' ') ? ln.slice(1) : ln;
          oldParts.push(ctx);
          newParts.push(ctx);
        }
        i++;
      }
      edits.push({
        file: repoRelative,
        op,
        oldContent: op === 'create' ? '' : oldParts.join('\n'),
        newContent: op === 'delete' ? '' : newParts.join('\n'),
        source: 'tool_call',
      });
      continue;
    }
    // Update file: split into hunks. A new hunk starts at each `@@`
    // marker or at the first content line if no `@@` precedes it.
    // Flush the current hunk's accumulated old/new content when we
    // hit a new `@@`, a file boundary, or end-of-patch.
    let oldParts: string[] = [];
    let newParts: string[] = [];
    const flushHunk = (): void => {
      if (oldParts.length === 0 && newParts.length === 0) return;
      // Skip pure-context hunks (no `+`/`-`) — they're noise.
      const hasChange =
        oldParts.length !== newParts.length ||
        oldParts.some((s, idx) => s !== newParts[idx]);
      if (!hasChange) {
        oldParts = [];
        newParts = [];
        return;
      }
      edits.push({
        file: repoRelative,
        op: 'edit',
        oldContent: oldParts.join('\n'),
        newContent: newParts.join('\n'),
        source: 'tool_call',
      });
      oldParts = [];
      newParts = [];
    };
    while (i < lines.length) {
      const ln = lines[i];
      if (/^\*\*\* (Update|Add|Delete) File: /.test(ln)) { flushHunk(); break; }
      if (/^\*\*\* End Patch/.test(ln)) { flushHunk(); break; }
      if (/^\*\*\* End of File$/.test(ln)) { i++; continue; }
      if (ln.startsWith('@@')) {
        flushHunk();
        i++;
        continue;
      }
      if (ln.startsWith('+')) newParts.push(ln.slice(1));
      else if (ln.startsWith('-')) oldParts.push(ln.slice(1));
      else if (ln.startsWith(' ') || ln === '') {
        const ctx = ln.startsWith(' ') ? ln.slice(1) : ln;
        oldParts.push(ctx);
        newParts.push(ctx);
      }
      i++;
    }
  }
  return edits;
}

function extractCodexMessageText(payload: any): string {
  const c = payload?.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const block of c) {
    if (typeof block === 'string') parts.push(block);
    else if (typeof block?.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

function appendCommitEdits(
  turn: PromptCapture,
  sha: string,
  repoPath: string,
  gitOpts: { cwd: string; encoding: 'utf-8'; stdio: ['pipe', 'pipe', 'pipe']; timeout: number; maxBuffer: number },
): void {
  // `git diff-tree --root -m` gives per-file before/after via `--patch`,
  // but we want raw file content snapshots so the server can run LCS.
  // Pull each changed file's BEFORE blob via `git show <sha>^:<file>` and
  // AFTER blob via `git show <sha>:<file>`. New files have no `^:` blob;
  // deletions have no `:` blob — handle both.
  let names: string;
  try {
    names = execFileSync(
      'git',
      ['diff-tree', '--no-commit-id', '--name-status', '-r', sha],
      gitOpts,
    );
  } catch { return; }
  for (const line of names.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const status = parts[0];
    const file = parts.slice(1).join(' '); // handle paths with spaces (rare)
    const repoRelative = makeRepoRelative(file, repoPath);
    let oldContent: string | undefined;
    let newContent: string | undefined;
    if (status !== 'A' && status !== 'D') {
      try { oldContent = execFileSync('git', ['show', `${sha}^:${file}`], gitOpts); } catch { /* parent had no such file */ }
    }
    if (status !== 'D') {
      try { newContent = execFileSync('git', ['show', `${sha}:${file}`], gitOpts); } catch { /* binary or missing */ }
    }
    const op: PromptEditOp = status === 'A' ? 'create'
      : status === 'D' ? 'delete'
      : status.startsWith('R') ? 'rename'
      : 'edit';
    turn.edits.push({
      file: repoRelative,
      op,
      oldContent: op === 'create' ? '' : oldContent,
      newContent: op === 'delete' ? '' : newContent,
      source: 'commit',
      commitSha: sha,
    });
  }
}

// ─── Shared post-processing ───────────────────────────────────────────────

function attributeCommitsToPrompts(turns: PromptCapture[], opts: CaptureInputs): void {
  // For transcript-based agents, we know which file an edit touched but
  // not which commit it ended up in. Walk the session's commits in
  // order and mark a commit as belonging to a turn when at least one of
  // that turn's edited files appears in the commit. Multiple turns can
  // claim the same commit when squashed edits cross prompt boundaries.
  const shas = (opts.sessionCommitShas || []).filter((s) => HEX.test(s));
  if (shas.length === 0 || !opts.repoPath) return;
  const gitOpts = { cwd: opts.repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 5000 };

  const filesByCommit = new Map<string, Set<string>>();
  for (const sha of shas) {
    try {
      const names = execFileSync(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
        gitOpts,
      ).split('\n').map((s) => s.trim()).filter(Boolean);
      filesByCommit.set(sha, new Set(names));
    } catch { /* commit unreachable */ }
  }
  for (const turn of turns) {
    const filesTouched = new Set(turn.edits.map((e) => e.file));
    if (filesTouched.size === 0) continue;
    for (const [sha, names] of filesByCommit) {
      let intersects = false;
      for (const f of filesTouched) {
        if (names.has(f)) { intersects = true; break; }
      }
      if (intersects && !turn.commits.includes(sha)) turn.commits.push(sha);
    }
    // For tool-call edits whose file landed in a commit, mark them as
    // committed by stamping `commitSha`. Edits with no matching commit
    // remain `source: 'tool_call'` without a commitSha → rendered as
    // uncommitted.
    for (const edit of turn.edits) {
      if (edit.commitSha) continue;
      for (const sha of turn.commits) {
        const names = filesByCommit.get(sha);
        if (names && names.has(edit.file)) {
          edit.commitSha = sha;
          break;
        }
      }
    }
  }
}
