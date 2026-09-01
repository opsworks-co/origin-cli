import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { redactSecrets } from './redaction.js';
import { api } from './api.js';
import { loadConfig, loadRepoConfig } from './config.js';
import type { OriginMarkers } from './origin-markers.js';
import { gitIdentityEnv } from './utils/exec.js';
import {
  foldRemoteMemory,
  foldRemoteMemoryBrief,
  reconcileMemoryWithRemote,
  reconcileMemoryBriefWithRemote,
} from './memory.js';

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
  promptSummary: string;
  // Untruncated last prompt (post-redaction, capped at ~8KB). Lets the next
  // agent reading blame see the actual intent behind a commit, not a 200-char
  // teaser. Stored separately from promptSummary so older readers keep working.
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
  // refs/notes/origin can see this without an Origin DB account. Capped
  // per-prompt to keep notes under push-friendly size limits.
  prompts?: PromptNoteEntry[];
  // The agent's own `[Origin: Intent/Decision/Open/Verify]` markers, parsed
  // from this session's transcript. This is the "why" behind the change —
  // the single most valuable thing for the NEXT agent (it stops a later
  // agent "fixing" something that was deliberate). Session-level (not
  // per-prompt): every commit from the session carries the same markers.
  // Treated as prompt text for privacy: withheld when notes are metadata-only.
  markers?: OriginMarkers;
  // Origin web URL where the full session can be inspected (for users in
  // the same org).
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
}

