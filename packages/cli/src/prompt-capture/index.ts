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

const CLAUDE_EDIT_TOOLS = new Set([
  'Edit',
  'mcp__acp__Edit',
  'replace',
  'edit',
  'apply_diff',
]);
const CLAUDE_WRITE_TOOLS = new Set([
  'Write',
  'mcp__acp__Write',
  'write_file',
  'WriteFile',
  'write',
  'create',
]);
const CLAUDE_MULTI_EDIT_TOOLS = new Set(['MultiEdit', 'mcp__acp__MultiEdit']);

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

function extractFromGeminiTranscript(opts: CaptureInputs): PromptCapture[] {
  if (!opts.transcriptPath || !fs.existsSync(opts.transcriptPath)) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(opts.transcriptPath, 'utf-8'));
  } catch {
    return [];
  }
  const messages: any[] = parsed?.messages || parsed?.history || [];
  if (!Array.isArray(messages)) return [];

  const turns: PromptCapture[] = [];
  const startTurn = (text: string): PromptCapture => ({
    promptIndex: turns.length,
    promptText: text.slice(0, 1000),
    agent: 'gemini',
    edits: [],
    commits: [],
  });
  let current: PromptCapture | null = null;

  for (const msg of messages) {
    const role = msg?.role || '';
    if (role === 'user' || role === 'human') {
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      const text = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
      if (text) {
        if (current) turns.push(current);
        current = startTurn(text);
      }
      continue;
    }
    if (role !== 'model' && role !== 'assistant') continue;
    if (!current) current = startTurn('');
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    for (const part of parts) {
      const fc = part?.functionCall;
      if (!fc || typeof fc !== 'object') continue;
      const name = String(fc.name || '');
      const args = fc.args || {};
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

// Parse Codex's apply_patch format and emit one PromptEdit per file
// section. The format is:
//
//   *** Begin Patch
//   *** Update File: path/to/file
//   @@ optional context header
//    unchanged line
//   -removed line
//   +added line
//   *** End Patch
//
// `*** Add File:` and `*** Delete File:` mark creates and deletes
// respectively. We reconstruct each file's pre- and post-image so the
// server can run LCS against them — same as the unified-diff path.
function parseApplyPatch(patchText: string, repoPath: string): PromptEdit[] {
  if (!patchText) return [];
  const edits: PromptEdit[] = [];
  // Split on `*** ` markers while keeping the marker as the first line
  // of each section, then walk in order so each Update/Add/Delete block
  // sees its own hunks until the next file marker (or End Patch).
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
    // Collect lines until the next file marker or end-of-patch.
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
