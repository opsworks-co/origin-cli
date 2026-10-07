/**
 * Audit and scrub ONE already-written refs/notes/origin note (OR-49/A9).
 *
 * Pure: no git, no I/O. `origin scrub-notes` runs every note through
 * scrubNoteBody, and rewrites the ref only when every note is either clean or
 * safely rewritten — a blocked note stops the whole rewrite, because the ref
 * then cannot be called clean.
 *
 * Only the known prompt-derived carriers are removed:
 *
 *   origin.promptSummary, origin.fullPrompt, origin.markers,
 *   origin.prompts[].text, origin.prompts[].editsJson → promptText
 *
 * Everything else — unknown top-level fields, attribution_record, code edits,
 * files, stats, hashes, references — is kept as it is. A carrier with an
 * unexpected type, an editsJson that cannot be proven free of prompt text, or
 * a body that is not a JSON object is never guessed at: the note is reported
 * blocked and nothing is changed. A JSON object with no `origin` key at all
 * (record-only, rewrite and bare backfill notes) has none of the carriers and
 * is clean as it is.
 *
 * One lossy case exists, and only behind an explicit opt-in
 * (`dropUnprovableEdits`, `--drop-unprovable-edits`): an editsJson the writer
 * cut to the note budget, ending in EDITS_TRUNCATED_MARKER, whose kept prefix
 * provably holds prompt text. The prefix cannot be re-closed as JSON without
 * guessing, so the whole editsJson property is deleted and the rest of the
 * prompt entry is kept. Without the opt-in that note stays blocked.
 */

import { isDeepStrictEqual } from 'util';

/** Appended by the note writer when it cuts an editsJson to the note budget. */
export const EDITS_TRUNCATED_MARKER =
  '\n/* [origin: editsJson truncated for note portability] */';

export type PromptCarrier =
  | 'origin.promptSummary'
  | 'origin.fullPrompt'
  | 'origin.markers'
  | 'origin.prompts[].text'
  | 'origin.prompts[].editsJson.promptText';

export const PROMPT_CARRIERS: readonly PromptCarrier[] = [
  'origin.promptSummary',
  'origin.fullPrompt',
  'origin.markers',
  'origin.prompts[].text',
  'origin.prompts[].editsJson.promptText',
];

export type NoteBlockReason =
  /** The body is not JSON. */
  | 'not_json'
  /** JSON, but an array or a primitive rather than an object. */
  | 'not_json_object'
  /** The note has an `origin` key, but its value is not an object. */
  | 'origin_not_object'
  /** A carrier key holds a value of a type the writer never produced. */
  | 'carrier_wrong_type'
  /** origin.prompts is present but not an array. */
  | 'prompts_not_array'
  /** An origin.prompts entry is not an object. */
  | 'prompt_entry_not_object'
  /** origin.prompts[].editsJson is not a string. */
  | 'edits_json_wrong_type'
  /** editsJson is neither valid JSON nor a truncated prefix that can be read. */
  | 'edits_json_invalid'
  /** editsJson parses, but not to an object. */
  | 'edits_json_not_object'
  /**
   * A truncated editsJson still holds (part of) a prompt; it cannot be
   * rewritten without losing the edits. `dropUnprovableEdits` deletes it.
   */
  | 'edits_json_truncated';

export interface ScrubOptions {
  /**
   * Delete a whole origin.prompts[].editsJson that is an Origin-truncated
   * prefix (exact EDITS_TRUNCATED_MARKER) whose kept bytes provably hold
   * prompt text. Lossy: that capture is already incomplete and is not kept.
   */
  dropUnprovableEdits?: boolean;
}

export type NoteScrubResult =
  | { status: 'clean'; changed: false; scrubbed: any }
  | {
    status: 'rewritten';
    changed: true;
    scrubbed: Record<string, any>;
    /** Prompt carriers removed in place; the values around them are kept. */
    removed: Partial<Record<PromptCarrier, number>>;
    /** Whole editsJson values deleted under dropUnprovableEdits. */
    droppedEditsJson: number;
  }
  | { status: 'blocked'; changed: false; scrubbed: any; reason: NoteBlockReason; field: string };

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

