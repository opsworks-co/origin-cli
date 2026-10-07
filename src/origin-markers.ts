// Origin authoring markers → structured buckets, for git notes.
//
// Agents are asked (via buildOriginFrameworkGuidance in commands/hooks.ts)
// to emit four marker types inline as they work:
//
//   [Origin: Intent]   <one sentence on WHY this change>
//   [Origin: Decision] <choice> — <rationale>
//   [Origin: Open]     <unresolved thing>
//   [Origin: Verify]   <reviewer-check item>
//   [Origin: Closes]   <id or text of a PRIOR session's [Origin: Open] item>
//
// The server parses these from the stored transcript for the PR review
// surface (apps/api/src/services/self-reported-brief.ts). This module is
// the CLI-side mirror: it parses the SAME markers at Stop and session-end
// and stores them in refs/notes/origin so the "why" behind a change travels
// with the repo and can be pulled per-file by a later agent
// (get_file_context) — without an Origin DB account.
//
// Kept regex-compatible with the server parser so both surfaces agree.

import * as fs from 'fs';
import { cleanPrompt } from './transcript.js';

// Case-insensitive marker name, optional surrounding whitespace, optional
// leading bullet/quote prefix (the caller strips that clutter first).
// Captures the marker name and the content tail.
//
// ANCHORED at line start (^) on purpose. An emitted marker always opens its
// line — the guidance says so — whereas text that merely *mentions* the
// marker has it mid-sentence: source comments ("explicit [Origin: Decision]
// markers and/or the LLM summary"), docs HTML ("<code>[Origin: Decision]
// </code>"), and the guidance's own "Filled example: [Origin: Decision] used
// bcrypt over argon2 …" line. Unanchored, all of those were harvested as real
// decisions and written to git notes, where a later agent pulled them in as
// prior context. Trading a little recall for precision is the right call: a
// missed marker is invisible, a fabricated one actively misleads.
//
// `Closes` is the inverse of `Open` and the only marker that refers BACKWARDS,
// to a leftover some earlier session recorded. It is deliberately not parsed by
// the server's brief (self-reported-brief.ts): the PR surface reports what this
// change did, and discharging a months-old leftover is a fact about the repo's
// memory, not about the diff under review. The two parsers stay compatible in
// the sense that matters — neither invents a bucket the other would mis-file.
const MARKER_RE = /^\[Origin:\s*(Intent|Decision|Open|Verify|Closes)\s*\]\s*(.+?)\s*$/i;

// Keep notes push-friendly: cap items per bucket and content length.
const MAX_PER_BUCKET = 12;
const CONTENT_MAX = 400;

export interface OriginMarkers {
  intent?: string[];
  decision?: string[];
  open?: string[];
  verify?: string[];
  /** Prior leftovers this session says it discharged. See MARKER_RE. */
  closes?: string[];
}

// True when at least one bucket has an entry.
export function hasMarkers(m: OriginMarkers | undefined): m is OriginMarkers {
  return !!m && !!(m.intent?.length || m.decision?.length || m.open?.length || m.verify?.length || m.closes?.length);
}

