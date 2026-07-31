// ---------------------------------------------------------------------------
// Origin CLI — Per-agent transcript adapters for the hook-independent watcher
// ---------------------------------------------------------------------------
// Each adapter teaches transcript-watch.ts three things about one agent:
//   • listActive(now)  — walk that agent's on-disk transcript store and return
//                         the recently-written sessions (path, session id, cwd
//                         if recoverable, mtime).
//   • parse(path)      — turn one transcript file into the engine's uniform
//                         ParsedSession (prompts / transcript / tokens / tools /
//                         model / touched file paths), reusing the parser that
//                         already exists for that agent.
//   • isNoise?(parsed) — optional per-agent "this whole session is noise" filter.
//
// The hard part is cwd. Only Codex (its own watcher) and Claude Code record
// their cwd INSIDE the transcript. Claude reads it straight from the file
// (readClaudeCwd). The others don't store cwd on disk — their store paths encode
// an opaque workspace/project hash, not the folder — so their adapters return
// cwd:null and the engine recovers the repo from the ABSOLUTE file paths the
// session touched (deriveRepoFromFilePaths). That fallback only works when the
// transcript carries absolute paths; a session that only touched relative paths
// (or never a git repo) is skipped. This is the same tradeoff deriveAgyRepoPath
// already makes for Antigravity.
// ---------------------------------------------------------------------------

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseTranscript,
  formatTranscriptForDisplay,
  extractPromptFileMappings,
  buildDiffFromEdits,
  readCopilotModel,
  type ParsedTranscript,
} from './transcript.js';
import { readGeminiModel } from './agents/gemini.js';
import { discoverCursorTranscript, getCursorModelFromDb } from './agents/cursor.js';
import {
  parseAntigravityTranscript,
  estimateAntigravityUsage,
} from './antigravity-transcript.js';

// ─── Engine-facing types ───────────────────────────────────────────────────────

export interface ScannedTranscript {
  sessionId: string;          // the agent's own session/conversation id (== agentSessionId)
  transcriptPath: string;
  cwd: string | null;         // null → engine derives the repo from parsed.filePaths
  mtimeMs: number;
}

export interface ParsedSession {
  userPrompts: string[];
  promptTimestamps: number[]; // epoch-ms per prompt, aligned; may be empty
  // Earliest known epoch-ms for the whole session (the transcript's first
  // timestamp). Feeds the session `startedAt` so a watcher-noticed session
  // isn't stamped "now". Independent of per-prompt alignment.
  sessionStartedAtMs?: number;
  // Latest epoch-ms seen in the transcript — the session's real END of activity.
  // Preferred over the file's mtime for duration: mtime moves when anything
  // rewrites the file, and "now" would make a finished session's duration grow
  // forever while the daemon keeps polling.
  sessionLastActivityMs?: number;
  transcript: string;
  model?: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  // Cache tokens — needed for an accurate cost estimate (cache reads are billed
  // far cheaper than fresh input, so folding them into inputTokens overcharges).
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  toolCalls: number;
  // Absolute file paths the session touched (edits + reads) — the cwd-recovery
  // fallback for agents that don't record their cwd on disk.
  filePaths: string[];
  // Absolute paths the agent actually MODIFIED (write/edit tools), from the
  // transcript itself — authoritative for files-changed, so we don't depend on
  // a working-tree diff against a baseline the poll-based watcher captured late.
  filesChanged: string[];
  // Per-prompt file changes derived PURELY from the transcript's Edit/Write
  // content (git-independent). The fallback for uncommitted work the poll-based
  // tree diff misses (baseline captured after the edit). Empty for agents whose
  // transcript doesn't carry structured edits (e.g. Antigravity).
  promptDiffs: Array<{ promptIndex: number; filesChanged: string[]; diff: string; linesAdded: number; linesRemoved: number }>;
  // Per-prompt structured edits WITH content, absolute paths. Supplied by agents
  // that record what they wrote but have no extractor in the canonical
  // capturePromptEdits pipeline (Antigravity). The watcher turns these into
  // PromptChange.editsJson — the record the dashboard treats as authoritative,
  // without which the read path blanks per-prompt files.
  promptEdits?: Array<{ promptIndex: number; edits: Array<{ file: string; op: string; oldContent?: string; newContent?: string }> }>;
  // Prompt indices that provably ran `git commit` (from the transcript's own
  // shell calls). The deterministic anchor for commit→turn attribution when the
  // agent has no canonical extractor — file-overlap guessing is ambiguous.
  promptsThatCommitted?: number[];
}

