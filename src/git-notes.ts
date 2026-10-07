import { execFileSync } from 'child_process';
import { cachedWriteKey, seal, type SealedPromptFields } from './note-seal.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { redactSecrets } from './redaction.js';
import { api } from './api.js';
import type { OriginMarkers } from './origin-markers.js';
import { cachedGitIdentity, gitIdentityEnv, identityEnvFor, recordGitIdentity } from './utils/exec.js';
import { debugLog } from './debug-log.js';
import {
  foldRemoteMemory,
  foldRemoteMemoryBrief,
  reconcileMemoryWithRemote,
  reconcileMemoryBriefWithRemote,
} from './memory.js';
import {
  ATTRIBUTION_RECORD_NOTE_KEY,
  buildAttributionRecordForCommit,
  type AttributionRecordSource,
} from './attribution-note.js';
import { cliVersion } from './cli-version.js';
import { mergeSessionNoteOverRewrite } from './history-rewrite.js';
import { withNoteWriteLock, type NoteLease } from './note-write-lock.js';
import { isPromptHash, provablePromptHash } from './prompt-hash.js';
import { shouldIncludePromptText } from './prompt-privacy.js';
import { EDITS_TRUNCATED_MARKER, scrubNoteObject } from './note-scrub.js';

function redact(text: string): string {
  return redactSecrets(text || '').redacted;
}

const TRUNCATED_MARKER = '…[truncated]';

function redactAndCap(text: string, maxBytes: number): string {
  const out = redact(text);
  const buf = Buffer.from(out, 'utf-8');
  if (buf.length <= maxBytes) return out;
  // Slice on byte boundaries, then re-decode. `Buffer.toString('utf-8')`
  // replaces partial multi-byte sequences with U+FFFD, so we don't emit
  // invalid UTF-8 even when the cap lands mid-codepoint.
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf-8');
  const head = buf.subarray(0, Math.max(0, maxBytes - markerBytes)).toString('utf-8');
  return head + TRUNCATED_MARKER;
}

/**
 * Write Origin metadata as Git Notes on each commit SHA.
 * Uses a custom ref `refs/notes/origin` to avoid conflicts with user's own notes.
 *
 * Notes are portable — they travel with the repo when pushed:
 *   git push origin refs/notes/origin
 *
 * Read a note:
 *   git notes --ref=origin show <SHA>
 */

// Caps keep the per-commit note small enough to push without bloating the repo.
// fullPrompt is the largest contributor; 8KB after redaction is a reasonable
// budget for next-agent context (≈1500 tokens of preceding intent).
const FULL_PROMPT_MAX_BYTES = 8 * 1024;
const FILES_READ_MAX = 100;

export interface GitNoteData {
  sessionId: string;
  model: string;
  agentSlug?: string;
  promptCount: number;
  // Prompt text: serialized only with the explicit notesIncludePrompts opt-in.
  promptSummary: string;
  // The last prompt, whole and unredacted as the hooks captured it. The note
  // stores it redacted and capped at ~8KB, and only with the opt-in; its
  // `promptHash` (see prompt-hash.ts) is written either way when provable.
  fullPrompt?: string;
  // Pointer to the previous Origin session in this repo, captured at
  // session-start from refs/notes/origin-memory. Lets readers walk a chain of
  // sessions to reconstruct evolution of a feature across commits.
  previousSessionId?: string;
  // Files the agent loaded into context during this session (unique paths,
  // capped). Helps the next agent understand what the prior agent saw —
  // not just what it changed.
  filesRead?: string[];
  // Per-prompt attribution that travels with the repo. Each entry records
  // who/what wrote a prompt's work — anyone who clones the repo and fetches
  // refs/notes/origin can see this without an Origin DB account, so an
  // entry's text travels only with the opt-in. Capped per-prompt to keep
  // notes under push-friendly size limits.
  prompts?: PromptNoteEntry[];
  // The agent's own `[Origin: Intent/Decision/Open/Verify]` markers, parsed
  // from this session's transcript. This is the "why" behind the change —
  // the single most valuable thing for the NEXT agent (it stops a later
  // agent "fixing" something that was deliberate). Only what the turn that
  // made the commit wrote — writers pass `markersForCommit` for that.
  // Treated as prompt text for privacy: withheld when notes are metadata-only.
  markers?: OriginMarkers;
  // Per commit instead of `markers`: the markers of the turn that made it. A
  // session's markers are not every commit's — see committed-markers.ts.
  markersForCommit?: (sha: string) => OriginMarkers | undefined;
  // Origin web URL where the full session can be inspected (for users in
  // the same org) — the permissioned home of the prompts a note no longer
  // carries by default.
  originUrl: string;
  // Session telemetry. OPTIONAL because not every writer knows it: the
  // post-commit hook writes the note before the transcript is parsed, and it
  // used to hardcode `tokensUsed: 0, costUsd: 0, durationMs: 0` — a note that
  // asserted a real session cost nothing and took no time. An absent field
  // reads as "not measured here"; a zero reads as a measurement. Omitted from
  // the serialized note when undefined.
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  linesAdded: number;
  linesRemoved: number;
  aiPercentage?: number;
  humanPercentage?: number;
  mixedPercentage?: number;
  snapshot?: boolean;
  snapshotAt?: string;
  filesChanged?: string[];
  // Real sub-agents (Claude Code `Task` spawns) this session launched — the
  // honest "N sub-agents" record. Each entry names the configured sub-agent
  // type and the parent turn it ran under. Empty/absent when none were used.
  subagents?: Array<{ type: string | null; promptIndex: number; files?: string[] }>;
  // Source of the canonical v1 record embedded next to `origin` (see
  // attribution-note.ts). Absent: the note is legacy-only.
  attribution?: AttributionRecordSource;
}

// Per-prompt attribution row stored inside the commit note. Optional fields
// are dropped when empty to keep the serialized JSON compact.
export interface PromptNoteEntry {
  index: number;
  text: string;                     // serialized redacted, capped per PROMPT_TEXT_MAX_BYTES, opt-in only
  /** Canonical hash of this prompt's permissioned record, when provable
   *  (buildPromptNoteEntries / prompt-hash.ts). Written with or without text. */
  promptHash?: string;
  agent?: string;                   // codex, claude, cursor, gemini
  model?: string;                   // gpt-5.5, claude-opus, ...
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;               // ISO 8601
  files?: string[];                 // files this prompt edited
  /** JSON-encoded PromptCapture (see prompt-capture/types.ts). Lets a
   *  different Origin org importing this repo run AI Blame from the
   *  authoritative LCS-replay path. Capped at EDITS_JSON_MAX_BYTES per
   *  entry so notes stay push-friendly even on big sessions. */
  editsJson?: string;
  /** Working-tree SHA at the prompt's stop (powers soft restore). */
  treeSha?: string;
  /** HEAD at the prompt's stop. */
  commitSha?: string;
}

const PROMPT_TEXT_MAX_BYTES = 1024;
const PROMPTS_MAX = 50;
// Per-prompt editsJson budget inside a git note. Same 16 KB cap used by
// the origin-sessions branch (`local-entrypoint.ts:EDITS_JSON_MAX_BYTES`)
// so behavior is consistent across both portability surfaces. Truncated
// entries get a marker; consumers parse the JSON prefix and fall back to
// pc.diff when parsing fails.
const EDITS_JSON_MAX_BYTES = 16 * 1024;

function capEditsJsonForNote(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (Buffer.byteLength(raw, 'utf-8') <= EDITS_JSON_MAX_BYTES) return raw;
  const slice = raw.slice(0, EDITS_JSON_MAX_BYTES - EDITS_TRUNCATED_MARKER.length);
  return slice + EDITS_TRUNCATED_MARKER;
}

