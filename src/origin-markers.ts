// Origin authoring markers → structured buckets, for git notes.
//
// Agents are asked (via buildOriginFrameworkGuidance in commands/hooks.ts)
// to emit four marker types inline as they work:
//
//   [Origin: Intent]   <one sentence on WHY this change>
//   [Origin: Decision] <choice> — <rationale>
//   [Origin: Open]     <unresolved thing>
//   [Origin: Verify]   <reviewer-check item>
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

// Tolerant: case-insensitive marker name, optional surrounding whitespace,
// optional leading bullet/quote prefix (handled by the caller stripping
// clutter). Captures the marker name and the content tail.
const MARKER_RE = /\[Origin:\s*(Intent|Decision|Open|Verify)\s*\]\s*(.+?)\s*$/i;

// Keep notes push-friendly: cap items per bucket and content length.
const MAX_PER_BUCKET = 12;
const CONTENT_MAX = 400;

export interface OriginMarkers {
  intent?: string[];
  decision?: string[];
  open?: string[];
  verify?: string[];
}

// True when at least one bucket has an entry.
export function hasMarkers(m: OriginMarkers | undefined): m is OriginMarkers {
  return !!m && !!(m.intent?.length || m.decision?.length || m.open?.length || m.verify?.length);
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
  return withoutPlaceholders.replace(/[\s—–\-:.,;/|()]+/g, '').length === 0;
}

// Light cleanup — mirrors the server's cleanContent: strip wrapping
// quotes, collapse whitespace, cap length, drop a single trailing period.
function cleanContent(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  if (s.length > CONTENT_MAX) s = s.slice(0, CONTENT_MAX - 1).trimEnd() + '…';
  s = s.replace(/\.\s*$/, '');
  return s;
}

// Parse markers from already-extracted plain text (one marker per line).
// De-dupes by (kind, lowercased content) and caps each bucket.
export function parseOriginMarkers(text: string | null | undefined): OriginMarkers | undefined {
  if (!text) return undefined;
  const buckets: Record<'intent' | 'decision' | 'open' | 'verify', string[]> = {
    intent: [], decision: [], open: [], verify: [],
  };
  const seen = new Set<string>();

  for (const rawLine of text.split('\n')) {
    // Cap line length to avoid pathological backtracking on giant
    // single-line outputs, then strip leading list/quote clutter.
    const line = rawLine.length > 4000 ? rawLine.slice(0, 4000) : rawLine;
    const cleaned = line.replace(/^[\s>*\-+•]+/, '');
    const m = cleaned.match(MARKER_RE);
    if (!m) continue;
    const kind = m[1].toLowerCase() as 'intent' | 'decision' | 'open' | 'verify';
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
  return hasMarkers(out) ? out : undefined;
}

// Extract human-readable text from a stored transcript blob. Transcripts
// come in several shapes across agents; markers are literal text lines
// that live inside JSON string values (JSONL for Claude Code, a
// DisplayMessage[] array for some, plain text for others). We normalize
// all of them to newline-joined text so the line-based marker regex sees
// each marker on its own line:
//   - DisplayMessage[] JSON  → join each message's string content
//   - JSONL (one JSON/line)  → deep-collect every string leaf per line
//   - anything else          → the raw line, unchanged
// JSON.parse turns escaped "\n" inside a content string into real
// newlines, so a marker embedded mid-message still lands on its own line.
export function extractTranscriptText(transcript: string | null | undefined): string {
  if (!transcript) return '';
  const trimmed = transcript.trim();

  // DisplayMessage[] / [{role,content}] form.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<{ content?: unknown }>;
      if (Array.isArray(arr)) {
        return arr
          .map((m) => (typeof m?.content === 'string' ? m.content : collectStrings(m)))
          .join('\n');
      }
    } catch { /* fall through to line mode */ }
  }

  // JSONL / mixed. Parse each line; deep-collect strings on success.
  const chunks: string[] = [];
  for (const line of transcript.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        chunks.push(collectStrings(JSON.parse(t)));
        continue;
      } catch { /* not JSON — use raw */ }
    }
    chunks.push(line);
  }
  return chunks.join('\n');
}

// Depth-limited collection of all string leaves in a parsed JSON value,
// joined with newlines. Agent-agnostic: wherever the marker text lives in
// the object tree, it ends up on its own line for the regex.
function collectStrings(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => collectStrings(v, depth + 1)).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((v) => collectStrings(v, depth + 1))
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
