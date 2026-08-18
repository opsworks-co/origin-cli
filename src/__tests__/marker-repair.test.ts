/**
 * Retroactive marker repair.
 *
 * This deletes captured content on a heuristic — the source transcripts are
 * gone, so a stored string can only be judged by its own shape. The tests that
 * matter most are therefore the NEGATIVE ones: a genuine marker wrongly
 * dropped is unrecoverable, while junk left behind is noise the next pass can
 * still catch. Every "keeps" case below is a real string from this repo's
 * notes or a near-miss deliberately chosen to sit close to a junk signature.
 */
import { describe, it, expect } from 'vitest';
import { judgeMarker, repairMarkers, repairNoteObject } from '../marker-repair.js';

describe('judgeMarker — junk signatures', () => {
  it('drops a fragment that OPENS with a marker token (prose ABOUT markers)', () => {
    // The old unanchored regex matched mid-sentence, so documentation and
    // source comments describing markers were stored as emissions. These lead
    // with the token, or with punctuation immediately before it.
    const v = judgeMarker('/`[Origin: Verify]` markers. Reviewers stop reverse-engineering the diff');
    expect(v.junk).toBe(true);
    expect(v.reason).toBe('marker-token');
    expect(judgeMarker('/ `[Origin: Verify]` markers the agent emitted').reason).toBe('marker-token');
    expect(judgeMarker('[Origin: Decision] a doubled prefix').reason).toBe('marker-token');
  });

  it('drops unfilled template placeholders', () => {
    expect(judgeMarker('<one sentence on WHY you\'re making this change>').reason).toBe('placeholder');
    expect(judgeMarker('<choice you made> — <why>').reason).toBe('placeholder');
  });

  it("drops the guidance block's worked example", () => {
    expect(judgeMarker('used bcrypt over argon2 — broader Node compatibility').reason)
      .toBe('template-example');
  });

  it('drops empty / whitespace-only content', () => {
    expect(judgeMarker('   ').reason).toBe('empty');
    expect(judgeMarker('').reason).toBe('empty');
  });
});

describe('judgeMarker — must NOT drop genuine markers', () => {
  it('keeps a real decision that merely mentions Origin', () => {
    expect(judgeMarker('Moved the live parser into codex.ts rather than patching it in place').junk).toBe(false);
    expect(judgeMarker('Server-first via a new /why endpoint reusing the trailer resolver').junk).toBe(false);
  });

  it('keeps content containing angle brackets that are not placeholders', () => {
    // Generics and comparisons are the obvious false positive for the
    // placeholder rule — "Map<string, any>" must survive.
    expect(judgeMarker('Used Map<string, any> for the cache rather than a plain object').junk).toBe(false);
    expect(judgeMarker('Guarded on n < 10 to keep the loop bounded').junk).toBe(false);
  });

  it('keeps content mentioning bcrypt in a real sentence', () => {
    // Only the template's exact pairing is junk; a genuine bcrypt decision is not.
    expect(judgeMarker('Hashed the reset token with bcrypt because the column is already sized for it').junk)
      .toBe(false);
  });

  it('keeps a truncated marker rather than guessing', () => {
    // Real junk often reads like this (a marker that wrapped in its source),
    // but a genuine marker capped at CONTENT_MAX ends identically. Nothing in
    // the stored string separates them, so this deliberately survives.
    expect(judgeMarker('Make binary detection work on native Windows so `origin enable').junk).toBe(false);
  });

  it('keeps the word "origin" on its own', () => {
    expect(judgeMarker('Pushed to origin rather than the fork').junk).toBe(false);
  });

  it('keeps a genuine decision that MENTIONS a marker token mid-sentence', () => {
    // Reported by a peer session running this judge over real notes. The author
    // wrote `[Origin: Decision] two decision sources — explicit [Origin:
    // Decision] markers as ground truth …`; the anchored parser consumes the
    // first token as the prefix and the second legitimately survives in the
    // content. Dropping it destroyed a real decision — and in a repo that
    // builds marker tooling, decisions ABOUT markers are common.
    expect(judgeMarker(
      'two decision sources — explicit [Origin: Decision] markers as ground truth '
      + 'plus conservative LLM inference — so capture works with and without an LLM key',
    ).junk).toBe(false);
  });
});

describe('repairMarkers', () => {
  it('drops only the junk entries and keeps the rest of the bucket', () => {
    const r = repairMarkers({
      decision: ['A real decision', '/`[Origin: Decision]` markers in the docs'],
      verify: ['Check the deploy'],
    });
    expect(r.changed).toBe(true);
    expect(r.markers).toEqual({ decision: ['A real decision'], verify: ['Check the deploy'] });
    expect(r.kept).toBe(2);
    expect(r.dropped).toHaveLength(1);
  });

  it('reports unchanged when everything is genuine', () => {
    const markers = { intent: ['Fix the badge'], verify: ['Check it live'] };
    const r = repairMarkers(markers);
    expect(r.changed).toBe(false);
    expect(r.kept).toBe(2);
  });

  it('returns undefined markers when NOTHING survives', () => {
    // An empty {} would leave a `markers` key asserting markers exist.
    const r = repairMarkers({ decision: ['<choice you made> — <why>'] });
    expect(r.changed).toBe(true);
    expect(r.markers).toBeUndefined();
  });

  it('tolerates a missing or malformed block', () => {
    expect(repairMarkers(undefined).changed).toBe(false);
    expect(repairMarkers(null).changed).toBe(false);
    expect(repairMarkers({ decision: 'not an array' } as any).changed).toBe(false);
  });
});

describe('repairNoteObject', () => {
  const junk = '/`[Origin: Verify]` markers. Reviewers stop reverse-engineering';

  it('handles the {origin: …} note shape', () => {
    const note = { origin: { sessionId: 's1', markers: { decision: ['Real one', junk] } } };
    const out = repairNoteObject(note);
    expect(out.changed).toBe(true);
    expect(out.note.origin.markers).toEqual({ decision: ['Real one'] });
    expect(out.note.origin.sessionId).toBe('s1');
  });

  it('handles the bare payload shape', () => {
    const out = repairNoteObject({ sessionId: 's2', markers: { verify: [junk] } });
    expect(out.changed).toBe(true);
    expect(out.note.markers).toBeUndefined();
    expect(out.note.sessionId).toBe('s2');
  });

  it('does not mutate the input note', () => {
    const note = { origin: { markers: { decision: ['Real one', junk] } } };
    repairNoteObject(note);
    expect(note.origin.markers.decision).toHaveLength(2); // original untouched
  });

  it('leaves an unchanged note byte-identical', () => {
    const note = { origin: { sessionId: 's3', markers: { intent: ['Ship it'] } } };
    const out = repairNoteObject(note);
    expect(out.changed).toBe(false);
    expect(out.note).toBe(note); // same reference — no rewrite triggered
  });

  it('leaves notes with no markers alone', () => {
    const note = { origin: { sessionId: 's4', promptCount: 3 } };
    const out = repairNoteObject(note);
    expect(out.changed).toBe(false);
    expect(out.note).toBe(note);
  });

  it('ignores non-object input rather than throwing', () => {
    expect(repairNoteObject(null as any).changed).toBe(false);
    expect(repairNoteObject('a string' as any).changed).toBe(false);
  });
});