// Cap + redact the marker buckets before they go into a note. Bounded so
// a chatty session can't bloat the note; each entry is redacted like any
// other prompt-derived text. Returns undefined when nothing survives.
const MARKERS_MAX_PER_BUCKET = 12;
function sanitizeMarkersForNote(markers: OriginMarkers | undefined): OriginMarkers | undefined {
  if (!markers) return undefined;
  const clean = (arr: string[] | undefined): string[] | undefined => {
    if (!arr || arr.length === 0) return undefined;
    const out = arr
      .slice(0, MARKERS_MAX_PER_BUCKET)
      .map((s) => redact(s))
      .filter((s) => s.length > 0);
    return out.length ? out : undefined;
  };
  const result: OriginMarkers = {};
  const intent = clean(markers.intent);
  const decision = clean(markers.decision);
  const open = clean(markers.open);
  const verify = clean(markers.verify);
  if (intent) result.intent = intent;
  if (decision) result.decision = decision;
  if (open) result.open = open;
  if (verify) result.verify = verify;
  return intent || decision || open || verify ? result : undefined;
}

// Build the serialized note payload. Pure — exported for tests. When
// `includePromptText` is false (the default), all prompt-text carriers
// are withheld: promptSummary, fullPrompt, per-prompt `text`, markers, and
// the promptText embedded inside each editsJson capture. Metadata that makes
// blame work — model, agent, files, counts, line stats, tree/commit
// pointers, the code edits themselves, originUrl and provable prompt hashes —
// always travels.
export function buildNotePayload(data: GitNoteData, includePromptText: boolean): string {
  return JSON.stringify(buildNoteObject(data, includePromptText), null, 2);
}

/**
 * The note for one annotated commit: the legacy `origin` object, plus the
 * canonical v1 record for exactly this commit when one can be built. Pure
 * apart from reading the schema. `reason` says why a record was left out.
 */
export function buildNoteEnvelopeForCommit(
  legacy: { origin: Record<string, unknown> },
  sha: string,
  source: AttributionRecordSource | undefined,
  opts: { recordedAt: Date; producerVersion: string },
): { payload: string; reason?: string } {
  if (!source) return { payload: JSON.stringify(legacy, null, 2), reason: 'no record source' };
  const built = buildAttributionRecordForCommit(sha, source, opts);
  if (!built.record) return { payload: JSON.stringify(legacy, null, 2), reason: built.reason };
  return {
    payload: JSON.stringify({ ...legacy, [ATTRIBUTION_RECORD_NOTE_KEY]: built.record }, null, 2),
  };
}

function buildNoteObject(data: GitNoteData, includePromptText: boolean): { origin: Record<string, unknown> } {
  const summarySource = redact(data.promptSummary || '');
  const promptSummary =
    summarySource.length > 200 ? summarySource.slice(0, 200) + '...' : summarySource;
  const fullPrompt = data.fullPrompt
    ? redactAndCap(data.fullPrompt, FULL_PROMPT_MAX_BYTES)
    : undefined;
  const filesRead = data.filesRead && data.filesRead.length > 0
    ? Array.from(new Set(data.filesRead)).slice(0, FILES_READ_MAX)
    : undefined;
  // Sanitize per-prompt entries: redact text, cap length, drop empty
  // fields. Cap the array itself so a 500-prompt session doesn't bloat
  // the note past push-friendly size.
  const prompts = data.prompts && data.prompts.length > 0
    ? data.prompts.slice(0, PROMPTS_MAX).map((p) => {
        const out: Record<string, unknown> = { index: p.index };
        if (includePromptText && p.text) out.text = redactAndCap(p.text, PROMPT_TEXT_MAX_BYTES);
        if (isPromptHash(p.promptHash)) out.promptHash = p.promptHash;
        if (p.agent) out.agent = p.agent;
        if (p.model) out.model = p.model;
        if (p.authorName) out.authorName = p.authorName;
        if (p.authorEmail) out.authorEmail = p.authorEmail;
        if (p.timestamp) out.timestamp = p.timestamp;
        if (p.files && p.files.length > 0) out.files = p.files;
        // editsJson + tree/commit refs travel so a different Origin org
        // pulling this repo's notes can drive AI Blame from the LCS-replay
        // path. Under the default privacy gate the embedded promptText is
        // blanked first; the code edits themselves stay.
        const editsJson = includePromptText
          ? capEditsJsonForNote(p.editsJson)
          : capEditsJsonForNote(scrubEditsJsonString(p.editsJson));
        if (editsJson) out.editsJson = editsJson;
        if (p.treeSha) out.treeSha = p.treeSha;
        if (p.commitSha) out.commitSha = p.commitSha;
        return out;
      })
    : undefined;

  // Round-trip through JSON so undefined keys are dropped exactly as the
  // serialized note always dropped them.
  return JSON.parse(JSON.stringify(
    {
      origin: {
        // Stays at 1 — the new fields (fullPrompt, previousSessionId,
        // filesRead, prompts, promptTextWithheld, promptHash) are purely additive.
        // Existing readers look up keys by name and ignore unknowns, so
        // no version bump is needed.
        version: 1,
        sessionId: data.sessionId,
        model: data.model,
        agent: data.agentSlug || undefined,
        promptCount: data.promptCount,
        // The prompt `fullPrompt` stands for, by identity only.
        promptHash: provablePromptHash(data.fullPrompt),
        promptSummary: includePromptText ? promptSummary : undefined,
        fullPrompt: includePromptText ? fullPrompt : undefined,
        promptTextWithheld: includePromptText ? undefined : true,
        previousSessionId: data.previousSessionId || undefined,
        filesRead,
        prompts,
        // Markers are the agent's own commentary — gate them behind the
        // same prompt-text privacy switch as promptSummary/fullPrompt.
        markers: includePromptText ? sanitizeMarkersForNote(data.markers) : undefined,
        tokensUsed: typeof data.tokensUsed === 'number' ? data.tokensUsed : undefined,
        costUsd: typeof data.costUsd === 'number' ? parseFloat(data.costUsd.toFixed(4)) : undefined,
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
        linesAdded: data.linesAdded,
        linesRemoved: data.linesRemoved,
        originUrl: data.originUrl,
        aiPercentage: data.aiPercentage ?? undefined,
        humanPercentage: data.humanPercentage ?? undefined,
        mixedPercentage: data.mixedPercentage ?? undefined,
        // Real sub-agent spawns (metadata only — no prompt text, so not gated
        // behind the privacy switch). Absent when the session used none.
        subagents: data.subagents && data.subagents.length ? data.subagents : undefined,
        timestamp: new Date().toISOString(),
      },
    },
  ));
}

/**
 * A metadata-only note plus the prompt text it withheld, encrypted under the
 * repo's key for the month (note-seal.ts). The clear fields stay exactly as a
 * metadata-only note has them (`promptTextWithheld: true` — readers without a
 * key see an ordinary withheld note); `sealed` holds summary, full prompt,
 * markers and per-prompt text. Nothing to seal → the note is unchanged.
 * Pure apart from the cipher's random nonce; exported for tests.
 */
