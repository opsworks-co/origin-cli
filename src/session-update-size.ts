// ── Keep a session PATCH inside what the server will accept ────────────────
//
// The API ignores a turn's `editsJson` longer than 500,000 characters
// (apps/api/src/routes/mcp.ts, both promptChanges blocks:
// `pc.editsJson.length <= 500_000`). The CLI never knew, and a long Claude
// Code session routinely crosses it: a commit-sourced edit
// (prompt-capture `appendCommitEdits` / `supplementUncoveredCommittedFiles`)
// carries the WHOLE file before and after the commit, so one commit touching
// hooks.ts and stop.ts put 930KB into a single turn.
//
// Session 874ff028 sent turn 0 as 1.16MB of editsJson and turn 7 as 943KB. The
// server dropped both — the rows lost their tool-call evidence and with it the
// authority to replace a stale diff — while every Stop still re-sent all of it,
// and the PATCH grew to 4.7MB, past what the hook's 8s budget can upload. Every
// update from then on timed out and queued, and the page froze.
//
// Commit-sourced edits are reconstructions, not authorship: the diff synthesis
// and blame skip them. Their contents are still read by some session-page
// paths (apps/api/src/routes/sessions.ts line claims and whole-file-write
// rebuilds, scoped-session-lines `hasContentlessWrite`), so shedding them
// loses a little there. But this only runs on an editsJson the server would
// discard WHOLE, so a trimmed copy still keeps more than the server would. An
// over-limit capture first sheds THEIR contents, keeping every edit and every
// tool-call byte. A capture still over the limit is omitted — the server would
// have discarded it anyway, and sending it only costs the upload.

/** The server's cap on one turn's editsJson, in JS string length. */
export const SERVER_EDITS_JSON_MAX_CHARS = 500_000;

/** Why an editsJson changed on the way out, for the hook log. */
export interface EditsJsonFit {
  promptIndex: number | null;
  before: number;
  after: number | null;
}

/**
 * `raw` if the server will accept it, else the same capture with its
 * commit-sourced edits' contents removed, else undefined when even that is
 * over the limit (or it cannot be parsed).
 */
export function fitEditsJsonForServer(raw: string): string | undefined {
  if (raw.length <= SERVER_EDITS_JSON_MAX_CHARS) return raw;
  let cap: any;
  try { cap = JSON.parse(raw); } catch { return undefined; }
  if (!cap || typeof cap !== 'object' || !Array.isArray(cap.edits)) return undefined;
  const edits = cap.edits.map((e: any) => {
    if (!e || typeof e !== 'object' || e.source !== 'commit') return e;
    if (e.oldContent === undefined && e.newContent === undefined) return e;
    const { oldContent: _old, newContent: _new, ...rest } = e;
    return { ...rest, contentOmitted: true };
  });
  const shed = JSON.stringify({ ...cap, edits });
  return shed.length <= SERVER_EDITS_JSON_MAX_CHARS ? shed : undefined;
}

/**
 * A session update whose promptChanges' editsJson all fit the server's limit.
 * Returns the input untouched when nothing needed fitting, so the common path
 * allocates nothing.
 */
export function fitSessionUpdateForServer<T>(data: T, onFit?: (fit: EditsJsonFit) => void): T {
  const rows = (data as any)?.promptChanges;
  if (!Array.isArray(rows)) return data;
  if (!rows.some((pc: any) => typeof pc?.editsJson === 'string' && pc.editsJson.length > SERVER_EDITS_JSON_MAX_CHARS)) {
    return data;
  }
  const promptChanges = rows.map((pc: any) => {
    if (typeof pc?.editsJson !== 'string' || pc.editsJson.length <= SERVER_EDITS_JSON_MAX_CHARS) return pc;
    const fitted = fitEditsJsonForServer(pc.editsJson);
    onFit?.({
      promptIndex: Number.isInteger(pc.promptIndex) ? pc.promptIndex : null,
      before: pc.editsJson.length,
      after: fitted === undefined ? null : fitted.length,
    });
    if (fitted === undefined) {
      const { editsJson: _dropped, ...rest } = pc;
      return rest;
    }
    return { ...pc, editsJson: fitted };
  });
  return { ...(data as any), promptChanges };
}
