import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasAncestorProcess } from './utils/process-detect.js';

// ── Devin CLI (terminal) transcript capture ──────────────────────────────
// The Devin CLI — unlike Devin Desktop — writes a PLAINTEXT transcript per
// session at ~/.local/share/devin/cli/transcripts/<session_id>.json in the
// "ATIF-v1.7" interchange format. Its hooks (SessionStart/UserPromptSubmit/
// Stop/SessionEnd) only carry the prompt + session_id — no transcript_path,
// no tokens, no cost, no assistant output. But this file, keyed by the hook's
// session_id, has all of it: real model, per-step assistant text + tool calls,
// and final token metrics. It is Devin's equivalent of Claude Code's JSONL
// transcript, just at a fixed location we derive from session_id.

export interface DevinCliSessionData {
  model?: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  prompts: string[];   // every user message, in order
  /** JSON.stringify([{role, content}]) — display transcript, or undefined. */
  transcript?: string;
}

// Locate the Devin CLI's data dir. Devin follows the XDG spec on mac + linux
// (~/.local/share) and %LOCALAPPDATA% on Windows. We try the documented
// locations in order and return the first transcript file that exists.
export function findDevinCliTranscript(sessionId: string): string | null {
  if (!sessionId) return null;
  const home = os.homedir();
  const bases: string[] = [];
  if (process.env.XDG_DATA_HOME) bases.push(process.env.XDG_DATA_HOME);
  bases.push(path.join(home, '.local', 'share'));                 // macOS + Linux
  if (process.env.LOCALAPPDATA) bases.push(process.env.LOCALAPPDATA); // Windows
  bases.push(path.join(home, 'AppData', 'Local'));                // Windows fallback
  for (const base of bases) {
    const p = path.join(base, 'devin', 'cli', 'transcripts', `${sessionId}.json`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Devin CLI reuses Claude Code's hooks and reads ~/.claude/settings.json, so a
// Devin run with only the claude-code hook installed fires as
// agentSlug='claude-code' and gets mislabeled "Claude".
//
// We can't key off the hook's session_id: Devin passes its hook a word-word id
// (e.g. "kind-boater") that does NOT match the ATIF transcript filename (e.g.
// "abstracted-evening.json") for the SAME run — verified live on v3000.2.17.
// The reliable, live signal is the process tree: the claude-code hook runs as a
// descendant of the `devin` binary. A real Claude session (or a devin running
// elsewhere) never puts devin in THIS hook's ancestry. Returns 'devin' to
// re-tag when that's the case; only the claude-code/claude slug is ever
// hijacked, so no other agent is touched.
export function retagDevinFromProcess(slug: string | undefined): string | undefined {
  if (slug && slug !== 'claude-code' && slug !== 'claude') return slug;
  // Match the devin binary as a command (`devin`, `/path/to/devin`,
  // `devin chat …`) but not substrings like "devin-desktop" or a path segment.
  if (hasAncestorProcess(/(^|\/)devin(\s|$)/i)) return 'devin';
  return slug;
}

const num = (v: any): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
};

const truncate = (s: string, max = 2000): string =>
  s.length > max ? s.slice(0, max) + '…' : s;

// Pure parse of an ATIF transcript's raw JSON → session data. Split from the
// file read so it is unit-testable without disk. `sinceIso`, when given, drops
// steps older than that timestamp (so a resumed session only reports the new
// turn's tokens/output) — but token metrics are session-cumulative in ATIF, so
// they are always taken from final_metrics as-is.
export function parseDevinCliTranscript(raw: string, sinceIso?: string): DevinCliSessionData | null {
  let d: any;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || !Array.isArray(d.steps)) return null;

  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const inWindow = (ts: any): boolean => {
    if (!Number.isFinite(sinceMs)) return true;
    const t = Date.parse(String(ts || ''));
    // Keep steps with no timestamp; only drop ones provably before `since`.
    return !Number.isFinite(t) || t >= sinceMs - 1000;
  };

  const prompts: string[] = [];
  const turns: Array<{ role: string; content: string }> = [];
  let toolCalls = 0;

  for (const s of d.steps) {
    const source = String(s?.source || '');
    if (source === 'system') continue;              // skip system prompt noise
    if (!inWindow(s?.timestamp)) continue;
    const message = typeof s?.message === 'string' ? s.message.trim() : '';

    if (source === 'user') {
      if (message) { prompts.push(message); turns.push({ role: 'user', content: truncate(message) }); }
      continue;
    }
    // Any non-system, non-user step is the agent (Devin uses source "agent").
    if (message) turns.push({ role: 'assistant', content: truncate(message) });
    const tcs = Array.isArray(s?.tool_calls) ? s.tool_calls : [];
    for (const tc of tcs) {
      toolCalls++;
      const fn = tc?.function_name || tc?.name || 'tool';
      let args = '';
      try { args = typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {}); } catch { args = ''; }
      turns.push({ role: 'assistant', content: `[Tool: ${fn}] ${truncate(args, 500)}` });
    }
  }

  const fm = d.final_metrics || {};
  const inputTokens = num(fm.total_prompt_tokens);
  const outputTokens = num(fm.total_completion_tokens);
  const cacheReadTokens = num(fm.total_cached_tokens);
  const tokensUsed = inputTokens + outputTokens;

  // Prefer the human model label ("SWE-1.6 Slow"); fall back to a per-step
  // generation_model slug ("swe-1-6-slow") if the header lacks it.
  let model = typeof d?.agent?.model_name === 'string' ? d.agent.model_name.trim() : '';
  if (!model) {
    for (const s of d.steps) {
      const gm = s?.extra?.generation_model;
      if (typeof gm === 'string' && gm) { model = gm; break; }
    }
  }

  return {
    model: model || undefined,
    tokensUsed,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    toolCalls,
    prompts,
    transcript: turns.length > 0 ? JSON.stringify(turns) : undefined,
  };
}