// ─── Truncated editsJson ──────────────────────────────────────────────────
//
// The writer cuts an editsJson over the note budget and appends
// EDITS_TRUNCATED_MARKER, so the stored value is a JSON prefix. Notes written
// metadata-only blank promptText BEFORE that cut, so most truncated values are
// clean — but that has to be proven from the bytes, not assumed. This reads
// the prefix as JSON tokens (never a regex over the text) and reports what the
// top-level `promptText` key holds in the bytes that were kept.

type TruncatedPromptText = 'absent' | 'empty' | 'present' | 'unreadable';

function readTruncatedPromptText(prefix: string): TruncatedPromptText {
  let i = 0;
  const n = prefix.length;
  const ws = () => { while (i < n && ' \t\n\r'.includes(prefix[i])) i++; };
  // A JSON string starting at prefix[i] === '"'. Returns its value, or null
  // when the prefix ends inside it; throws on an invalid escape.
  const str = (): string | null => {
    i++;
    let out = '';
    while (i < n) {
      const c = prefix[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        if (i + 1 >= n) return null;
        const e = prefix[i + 1];
        if (e === 'u') {
          if (i + 6 > n) return null;
          const hex = prefix.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in simple)) throw new Error('bad escape');
        out += simple[e];
        i += 2;
        continue;
      }
      // JSON.stringify escapes every control character; a raw one means
      // these bytes were not written as JSON.
      if (c < ' ') throw new Error('raw control character');
      out += c;
      i++;
    }
    return null;
  };
  // Skip one value of any type. Returns false when the prefix ends inside it.
  const skipValue = (): boolean => {
    ws();
    if (i >= n) return false;
    const c = prefix[i];
    if (c === '"') return str() !== null;
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (i < n && prefix[i] === close) { i++; return true; }
      for (;;) {
        if (c === '{') {
          ws();
          if (i >= n) return false;
          if (prefix[i] !== '"') throw new Error('bad key');
          if (str() === null) return false;
          ws();
          if (i >= n) return false;
          if (prefix[i] !== ':') throw new Error('bad colon');
          i++;
        }
        if (!skipValue()) return false;
        ws();
        if (i >= n) return false;
        if (prefix[i] === ',') { i++; continue; }
        if (prefix[i] === close) { i++; return true; }
        throw new Error('bad separator');
      }
    }
    const lit = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(prefix.slice(i));
    if (!lit) {
      // The prefix may end inside a literal ("tr", "12").
      if (/^[-\d.eE+truefalsn]*$/.test(prefix.slice(i))) { i = n; return false; }
      throw new Error('bad literal');
    }
    i += lit[0].length;
    // A literal that runs to the very end may itself be cut short.
    return i < n;
  };

  try {
    ws();
    if (prefix[i] !== '{') return 'unreadable';
    i++;
    let seen: TruncatedPromptText = 'absent';
    for (;;) {
      ws();
      if (i >= n) return seen;
      if (prefix[i] === '}') return seen;
      if (prefix[i] !== '"') return 'unreadable';
      const key = str();
      if (key === null) return seen;
      ws();
      if (i >= n) return seen;
      if (prefix[i] !== ':') return 'unreadable';
      i++;
      ws();
      if (i >= n) return seen;
      if (key === 'promptText') {
        if (prefix[i] !== '"') return 'unreadable';
        const value = str();
        // Cut inside the string: whatever was kept is prompt text.
        if (value === null) return 'present';
        if (value.length > 0) return 'present';
        seen = 'empty';
      } else if (!skipValue()) {
        return seen;
      }
      ws();
      if (i >= n) return seen;
      if (prefix[i] === ',') { i++; continue; }
      if (prefix[i] === '}') return seen;
      return 'unreadable';
    }
  } catch {
    return 'unreadable';
  }
}

// What the kept prefix of a value that is NOT valid JSON says about
// promptText; null when the value does not end in the writer's exact marker
// (then it is not an Origin-truncated editsJson at all).
function truncatedEditsJsonVerdict(raw: string): TruncatedPromptText | null {
  try {
    JSON.parse(raw);
    return null;
  } catch { /* not JSON: may be a truncated prefix */ }
  if (!raw.endsWith(EDITS_TRUNCATED_MARKER)) return null;
  return readTruncatedPromptText(raw.slice(0, -EDITS_TRUNCATED_MARKER.length));
}