export function withSealedPrompts(
  metadataOnly: { origin: Record<string, unknown> },
  data: GitNoteData,
  key: { kid: string; key: Buffer },
): { origin: Record<string, unknown> } {
  const full = buildNoteObject(data, true).origin as Record<string, any>;
  const prompts = Array.isArray(full.prompts)
    ? full.prompts.filter((p: any) => typeof p?.text === 'string' && p.text).map((p: any) => ({ index: p.index, text: p.text }))
    : [];
  const fields: SealedPromptFields = {};
  if (full.promptSummary) fields.promptSummary = full.promptSummary;
  if (full.fullPrompt) fields.fullPrompt = full.fullPrompt;
  if (full.markers) fields.markers = full.markers;
  if (prompts.length > 0) fields.prompts = prompts;
  if (Object.keys(fields).length === 0) return metadataOnly;
  return { ...metadataOnly, origin: { ...metadataOnly.origin, sealed: seal(fields, key) } };
}

// Scrubbing an ALREADY-WRITTEN note (`origin scrub-notes`) lives in
// note-scrub.ts; re-exported here, where callers have always imported it from.
export { scrubNoteObject };

// The prompt-publication policy lives in prompt-privacy.ts; re-exported here,
// where every caller has always imported it from.
export { shouldIncludePromptText };

// ─── Notes auto-sync ─────────────────────────────────────────────────────
//
// Notes only help if they're actually present after a clone. A plain
// `git clone` does NOT fetch refs/notes/*, so a teammate cloning an
// Origin-tracked repo would see no attribution until they manually ran
// a fetch with the right refspec. This helper makes the sync automatic:
//
//   1. Installs a persistent fetch refspec
//      (+refs/notes/origin:refs/notes/origin-remote) on the repo's
//      remote, so every ordinary `git fetch` / `git pull` from then on
//      carries the notes down without anyone thinking about it.
//   2. Runs one immediate fetch so the CURRENT command already sees them.
//   3. Folds the fetched notes into local refs/notes/origin — straight
//      copy when no local notes exist (the fresh-clone case), otherwise
//      `git notes merge -s ours` (local machine stays authoritative for
//      commits it annotated itself, matching the pre-push merge).
//
// Best-effort everywhere: no remote, offline, or no notes upstream all
// degrade to a quiet no-op. Returns true when local notes were created
// or updated.
export const NOTES_FETCH_REFSPEC = '+refs/notes/origin:refs/notes/origin-remote';

// ─── Memory notes transport ──────────────────────────────────────────────
//
// refs/notes/origin-memory (+ its LLM continuation brief) used to be
// machine-local: no push path and no fetch refspec anywhere in the CLI, so
// the "memory travels with the repo" promise in DOCS.md only held if a human
// typed `git push origin refs/notes/origin-memory` by hand. A teammate's
// clone — or your own second machine — started with an empty payload.
//
// Same staging-ref discipline as attribution notes: fetch into a `-remote`
// ref and fold, never map straight onto the live ref (see
// LEGACY_CLOBBERING_NOTES_REFSPEC for what that costs). The fold itself is
// payload-level, not `git notes merge` — see mergeMemoryPayloads.
export const MEMORY_NOTES_REFS = [
  { local: 'refs/notes/origin-memory', staging: 'refs/notes/origin-memory-remote' },
  { local: 'refs/notes/origin-memory-brief', staging: 'refs/notes/origin-memory-brief-remote' },
] as const;

export const MEMORY_NOTES_FETCH_REFSPECS = MEMORY_NOTES_REFS.map(
  (r) => `+${r.local}:${r.staging}`,
);

// ─── The glob refspec (how notes actually reach a second clone) ──────────
//
// Every explicit refspec above shares one defect: naming a ref the remote
// does NOT have makes plain `git fetch` die with
// "fatal: couldn't find remote ref refs/notes/origin" (exit 128). That is why
// syncNotesFromRemote only persists them `if (ok)` — and that guard is exactly
// what strands the feature. The first machine writes memory before any remote
// has a memory ref, so the fetch fails, so the refspec is never installed, so
// the NEXT pull doesn't carry notes either. Chicken-and-egg: the refspec is
// only installed once it's no longer the thing that would have helped.
//
// A GLOB refspec has no such failure mode — git matches it against whatever
// the remote happens to have and silently matches nothing when the remote has
// none (verified against git 2.50: exit 0, no output). So it can be installed
// UNCONDITIONALLY, on the very first sync, and it starts carrying notes the
// moment the remote gains them, with no further help from Origin.
//
// Capture behaviour (`origin*` → `origin-remote*`):
//   refs/notes/origin              → refs/notes/origin-remote
//   refs/notes/origin-memory       → refs/notes/origin-remote-memory
//   refs/notes/origin-memory-brief → refs/notes/origin-remote-memory-brief
//   refs/notes/origin-acceptance   → refs/notes/origin-remote-acceptance
//
// The empty capture lands on `refs/notes/origin-remote`, which is byte-identical
// to the attribution staging ref this file has always used — so already-synced
// repos keep working with no migration. Memory's legacy staging names differ,
// hence LEGACY_MEMORY_STAGING below.
//
// Scoped to `origin*` rather than `refs/notes/*` deliberately: a plain
// `refs/notes/*` glob would also drag down the user's OWN `refs/notes/commits`
// on every fetch. Not harmful — staging is a separate namespace and `git notes`
// keeps working — but it's their data, not ours, and fetching it is surprising.
//
// Still a staging namespace, never the live ref. See
// LEGACY_CLOBBERING_NOTES_REFSPEC for what mapping straight onto refs/notes/origin
// costs.
export const ORIGIN_NOTES_GLOB_REFSPEC = '+refs/notes/origin*:refs/notes/origin-remote*';

// Where the glob lands each ref, paired with the staging name older releases
// used. Folding checks the glob location first and falls back to the legacy one
// so a repo configured by a previous CLI keeps folding until its next sync.
export const STAGED_NOTES = {
  attribution: { staging: 'refs/notes/origin-remote', legacy: null },
  memory: { staging: 'refs/notes/origin-remote-memory', legacy: 'refs/notes/origin-memory-remote' },
  brief: { staging: 'refs/notes/origin-remote-memory-brief', legacy: 'refs/notes/origin-memory-brief-remote' },
  acceptance: { staging: 'refs/notes/origin-remote-acceptance', legacy: null },
} as const;

/** The live ref each staging entry folds onto. */
export const LIVE_NOTES_REFS: Record<keyof typeof STAGED_NOTES, string> = {
  attribution: 'refs/notes/origin',
  memory: 'refs/notes/origin-memory',
  brief: 'refs/notes/origin-memory-brief',
  acceptance: 'refs/notes/origin-acceptance',
};

/**
 * Cheap precondition for the session-start fold: does some staging ref hold
 * notes whose LIVE counterpart does not exist at all?
 *
 * foldStagedNotes is not cheap enough to run unconditionally in front of a
 * launching agent — measured 117ms on a small repo and 259ms on this one, on
 * macOS, because the memory path reads, parses and merges both whole payloads
 * before it can discover there was nothing to do (and process spawns cost
 * several times more on Windows). The answer is almost always "nothing to
 * do", so pay ONE `git for-each-ref` to find out instead.
 *
 * "Live ref missing entirely" is deliberately narrower than "staging differs
 * from live". It is the state that is permanently stuck — a fresh clone whose
 * post-checkout fetched but never folded reads its memory as absent, forever,
 * with no user-visible sign the data is right there — and it is decidable from
 * ref names alone. Ordinary staleness (live exists, staging is newer) is not
 * stuck: the post-merge hook folds on every pull and the throttled sync folds
 * within the backoff window, so it does not need to be bought at the cost of a
 * quarter-second on every agent launch.
 */