export interface TranscriptAdapter {
  slug: string;               // internal adapter id (state namespacing)
  agentSlugForServer: string; // agentSlug sent to the API (e.g. 'claude-code')
  // Agent key for the canonical per-prompt edit pipeline (capturePromptEdits →
  // PromptCapture.edits → PromptChange.editsJson). editsJson is what the
  // dashboard treats as the AUTHORITATIVE per-prompt record; without it the read
  // path falls back to legacy projections and its defensive heuristics can blank
  // files/diffs. Set only for agents whose transcript that extractor
  // understands; omit for the rest (they keep the legacy diff fields).
  promptCaptureAgent?: 'claude' | 'cursor' | 'codex' | 'gemini';
  listActive(now: number): ScannedTranscript[];
  parse(transcriptPath: string): ParsedSession | null;
  isNoise?(parsed: ParsedSession): boolean;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

// Candidate window: only files touched within this window are considered. Wider
// than the engine's 20-min IDLE_MS so a just-idle session is still re-scanned
// and gets its ENDED transition (and a restart re-adopts recent sessions).
const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

function home(...segs: string[]): string {
  return path.join(os.homedir(), ...segs);
}

function safeReaddir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statMtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// File creation time, as a session-start fallback for agents whose transcript
// carries no timestamps (Cursor). Returns 0 when unavailable or implausible:
// some Linux filesystems don't record birthtime (0, or equal to mtime), and a
// birthtime AFTER mtime means the value can't be trusted.
function fileBirthMs(p: string): number {
  try {
    const st = fs.statSync(p);
    const birth = st.birthtimeMs;
    if (!Number.isFinite(birth) || birth <= 0) return 0;
    if (birth > st.mtimeMs) return 0;
    return birth;
  } catch {
    return 0;
  }
}

function recent(mtimeMs: number, now: number, win = ACTIVE_WINDOW_MS): boolean {
  return mtimeMs > 0 && now - mtimeMs <= win;
}

// Earliest `timestamp` across a JSONL transcript's lines (ISO string or epoch),
// as epoch-ms. Bounds the read at the first ~50 lines — the opening lines carry
// the session's real start and scanning the whole file each poll is wasteful.
// Returns 0 when no parseable timestamp is found.
function earliestJsonlTimestampMs(transcriptPath: string): number {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    let best = 0;
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (++n > 50) break;
      try {
        const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        const ms = typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) : NaN);
        if (Number.isFinite(ms) && ms > 0 && (best === 0 || ms < best)) best = ms;
      } catch { /* skip */ }
    }
    return best;
  } catch {
    return 0;
  }
}

// Latest `timestamp` across a JSONL transcript, as epoch-ms (0 when none).
// Unlike the earliest-scan this must read every line — the last event is the end
// of the session, and that is what duration should measure to.
function latestJsonlTimestampMs(transcriptPath: string): number {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    let best = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        const ms = typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) : NaN);
        if (Number.isFinite(ms) && ms > best) best = ms;
      } catch { /* skip */ }
    }
    return best;
  } catch {
    return 0;
  }
}

// Count +/- lines in a unified diff (ignoring the +++/--- file headers).
function countDiffLines(diff: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
    else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

// Per-prompt diffs derived from the transcript's own edit records (no git).
function promptDiffsFromTranscript(transcriptPath: string): ParsedSession['promptDiffs'] {
  try {
    return extractPromptFileMappings(transcriptPath).map((m) => ({
      promptIndex: m.promptIndex,
      filesChanged: m.filesChanged,
      diff: m.diff || '',
      ...countDiffLines(m.diff || ''),
    }));
  } catch {
    return [];
  }
}

// Per-prompt structured edits WITH content, for PromptChange.editsJson. The
// server treats editsJson as the authoritative per-prompt record and derives the
// line counts from the edit content inside it — so a content-less editsJson makes
// every turn report +0 even when the diff we sent was correct.
//
// Maps each agent's write/replace tool shape onto the common op form:
//   whole-file write  -> { op:'write', newContent }   (content | contents | file_text)
//   region replace    -> { op:'edit',  oldContent, newContent }
function promptEditsFromTranscript(transcriptPath: string): ParsedSession['promptEdits'] {
  try {
    return extractPromptFileMappings(transcriptPath).map((m) => ({
      promptIndex: m.promptIndex,
      edits: (m.edits || []).map((e) => {
        const i = e.input || {};
        const whole = i.file_text ?? i.contents ?? i.content;
        if (typeof whole === 'string') {
          return { file: e.file, op: 'write', newContent: whole };
        }
        return {
          file: e.file,
          op: 'edit',
          oldContent: String(i.old_string ?? i.old_str ?? ''),
          newContent: String(i.new_string ?? i.new_str ?? ''),
        };
      }),
    }));
  } catch {
    return [];
  }
}

function uniqueFiles(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const f of list) {
      if (f && !seen.has(f)) { seen.add(f); out.push(f); }
    }
  }
  return out;
}

