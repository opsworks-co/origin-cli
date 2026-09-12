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
// the CLI-side mirror: it parses the SAME markers at session-end and
// stores them in refs/notes/origin so the "why" behind a change travels
// with the repo and can be pulled per-file by a later agent
// (get_file_context) — without an Origin DB account.
//
// Kept regex-compatible with the server parser so both surfaces agree.

import * as fs from 'fs';

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
  if (!transcriptPath) return undefined;
  try {
    const stat = fs.statSync(transcriptPath);
    let raw: string;
    if (stat.size <= TRANSCRIPT_READ_MAX_BYTES) {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(TRANSCRIPT_READ_MAX_BYTES);
        const start = stat.size - TRANSCRIPT_READ_MAX_BYTES;
        fs.readSync(fd, buf, 0, TRANSCRIPT_READ_MAX_BYTES, start);
        raw = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return parseMarkersFromTranscript(raw);
  } catch {
    return undefined;
  }
}