export function hasUnfoldedStagedNotes(repoPath: string): boolean {
  let present: Set<string>;
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/notes/'], {
      windowsHide: true,
      cwd: repoPath,
      stdio: 'pipe' as const,
      timeout: 5_000,
      encoding: 'utf-8' as const,
    }).trim();
    present = new Set(out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []);
  } catch {
    return false; // not a repo, or git unavailable — nothing we can fold anyway
  }
  for (const key of Object.keys(STAGED_NOTES) as Array<keyof typeof STAGED_NOTES>) {
    const entry = STAGED_NOTES[key];
    const isStaged = present.has(entry.staging) || (!!entry.legacy && present.has(entry.legacy));
    if (isStaged && !present.has(LIVE_NOTES_REFS[key])) return true;
  }
  return false;
}

// A forced refspec that maps the remote's notes STRAIGHT onto local
// refs/notes/origin. Older `origin enable` releases installed this, and it
// silently destroys attribution: the leading '+' force-updates the local ref on
// every ordinary `git fetch`/`git pull`, so any note written locally but not yet
// pushed (offline, a failed push, a push that lost a race) is gone with no
// warning. Reproduced: write a local note, `git pull`, note vanishes.
//
// The staging refspec above plus `notes merge -s ours` is the safe equivalent —
// it keeps the local machine authoritative for commits it annotated itself. We
// strip this one wherever we find it so already-configured repos stop losing
// notes on the next pull.
export const LEGACY_CLOBBERING_NOTES_REFSPEC = '+refs/notes/origin:refs/notes/origin';

/**
 * Remove the legacy clobbering refspec from a remote, if present.
 * Returns true when one was removed. Best-effort; never throws.
 */
export function removeLegacyNotesRefspec(repoPath: string, remote: string): boolean {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 5_000,
    encoding: 'utf-8' as const,
  };
  try {
    const existing = execFileSync(
      'git', ['config', '--get-all', `remote.${remote}.fetch`], execOpts,
    );
    if (!existing.split('\n').map((s) => s.trim()).includes(LEGACY_CLOBBERING_NOTES_REFSPEC)) {
      return false;
    }
  } catch {
    return false; // no fetchspecs configured at all
  }
  try {
    // --unset-all with an exact-match value pattern: the value is a fixed
    // literal, and `^…$` anchors it so a longer refspec that merely contains
    // this string can't be caught by accident.
    execFileSync(
      'git',
      [
        'config', '--unset-all', `remote.${remote}.fetch`,
        `^\\+refs/notes/origin:refs/notes/origin$`,
      ],
      execOpts,
    );
    return true;
  } catch {
    return false;
  }
}

export function syncNotesFromRemote(repoPath: string, timeoutMs = 15_000): boolean {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: timeoutMs,
    encoding: 'utf-8' as const,
  };

  let remote = '';
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], execOpts);
    remote = 'origin';
  } catch {
    try {
      const list = execFileSync('git', ['remote'], execOpts).trim();
      if (list) remote = list.split('\n')[0];
    } catch { /* no remotes */ }
  }
  if (!remote) return false;

  // 0. Heal repos configured by an older `origin enable`, which installed a
  //    forced direct refspec that wipes unpushed local notes on every pull.
  //    Done here (not just in `enable`) because this runs on SessionStart, so
  //    an already-poisoned repo gets repaired without the user doing anything.
  removeLegacyNotesRefspec(repoPath, remote);

  const addRefspec = (spec: string) => {
    try {
      const existing = execFileSync('git', ['config', '--get-all', `remote.${remote}.fetch`], execOpts);
      if (existing.includes(spec)) return;
    } catch { /* no fetch config yet — fall through and add */ }
    try {
      execFileSync('git', ['config', '--add', `remote.${remote}.fetch`, spec], execOpts);
    } catch { /* config write failed — the explicit fetch below still works once */ }
  };

  // 1. Install the glob refspec UNCONDITIONALLY — before any fetch, and
  //    regardless of what the remote currently carries. A glob that matches
  //    nothing is a clean no-op for `git fetch` (unlike the explicit refspecs,
  //    which abort it), so there is nothing to guard against. From here on the
  //    user's own `git pull` / `git fetch` carries every refs/notes/origin*
  //    down without Origin being involved at all — including refs the remote
  //    only gains later, which is the case the old conditional install could
  //    never reach. See ORIGIN_NOTES_GLOB_REFSPEC.
  addRefspec(ORIGIN_NOTES_GLOB_REFSPEC);

  // 2. One immediate fetch so THIS command already sees the notes, rather than
  //    the user's next pull. One invocation covers every ref the glob matches —
  //    the old loop paid a separate round trip per ref because an absent ref
  //    would have killed a combined fetch.
  let fetchedAny = false;
  try {
    execFileSync('git', ['fetch', '--no-tags', remote, ORIGIN_NOTES_GLOB_REFSPEC], execOpts);
    fetchedAny = true;
  } catch { /* offline, or no such remote */ }
  if (!fetchedAny) return false;

  return foldStagedNotes(repoPath);
}

/**
 * Fold whatever is sitting in the staging refs onto the live notes refs.
 *
 * Split out of syncNotesFromRemote because it is purely LOCAL — no network, no
 * refspec writes — which is what makes it safe to run from the post-merge hook
 * on every `git pull`. Once ORIGIN_NOTES_GLOB_REFSPEC is configured the pull
 * itself has already brought the staging refs up to date, so folding is all
 * that's left to do, and it costs a few milliseconds of local git.
 *
 * Returns true when any live ref actually moved.
 */
export function foldStagedNotes(repoPath: string): boolean {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 15_000,
    encoding: 'utf-8' as const,
  };

  // Prefer where the glob lands a ref; fall back to the staging name an older
  // CLI used, so a repo still carrying the explicit refspecs keeps folding.
  const staged = (entry: { staging: string; legacy: string | null }): string | null => {
    if (refSha(repoPath, entry.staging)) return entry.staging;
    if (entry.legacy && refSha(repoPath, entry.legacy)) return entry.legacy;
    return null;
  };

  let changed = false;

  // Per-commit note refs (attribution, acceptance). `-s ours` is the right
  // strategy for both: the local machine stays authoritative for commits it
  // annotated itself, and distinct commits union naturally.
  for (const live of ['refs/notes/origin', 'refs/notes/origin-acceptance'] as const) {
    const key = live.endsWith('acceptance') ? 'acceptance' : 'attribution';
    const from = staged(STAGED_NOTES[key]);
    if (!from) continue;
    const beforeSha = refSha(repoPath, live);
    const remoteSha = refSha(repoPath, from);
    if (!remoteSha || beforeSha === remoteSha) continue;
    try {
      if (!beforeSha) {
        execFileSync('git', ['update-ref', live, from], execOpts);
        changed = true;
      } else {
        execFileSync('git', ['notes', `--ref=${live}`, 'merge', '-s', 'ours', from], execOpts);
        changed = refSha(repoPath, live) !== beforeSha || changed;
      }
    } catch { /* leave local notes untouched */ }
  }

  // Memory. NOT `git notes merge` — the whole payload is one note on the root
  // commit, so any git-level strategy resolves the entire blob and silently
  // drops one side's sessions. mergeMemoryPayloads unions them entry-by-entry.
  try {
    const from = staged(STAGED_NOTES.memory);
    if (from && foldRemoteMemory(repoPath, from)) changed = true;
  } catch { /* non-fatal */ }
  try {
    const from = staged(STAGED_NOTES.brief);
    if (from && foldRemoteMemoryBrief(repoPath, from)) changed = true;
  } catch { /* non-fatal */ }

  return changed;
}