// A clean, display-formatted transcript for the parseTranscript-based agents
// (Claude/Cursor/Gemini/Copilot), matching what the Stop hook sends: a
// JSON.stringify(DisplayMessage[]) string the web parses into turns. If
// formatting throws or yields nothing we return '' — NEVER the raw JSONL, which
// is not a DisplayMessage[] array and would make the web synthesize user-only
// turns ("no response captured").
function displayTranscript(transcriptPath: string, _parsed: ParsedTranscript): string {
  try {
    const t = formatTranscriptForDisplay(transcriptPath, { verbose: false });
    if (t && t.trim().startsWith('[')) return t;
  } catch { /* fall through to empty */ }
  return '';
}

// Map a ParsedTranscript (Claude-shaped parser output) into a ParsedSession.
// `modelOverride` lets Cursor/Copilot/Gemini supply the real model when the
// generic parser can't read one from the file.
function fromParsedTranscript(
  transcriptPath: string,
  p: ParsedTranscript,
  modelOverride?: string | null,
  tokenOverride?: { tokensUsed: number; inputTokens: number; outputTokens: number },
): ParsedSession {
  return {
    userPrompts: p.prompts,
    promptTimestamps: [],
    // Cursor's JSONL carries NO timestamps at all, so both scans return 0 and
    // duration would stay 0. Fall back to the filesystem: the transcript file is
    // created when the conversation starts and last written when it ends, so
    // birthtime→mtime is a real span (measured 1073s on a live session). This is
    // wall-clock conversation time, same as the first→last timestamp span we use
    // for the other agents, so it stays comparable.
    sessionStartedAtMs: earliestJsonlTimestampMs(transcriptPath) || fileBirthMs(transcriptPath) || undefined,
    sessionLastActivityMs: latestJsonlTimestampMs(transcriptPath) || statMtime(transcriptPath) || undefined,
    transcript: displayTranscript(transcriptPath, p),
    model: modelOverride || p.model || undefined,
    tokensUsed: tokenOverride ? tokenOverride.tokensUsed : p.tokensUsed,
    inputTokens: tokenOverride ? tokenOverride.inputTokens : p.inputTokens,
    outputTokens: tokenOverride ? tokenOverride.outputTokens : p.outputTokens,
    cacheReadTokens: p.cacheReadTokens,
    cacheCreationTokens: p.cacheCreationTokens,
    toolCalls: p.toolCalls,
    filePaths: uniqueFiles(p.filesChanged, p.filesRead),
    filesChanged: p.filesChanged,
    promptDiffs: promptDiffsFromTranscript(transcriptPath),
    promptEdits: promptEditsFromTranscript(transcriptPath),
  };
}

// ─── Claude Code ────────────────────────────────────────────────────────────
// Store: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Every transcript
// line embeds an absolute `cwd` (and sessionId, gitBranch), so we read the cwd
// straight from the file — no lossy decode of the dir name. Sub-session
// transcripts live in a <sessionId>/subagents/ subdir; we only take the .jsonl
// files DIRECTLY under each project dir (the real conversations).

function claudeProjectsDir(): string { return home('.claude', 'projects'); }