// True when a marker's content is just the unfilled template — angle-bracket
// placeholders (e.g. "<one sentence on WHY…>" or "<choice you made> — <why>")
// with nothing but glue between them. Some agents (seen with Codex) echo the
// [Origin: …] template verbatim instead of filling it in; those placeholders
// must not be stored in git notes (or shown on the PR surface). Real prose
// never reduces to empty; generics like "Map<string, any>" keep "Map".
// Mirrors self-reported-brief.ts on the server so both surfaces agree.
function isPlaceholderMarker(content: string): boolean {
  const withoutPlaceholders = content.replace(/<[^>]*>/g, '');
  // Quotes/brackets/emphasis count as glue too. The template also reaches us
  // as a SOURCE line — `'  [Origin: Decision] <choice you made> — <why>',` in
  // hooks.ts — whose trailing `',` left one non-glue char behind and let the
  // placeholder through.
  return withoutPlaceholders.replace(/[\s—–\-:.,;/|()"'`[\]{}*_]+/g, '').length === 0;
}

// Light cleanup — mirrors the server's cleanContent: strip wrapping
// quotes, collapse whitespace, cap length, drop a single trailing period.
function cleanContent(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // Strip wrapping quotes only when they PAIR. Stripping any leading quote
  // ate the opening backtick of content that starts with an inline-code span
  // (`` `parseMarkers…` appears to match … ``), storing a mangled sentence.
  while (s.length > 1 && /["'`]/.test(s[0]) && s[0] === s[s.length - 1]) {
    s = s.slice(1, -1).trim();
  }
  // A bold-wrapped marker (`**[Origin: Decision]** chose X`) leaves the
  // closing emphasis at the head of the content once the opening `*`s are
  // stripped as line clutter.
  s = s.replace(/^[*_]+\s*/, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > CONTENT_MAX) s = s.slice(0, CONTENT_MAX - 1).trimEnd() + '…';
  s = s.replace(/\.\s*$/, '');
  return s;
}

// Parse markers from already-extracted plain text (one marker per line).
// De-dupes by (kind, lowercased content) and caps each bucket.
export function parseOriginMarkers(text: string | null | undefined): OriginMarkers | undefined {
  if (!text) return undefined;
  const buckets: Record<'intent' | 'decision' | 'open' | 'verify' | 'closes', string[]> = {
    intent: [], decision: [], open: [], verify: [], closes: [],
  };
  const seen = new Set<string>();

  for (const rawLine of text.split('\n')) {
    // Cap line length to avoid pathological backtracking on giant
    // single-line outputs, then strip leading list/quote clutter.
    const line = rawLine.length > 4000 ? rawLine.slice(0, 4000) : rawLine;
    const cleaned = line.replace(/^[\s>*\-+•]+/, '');
    const m = cleaned.match(MARKER_RE);
    if (!m) continue;
    const kind = m[1].toLowerCase() as 'intent' | 'decision' | 'open' | 'verify' | 'closes';
    const content = cleanContent(m[2]);
    if (!content) continue;
    // Drop unfilled template placeholders — don't persist "<one sentence…>"
    // into git notes where a later agent would pull it as prior context.
    if (isPlaceholderMarker(content)) continue;
    const key = `${kind}::${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (buckets[kind].length < MAX_PER_BUCKET) buckets[kind].push(content);
  }

  const out: OriginMarkers = {};
  if (buckets.intent.length) out.intent = buckets.intent;
  if (buckets.decision.length) out.decision = buckets.decision;
  if (buckets.open.length) out.open = buckets.open;
  if (buckets.verify.length) out.verify = buckets.verify;
  if (buckets.closes.length) out.closes = buckets.closes;
  return hasMarkers(out) ? out : undefined;
}

// Extract human-readable text from a stored transcript blob. Transcripts
// come in several shapes across agents; markers are literal text lines
// that live inside JSON string values (JSONL for Claude Code, a
// DisplayMessage[] array for some, plain text for others). We normalize
// all of them to newline-joined text so the line-based marker regex sees
// each marker on its own line:
//   - DisplayMessage[] JSON  → join each message's string content
//   - JSONL (one JSON/line)  → collect the authored string leaves per line
//   - anything else          → the raw line, unchanged
// JSON.parse turns escaped "\n" inside a content string into real
// newlines, so a marker embedded mid-message still lands on its own line.
//
// Scoped to what the AGENT AUTHORED. A marker only means something when the
// agent wrote it about its own work; the same characters appearing in a file
// it read, a command's output, a user prompt, or the framework guidance the
// CLI itself injects are somebody else's words. Collecting every string leaf
// meant the guidance template — which carries a worked example — was scraped
// back out of the transcript as if the agent had decided it, so notes filled
// with "used bcrypt over argon2" from repos that never touched bcrypt.
export function extractTranscriptText(transcript: string | null | undefined): string {
  if (!transcript) return '';
  const trimmed = transcript.trim();

  // DisplayMessage[] / [{role,content}] form.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      if (Array.isArray(arr)) {
        return joinAuthored(
          arr.map((m) => ({
            authored: isAssistantAuthored(m),
            text:
              typeof (m as { content?: unknown })?.content === 'string'
                ? ((m as { content: string }).content)
                : collectAuthoredStrings(m),
          })),
        );
      }
    } catch { /* fall through to line mode */ }
  }

  // JSONL / mixed. Parse each line; collect authored strings on success.
  const rows: AuthoredChunk[] = [];
  for (const line of transcript.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const rec = JSON.parse(t);
        rows.push({ authored: isAssistantAuthored(rec), text: collectAuthoredStrings(rec) });
        continue;
      } catch { /* not JSON — use raw */ }
    }
    rows.push({ authored: false, text: line });
  }
  return joinAuthored(rows);
}

interface AuthoredChunk { authored: boolean; text: string }

// Prefer agent-authored chunks; fall back to everything when the transcript
// shape carries no authorship at all (plain-text logs, unknown agents). The
// fallback is why the anchored MARKER_RE matters — it's the only guard left
// when we can't tell who wrote a line.
function joinAuthored(rows: AuthoredChunk[]): string {
  const authored = rows.filter((r) => r.authored);
  return (authored.length ? authored : rows).map((r) => r.text).join('\n');
}

// Keys whose values are tool payloads rather than agent prose: file contents
// the agent read or wrote, command output, and the context Origin's own hooks
// inject. Markers inside these are never self-reports — an agent that reads
// hooks.ts (which contains the template) must not thereby "decide" it.
const TOOL_PAYLOAD_KEYS = new Set([
  'input', 'args', 'arguments', 'command', 'cmd',
  'toolUseResult', 'tool_result', 'toolResult', 'output', 'stdout', 'stderr',
  'attachment', 'additionalContext', 'hookAdditionalContext', 'hookInfos', 'hookErrors',
]);

// Content-block types that carry tool traffic rather than authored text.
// `custom_tool_call` is the Codex 0.145+ exec wrapper.
const TOOL_BLOCK_TYPES = new Set([
  'tool_use', 'tool_result', 'custom_tool_call', 'custom_tool_call_output',
  'function_call', 'function_call_output',
]);

// True when a record was authored by the agent. Deep — Codex nests the role
// under `payload`, Gemini tags its turns `type:"gemini"` — but bounded, and
// paired with collectAuthoredStrings' key skipping so a tool result that
// happens to embed a sub-agent's assistant message still contributes no text.
function isAssistantAuthored(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  const role = typeof o.role === 'string' ? o.role.toLowerCase() : '';
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  if (role === 'assistant' || role === 'model' || role === 'agent') return true;
  if (type === 'assistant' || type === 'gemini') return true;
  for (const [k, v] of Object.entries(o)) {
    if (TOOL_PAYLOAD_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && isAssistantAuthored(v, depth + 1)) return true;
  }
  return false;
}

// Depth-limited collection of the string leaves a record's author actually
// wrote, joined with newlines. Agent-agnostic: wherever the marker text lives
// in the object tree it ends up on its own line for the regex, minus the tool
// payloads.
function collectAuthoredStrings(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => collectAuthoredStrings(v, depth + 1)).join('\n');
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
    if (TOOL_BLOCK_TYPES.has(type)) return '';
    return Object.entries(o)
      .filter(([k]) => !TOOL_PAYLOAD_KEYS.has(k))
      .map(([, v]) => collectAuthoredStrings(v, depth + 1))
      .join('\n');
  }
  return '';
}

// Convenience: transcript blob → markers.
export function parseMarkersFromTranscript(
  transcript: string | null | undefined,
): OriginMarkers | undefined {
  return parseOriginMarkers(extractTranscriptText(transcript));
}

/**
 * Union `[Origin: Closes]` ids from several already-parsed marker sets.
 *
 * Stop sees the same claim in more than one place (the transcript file, the
 * parsed blob, a last-assistant-message on stdin). De-duping here means the
 * recorder does not have to care which source won.
 */
export function closesFromMarkers(
  ...sources: Array<OriginMarkers | undefined | null>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const raw of src?.closes || []) {
      const c = raw.trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// Read markers straight from a transcript file. Used by the note-write
// paths (missing-notes fallback, post-commit) that don't already hold a
// parsed transcript in memory — notably Codex, which often writes its
// notes via those paths rather than the main session-end write. Caps the
// read so a huge transcript can't stall a commit, and is fully best-effort
// (any error → undefined). Reads only the TAIL of very large transcripts,
// where the wrap-up markers ([Origin: Open/Verify]) are most likely to be.
const TRANSCRIPT_READ_MAX_BYTES = 4 * 1024 * 1024;
export function parseMarkersFromTranscriptPath(
  transcriptPath: string | null | undefined,
): OriginMarkers | undefined {
  const raw = readTranscriptCapped(transcriptPath);
  return raw === undefined ? undefined : parseMarkersFromTranscript(raw);
}

function readTranscriptCapped(
  transcriptPath: string | null | undefined,
  maxBytes: number = TRANSCRIPT_READ_MAX_BYTES,
): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size <= maxBytes) return fs.readFileSync(transcriptPath, 'utf-8');
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const start = stat.size - maxBytes;
      fs.readSync(fd, buf, 0, maxBytes, start);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// ─── Markers per turn ────────────────────────────────────────────────────────
//
// A marker is the agent's account of the work of the turn it was written in.
// Parsing the whole transcript into one bag and stamping it on every commit
// the session made put a turn's decision on commits that had nothing to do
// with it — session 46b82050 tried a white-and-cyan logo on localhost, the
// user rejected it ("commit only video change, design change is not
// approved"), and "The logo on public pages became white with a cyan dot" was
// recorded as the decision behind three landing-page commits, none of which
// touched the logo. The repo's memory is what was COMMITTED: a marker belongs
// to a commit only when the turn that wrote it is the turn that made it.

export interface MarkerTurn {
  /** When the turn's prompt was sent (ms), when the transcript records it. */
  startedAt: number | null;
  markers: OriginMarkers | undefined;
  /**
   * The lines the turn's tool calls wrote into files, normalized (see
   * significantLine). How an earlier turn proves its work landed in a commit
   * made by a later one.
   */
  written?: string[];
}

/** A commit to place: when it was made, and the lines it added (normalized). */
export interface CommitEvidence {
  at: number;
  added?: ReadonlySet<string>;
  /**
   * The index (into the turns) of the turn that made it, when the caller
   * already knows it — the transcript watcher pairs commits with turns itself.
   * Places a commit in a transcript with no times, where `at` cannot.
   */
  turn?: number;
}

/** Split a transcript at its user prompts and parse each turn's markers. */
export function splitMarkersByTurn(transcript: string | null | undefined): MarkerTurn[] {
  if (!transcript) return [];
  const trimmed = transcript.trim();
  let records: unknown[] | null = null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const whole = JSON.parse(trimmed);
      if (Array.isArray(whole)) records = whole;
      else if (Array.isArray(whole?.messages)) records = whole.messages;
    } catch { /* JSONL — line mode */ }
  }
  const rows: Array<{ rec: unknown; authored: boolean; text: string }> = [];
  if (records) {
    for (const m of records) {
      rows.push({
        rec: m,
        authored: isAssistantAuthored(m),
        text: typeof (m as { content?: unknown })?.content === 'string'
          ? (m as { content: string }).content
          : collectAuthoredStrings(m),
      });
    }
  } else {
    for (const line of transcript.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('{') || t.startsWith('[')) {
        // A tool's RESULT is most of a long transcript's bytes (file reads,
        // command output) and holds no prompt, no authored marker and nothing
        // written, so it is not parsed at all. What reading it would have
        // given is exactly what skipping it gives: nothing.
        if (isToolResultLine(t)) continue;
        try {
          const rec = JSON.parse(t);
          rows.push({ rec, authored: isAssistantAuthored(rec), text: collectAuthoredStrings(rec) });
          continue;
        } catch { /* not JSON — use raw */ }
      }
      rows.push({ rec: null, authored: false, text: line });
    }
  }
  // Same fallback as joinAuthored: a transcript with no authorship at all is
  // read whole, per turn.
  const anyAuthored = rows.some((r) => r.authored);
  const turns: Array<{ startedAt: number | null; texts: string[]; written: Set<string> }> = [{ startedAt: null, texts: [], written: new Set() }];
  for (const r of rows) {
    if (r.rec && isUserPrompt(r.rec)) {
      turns.push({ startedAt: recordTime(r.rec), texts: [], written: new Set() });
      continue;
    }
    if (r.rec) collectWrittenLines(r.rec, turns[turns.length - 1].written);
    if (anyAuthored && !r.authored) continue;
    turns[turns.length - 1].texts.push(r.text);
  }
  // No prompt found means no turn boundary to go by: nothing can be placed.
  if (turns.length === 1) return [];
  return turns.map((t) => ({
    startedAt: t.startedAt,
    markers: parseOriginMarkers(t.texts.join('\n')),
    written: [...t.written],
  }));
}

// One hook asks for the same transcript's turns more than once (post-commit:
// the note, then the memory entry). Keyed on size and mtime, so a transcript
// that grew is read again.
let turnsCache: { key: string; turns: MarkerTurn[] } | null = null;

// Claude Code files a tool result as its own record carrying `toolUseResult`;
// Codex as a `*_call_output` item, named near the start of the line.
function isToolResultLine(line: string): boolean {
  if (line.includes('"toolUseResult"')) return true;
  return /"type":\s*"(?:custom_tool_call_output|function_call_output)"/.test(line.slice(0, 300));
}

// The whole transcript, not the 4 MB tail parseMarkersFromTranscriptPath
// reads: a decision belongs to the turn that wrote it, and in a long session
// the turn a commit needs is often hours back — session 46b82050's transcript
// was 11 MB and both its decisions were outside the tail. Bounded still, for a
// transcript nothing should ever grow to.
const MARKER_TURNS_MAX_BYTES = 256 * 1024 * 1024;

export function readMarkerTurns(transcriptPath: string | null | undefined): MarkerTurn[] {
  if (!transcriptPath) return [];
  let key = '';
  try {
    const st = fs.statSync(transcriptPath);
    key = `${transcriptPath}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    return [];
  }
  if (turnsCache?.key === key) return turnsCache.turns;
  const turns = splitMarkersByTurn(readTranscriptCapped(transcriptPath, MARKER_TURNS_MAX_BYTES));
  turnsCache = { key, turns };
  return turns;
}

// A commit's date has whole-second precision and is truncated, so a commit made
// in the same second its turn's prompt was sent can read as slightly earlier.
const COMMIT_TIME_SLACK_MS = 1000;

/**
 * The markers written in the turns that made these commits, merged.
 *
 * A commit's turn is the one the caller names (`turn`), else the last one whose
 * prompt was sent before it. A transcript that records no times (Cursor) and
 * gets none from the hook (withPromptTimes) cannot place a commit by time,
 * except in the turn still running: `currentTurnStartedAt` (the hook's own
 * record of the latest prompt) says whether the commit belongs to it. A commit that cannot be
 * placed contributes nothing — a missing decision is invisible, a decision
 * about work that was thrown away misleads whoever reads it next.
 *
 * An EARLIER turn joins when its work is in the commit: the agent made and
 * explained the change in one turn, and "looks good, commit it" in the next
 * made the commit. Its turn order and time alone cannot tell that apart from a
 * design tried and thrown away before the commit (session 46b82050), so it has
 * to show it: most of the lines its tool calls wrote are among the lines the
 * commit added (`added`). A commit given with no `added` gets its own turn's
 * markers only.
 *
 * `closes` is left out: it is a claim about an earlier session's leftover,
 * checked against what landed elsewhere (todo-sweep.ts), not about these
 * commits.
 */
export function markersOfCommitTurns(
  turns: MarkerTurn[],
  commits: Array<number | CommitEvidence>,
  opts: { currentTurnStartedAt?: number | null } = {},
): OriginMarkers | undefined {
  if (turns.length === 0) return undefined;
  const timed = turns.some((t) => t.startedAt !== null);
  const picked = new Set<number>();
  for (const c of commits) {
    const { at, added, turn } = typeof c === 'number' ? { at: c, added: undefined, turn: undefined } : c;
    let pick = -1;
    if (turn !== undefined) {
      if (Number.isInteger(turn) && turn >= 0 && turn < turns.length) pick = turn;
    } else if (!Number.isFinite(at)) {
      continue;
    } else if (timed) {
      for (let i = 0; i < turns.length; i++) {
        const s = turns[i].startedAt;
        if (s !== null && s <= at + COMMIT_TIME_SLACK_MS) pick = i;
      }
    } else if (opts.currentTurnStartedAt != null && at + COMMIT_TIME_SLACK_MS >= opts.currentTurnStartedAt) {
      pick = turns.length - 1;
    }
    if (pick < 0) continue;
    picked.add(pick);
    if (added && added.size > 0) {
      for (let j = 0; j < pick; j++) if (workLanded(turns[j].written, added)) picked.add(j);
    }
  }
  const sets = [...picked].sort((a, b) => a - b).map((i) => turns[i].markers);
  const merged = mergeMarkers(...sets);
  if (merged) delete merged.closes;
  return hasMarkers(merged) ? merged : undefined;
}

// Most of what the turn wrote is in the commit — at least half, and at least
// two lines unless it wrote only one. A turn that wrote nothing (or only
// deleted) has nothing to show and does not join.
function workLanded(written: string[] | undefined, added: ReadonlySet<string>): boolean {
  const lines = written || [];
  if (lines.length === 0) return false;
  let hit = 0;
  for (const l of lines) if (added.has(l)) hit++;
  return hit * 2 >= lines.length && hit >= Math.min(2, lines.length);
}

/**
 * A line as both sides compare it: trimmed, inner whitespace collapsed. Empty
 * when it is too generic to prove anything — short, or only punctuation (`});`,
 * `}`, `</div>`) — since those recur in any commit.
 */
export function significantLine(line: string): string {
  const t = line.trim().replace(/\s+/g, ' ');
  if (t.length < 8) return '';
  if (!/[A-Za-z0-9]{3}/.test(t)) return '';
  return t;
}

// Keys under a tool call that carry text written into a file, across agents:
// Claude Code / Cursor (new_string, content, contents, edits[].new_string),
// Gemini (new_string, content), Antigravity (CodeContent, ReplacementContent,
// ReplacementChunks[].ReplacementContent).
const WRITE_KEYS = new Set([
  'new_string', 'newString', 'new_str', 'content', 'contents', 'file_text', 'new_source',
  'CodeContent', 'ReplacementContent',
]);

// Gather the lines a record's tool calls wrote. Only inside tool-call nodes —
// a tool RESULT (a file the agent read) is somebody else's text.
function collectWrittenLines(rec: unknown, out: Set<string>): void {
  const visit = (v: unknown, inCall: boolean, key: string, depth: number): void => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      if (!inCall) return;
      // Codex apply_patch: the added lines are the `+` lines.
      if (/^\*\*\* Begin Patch/m.test(v)) {
        for (const l of v.split('\n')) if (l.startsWith('+') && !l.startsWith('+++')) add(l.slice(1));
        return;
      }
      // Double-encoded arguments (Antigravity, function_call.arguments).
      const t = v.trim();
      if ((t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) && t.length > 1) {
        try {
          const parsed = JSON.parse(t);
          if (typeof parsed !== 'string' || WRITE_KEYS.has(key)) {
            visit(parsed, true, key, depth + 1);
            return;
          }
        } catch { /* not JSON */ }
      }
      if (WRITE_KEYS.has(key)) for (const l of v.split('\n')) add(l);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, inCall, key, depth + 1);
      return;
    }
    if (typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type.toLowerCase() : '';
    if (type === 'tool_result' || type === 'custom_tool_call_output' || type === 'function_call_output') return;
    const call = inCall || type === 'tool_use' || type === 'custom_tool_call' || type === 'function_call';
    for (const [k, x] of Object.entries(o)) {
      if (k === 'toolUseResult') continue;
      visit(x, call || k === 'tool_calls' || k === 'functionCall', k, depth + 1);
    }
  };
  const add = (l: string) => {
    const s = significantLine(l);
    if (s) out.add(s);
  };
  visit(rec, false, '', 0);
}

/** Union of marker sets, de-duped per bucket, first seen first. */
export function mergeMarkers(...sets: Array<OriginMarkers | undefined | null>): OriginMarkers | undefined {
  const out: OriginMarkers = {};
  for (const kind of ['intent', 'decision', 'open', 'verify', 'closes'] as const) {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const s of sets) {
      for (const item of s?.[kind] || []) {
        const key = item.toLowerCase();
        if (seen.has(key) || items.length >= MAX_PER_BUCKET) continue;
        seen.add(key);
        items.push(item);
      }
    }
    if (items.length) out[kind] = items;
  }
  return hasMarkers(out) ? out : undefined;
}

