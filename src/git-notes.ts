import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { redactSecrets } from './redaction.js';
import { api } from './api.js';
import { loadConfig, loadRepoConfig } from './config.js';

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
  // Origin web URL where the full session can be inspected (for users in
  // the same org).
  originUrl: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  linesAdded: number;
  linesRemoved: number;
  aiPercentage?: number;
  humanPercentage?: number;
  mixedPercentage?: number;
  snapshot?: boolean;
  snapshotAt?: string;
  filesChanged?: string[];
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
        tokensUsed: data.tokensUsed,
        costUsd: parseFloat(data.costUsd.toFixed(4)),
        durationMs: data.durationMs,
        linesAdded: data.linesAdded,
        linesRemoved: data.linesRemoved,
        originUrl: data.originUrl,
        aiPercentage: data.aiPercentage ?? undefined,
        humanPercentage: data.humanPercentage ?? undefined,
        mixedPercentage: data.mixedPercentage ?? undefined,
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

export function syncNotesFromRemote(repoPath: string): boolean {
  const execOpts = {
    cwd: repoPath,
    stdio: 'pipe' as const,
    timeout: 15_000,
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

  // 1. Persistent refspec — added once, then every git pull syncs notes.
  try {
    const existing = execFileSync('git', ['config', '--get-all', `remote.${remote}.fetch`], execOpts);
    if (!existing.includes(NOTES_FETCH_REFSPEC)) {
      execFileSync('git', ['config', '--add', `remote.${remote}.fetch`, NOTES_FETCH_REFSPEC], execOpts);
    }
  } catch {
    try {
      execFileSync('git', ['config', '--add', `remote.${remote}.fetch`, NOTES_FETCH_REFSPEC], execOpts);
    } catch { /* config write failed — fetch below still works once */ }
  }

  // 2. Immediate fetch.
  const beforeSha = refSha(repoPath, 'refs/notes/origin');
  try {
    execFileSync('git', ['fetch', '--no-tags', remote, NOTES_FETCH_REFSPEC], execOpts);
  } catch {
    return false; // offline / no notes upstream — nothing to merge
  }
  const remoteSha = refSha(repoPath, 'refs/notes/origin-remote');
  if (!remoteSha) return false;

  // 3. Fold into local notes.
  try {
    if (!beforeSha) {
      execFileSync('git', ['update-ref', 'refs/notes/origin', 'refs/notes/origin-remote'], execOpts);
      return true;
    }
    if (beforeSha === remoteSha) return false;
    execFileSync('git', ['notes', '--ref=refs/notes/origin', 'merge', '-s', 'ours', 'refs/notes/origin-remote'], execOpts);
    return refSha(repoPath, 'refs/notes/origin') !== beforeSha;
  } catch {
    return false;
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
const NOTES_SYNC_BACKOFF_MS = 6 * 60 * 60 * 1000;

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
export function syncNotesFromRemoteThrottled(repoPath: string): boolean {
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
    syncNotesFromRemote(repoPath);
    return true;
  } catch {
    return false;
  }
}

function refSha(repoPath: string, ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
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
      execFileSync('git', ['notes', '--ref=origin', 'add', '-f', '-m', notePayload, sha], execOpts);
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
    // Detect a remote. Prefer "origin" (the git default), fall back to
    // the first remote listed if "origin" isn't configured.
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
}