// First `cwd` value found in the transcript. Claude writes it on nearly every
// line; scanning the first ~200 lines is plenty and bounds the read.
function readClaudeCwd(transcriptPath: string): string | null {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (++n > 200) break;
      try {
        const o = JSON.parse(line);
        if (typeof o?.cwd === 'string' && o.cwd.trim()) return o.cwd.trim();
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return null;
}

export const claudeAdapter: TranscriptAdapter = {
  slug: 'claude',
  agentSlugForServer: 'claude-code',
  promptCaptureAgent: 'claude',
  listActive(now: number): ScannedTranscript[] {
    const out: ScannedTranscript[] = [];
    const root = claudeProjectsDir();
    for (const proj of safeReaddir(root)) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(root, proj.name);
      for (const entry of safeReaddir(projDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const fp = path.join(projDir, entry.name);
        const mtimeMs = statMtime(fp);
        if (!recent(mtimeMs, now)) continue;
        out.push({
          sessionId: entry.name.replace(/\.jsonl$/, ''),
          transcriptPath: fp,
          cwd: readClaudeCwd(fp),
          mtimeMs,
        });
      }
    }
    return out;
  },
  parse(transcriptPath: string): ParsedSession | null {
    if (!fs.existsSync(transcriptPath)) return null;
    return fromParsedTranscript(transcriptPath, parseTranscript(transcriptPath));
  },
};

// ─── GitHub Copilot CLI ───────────────────────────────────────────────────────
// Store: ~/.copilot/session-state/<sessionId>/events.jsonl (dotted-type events).
// parseTranscript() converts the events to Claude shape internally; the real
// model comes from readCopilotModel(). cwd is not in the path; recovered from
// touched file paths.

function copilotSessionStateDir(): string { return home('.copilot', 'session-state'); }

export const copilotAdapter: TranscriptAdapter = {
  slug: 'copilot',
  agentSlugForServer: 'copilot',
  listActive(now: number): ScannedTranscript[] {
    const out: ScannedTranscript[] = [];
    const root = copilotSessionStateDir();
    for (const sess of safeReaddir(root)) {
      if (!sess.isDirectory()) continue;
      const fp = path.join(root, sess.name, 'events.jsonl');
      const mtimeMs = statMtime(fp);
      if (!recent(mtimeMs, now)) continue;
      out.push({ sessionId: sess.name, transcriptPath: fp, cwd: readCopilotCwd(fp), mtimeMs });
    }
    return out;
  },
  parse(transcriptPath: string): ParsedSession | null {
    if (!fs.existsSync(transcriptPath)) return null;
    const p = parseTranscript(transcriptPath);
    const model = readCopilotModel(transcriptPath);
    const base = fromParsedTranscript(transcriptPath, p, model);
    // Copilot's session dir is an opaque id and its workspace.yaml records
    // `cwd: /` (no real path), so the ONLY way to find the repo is the absolute
    // paths in its tool arguments. Its tools also use keys the generic extractor
    // doesn't know (`paths`, `directory`, shell command lines), so harvest any
    // absolute path from the raw events. Used for cwd recovery only — NOT for
    // files-changed, which stays sourced from recognized edit tools.
    if (base.filePaths.length === 0) {
      base.filePaths = harvestCopilotPaths(transcriptPath);
    }
    return base;
  },
};

// Copilot's `session.start` event carries authoritative workspace metadata in
// `data.context` — gitRoot / cwd / repository / branch — for sessions that run
// against a real checkout (the desktop + CLI cases). This is the exact repo, so
// prefer it over scraping paths out of tool arguments.
//
// Remote read-only cloud tasks record `cwd: "/"` and no gitRoot; treat that as
// absent so those sessions fall through (they have no local repo at all).
export function readCopilotCwd(transcriptPath: string): string | null {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (++n > 40) break; // session.start is the first event
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      const ctx = ev?.data?.context;
      if (!ctx) continue;
      for (const v of [ctx.gitRoot, ctx.cwd]) {
        if (typeof v === 'string' && v.trim() && v.trim() !== '/') return v.trim();
      }
    }
  } catch { /* unreadable */ }
  return null;
}

