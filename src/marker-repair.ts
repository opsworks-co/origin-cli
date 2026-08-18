// Retroactive repair for [Origin: …] markers already written to git notes.
//
// The extractor used to match `[Origin: Decision]` ANYWHERE in a line and to
// read every string in a transcript, including Origin's own injected guidance.
// That is fixed at the parser (anchored `^`, assistant-authored turns only) —
// but the fix only governs what is written NEXT. Notes already on disk, and on
// every remote and clone that fetched them, keep whatever the old parser
// stored, and `get_file_context` / `origin why` keep serving it.
//
// Repair cannot re-parse: the note holds the extracted CONTENT, not the source
// line, and the transcripts behind historical commits are long gone. So this
// re-validates each STORED string against signatures that only a false match
// produces, and is deliberately conservative — a genuine marker wrongly
// deleted is unrecoverable, while a junk one left behind is merely noise that
// the next repair can still catch.
//
// What it will NOT try to detect: truncation. Plenty of real junk reads like
// "…so `origin enable" (a marker that wrapped in its source), but a genuine
// marker capped at CONTENT_MAX ends the same way, and nothing in the stored
// string distinguishes them. Guessing there would delete real content.

export type MarkerKind = 'intent' | 'decision' | 'open' | 'verify';

export interface StoredMarkers {
  intent?: string[];
  decision?: string[];
  open?: string[];
  verify?: string[];
}

export interface MarkerVerdict {
  content: string;
  junk: boolean;
  reason?: 'marker-token' | 'placeholder' | 'template-example' | 'empty';
}

// The worked example from the guidance block Origin injects into every prompt.
// Agents that echoed the template verbatim stored this as a real decision.
const TEMPLATE_EXAMPLE = /used bcrypt over argon2/i;

// A marker token in the content is evidence of a false match only when the
// content OPENS with it, after any leading glue. That shape is a fragment the
// unanchored regex sliced out of prose:
//
//     /`[Origin: Verify]` markers. Reviewers stop reverse-engineering …
//
// A token appearing MID-sentence is the author legitimately writing about
// markers, and the anchored parser keeps it in the capture group:
//
//     [Origin: Decision] two decision sources — explicit [Origin: Decision]
//     markers as ground truth plus conservative LLM inference …
//
// The first version of this rule matched the token anywhere and deleted that
// second one. The premise it rested on — "a genuine marker's content does not
// re-introduce the token, the parser already consumed it as the prefix" — held
// for the OLD unanchored parser and does NOT hold for the anchored one. It was
// wrong for exactly the content most likely to discuss markers, which in a repo
// that builds marker tooling is a lot of it. This is also the only rule here
// that can destroy real content, so it gets the narrower test.
//
// The leading class deliberately excludes `[` so the token itself isn't eaten.
const MARKER_TOKEN = /^[^A-Za-z0-9\[]*\[origin:\s*(intent|decision|open|verify)\s*\]/i;

// Unfilled template placeholders: "<one sentence on WHY …>". Mirrors
// isPlaceholderMarker in origin-markers.ts — content that is nothing but
// angle-bracket placeholders and glue.
function isPlaceholder(content: string): boolean {
  const withoutPlaceholders = content.replace(/<[^>]*>/g, '');
  return withoutPlaceholders.replace(/[\s—–\-:.,;/|()"'`[\]{}*_]+/g, '').length === 0;
}

/** Judge one stored marker string. */
export function judgeMarker(content: string): MarkerVerdict {
  const s = (content ?? '').trim();
  if (!s) return { content, junk: true, reason: 'empty' };
  if (MARKER_TOKEN.test(s)) return { content, junk: true, reason: 'marker-token' };
  if (isPlaceholder(s)) return { content, junk: true, reason: 'placeholder' };
  if (TEMPLATE_EXAMPLE.test(s)) return { content, junk: true, reason: 'template-example' };
  return { content, junk: false };
}

export interface RepairResult {
  changed: boolean;
  markers?: StoredMarkers;
  dropped: Array<{ kind: MarkerKind; content: string; reason: string }>;
  kept: number;
}

const KINDS: MarkerKind[] = ['intent', 'decision', 'open', 'verify'];

/**
 * Re-validate a note's marker block. Returns the cleaned block, or undefined
 * for `markers` when nothing survives — an empty object would leave a marker
 * key on the note claiming markers exist.
 */
export function repairMarkers(markers: StoredMarkers | undefined | null): RepairResult {
  const dropped: RepairResult['dropped'] = [];
  const out: StoredMarkers = {};
  let kept = 0;

  if (!markers || typeof markers !== 'object') {
    return { changed: false, markers: markers ?? undefined, dropped, kept: 0 };
  }

  for (const kind of KINDS) {
    const list = (markers as any)[kind];
    if (!Array.isArray(list)) continue;
    const survivors: string[] = [];
    for (const raw of list) {
      if (typeof raw !== 'string') {
        dropped.push({ kind, content: String(raw), reason: 'empty' });
        continue;
      }
      const verdict = judgeMarker(raw);
      if (verdict.junk) dropped.push({ kind, content: raw, reason: verdict.reason! });
      else survivors.push(raw);
    }
    if (survivors.length > 0) {
      out[kind] = survivors;
      kept += survivors.length;
    }
  }

  const changed = dropped.length > 0;
  return {
    changed,
    markers: kept > 0 ? out : undefined,
    dropped,
    kept,
  };
}

/**
 * Repair a whole Origin note object in place-safe fashion. Notes are either
 * `{origin: {...}}` or the bare payload; both shapes appear in the wild.
 */
export function repairNoteObject(note: any): RepairResult & { note: any } {
  if (!note || typeof note !== 'object') {
    return { changed: false, dropped: [], kept: 0, note };
  }
  const holder = note.origin && typeof note.origin === 'object' ? note.origin : note;
  const result = repairMarkers(holder.markers);
  if (!result.changed) return { ...result, note };

  // Structured-clone so a caller comparing before/after sees a real diff.
  const copy = JSON.parse(JSON.stringify(note));
  const target = copy.origin && typeof copy.origin === 'object' ? copy.origin : copy;
  if (result.markers) target.markers = result.markers;
  else delete target.markers;
  return { ...result, note: copy };
}