/**
 * Push Origin's memory notes to `remote`. Gated by the SAME privacy switch
 * that governs attribution notes and the origin-sessions branch
 * (notesIncludePrompts): memory holds session summaries, per-file notes and
 * decision text, so it leaves the machine only for someone who opted in to
 * sharing prompt-derived content. Off by default; local memory is unaffected.
 *
 * Best-effort and silent — a memory push must never fail a commit or a
 * session end. On a non-fast-forward (another machine pushed since we last
 * synced) we fetch, payload-merge, and retry ONCE.
 */
/**
 * The remote Origin pushes notes to: "origin" when it exists, else the first
 * remote configured. Returns '' when the repo has none (local-only repo), which
 * every caller treats as "nothing to push".
 */
export function resolvePushRemote(repoPath: string): string {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 5_000,
    encoding: 'utf-8' as const,
  };
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], execOpts);
    return 'origin';
  } catch { /* no "origin" remote — fall through */ }
  try {
    const list = execFileSync('git', ['remote'], execOpts).trim();
    if (list) return list.split('\n')[0];
  } catch { /* no remotes at all */ }
  return '';
}

/**
 * Push refs/notes/origin-acceptance — "how much of the previous agent's output
 * did the human actually keep".
 *
 * The ref was local-only until now: every notes push targeted refs/notes/origin,
 * and memory got its own transport, so acceptance had none. The glob fetchspec
 * already brings it DOWN and foldStagedNotes already merges it, so this closes
 * the last leg — without it the fetch/fold half is inert.
 *
 * Per-commit data, so this is the attribution shape (`notes merge -s ours` on a
 * staging ref), NOT memory's payload-level union: distinct commits union on
 * their own, and when two machines annotate the SAME commit the local one is
 * authoritative — it measured survival against its own HEAD.
 *
 * Deliberately NOT gated on notesIncludePrompts, unlike pushMemoryNotes. That
 * switch means "don't publish my prompt text", and an acceptance note carries
 * none: {sessionId, computedAt, addedLines, survivingLines, acceptanceRate}.
 * That is strictly less than refs/notes/origin already publishes for the same
 * commit with the switch off, the default (which still pushes, just without
 * prompt text). If
 * this ever grows a prompt-derived field, it must move behind the gate.
 *
 * Best-effort and silent — never fails a commit, a push, or a session end.
 */
export function pushAcceptanceNotes(repoPath: string, remote: string): void {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 30_000,
    encoding: 'utf-8' as const,
  };
  const live = 'refs/notes/origin-acceptance';
  const staging = STAGED_NOTES.acceptance.staging;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', live], execOpts);
  } catch {
    return; // nothing written locally yet — the common case
  }
  const push = () => execFileSync(
    'git', ['push', remote, `${live}:${live}`, '--no-verify', '--quiet'], execOpts,
  );
  try {
    push();
  } catch {
    // Non-fast-forward: another machine annotated commits we haven't seen.
    // Fetch theirs, merge -s ours (ours wins per-commit), retry ONCE.
    try {
      execFileSync('git', ['fetch', '--no-tags', remote, `+${live}:${staging}`], execOpts);
      execFileSync('git', ['notes', `--ref=${live}`, 'merge', '-s', 'ours', staging], execOpts);
      push();
    } catch { /* give up quietly — acceptance stays local until next time */ }
  }
}

export function pushMemoryNotes(repoPath: string, remote: string): void {
  if (!shouldIncludePromptText(repoPath)) return;
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 30_000,
    encoding: 'utf-8' as const,
  };
  for (const { local, staging } of MEMORY_NOTES_REFS) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', local], execOpts);
    } catch {
      continue; // nothing written locally for this ref yet
    }
    const push = () => execFileSync('git', ['push', remote, `${local}:${local}`, '--no-verify', '--quiet'], execOpts);
    try {
      push();
    } catch {
      // Non-fast-forward: another machine advanced the ref. Re-fetch and
      // RECONCILE — union the payloads, then re-parent our ref onto the remote
      // tip so the retry actually fast-forwards. Folding alone isn't enough:
      // two independently-created memory notes share no ancestor, so a merged
      // payload on an unrelated history is rejected just the same.
      try {
        execFileSync('git', ['fetch', '--no-tags', remote, `+${local}:${staging}`], execOpts);
        if (local.endsWith('origin-memory')) reconcileMemoryWithRemote(repoPath, staging);
        else reconcileMemoryBriefWithRemote(repoPath, staging);
        push();
      } catch { /* give up quietly — memory stays local until next time */ }
    }
  }
}

// ─── SessionStart notes fetch (throttled) ────────────────────────────────
//
// syncNotesFromRemote installs a persistent refspec so ordinary `git pull`s
// carry notes down — but a FRESH clone that hasn't pulled since (the exact
// "new teammate opens the repo" case) starts with no local notes, so the
// SessionStart "Repository AI context" block renders almost nothing until
// the user runs `origin link`/`blame`. Wiring the sync into SessionStart
// closes that gap, but SessionStart fires on every agent launch, so we
// gate the fetch behind a per-repo backoff: once the notes are present the
// refspec keeps them fresh on normal pulls and re-fetching every launch
// would just add latency. Hot-path cost when throttled is a single stat().
// 6h was right when this was the ONLY thing that ever fetched notes and each
// sync cost one round trip PER REF — re-running it on every agent launch would
// have been four fetches a launch. Both premises are gone: the glob fetchspec
// makes it a single fetch of one tiny ref, and ordinary `git pull` now keeps
// notes current on its own, so this is no longer the transport — it's the
// freshness guarantee at session start.
//
// At 6h that guarantee was mostly theatre: an agent launched 5h59m after the
// last sync started on stale memory with no way to know. 10 minutes means any
// launch after a short gap pulls, which is what "fresh at session start" has to
// mean to be worth anything.
//
// Safe against fleet launches because the stamp is written BEFORE the fetch:
// 16 agents starting at once in the same repo produce ONE fetch, not 16.
export const NOTES_SYNC_BACKOFF_MS = 10 * 60 * 1000;

function notesSyncStampPath(repoPath: string): string {
  const key = crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.origin', 'notes-sync', `${key}.stamp`);
}