// Absolute filesystem paths appearing anywhere in Copilot's tool arguments.
// Deliberately permissive (any Windows drive path or POSIX absolute path) and
// deduped; deriveRepoFromFilePaths then keeps only the ones inside a git repo,
// so a stray non-repo path costs nothing.
export function harvestCopilotPaths(transcriptPath: string): string[] {
  const out = new Set<string>();
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      const args = ev?.data?.arguments;
      if (!args) continue;
      const blob = typeof args === 'string' ? args : JSON.stringify(args);
      // Windows drive paths (C:\…, backslashes arrive JSON-escaped) AND POSIX
      // absolute paths (/Users/… on macOS/Linux) — Copilot runs on all three.
      const candidates: string[] = [];
      for (const m of blob.matchAll(/[A-Za-z]:(?:\\\\|\\)[^"'\n,;)]+/g)) {
        candidates.push(m[0].replace(/\\\\/g, '\\').replace(/[\\/.]+$/, ''));
      }
      // Require at least two segments so a bare "/" or a word like "and/or"
      // can't qualify; existence filtering below removes the rest.
      for (const m of blob.matchAll(/\/(?:[\w.@+-]+\/)+[\w.@+-]+/g)) {
        candidates.push(m[0].replace(/\/+$/, ''));
      }
      // Only keep paths that actually EXIST. Copilot asks questions containing
      // example paths ("C:\\path\\to\\repo") and choice labels, so prose would
      // otherwise pollute the list.
      for (const p of candidates) {
        try { if (p && fs.existsSync(p)) out.add(p); } catch { /* skip */ }
      }
    }
  } catch { /* unreadable — no paths */ }
  return [...out];
}

// ─── Gemini CLI ───────────────────────────────────────────────────────────────
// Store (varies by version): ~/.gemini/tmp/<hash>/chats/session-*.json,
// ~/.gemini/tmp/<hash>/checkpoints/*.json, ~/.gemini/projects/<hash>/checkpoints/
// *.json. The <hash> is a non-reversible project hash, so cwd is recovered from
// touched file paths. parseTranscript() auto-detects the Gemini JSON shape;
// readGeminiModel() supplies the real model.

// Only `chats/session-<id>.json` files carry a STABLE per-conversation id (the
// embedded <id>). Checkpoint files (checkpoint*.json) don't embed it, so keying
// identity on their basename both forks a conversation across its files and
// collides across workspaces (every workspace's `checkpoint.json` → the same
// id). We therefore scan only session-*.json under chats/ and take the id from
// the filename. A Gemini build that writes ONLY checkpoints won't be captured
// by the watcher — an accepted gap over corrupting session identity.
const GEMINI_SESSION_FILE_RE = /^session-(.+)\.json$/;

function geminiCandidateFiles(): Array<{ path: string; sessionId: string }> {
  const out: Array<{ path: string; sessionId: string }> = [];
  const pushFrom = (root: string) => {
    for (const ws of safeReaddir(root)) {
      if (!ws.isDirectory()) continue;
      const chats = path.join(root, ws.name, 'chats');
      for (const f of safeReaddir(chats)) {
        const m = f.isFile() ? f.name.match(GEMINI_SESSION_FILE_RE) : null;
        if (m) out.push({ path: path.join(chats, f.name), sessionId: m[1] });
      }
    }
  };
  pushFrom(home('.gemini', 'tmp'));
  pushFrom(home('.gemini', 'projects'));
  return out;
}

export const geminiAdapter: TranscriptAdapter = {
  slug: 'gemini',
  agentSlugForServer: 'gemini',
  promptCaptureAgent: 'gemini',
  listActive(now: number): ScannedTranscript[] {
    const out: ScannedTranscript[] = [];
    for (const { path: fp, sessionId } of geminiCandidateFiles()) {
      const mtimeMs = statMtime(fp);
      if (!recent(mtimeMs, now)) continue;
      out.push({ sessionId, transcriptPath: fp, cwd: null, mtimeMs });
    }
    return out;
  },
  parse(transcriptPath: string): ParsedSession | null {
    if (!fs.existsSync(transcriptPath)) return null;
    const p = parseTranscript(transcriptPath);
    const model = readGeminiModel(transcriptPath);
    return fromParsedTranscript(transcriptPath, p, model);
  },
};

// ─── Cursor ───────────────────────────────────────────────────────────────────
// Store: ~/.cursor/projects/<workspace>/agent-transcripts/<conversationId>/
// <conversationId>.jsonl. The <workspace> is Cursor's own hash, not the cwd, so
// cwd is recovered from touched file paths. parseTranscript() handles the JSONL
// for prompts/tools/files; Cursor records no token counts (estimated via
// discoverCursorTranscript) and stores the model in a separate SQLite DB
// (getCursorModelFromDb).

function cursorProjectsDir(): string { return home('.cursor', 'projects'); }