// Read + parse the Devin CLI transcript for a hook's session_id. Returns null
// if the file is absent/unreadable/malformed (all non-fatal — capture falls
// back to prompt-only).
export function discoverDevinCliSessionData(
  sessionId: string,
  opts: { since?: string } = {},
): DevinCliSessionData | null {
  const p = findDevinCliTranscript(sessionId);
  if (!p) return null;
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return null; }
  if (!raw) return null;
  return parseDevinCliTranscript(raw, opts.since);
}

// List the Devin CLI transcript directories that exist on this machine (XDG /
// macOS / Windows), in preference order. Mirrors findDevinCliTranscript's base
// resolution but returns dirs so we can scan them.
function devinTranscriptDirs(): string[] {
  const home = os.homedir();
  const bases: string[] = [];
  if (process.env.XDG_DATA_HOME) bases.push(process.env.XDG_DATA_HOME);
  bases.push(path.join(home, '.local', 'share'));
  if (process.env.LOCALAPPDATA) bases.push(process.env.LOCALAPPDATA);
  bases.push(path.join(home, 'AppData', 'Local'));
  return bases.map((b) => path.join(b, 'devin', 'cli', 'transcripts'));
}

// Locate a Devin CLI session's data WITHOUT its session_id — the hook's
// session_id doesn't match the transcript filename (see retagDevinFromProcess).
// The transcript is instead correlated by its content: it must contain one of
// `prompts` as a user message. Among transcripts modified at/after `since`
// (this session's start), returns the newest that matches. There is NO fallback
// to "the newest transcript" — that grabbed an UNRELATED session's transcript
// when the current turn wasn't flushed yet, and adopting its output clobbered
// the live-captured turn (the reported "output disappeared 3s later" bug). A
// genuine prompt match is the only accept condition; returns null otherwise.
export function discoverDevinCliSessionDataByPrompt(
  prompts: string[],
  opts: { since?: string } = {},
): DevinCliSessionData | null {
  const wanted = prompts.map((p) => (p || '').trim()).filter(Boolean);
  if (wanted.length === 0) return null;
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  // A small backdate tolerance: a transcript created a beat before the hook's
  // recorded start still belongs to this run.
  const cutoff = Number.isFinite(sinceMs) ? sinceMs - 60_000 : -Infinity;

  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const dir of devinTranscriptDirs()) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= cutoff) candidates.push({ path: full, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  }
  // Newest first — if two transcripts both match, the run in progress is newest.
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates) {
    let raw = '';
    try { raw = fs.readFileSync(c.path, 'utf-8'); } catch { continue; }
    if (!raw) continue;
    // Parse UNFILTERED: correlate on the file's full prompt history, and token
    // metrics are session-cumulative (final_metrics) regardless of `since`.
    const data = parseDevinCliTranscript(raw);
    if (!data) continue;
    const filePrompts = data.prompts.map((p) => p.trim());
    if (filePrompts.some((p) => wanted.some((w) => p === w || p.includes(w) || w.includes(p)))) {
      return data;
    }
  }
  return null;
}