/** True only for the one value dropUnprovableEdits may delete. */
export function isDroppableEditsJson(raw: unknown): boolean {
  return typeof raw === 'string' && truncatedEditsJsonVerdict(raw) === 'present';
}

type EditsJsonVerdict =
  | { kind: 'clean' }
  | { kind: 'rewrite'; value: string }
  | { kind: 'drop' }
  | { kind: 'blocked'; reason: NoteBlockReason };

function scrubEditsJson(raw: string, opts: ScrubOptions): EditsJsonVerdict {
  // An empty value carries nothing.
  if (raw.length === 0) return { kind: 'clean' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const verdict = truncatedEditsJsonVerdict(raw);
    if (verdict === 'absent' || verdict === 'empty') return { kind: 'clean' };
    if (verdict === 'present') return opts.dropUnprovableEdits ? { kind: 'drop' } : { kind: 'blocked', reason: 'edits_json_truncated' };
    return { kind: 'blocked', reason: 'edits_json_invalid' };
  }
  if (!isPlainObject(parsed)) return { kind: 'blocked', reason: 'edits_json_not_object' };
  if (!has(parsed, 'promptText')) return { kind: 'clean' };
  const text = parsed.promptText;
  if (typeof text !== 'string') return { kind: 'blocked', reason: 'carrier_wrong_type' };
  // The metadata-only writer blanks the prompt to "" — that form holds no text.
  if (text.length === 0) return { kind: 'clean' };
  delete parsed.promptText;
  return { kind: 'rewrite', value: JSON.stringify(parsed) };
}

/**
 * Classify one parsed note and, when it carries prompt text, return the
 * scrubbed copy. The input is never mutated. `changed`/`scrubbed` keep the
 * shape older callers read.
 */
export function scrubNoteObject(note: unknown, opts: ScrubOptions = {}): NoteScrubResult {
  const blocked = (reason: NoteBlockReason, field: string): NoteScrubResult =>
    ({ status: 'blocked', changed: false, scrubbed: note, reason, field });
  if (!isPlainObject(note)) return blocked('not_json_object', '');
  // Every carrier lives under `origin`: without that key there is none.
  if (!has(note, 'origin')) return { status: 'clean', changed: false, scrubbed: note };
  if (!isPlainObject(note.origin)) return blocked('origin_not_object', 'origin');

  const origin: Record<string, any> = { ...note.origin };
  const removed: Partial<Record<PromptCarrier, number>> = {};
  let droppedEditsJson = 0;
  const count = (carrier: PromptCarrier) => { removed[carrier] = (removed[carrier] ?? 0) + 1; };

  for (const key of ['promptSummary', 'fullPrompt'] as const) {
    if (!has(origin, key)) continue;
    if (typeof origin[key] !== 'string') return blocked('carrier_wrong_type', `origin.${key}`);
    delete origin[key];
    count(`origin.${key}`);
  }
  if (has(origin, 'markers')) {
    if (!isPlainObject(origin.markers)) return blocked('carrier_wrong_type', 'origin.markers');
    delete origin.markers;
    count('origin.markers');
  }
  if (has(origin, 'prompts')) {
    if (!Array.isArray(origin.prompts)) return blocked('prompts_not_array', 'origin.prompts');
    const prompts: unknown[] = [];
    for (const p of origin.prompts as unknown[]) {
      if (!isPlainObject(p)) return blocked('prompt_entry_not_object', 'origin.prompts[]');
      const np: Record<string, any> = { ...p };
      if (has(np, 'text')) {
        if (typeof np.text !== 'string') return blocked('carrier_wrong_type', 'origin.prompts[].text');
        delete np.text;
        count('origin.prompts[].text');
      }
      if (has(np, 'editsJson')) {
        if (typeof np.editsJson !== 'string') return blocked('edits_json_wrong_type', 'origin.prompts[].editsJson');
        const verdict = scrubEditsJson(np.editsJson, opts);
        if (verdict.kind === 'blocked') return blocked(verdict.reason, 'origin.prompts[].editsJson');
        if (verdict.kind === 'drop') {
          delete np.editsJson;
          droppedEditsJson++;
        } else if (verdict.kind === 'rewrite') {
          np.editsJson = verdict.value;
          count('origin.prompts[].editsJson.promptText');
        }
      }
      prompts.push(np);
    }
    origin.prompts = prompts;
  }

  if (Object.keys(removed).length === 0 && droppedEditsJson === 0) return { status: 'clean', changed: false, scrubbed: note };
  origin.promptTextWithheld = true;
  return { status: 'rewritten', changed: true, scrubbed: { ...note, origin }, removed, droppedEditsJson };
}