// Fetch remote notes at most once per backoff window per repo. Returns true
// when a fetch actually ran this call (regardless of whether it changed any
// local notes). Best-effort and silent: a missing remote, offline, or no
// upstream notes all degrade to a no-op, and the persistent refspec still
// carries notes on the next ordinary pull. Safe to call on every
// SessionStart.
export function syncNotesFromRemoteThrottled(repoPath: string, timeoutMs?: number): boolean {
  const stamp = notesSyncStampPath(repoPath);
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < NOTES_SYNC_BACKOFF_MS) return false;
  } catch {
    // No stamp yet — first sync for this repo (the fresh-clone case). Fall
    // through and fetch.
  }
  // Stamp BEFORE fetching so a slow/hanging network can't let concurrent
  // session starts pile up parallel fetches, and a persistently failing
  // fetch still waits out the window (the refspec covers the gap on the
  // next pull).
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, new Date().toISOString());
  } catch (err: unknown) {
    // No stamp means no throttle: "proceed once anyway" was once per PROCESS,
    // and every session start is its own process, so a read-only home turned
    // sixteen concurrent agents into sixteen concurrent fetches — the stampede
    // this window exists to prevent. Skip the fetch instead; `origin notes
    // sync` still works by hand, and the refspec covers the next pull.
    debugLog('notes-sync', 'cannot write the sync stamp; skipping the throttled fetch', {
      stamp, message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  try {
    syncNotesFromRemote(repoPath, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The sync a session-entry path should use.
 *
 * Same throttle, but a tighter network budget: this one runs SYNCHRONOUSLY
 * before the agent's context block is built (the block has to reflect what was
 * just fetched, so it can't be backgrounded), which puts it directly in front
 * of the user waiting for their agent to start. The default 15s is a fine
 * ceiling for `origin blame` and for post-merge; it is not fine for a launch.
 *
 * On timeout the notes simply stay as they were — the configured glob fetchspec
 * carries them on the next ordinary pull either way.
 */
export const SESSION_START_SYNC_TIMEOUT_MS = 6_000;

export function syncNotesForSessionStart(repoPath: string): boolean {
  const fetched = syncNotesFromRemoteThrottled(repoPath, SESSION_START_SYNC_TIMEOUT_MS);

  // Throttled out is NOT the same as "nothing to do". The staging refs can hold
  // notes an earlier sync fetched but never folded, and on a fresh clone that is
  // the norm rather than the exception: `git clone` fires post-checkout, which
  // stamps the throttle BEFORE fetching and then does its work BACKGROUNDED, so
  // anything that kills or times out that child (the 6s/15s budget, a closed
  // terminal, a slow network) leaves refs/notes/origin-remote-memory populated
  // and refs/notes/origin-memory absent. The agent then starts inside the
  // backoff window, skips the sync entirely, and buildMemoryContext reads the
  // LIVE ref — finding nothing. The repo's memory is sitting in .git the whole
  // time, invisible until the window elapses.
  //
  // The throttle exists to budget NETWORK round trips, and folding needs none,
  // so gate the fold on whether there is actually something stuck rather than on
  // the network backoff. hasUnfoldedStagedNotes is one `git for-each-ref`; the
  // fold itself is far too expensive to run unconditionally here (see its
  // comment), and this way the stuck state repairs itself on the next agent
  // launch instead of the next backoff window.
  if (!fetched && hasUnfoldedStagedNotes(repoPath)) {
    try {
      foldStagedNotes(repoPath);
    } catch {
      // Non-fatal — a session start must never fail on notes bookkeeping.
    }
  }
  return fetched;
}

function refSha(repoPath: string, ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      windowsHide: true,
      cwd: repoPath,
      stdio: 'pipe' as const,
      timeout: 5000,
      encoding: 'utf-8' as const,
    }).trim() || null;
  } catch {
    return null;
  }
}

// Strip the promptText field from a raw editsJson string. The capture
// embeds the prompt alongside the edits; the edits themselves (code
// before/after) stay — they power cross-org AI Blame and are repo
// content anyway. Fail closed: if the JSON doesn't parse (e.g. an
// already-truncated payload), withhold the whole blob rather than risk
// leaking text through a parser disagreement.
function scrubEditsJsonString(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if ('promptText' in parsed) parsed.promptText = '';
      return JSON.stringify(parsed);
    }
  } catch { /* fall through to withhold */ }
  return undefined;
}

// A v1 record names its revision in full; an abbreviated sha from a caller is
// resolved once here. Anything that does not resolve is passed through, and
// the record builder then leaves the record out.
function fullCommitSha(repoPath: string, sha: string): string {
  if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return sha;
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
      windowsHide: true, cwd: repoPath, stdio: 'pipe' as const, timeout: 5_000, encoding: 'utf-8' as const,
    }).trim().toLowerCase() || sha;
  } catch {
    return sha;
  }
}

// ─── Publishing refs/notes/origin ────────────────────────────────────────
//
// ONE publisher for the attribution notes ref, shared by the pre-push hook,
// `origin push-metadata` and the best-effort auto-push after a note write, so
// the three cannot disagree about how metadata reaches a remote:
//
//   1. Nothing to do without a local refs/notes/origin.
//   2. Push without force (`refs/notes/origin:refs/notes/origin`, no `+`) and
//      with --no-verify, so the push never re-enters the pre-push hook.
//   3. Rejected: fetch the remote's ref into the staging namespace, merge it
//      with `git notes merge -s ours` (notes on different commits union; on the
//      SAME commit the local note stays — this machine wrote it), and retry.
//   4. Bounded: at most NOTES_PUSH_MAX_ATTEMPTS pushes, never a loop.
//
// A forced rewrite of the remote ref is `origin scrub-notes --push` (OR-49),
// never this path.

export const NOTES_PUSH_MAX_ATTEMPTS = 3;

export type NotesPublishResult =
  | { status: 'pushed'; remote: string; attempts: number; merged: boolean }
  | { status: 'no-notes' }
  | { status: 'no-remote'; remote: string }
  | { status: 'failed'; remote: string; attempts: number; reason: string };

/**
 * Hide credentials a remote URL (or a git error quoting one) may carry:
 * `https://user:token@host/x` → `https://***@host/x`. Everything the transport
 * logs or prints about a remote goes through this.
 */
export function redactRemoteCredentials(text: string): string {
  return (text || '').replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, '$1***@');
}

/** A log-safe summary of a publish result. */
export function describePublishResult(result: NotesPublishResult): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  if ('remote' in result) out.remote = redactRemoteCredentials(result.remote);
  if (result.status === 'failed') out.reason = redactRemoteCredentials(result.reason);
  return out;
}

/** True when `remote` is not a configured name but a URL/path git can push to directly. */
function looksLikeRemoteUrl(remote: string): boolean {
  // `git push <url>` passes the URL as the hook's remote name. A URL, an scp
  // form or an existing path is still a destination.
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)
    || /^[^/\s]+@[^:\s]+:/.test(remote)
    || fs.existsSync(remote);
}

function lastLine(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  const text = (e?.stderr ? String(e.stderr) : '') || e?.message || String(err);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(' | ').slice(0, 400);
}

/**
 * Wall-clock budget for one whole publish (every push, fetch and merge it
 * runs), not per command. The hook paths run inside a user's `git push` or
 * right after a commit, and metadata must never hold those up for minutes:
 * push → fetch → merge → push → fetch → merge → push at 30s a command would.
 */
export const HOOK_PUBLISH_BUDGET_MS = 20_000;
/** `origin push-metadata`: a person is waiting for the answer, so longer — still finite. */
export const INTERACTIVE_PUBLISH_BUDGET_MS = 120_000;
/** Never start a command with less than this left; it could only time out. */
const MIN_COMMAND_MS = 1_000;
/** Ceiling for any single network command inside the budget. */
const PUBLISH_COMMAND_TIMEOUT_MS = 30_000;

export interface PublishOptions {
  /** Total budget for the whole publish. Default: HOOK_PUBLISH_BUDGET_MS. */
  budgetMs?: number;
  /**
   * Push attempts, 1..NOTES_PUSH_MAX_ATTEMPTS (see normalizeMaxAttempts). 1 means no fetch-merge-retry:
   * the auto-push after a note write runs inside an agent's Stop hook, where
   * each round trip is latency the agent waits for; a rejected push is left to
   * the next pre-push, which merges and retries. Default: the maximum.
   */
  maxAttempts?: number;
  /** Test seams: the clock and the command runner. */
  now?: () => number;
  exec?: typeof execFileSync;
}

/**
 * What one git command inside the publish budget came to. The four outcomes
 * are kept apart because they mean different things to the caller: an
 * ordinary non-zero exit is an answer ("no such ref", "not an ancestor", "no
 * such remote"); a command that never started, or was killed by its timeout,
 * is no answer at all and must surface as the deadline.
 */
type GitRun =
  | { kind: 'ok'; out: string }
  | { kind: 'failed'; message: string }
  | { kind: 'not-started' }
  | { kind: 'timeout' };

function isTimeout(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === 'ETIMEDOUT';
}