// Cursor's workspace folder name is the cwd with the drive colon and every path
// separator flattened to '-' and lowercased: `C:\soft\origin-demo-1` becomes
// `c-soft-origin-demo-1`. Decoding is AMBIGUOUS because directory names contain
// their own dashes — that example could be c:/soft/origin-demo-1 (right),
// c:/soft/origin/demo/1, c:/soft-origin/demo-1, …
//
// So don't guess: enumerate the readings and keep the one that EXISTS on disk.
// The first segment is the drive; each later dash is either a separator or a
// literal dash. Separator-first ordering finds the common case immediately, and
// the search is bounded so a pathological name can't blow up.
export function decodeCursorWorkspacePath(folderName: string): string | null {
  const parts = folderName.split('-');
  if (parts.length < 2) return null;
  const drive = parts[0];
  if (!/^[A-Za-z]$/.test(drive)) return null;      // not a Windows workspace name
  if (parts.length > 12) return null;              // keep the search bounded
  const rest = parts.slice(1);

  let found: string | null = null;
  const walk = (index: number, acc: string) => {
    if (found) return;
    if (index === rest.length) {
      const candidate = `${drive.toUpperCase()}:/${acc}`;
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) found = candidate; } catch { /* skip */ }
      return;
    }
    const seg = rest[index];
    // Prefer treating the dash as a separator (the usual case), then as literal.
    if (acc) {
      walk(index + 1, `${acc}/${seg}`);
      if (!found) walk(index + 1, `${acc}-${seg}`);
    } else {
      walk(index + 1, seg);
    }
  };
  walk(0, '');
  return found;
}

export const cursorAdapter: TranscriptAdapter = {
  slug: 'cursor',
  agentSlugForServer: 'cursor',
  promptCaptureAgent: 'cursor',
  listActive(now: number): ScannedTranscript[] {
    const out: ScannedTranscript[] = [];
    const root = cursorProjectsDir();
    for (const ws of safeReaddir(root)) {
      if (!ws.isDirectory()) continue;
      const atDir = path.join(root, ws.name, 'agent-transcripts');
      for (const conv of safeReaddir(atDir)) {
        if (!conv.isDirectory()) continue;
        const fp = path.join(atDir, conv.name, `${conv.name}.jsonl`);
        const mtimeMs = statMtime(fp);
        if (!recent(mtimeMs, now)) continue;
        // The workspace folder name is the only repo signal Cursor gives: a
        // read-only session (no edits, only relative shell commands) has no
        // absolute path anywhere in its transcript, so path harvesting finds
        // nothing and the session would be dropped as "not in a git repo".
        out.push({ sessionId: conv.name, transcriptPath: fp, cwd: decodeCursorWorkspacePath(ws.name), mtimeMs });
      }
    }
    return out;
  },
  parse(transcriptPath: string): ParsedSession | null {
    if (!fs.existsSync(transcriptPath)) return null;
    const p = parseTranscript(transcriptPath);
    const conversationId = path.basename(transcriptPath).replace(/\.jsonl$/, '');
    // Cursor stores no token counts in the transcript — pull the char-estimated
    // totals, and the real model from Cursor's tracking DB.
    let tokenOverride: { tokensUsed: number; inputTokens: number; outputTokens: number } | undefined;
    try {
      const est = discoverCursorTranscript(conversationId);
      if (est && est.tokensUsed > 0) {
        tokenOverride = { tokensUsed: est.tokensUsed, inputTokens: est.inputTokens, outputTokens: est.outputTokens };
      }
    } catch { /* estimation is best-effort */ }
    let model: string | null = null;
    try { model = getCursorModelFromDb(conversationId); } catch { /* best-effort */ }
    return fromParsedTranscript(transcriptPath, p, model, tokenOverride);
  },
};

// ─── Antigravity (Google agentic CLI) ──────────────────────────────────────────
// Store: ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/
// transcript_full.jsonl. Its parser takes the file CONTENTS (not a path), yields
// char-estimated tokens (no real counts), and records no cwd — the repo is
// recovered from the absolute file paths in tool_calls.

// Antigravity's on-disk brain dir moved between versions — newer builds write
// to ~/.gemini/antigravity/brain, older ones to ~/.gemini/antigravity-cli/brain.
// Scan both so capture works regardless of version.
function antigravityBrainDirs(): string[] {
  return [home('.gemini', 'antigravity', 'brain'), home('.gemini', 'antigravity-cli', 'brain')];
}