/** scrubNoteObject over a raw note body; a body that is not JSON is blocked. */
export function scrubNoteBody(body: string, opts: ScrubOptions = {}): NoteScrubResult & { parsed?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'blocked', changed: false, scrubbed: body, reason: 'not_json', field: '' };
  }
  return { ...scrubNoteObject(parsed, opts), parsed };
}

/** How a rewritten note body is stored: the writer's own format. */
export function serializeScrubbedNote(note: unknown): string {
  return JSON.stringify(note, null, 2) + '\n';
}

// ─── Independent check of a rewrite ───────────────────────────────────────
//
// verifyScrubbedNote does not trust scrubNoteObject: it removes ONLY the
// allowlisted paths from both sides and requires everything left to be equal,
// so a rewrite that dropped or changed anything else is refused.

// `dropped`: indexes of prompt entries whose whole editsJson the rewrite
// deleted, already checked to be droppable.
function withoutAllowedPaths(note: Record<string, any>, dropped: ReadonlySet<number>): unknown {
  const origin: Record<string, any> = { ...note.origin };
  delete origin.promptSummary;
  delete origin.fullPrompt;
  delete origin.markers;
  delete origin.promptTextWithheld;
  if (Array.isArray(origin.prompts)) {
    origin.prompts = origin.prompts.map((p: any, i: number) => {
      if (!isPlainObject(p)) return p;
      const np: Record<string, any> = { ...p };
      delete np.text;
      if (dropped.has(i)) delete np.editsJson;
      if (typeof np.editsJson === 'string') {
        // Compare a parsed editsJson without its promptText; one that does not
        // parse stays a string and must then be byte-identical.
        try {
          const parsed = JSON.parse(np.editsJson);
          if (isPlainObject(parsed)) {
            delete parsed.promptText;
            np.editsJson = { parsedEditsJson: parsed };
          }
        } catch { /* compared as a string */ }
      }
      return np;
    });
  }
  return { ...note, origin };
}

/**
 * null when `after` is `before` minus prompt carriers and nothing else;
 * otherwise a short reason (no note content in it). A whole editsJson may be
 * missing from `after` only under `dropUnprovableEdits`, and only where the
 * source value is itself droppable (checked here again, not taken from the
 * scrub).
 */
export function verifyScrubbedNote(before: unknown, after: unknown, opts: ScrubOptions = {}): string | null {
  if (!isPlainObject(before) || !isPlainObject(before.origin)) return 'source is not an Origin note';
  if (!isPlainObject(after) || !isPlainObject(after.origin)) return 'rewrite is not an Origin note';
  if (scrubNoteObject(after).status !== 'clean') return 'rewrite still carries prompt text';
  if (after.origin.promptTextWithheld !== true) return 'rewrite is not marked promptTextWithheld';
  if (!isDeepStrictEqual(before.attribution_record, after.attribution_record)) return 'attribution_record changed';
  if (Array.isArray(before.origin.prompts) !== Array.isArray(after.origin.prompts)
    || (Array.isArray(before.origin.prompts) && before.origin.prompts.length !== after.origin.prompts.length)) {
    return 'prompt entries changed';
  }
  const dropped = new Set<number>();
  const beforePrompts: unknown[] = Array.isArray(before.origin.prompts) ? before.origin.prompts : [];
  for (let i = 0; i < beforePrompts.length; i++) {
    const src = beforePrompts[i];
    const out = after.origin.prompts[i];
    if (!isPlainObject(src) || !has(src, 'editsJson') || !isPlainObject(out) || has(out, 'editsJson')) continue;
    if (!opts.dropUnprovableEdits) return 'an editsJson was dropped without --drop-unprovable-edits';
    if (!isDroppableEditsJson(src.editsJson)) return 'a dropped editsJson was not a truncated capture holding prompt text';
    dropped.add(i);
  }
  if (!isDeepStrictEqual(withoutAllowedPaths(before, dropped), withoutAllowedPaths(after, dropped))) return 'a non-prompt field changed';
  return null;
}