/**
 * Push attempts for a publish: an integer in 1..NOTES_PUSH_MAX_ATTEMPTS.
 * Anything that is not a finite number (undefined, NaN, ±Infinity) means the
 * default, the maximum; a finite value is truncated and clamped, so 0 and
 * negatives mean one attempt. Never zero attempts, never more than the ceiling.
 */
export function normalizeMaxAttempts(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NOTES_PUSH_MAX_ATTEMPTS;
  return Math.min(NOTES_PUSH_MAX_ATTEMPTS, Math.max(1, Math.trunc(value)));
}

/**
 * Publish local refs/notes/origin to `remote`. Never throws; the result says
 * what happened so a hook can log it and `origin push-metadata` can report it.
 *
 * Bounded twice: at most NOTES_PUSH_MAX_ATTEMPTS pushes, and one deadline for
 * the whole operation. EVERY child process runs through one runner — the
 * committer-identity probe a notes merge needs included — so each gets only
 * the time that is left, none starts once less than MIN_COMMAND_MS remains,
 * and a spent or timed-out budget is reported as `deadline exceeded`, never as
 * an earlier git error or a "no notes"/"no remote" answer.
 */
export function publishAttributionNotes(
  repoPath: string,
  remote: string,
  opts: PublishOptions = {},
): NotesPublishResult {
  const now = opts.now ?? Date.now;
  const exec = opts.exec ?? execFileSync;
  const deadline = now() + (opts.budgetMs ?? HOOK_PUBLISH_BUDGET_MS);
  const live = 'refs/notes/origin';
  const staging = STAGED_NOTES.attribution.staging;
  let attempts = 0;
  const failed = (reason: string): NotesPublishResult =>
    ({ status: 'failed', remote, attempts, reason: redactRemoteCredentials(reason) });
  const outOfTime = (r: { kind: 'not-started' } | { kind: 'timeout' }, step: string): NotesPublishResult =>
    failed(r.kind === 'timeout'
      ? `deadline exceeded: the publish budget ran out while ${step}`
      : `deadline exceeded: the publish budget ran out before ${step}`);

  const run = (args: string[], cap: number, env?: NodeJS.ProcessEnv): GitRun => {
    const left = deadline - now();
    if (left < MIN_COMMAND_MS) return { kind: 'not-started' };
    try {
      const out = exec('git', args, {
        windowsHide: true, cwd: repoPath, stdio: 'pipe', encoding: 'utf-8',
        timeout: Math.min(cap, left), ...(env ? { env } : {}),
      });
      return { kind: 'ok', out: String(out ?? '').trim() };
    } catch (err) {
      return isTimeout(err) ? { kind: 'timeout' } : { kind: 'failed', message: lastLine(err) };
    }
  };

  try {
    // 1. Local notes. An ordinary non-zero exit is the answer "no such ref".
    const liveProbe = run(['rev-parse', '--verify', '--quiet', live], 5_000);
    if (liveProbe.kind === 'not-started' || liveProbe.kind === 'timeout') return outOfTime(liveProbe, 'checking the local notes');
    if (liveProbe.kind === 'failed' || !liveProbe.out) return { status: 'no-notes' };

    // 2. The destination: a configured name, or a URL/path git can push to.
    if (!remote) return { status: 'no-remote', remote };
    const named = run(['remote', 'get-url', remote], 5_000);
    if (named.kind === 'not-started' || named.kind === 'timeout') return outOfTime(named, 'resolving the remote');
    if (named.kind === 'failed' && !looksLikeRemoteUrl(remote)) return { status: 'no-remote', remote };

    let merged = false;
    let lastError = '';
    const maxAttempts = normalizeMaxAttempts(opts.maxAttempts);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const push = run(['push', '--no-verify', '--quiet', remote, `${live}:${live}`], PUBLISH_COMMAND_TIMEOUT_MS);
      if (push.kind === 'ok') return { status: 'pushed', remote, attempts: attempt, merged };
      if (push.kind === 'not-started') return outOfTime(push, `push attempt ${attempt}`);
      attempts = attempt;
      if (push.kind === 'timeout') return outOfTime(push, `push attempt ${attempt} was running`);
      lastError = push.message;
      if (attempt === maxAttempts) break;

      // Most rejections are a non-fast-forward: another clone published notes
      // this one has not folded yet. Bring them in and retry.
      const fetch = run(['fetch', '--no-tags', '--quiet', remote, `+${live}:${staging}`], PUBLISH_COMMAND_TIMEOUT_MS);
      // The deadline outranks the push rejection it interrupted.
      if (fetch.kind === 'not-started' || fetch.kind === 'timeout') return outOfTime(fetch, 'fetching the remote notes');
      // Unreachable remote, no permission, or no notes ref there at all — a
      // merge cannot fix any of those; the push error says why.
      if (fetch.kind === 'failed') return failed(lastError || fetch.message);

      const localSha = run(['rev-parse', '--verify', '--quiet', live], 5_000);
      if (localSha.kind === 'not-started' || localSha.kind === 'timeout') return outOfTime(localSha, 'reading the local notes');
      const remoteSha = run(['rev-parse', '--verify', '--quiet', staging], 5_000);
      if (remoteSha.kind === 'not-started' || remoteSha.kind === 'timeout') return outOfTime(remoteSha, 'reading the fetched notes');
      if (localSha.kind === 'ok' && remoteSha.kind === 'ok' && localSha.out && remoteSha.out) {
        // Exit 0: we already contain the remote's notes, so the rejection was
        // not a non-fast-forward (a protected ref, a hook, a quota) and a retry
        // would fail the same way. Exit 1 is the plain answer "not an
        // ancestor": merge and retry.
        const contained = run(['merge-base', '--is-ancestor', remoteSha.out, localSha.out], 5_000);
        if (contained.kind === 'not-started' || contained.kind === 'timeout') return outOfTime(contained, 'comparing the notes histories');
        if (contained.kind === 'ok') return failed(lastError);
      }

      // `notes merge` writes a commit and needs a committer. Probe for the
      // user's own identity inside the budget, like every other command; only
      // a real "no identity" answer falls back to Origin's.
      let hasIdentity = cachedGitIdentity(repoPath);
      if (hasIdentity === undefined) {
        const probe = run(['var', 'GIT_COMMITTER_IDENT'], 5_000);
        if (probe.kind === 'not-started' || probe.kind === 'timeout') return outOfTime(probe, 'checking the git identity');
        hasIdentity = probe.kind === 'ok';
        recordGitIdentity(repoPath, hasIdentity);
      }
      const merge = run(['notes', `--ref=${live}`, 'merge', '-s', 'ours', staging], PUBLISH_COMMAND_TIMEOUT_MS,
        { ...process.env, ...identityEnvFor(hasIdentity) });
      if (merge.kind === 'not-started' || merge.kind === 'timeout') return outOfTime(merge, 'merging the remote notes');
      if (merge.kind === 'failed') return failed(merge.message);
      merged = true;
    }
    return failed(lastError);
  } catch (err) {
    // An injected runner or an fs call misbehaving: still never throw.
    return failed(lastLine(err));
  }
}

/**
 * The only remote refs/notes/origin is ever published to without being named:
 * the configured `origin`, or '' when there is none. Used by the pre-push hook,
 * the auto-push after a note write and `origin push-metadata` with no
 * argument.
 *
 * Deliberately no fallback to the first remote or the branch's upstream: the
 * ref can hold redacted prompt text — with the opt-in, and in older notes
 * whatever the current setting says — and a repo whose only remote is a public
 * `upstream` must not receive it as a side effect. Publishing anywhere else
 * takes an explicit `origin push-metadata <remote>`.
 */