// A prompt the user sent — the start of a turn. Not a tool result (Claude Code
// files those as `type: "user"`), not a harness injection — marked as meta,
// or recognisable only by its text, like a background task's
// `<task-notification>` (cleanPrompt, the same rule the prompt list uses) —
// not a compaction summary. Session 46b82050: a task notification landing
// mid-turn split the turn between its commit and the decision about it.
function isUserPrompt(rec: unknown): boolean {
  const text = userPromptText(rec);
  return text !== null && cleanPrompt(text) !== null;
}

function userPromptText(rec: unknown): string | null {
  if (!rec || typeof rec !== 'object') return null;
  const o = rec as Record<string, any>;
  if (o.isMeta || o.isCompactSummary || o.isSidechain || o.toolUseResult !== undefined) return null;
  // Antigravity: a step per line, the user's request wrapped in <USER_REQUEST>.
  if (o.type === 'USER_INPUT') {
    const c = String(o.content || '');
    return o.source === 'USER_EXPLICIT' && /<USER_REQUEST>/.test(c) ? c : null;
  }
  const payload = o.payload && typeof o.payload === 'object' ? o.payload : undefined;
  if (payload?.type === 'user_message') return typeof payload.message === 'string' && payload.message.trim() ? payload.message : null;
  const role = String(o.message?.role ?? o.role ?? payload?.role ?? (o.type === 'user' ? 'user' : '')).toLowerCase();
  if (role !== 'user') return null;
  const content = o.message?.content ?? o.content ?? payload?.content ?? o.parts;
  if (typeof content === 'string') return content.trim() ? content : null;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && typeof b === 'object' && (b.type === undefined || b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    return text.trim() ? text : null;
  }
  return null;
}

function recordTime(rec: unknown): number | null {
  const o = rec as Record<string, unknown>;
  const raw = o?.timestamp ?? o?.created_at ?? (o?.payload as Record<string, unknown> | undefined)?.timestamp;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