// Per-prompt attribution row stored inside the commit note. Optional fields
// are dropped when empty to keep the serialized JSON compact.
export interface PromptNoteEntry {
  index: number;
  text: string;                     // post-redaction, capped per PROMPT_TEXT_MAX_BYTES
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
const EDITS_TRUNCATED_MARKER =
  '\n/* [origin: editsJson truncated for note portability] */';

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
// are withheld: promptSummary, fullPrompt, per-prompt `text`, and the
// promptText embedded inside each editsJson capture. Metadata that makes
// blame work — model, agent, files, counts, line stats, tree/commit
// pointers, the code edits themselves — always travels.
export function buildNotePayload(data: GitNoteData, includePromptText: boolean): string {
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

  return JSON.stringify(
    {
      origin: {
        // Stays at 1 — the new fields (fullPrompt, previousSessionId,
        // filesRead, prompts, promptTextWithheld) are purely additive.
        // Existing readers look up keys by name and ignore unknowns, so
        // no version bump is needed.
        version: 1,
        sessionId: data.sessionId,
        model: data.model,
        agent: data.agentSlug || undefined,
        promptCount: data.promptCount,
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
    null,
    2,
  );
}

// Scrub prompt text from an ALREADY-WRITTEN note object (parsed JSON).
// Used by `origin scrub-notes` to retroactively clean notes written
// before the metadata-only default existed. Returns whether anything
// changed so the command can rewrite only dirty notes. Fail-closed on
// editsJson: when the embedded capture can't be parsed (truncated for
// portability), the whole blob is dropped rather than risking text
// surviving inside an unparseable payload.
export function scrubNoteObject(note: any): { changed: boolean; scrubbed: any } {
  if (!note || typeof note !== 'object' || !note.origin || typeof note.origin !== 'object') {
    return { changed: false, scrubbed: note };
  }
  const origin = { ...note.origin };
  let changed = false;
  if (typeof origin.promptSummary === 'string' && origin.promptSummary.length > 0) {
    delete origin.promptSummary;
    changed = true;
  }
  if (typeof origin.fullPrompt === 'string' && origin.fullPrompt.length > 0) {
    delete origin.fullPrompt;
    changed = true;
  }
  // Markers are agent commentary — drop them under the metadata-only gate.
  if (origin.markers && typeof origin.markers === 'object') {
    delete origin.markers;
    changed = true;
  }
  if (Array.isArray(origin.prompts)) {
    origin.prompts = origin.prompts.map((p: any) => {
      if (!p || typeof p !== 'object') return p;
      const np = { ...p };
      if (typeof np.text === 'string' && np.text.length > 0) {
        delete np.text;
        changed = true;
      }
      if (typeof np.editsJson === 'string' && np.editsJson.length > 0) {
        const scrubbed = scrubEditsJsonString(np.editsJson);
        if (scrubbed !== np.editsJson) {
          if (scrubbed) np.editsJson = scrubbed;
          else delete np.editsJson;
          changed = true;
        }
      }
      return np;
    });
  }
  if (changed) origin.promptTextWithheld = true;
  return { changed, scrubbed: { ...note, origin } };
}

// Content gate for note contents. Default INCLUDES prompt text: blame
// with the prompt that produced each line is Origin's core promise, and
// it must survive cloning the repo without an Origin account. Privacy-
// sensitive teams opt OUT per repo (.origin.json:
// notesIncludePrompts: false) or per machine (~/.origin/config.json) —
// notes then carry attribution metadata only — and can retroactively
// clean existing notes with `origin scrub-notes --push`.
export function shouldIncludePromptText(repoPath: string): boolean {
  try {
    const repoCfg = loadRepoConfig(repoPath);
    if (typeof repoCfg?.notesIncludePrompts === 'boolean') return repoCfg.notesIncludePrompts;
  } catch { /* unreadable repo config → fall through */ }
  try {
    const cfg = loadConfig();
    if (typeof cfg?.notesIncludePrompts === 'boolean') return cfg.notesIncludePrompts;
  } catch { /* unreadable global config → fall through */ }
  return true;
}

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
 * decision text, so anyone who opted out of sharing prompt-derived content
 * stays opted out here too.
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
 * commit with the switch off (which still pushes, just without prompt text). If
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
  } catch {
    // Can't persist the stamp (read-only home, etc.) — proceed once anyway.
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

export function writeGitNotes(
  repoPath: string,
  commitShas: string[],
  data: GitNoteData,
): void {
  const execOpts = {
    windowsHide: true,
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 10000,
    encoding: 'utf-8' as const,
  };

  const notePayload = buildNotePayload(data, shouldIncludePromptText(repoPath));
  for (const sha of commitShas) {
    try {
      // Use --ref=origin to keep notes in a separate namespace
      // Use -f to overwrite if note already exists (handles re-runs)
      execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', notePayload, sha],
        { ...execOpts, env: { ...process.env, ...gitIdentityEnv(repoPath) } });
    } catch {
      // Never fail session-end because of a notes error
      // Notes are a nice-to-have, not critical
    }
    // Mirror the note up to Origin so local-only repos (no GitHub/GitLab
    // remote where the API could fetch refs/notes/origin from) still
    // surface attribution on the commit detail / per-file blame views.
    // Fire-and-forget: any failure (no auth, server down, repo not
    // synced yet) is silent. The note already lives in git either way.
    if (data.sessionId) {
      try {
        const parsed = JSON.parse(notePayload) as Record<string, unknown>;
        api.importGitNote(data.sessionId, sha, parsed).catch(() => { /* silent */ });
      } catch { /* notePayload always parses; defensive */ }
    }
  }

  // Auto-push notes to the configured remote so other developers see
  // them on fetch. Best-effort: silent on failure (no remote, no
  // network, permission denied, etc.). Single push for the whole notes
  // ref — git de-dupes per-commit additions. Push to refs/notes/origin
  // explicitly so we don't surprise the user with their own refs/notes.
  try {
    const remote = resolvePushRemote(repoPath);
    if (remote) {
      execFileSync(
        'git',
        ['push', remote, 'refs/notes/origin:refs/notes/origin'],
        { ...execOpts, timeout: 30_000 },
      );
    }
  } catch {
    // Push can fail for any number of reasons — never block session-end.
  }

  // Memory notes ride the same trigger. Separate try so a failed attribution
  // push (the block above throws before reaching here on e.g. a rejected
  // non-fast-forward) doesn't also strand memory.
  try {
    const remote = resolvePushRemote(repoPath);
    if (remote) pushMemoryNotes(repoPath, remote);
  } catch {
    // Never block session-end.
  }
}