export function resolveAutoPublishRemote(repoPath: string): string {
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], {
      windowsHide: true, cwd: repoPath, stdio: 'pipe' as const, timeout: 5_000, encoding: 'utf-8' as const,
    });
    return 'origin';
  } catch {
    return '';
  }
}

/**
 * How long a session event (Stop, SessionEnd) waits for the note-write lock,
 * for ALL the commits it writes together — not per commit. The session's next
 * event writes the same commits again, so a short wait loses nothing; a long
 * one would hold up the agent. post-commit keeps the default wait (20 s,
 * ORIGIN_NOTE_LOCK_WAIT_MS): it writes one commit in the background, it is the
 * writer an amend's rewrite races, and nothing may write that commit again.
 */
export const SESSION_EVENT_NOTE_LOCK_WAIT_MS = 2_000;
/** `git notes add` under the lock: its timeout, and what must be left of the lease before it starts. */
const NOTE_WRITE_TIMEOUT_MS = 10_000;

export interface WriteGitNotesOptions {
  /** Total wait for the note-write lock across every commit of this call. Default: the lock's own default. */
  lockWaitMs?: number;
}

export function writeGitNotes(
  repoPath: string,
  commitShas: string[],
  data: GitNoteData,
  opts: WriteGitNotesOptions = {},
): void {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 10000,
    encoding: 'utf-8' as const,
  };

  const includePromptText = shouldIncludePromptText(repoPath);
  // Sealed prompts (note-seal.ts): with the repo's opt-in and a cached key,
  // the prompt text rides encrypted. A clear-text opt-in in the same
  // .origin.json wins — sealing a note that already carries the text would be
  // pointless; a machine-wide one does not apply to a sealing repo
  // (shouldIncludePromptText).
  // No key → a metadata-only note, never clear text.
  const sealKey = includePromptText ? null : cachedWriteKey(repoPath);
  const sealed = (legacy: { origin: Record<string, unknown> }, d: GitNoteData) =>
    sealKey ? withSealedPrompts(legacy, d, sealKey) : legacy;
  const sharedLegacy = data.markersForCommit ? null : sealed(buildNoteObject(data, includePromptText), data);
  const producerVersion = cliVersion();
  // One budget for the whole call: a held lock costs it once, not once per commit.
  const lockDeadline = opts.lockWaitMs === undefined ? null : Date.now() + opts.lockWaitMs;
  for (const rawSha of commitShas) {
    // One canonical record per annotated commit: the record names its
    // revision, so it is built for this sha and never shared with the others.
    const sha = fullCommitSha(repoPath, rawSha);
    // A session's markers are not every commit's (committed-markers.ts): with
    // a per-commit lookup, a commit it has nothing for gets none.
    const forCommit = { ...data, markers: data.markersForCommit ? data.markersForCommit(sha) : data.markers };
    const legacy = sharedLegacy || sealed(buildNoteObject(forCommit, includePromptText), forCommit);
    const { payload: notePayload, reason } = buildNoteEnvelopeForCommit(
      legacy, sha, data.attribution, { recordedAt: new Date(), producerVersion },
    );
    if (reason && data.attribution) {
      // The legacy note is still written; only the v1 record is left out.
      debugLog('git-notes', 'no v1 attribution record for commit', { sha: sha.slice(0, 8), reason });
    }
    // What reached refs/notes/origin, read back after the write — null when
    // nothing was written (lock held elsewhere, git failed). Only a confirmed
    // note is mirrored to the API: a payload that lost the lock, or failed to
    // write, must not link the commit on the server either.
    let confirmed: string | null = null;
    try {
      // Use --ref=origin to keep notes in a separate namespace. -f replaces
      // this commit's earlier session note (re-runs of Stop/SessionEnd) — but
      // what a history rewrite carried onto it is kept (OR-11): read, merge
      // and write under the lock the rewrite hooks take, so neither order of
      // two backgrounded hooks loses the other's contributions.
      const mergeAndWrite = (lease: NoteLease) => {
        let existing: string | null = null;
        try {
          existing = execFileSync('git', ['notes', '--ref=origin', 'show', sha], execOpts).replace(/\n$/, '');
        } catch { /* no note yet */ }
        // The old commits a rewrite recorded: their notes say which models the
        // carried session ran under, so the snapshot never restores just one.
        const readSourceNote = (source: string): string | null => {
          try { return execFileSync('git', ['notes', '--ref=origin', 'show', source], execOpts); } catch { return null; }
        };
        const merged = mergeSessionNoteOverRewrite(existing, notePayload, sha, { recordedAt: new Date(), producerVersion }, readSourceNote);
        // Our lease may have run out while we read: then a newer holder may
        // be merging, and our -f would drop its write. Write nothing.
        if (!lease.holds(NOTE_WRITE_TIMEOUT_MS)) return false;
        execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', merged, sha],
          { ...execOpts, timeout: NOTE_WRITE_TIMEOUT_MS, env: { ...process.env, ...gitIdentityEnv(repoPath) } });
        confirmed = execFileSync('git', ['notes', '--ref=origin', 'show', sha], execOpts);
        return true;
      };
      const waitMs = lockDeadline === null ? undefined : Math.max(0, lockDeadline - Date.now());
      if (!withNoteWriteLock(repoPath, mergeAndWrite, { waitMs })) {
        // Never read-merge-write without the lock: a stale snapshot written
        // with -f would drop what the holder is writing. The note is left as it
        // is; the session's next write of this commit (Stop, SessionEnd) retries.
        debugLog('git-notes', 'note lock held by another writer, or lost; note not written this time', { sha: sha.slice(0, 8) });
      }
    } catch {
      // Never fail session-end because of a notes error
      // Notes are a nice-to-have, not critical
    }
    // Mirror the note up to Origin so local-only repos (no GitHub/GitLab
    // remote where the API could fetch refs/notes/origin from) still
    // surface attribution on the commit detail / per-file blame views.
    // Fire-and-forget: any failure (no auth, server down, repo not
    // synced yet) is silent. The note already lives in git either way.
    if (data.sessionId && confirmed !== null) {
      try {
        const parsed = JSON.parse(confirmed) as Record<string, unknown>;
        api.importGitNote(data.sessionId, sha, parsed).catch(() => { /* silent */ });
      } catch { /* a note someone else made non-JSON: nothing to mirror */ }
    }
  }

  // Auto-push notes to the configured remote so other developers see
  // them on fetch. Best-effort: silent on failure (no remote, no
  // network, permission denied, etc.). The same publisher as pre-push and
  // `origin push-metadata` — no force, --no-verify so the push never
  // re-enters pre-push — but ONE attempt: this runs inside the agent's Stop
  // and SessionEnd hooks, and a rejected push is merged and retried by the
  // next pre-push instead of here.
  try {
    // `origin` only — never the first-remote fallback memory uses (see
    // resolveAutoPublishRemote).
    const remote = resolveAutoPublishRemote(repoPath);
    if (remote) {
      const result = publishAttributionNotes(repoPath, remote, { budgetMs: HOOK_PUBLISH_BUDGET_MS, maxAttempts: 1 });
      debugLog('git-notes', 'auto-push refs/notes/origin', describePublishResult(result));
    }
  } catch {
    // Push can fail for any number of reasons — never block session-end.
  }

  // Memory notes ride the same trigger. Separate try so a failed attribution
  // push doesn't also strand memory.
  try {
    const remote = resolvePushRemote(repoPath);
    if (remote) pushMemoryNotes(repoPath, remote);
  } catch {
    // Never block session-end.
  }
}