// A conversation's transcript, preferring the fuller file over the short one.
function antigravityTranscriptPath(convDir: string): string | null {
  const logs = path.join(convDir, '.system_generated', 'logs');
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const fp = path.join(logs, name);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

export const antigravityAdapter: TranscriptAdapter = {
  slug: 'antigravity',
  agentSlugForServer: 'antigravity',
  listActive(now: number): ScannedTranscript[] {
    const out: ScannedTranscript[] = [];
    const seen = new Set<string>();
    for (const root of antigravityBrainDirs()) {
      for (const conv of safeReaddir(root)) {
        if (!conv.isDirectory() || seen.has(conv.name)) continue;
        const fp = antigravityTranscriptPath(path.join(root, conv.name));
        if (!fp) continue;
        const mtimeMs = statMtime(fp);
        if (!recent(mtimeMs, now)) continue;
        seen.add(conv.name);
        out.push({ sessionId: conv.name, transcriptPath: fp, cwd: null, mtimeMs });
      }
    }
    return out;
  },
  parse(transcriptPath: string): ParsedSession | null {
    let raw: string;
    try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return null; }
    const t = parseAntigravityTranscript(raw);
    const usage = estimateAntigravityUsage(t);
    // Build the transcript as a DisplayMessage[] JSON array — the SAME shape
    // formatTranscriptForDisplay emits and the web dashboard parses. A plain
    // string here (an earlier bug) isn't valid JSON, so the web fell back to
    // user-only turns ⇒ "no response captured". role/content per turn instead.
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < t.prompts.length; i++) {
      messages.push({ role: 'user', content: t.prompts[i] || '' });
      if (t.responses[i]) messages.push({ role: 'assistant', content: t.responses[i] });
    }
    // NOTE: parseAntigravityTranscript re-sorts turns by created_at each parse,
    // so a prompt that arrives out of order between polls can shift array
    // indices. The engine keys per-prompt shadows on the index, so a shadow
    // could re-map to a neighbouring prompt. Low-impact (agy is edit-path, not
    // the common case) but a known limitation vs. append-only stores.
    const validTimes = t.promptTimes.filter((x): x is number => typeof x === 'number' && x > 0);
    return {
      userPrompts: t.prompts,
      promptTimestamps: t.promptTimes.map((x) => x || 0),
      sessionStartedAtMs: validTimes.length ? Math.min(...validTimes) : undefined,
      sessionLastActivityMs: validTimes.length ? Math.max(...validTimes) : undefined,
      transcript: messages.length ? JSON.stringify(messages) : '',
      model: t.model || undefined,
      tokensUsed: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      toolCalls: 0, // agy transcript carries filePaths, not a tool-call count
      filePaths: t.filePaths, // all touched (read+edit) — for cwd recovery
      filesChanged: t.filesEdited, // ONLY edited/written files, not reads
      // Real per-prompt diffs: agy records the content it wrote (CodeContent /
      // TargetContent+ReplacementContent), normalized into the shared
      // buildDiffFromEdits shape — so each turn gets its own diff + line counts
      // exactly like Claude/Cursor, instead of file names with +0.
      promptDiffs: t.promptFilesEdited.map((files, i) => {
        const diff = t.promptEditRecords[i]?.length ? buildDiffFromEdits(t.promptEditRecords[i] as any) : '';
        return { promptIndex: i, filesChanged: files, diff, ...countDiffLines(diff) };
      }),
      promptsThatCommitted: t.promptRanCommit.map((r, i) => (r ? i : -1)).filter((i) => i >= 0),
      promptEdits: t.promptEditRecords.map((recs, i) => ({
        promptIndex: i,
        edits: recs.map((r) => (r.toolName === 'Write'
          ? { file: r.file, op: 'write', newContent: String(r.input.content ?? '') }
          : { file: r.file, op: 'edit', oldContent: String(r.input.old_string ?? ''), newContent: String(r.input.new_string ?? '') })),
      })),
    };
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────
// Codex is intentionally absent — it has its own dedicated codex-watch daemon.
export const ADAPTERS: TranscriptAdapter[] = [
  claudeAdapter,
  cursorAdapter,
  geminiAdapter,
  copilotAdapter,
  antigravityAdapter,
];
