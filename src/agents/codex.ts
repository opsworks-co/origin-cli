// ── Codex agent adapter: session discovery & rollout parsing ────────────────
// Extracted verbatim from commands/hooks.ts (R3 phase B). Everything Codex-
// specific about FINDING session data lives here: the ~/.codex SQLite thread
// lookup, rollout file resolution/decompression, the per-turn prompt
// timeline, and the rollout parser that recovers prompts/tokens/commit
// markers. hooks.ts orchestrates; this module knows where Codex keeps things.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { querySqlite } from '../utils/sqlite.js';
import * as fzstd from 'fzstd';
import { debugLog } from '../debug-log.js';
import { buildCodexThreadByIdQuery, buildCodexThreadByCwdQuery } from '../codex-thread-query.js';

// ─── Codex Session Data Discovery ─────────────────────────────────────────

export interface CodexSessionData {
  model: string;
  tokensUsed: number;
  inputTokens: number;     // NON-cached prompt tokens
  outputTokens: number;    // visible output + reasoning (both billed at output rate)
  cacheReadTokens?: number; // cached prompt portion — billed at the model's cached rate
  toolCalls: number;
  prompt: string;
  prompts?: string[];   // all user prompts from the rollout, in order
  transcript?: string;  // full JSONL conversation for display
  cwd?: string;         // codex thread's actual cwd — drives repoPath correction
  rolloutPath?: string; // absolute path to the rollout JSONL(.zst) — feed to
                        // the new per-prompt PromptCapture extractor
}

/**
 * Codex CLI stores session data in two places:
 *
 * 1. **SQLite** (`~/.codex/state_*.sqlite`) — `threads` table has model,
 *    `tokens_used`, cwd, rollout_path. `tokens_used` is a single aggregate
 *    that can be 0 or drastically undercounted for short sessions.
 *
 * 2. **Rollout JSONL** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`)
 *    — compressed event stream with per-turn `TokenCountEvent` entries
 *    containing `total_token_usage.{input_tokens,output_tokens,total_tokens}`
 *    and the full conversation (user messages, assistant responses, tool
 *    calls). This is the authoritative source.
 *
 * Strategy: query SQLite for the thread matching this repo, grab its
 * rollout_path, decompress and parse the JSONL for real token counts
 * and transcript. Fall back to SQLite `tokens_used` if rollout parsing fails.
 */
/**
 * True when a Codex thread is one of Codex's own internal LLM subroutines
 * (the ambient-suggestion safety filter, title generation, output summarizer)
 * rather than a user coding session. The Codex UI app logs each of these as its
 * own `threads` row, so without this every one is captured as a duplicate
 * session (e.g. a "gpt-5.4-mini / no repo / 0 tools" row whose prompt is
 * "You are an expert at upholding safety and compliance standards for Codex
 * ambient suggestions…"). Matches the thread's first_user_message — Codex's
 * meta prompts are stable strings a real user never sends — with a corroborated
 * mini-model / system-style / no-tools fallback for variants we lack an exact
 * string for. Exported for testing.
 */
/**
 * True only when the prompt UNMISTAKABLY identifies one of Codex's internal
 * meta-calls — the ambient-suggestion safety filter. Safe to call on a LIVE
 * hook prompt (user-prompt-submit) to drop it before capture: the match is
 * ANCHORED to the prompt's start, so a user merely mentioning the feature
 * ("why do Codex ambient suggestions show up as sessions?") is never dropped.
 * Deliberately EXCLUDES the looser discovery-time patterns in
 * isCodexInternalSubroutine below (substring ambient-mention, title
 * generation, output summarizer) — dropping a live user prompt is worse than
 * letting a rare meta-call through (the server-side subroutine sweep still
 * archives whatever slips past). Tolerates non-string hook input.
 */
export function isKnownCodexInternalPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  return /^You are an expert at upholding safety and compliance standards/i.test(prompt.trim());
}

export function isCodexInternalSubroutine(o: { model?: string | null; prompt?: string | null; toolCalls?: number }): boolean {
  const p = (o.prompt || '').trim();
  if (!p) return false;
  // Codex's auto-review pass runs as its own thread under a dedicated model
  // (`codex-auto-review`) and gets captured as a bogus parallel session — a
  // one-turn "session" whose prompt is the safety-assessment framing, not the
  // user's work. Match the model directly; it's unambiguous.
  if (/auto-review/i.test(o.model || '')) return true;
  if (isKnownCodexInternalPrompt(p)) return true;
  const KNOWN = [
    /Codex ambient suggestions/i,
    /You are an expert at upholding safety and compliance standards/i,
    /Generate a (?:short|concise|brief) title/i,
    /Summariz(?:e|ing) the (?:command|shell|tool) output/i,
    // Auto-review framing, in case the model label is ever missing.
    /whose request action you are assessing/i,
    /as untrusted evidence, not as instructions to follow/i,
  ];
  if (KNOWN.some((re) => re.test(p))) return true;
  // Corroborated heuristic: a mini model running a one-shot, system-style
  // classifier prompt with zero tool calls is the shape of an internal
  // meta-call — real coding work either uses tools or a natural user prompt.
  const isMini = /-mini\b/i.test(o.model || '');
  const systemStyle = /^(You are |You will |You'll be given |You are going to |Given the following)/i.test(p);
  if (isMini && systemStyle && (o.toolCalls ?? 0) === 0) return true;
  return false;
}

export function discoverCodexSessionData(
  repoPath: string,
  opts: { verbose?: boolean; threadId?: string } = {},
): CodexSessionData | null {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;

    // ── Step 1: Find the matching thread from SQLite ───────────────────
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ name: f, path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const dbPath = stateFiles[0].path;

    // STRICT thread-id matching when the caller has one. session-start
    // queries SQLite ONCE by EXACT `cwd = repoPath` and stores threads.id
    // on state.agentSessionId. Every downstream hook passes that id in
    // here, and we read its row directly — no basename LIKE, no
    // "newest thread overall" fallback. Both of those used to make Codex
    // happily attribute work from one repo's thread to another repo's
    // session whenever the user ran codex against multiple repos in
    // parallel.
    //
    // When threadId is absent (session-start itself, first call before
    // anything's been stored), we fall back to EXACT cwd equality —
    // never `LIKE` — and never to "latest thread overall."
    const sqliteOpts = { timeoutMs: 3000 };

    let raw = '';
    const DISCOVER_COLS = 'id, model, tokens_used, rollout_path, cwd, first_user_message';
    const byIdQuery = buildCodexThreadByIdQuery(DISCOVER_COLS, opts.threadId);
    if (byIdQuery) {
      raw = querySqlite(dbPath, byIdQuery, sqliteOpts).trim();
      if (!raw) {
        // SQLite unreadable — on native Windows, Codex holds state_*.sqlite
        // open in WAL mode and actively writes it, so sql.js's whole-file read
        // returns "database disk image is malformed" and every thread lookup
        // fails. Fall back to the append-only rollout file on disk, matched by
        // the thread id embedded in its filename.
        const diskById = opts.threadId
          ? findLatestRollout(path.join(codexDir, 'sessions'), opts.threadId)
          : '';
        if (diskById) {
          raw = `${opts.threadId}|codex|0|${diskById}||`;
          debugLog('codex', 'discoverCodexSessionData: resolved rollout from disk by threadId (sqlite unreadable)', { threadId: opts.threadId, rollout: diskById });
        } else {
          debugLog('codex', 'discoverCodexSessionData: threadId not found in SQLite or on disk', { threadId: opts.threadId });
          return null;
        }
      }
    } else {
      // No locked thread yet — match strictly on `cwd = repoPath`. The
      // exact match means concurrent codex threads in sibling repos
      // can't be confused for each other; if no row matches we bail
      // (callers expect null when nothing fits).
      raw = querySqlite(dbPath, buildCodexThreadByCwdQuery(DISCOVER_COLS, repoPath), sqliteOpts).trim();
      if (!raw) {
        // Same Windows WAL/"malformed" fallback — resolve by cwd from each
        // rollout's session_meta line (Codex stores the OS-native path; the
        // matcher compares separator-insensitively). This is the actual fix
        // for Codex sessions never capturing on native Windows.
        const disk = findCodexRolloutByCwd(codexDir, repoPath);
        if (disk) {
          raw = `${disk.threadId}|codex|0|${disk.path}|${repoPath}|`;
          debugLog('codex', 'discoverCodexSessionData: resolved rollout from disk by cwd (sqlite unreadable)', { repoPath, threadId: disk.threadId, rollout: disk.path });
        } else {
          debugLog('codex', 'discoverCodexSessionData: no thread for exact cwd (sqlite + disk)', { repoPath });
          return null;
        }
      }
    }

    const parts = raw.split('|');
    if (parts.length < 6) return null;

    const threadId = parts[0];
    const model = parts[1] || 'codex';
    const sqliteTokens = parseInt(parts[2], 10) || 0;
    const rolloutPath = parts[3] || '';
    const threadCwd = parts[4] || '';
    const rawPrompt = parts.slice(5).join('|') || '';
    // Codex's `first_user_message` column captures whatever the first
    // user-role event in the rollout contained — which is Codex's own
    // AGENTS.md replay or its environment-context wrapper, not anything
    // the user typed. Filter the echo out so it never reaches
    // state.prompts / the dashboard.
    const looksLikeOriginEcho =
      rawPrompt.includes('<!-- origin-managed -->') ||
      /^#\s+AGENTS\.md instructions for /m.test(rawPrompt);
    const stripped = rawPrompt
      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
      .trim();
    const prompt = looksLikeOriginEcho ? '' : stripped;

    // Resolve the rollout file once so we can hand the absolute path to
    // the new per-prompt PromptCapture extractor (which decompresses .zst
    // and walks the rollout for [branch sha] markers + commit-walking).
    const absRolloutPath = (() => {
      if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
      if (rolloutPath) {
        const abs = path.join(codexDir, rolloutPath);
        if (fs.existsSync(abs)) return abs;
      }
      try { return findCodexRolloutPath(repoPath, threadId); } catch { return null; }
    })();

    // ── Step 2: Try to parse the rollout JSONL for real token counts ──
    const rolloutResult = parseCodexRollout(codexDir, rolloutPath, threadId, { verbose: !!opts.verbose });

    // Drop Codex's own internal subroutine threads (ambient-suggestion safety
    // filter, title generation, etc.) so they don't get captured as duplicate
    // sessions. Uses the raw first_user_message + effective model/tool-calls.
    if (isCodexInternalSubroutine({
      model: rolloutResult?.model || model,
      prompt: rawPrompt,
      toolCalls: rolloutResult?.toolCalls ?? 0,
    })) {
      debugLog('codex', 'discoverCodexSessionData: internal subroutine thread — skipping capture', { threadId, model: rolloutResult?.model || model });
      return null;
    }

    if (rolloutResult) {
      debugLog('codex', 'parsed rollout JSONL', {
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        total: rolloutResult.tokensUsed,
        turns: rolloutResult.turnCount,
      });
      return {
        model: rolloutResult.model || model,
        tokensUsed: rolloutResult.tokensUsed,
        inputTokens: rolloutResult.inputTokens,
        outputTokens: rolloutResult.outputTokens,
        cacheReadTokens: rolloutResult.cacheReadTokens,
        toolCalls: rolloutResult.toolCalls,
        prompt,
        prompts: rolloutResult.userPrompts,
        transcript: rolloutResult.transcript,
        cwd: threadCwd || undefined,
        rolloutPath: absRolloutPath || undefined,
      };
    }

    // ── Step 3: Fall back to SQLite tokens_used (may be 0 / undercount) ─
    debugLog('codex', 'rollout parse failed, using SQLite tokens_used', { sqliteTokens });
    return {
      model,
      tokensUsed: sqliteTokens,
      inputTokens: Math.round(sqliteTokens * 0.7),
      outputTokens: Math.round(sqliteTokens * 0.3),
      toolCalls: 0,
      prompt,
      cwd: threadCwd || undefined,
      rolloutPath: absRolloutPath || undefined,
    };
  } catch (err) {
    debugLog('codex', 'discoverCodexSessionData error', { error: String(err) });
    return null;
  }
}

/**
 * Parse a Codex rollout JSONL(.zst) file for real per-turn token usage
 * and conversation transcript.
 *
 * Rollout files live under ~/.codex/sessions/YYYY/MM/DD/ and can be either
 * plain .jsonl or zstd-compressed .jsonl.zst. Each line is a JSON event.
 *
 * Token events have a `total_token_usage` field with cumulative counts.
 * We take the max seen values as the final totals.
 */
/**
 * Extract user prompts with timestamps from the agent's session log so the
 * post-commit hook can attribute each commit to the prompt that produced
 * it. Codex/Gemini don't fire user-prompt-submit hooks, so without this
 * every commit ends up stamped with promptIndex 0 (the rest being filled
 * in only at session end).
 *
 * Returns prompts in chronological order with millisecond timestamps; the
 * index in the array IS the promptIndex used for downstream UI.
 */
export interface PromptTimelineEntry {
  text: string;
  timestamp: number;
}

// Locate (without reading) the Codex rollout file for the current repo. Used
// by callers that need the path to hand to another module that does its own
// file IO (e.g. backfillCodexPromptMappings, which reads + decompresses the
// rollout inside its own process).
export function findCodexRolloutPath(repoPath: string, threadId?: string): string | null {
  // STRICT path resolution. When a threadId is passed, only return its
  // rollout. Otherwise EXACT-cwd match — no basename LIKE, no "latest
  // overall" fallback. Both of those used to silently attribute a foreign
  // Codex thread's rollout to this session.
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) return null;
    const stateFiles = fs.readdirSync(codexDir)
      .filter(f => f.startsWith('state_') && f.endsWith('.sqlite'))
      .map(f => ({ path: path.join(codexDir, f), mtime: fs.statSync(path.join(codexDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (stateFiles.length === 0) return null;

    const sqliteOpts = { timeoutMs: 3000 };

    let raw = '';
    const byIdQuery = buildCodexThreadByIdQuery('id, rollout_path', threadId);
    if (byIdQuery) {
      raw = querySqlite(stateFiles[0].path, byIdQuery, sqliteOpts).trim();
      if (!raw) {
        // Windows WAL/"malformed" fallback — the rollout file is named after
        // the thread id, so resolve it straight off disk.
        const diskById = threadId ? findLatestRollout(path.join(codexDir, 'sessions'), threadId) : '';
        if (diskById) return diskById;
        debugLog('codex', 'findCodexRolloutPath: threadId not in SQLite or on disk', { threadId });
        return null;
      }
    } else {
      raw = querySqlite(stateFiles[0].path, buildCodexThreadByCwdQuery('id, rollout_path', repoPath), sqliteOpts).trim();
      if (!raw) {
        const disk = findCodexRolloutByCwd(codexDir, repoPath);
        return disk ? disk.path : null;
      }
    }
    const parts = raw.split('|');
    const resolvedThreadId = parts[0];
    const rolloutPath = parts[1] || '';

    if (rolloutPath && fs.existsSync(rolloutPath)) return rolloutPath;
    if (rolloutPath) {
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) return abs;
    }
    // Last resort: the rollout file is named rollout-<id>-*.jsonl(.zst) in
    // ~/.codex/sessions/. Walk it by EXACT thread id only.
    const sessionsDir = path.join(codexDir, 'sessions');
    if (fs.existsSync(sessionsDir) && resolvedThreadId) {
      const latest = findLatestRollout(sessionsDir, resolvedThreadId);
      if (latest) return latest;
    }
    return null;
  } catch {
    return null;
  }
}

export function readCodexRolloutFile(repoPath: string, threadId?: string): string | null {
  try {
    const rolloutFile = findCodexRolloutPath(repoPath, threadId);
    if (!rolloutFile) return null;

    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      const compressed = fs.readFileSync(rolloutFile);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      return Buffer.from(decompressed).toString('utf-8');
    }
    return fs.readFileSync(rolloutFile, 'utf-8');
  } catch {
    return null;
  }
}

export function getCodexPromptsTimeline(repoPath: string, threadId?: string): PromptTimelineEntry[] {
  const content = readCodexRolloutFile(repoPath, threadId);
  if (!content) return [];
  const out: PromptTimelineEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const eventType = event?.type || event?.event || '';
      if (eventType !== 'item.created' && eventType !== 'message') continue;
      const item = event?.data || event?.item || event;
      const role = item?.role || item?.type;
      if (role !== 'user' && role !== 'human') continue;
      const content_ = item?.content || item?.text || item?.message;
      const text = typeof content_ === 'string'
        ? content_
        : Array.isArray(content_)
          ? content_.map((c: any) => c?.text || c?.content || '').join('')
          : '';
      if (!text || !text.trim()) continue;
      // Drop the AGENTS.md / origin-managed echo: Codex reads AGENTS.md
      // natively and replays it as the first user-role message in the
      // rollout. The user-prompt-submit hook already filters this for
      // the live `prompt` capture path; we apply the same filter here
      // so the dashboard's session view doesn't show Origin's own
      // system block as turn 1.
      if (text.includes('<!-- origin-managed -->')) continue;
      if (/^#\s+AGENTS\.md instructions for /m.test(text)) continue;
      // Codex also wraps the AGENTS.md content in <INSTRUCTIONS>...</INSTRUCTIONS>
      // — if that's everything in the message, drop it.
      const stripped = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '').trim();
      if (!stripped) continue;
      // Codex events carry an ISO-ish timestamp on most variants.
      const tsRaw = event?.timestamp || event?.ts || event?.time || event?.created_at || item?.timestamp;
      const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
      out.push({ text: stripped, timestamp: Number.isFinite(ts) ? ts : 0 });
    } catch { /* skip */ }
  }
  // If timestamps are missing, preserve insertion order (the JSONL itself is
  // chronological).
  return out;
}


// Exported for the pricing-regression test suite — it asserts that
// a real rollout fixture parses into the documented token/cost shape
// (non-cached input, cached reads, reasoning folded into output).
// This is the only public consumer; production callers go through
// `discoverCodexSessionData` above.
// Produce a readable (tool, display) label for a Codex tool call. Codex
// ≥0.145 wraps shell/patch calls in JS (`const r = await tools.exec_command(
// {"cmd":"…"}); text(r.output);` or `…tools.apply_patch(patch);`), so the
// raw `input` string is noisy. Unwrap the underlying command / patch for the
// transcript. Falls back to the raw string for any shape we don't recognize.
function describeCodexToolCall(name: string, input: string): { tool: string; display: string } {
  if (!input) return { tool: name || 'tool', display: '' };
  // apply_patch embedded in the exec wrapper.
  if (/tools\.apply_patch/.test(input) && input.includes('*** Begin Patch')) {
    const m = input.match(/"\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\\n)*"/);
    if (m) {
      try { return { tool: 'apply_patch', display: JSON.parse(m[0]) }; }
      catch { return { tool: 'apply_patch', display: m[0] }; }
    }
    return { tool: 'apply_patch', display: input };
  }
  // exec_command wrapper — recover the `"cmd":"…"` value (escaped-quote aware).
  if (/tools\.exec_command/.test(input) || name === 'exec' || name === 'exec_command') {
    const cm = input.match(/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cm) {
      try { return { tool: 'shell', display: JSON.parse(`"${cm[1]}"`) }; }
      catch { return { tool: 'shell', display: cm[1] }; }
    }
  }
  return { tool: name || 'tool', display: input };
}

// Convert a Codex apply_patch block (`*** Begin Patch … *** End Patch`) into a
// git-style unified diff + line counts. Codex records EVERY file edit as an
// apply_patch in its rollout, so this reconstructs a turn's exact diff from
// ground truth — independent of when the watcher's 8s poll happened to snapshot
// the working tree. That fixed the case where two fast turns landed in one poll
// and only the latest got a real diff (session 0509ca9e turn 2 = +0). Add /
// Update / Delete File sections → new-file / modify / delete diffs. Patch paths
// are absolute; relativized to repoRoot when given.
//
// `resolveBaseline` (optional) hands back a repo-relative file's content at the
// point this patch is applied. Without it, Update-File hunks can only be
// numbered sequentially from line 1 (Codex's `@@` marker is bare — see below);
// with it, each hunk is anchored to its REAL line number. Injected rather than
// read here so this stays a pure parser with no git/fs coupling.
export type CodexBaselineResolver = (relPath: string) => string | null;

// One `*** Add/Update/Delete File:` section, kept separate so a turn-level
// caller can regroup the blocks (see codexApplyPatchesToDiff) instead of
// re-parsing the joined diff text.
export interface CodexPatchSection {
  file: string;
  kind: 'add' | 'update' | 'delete';
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  // True when every hunk in this section got a real file line number rather
  // than the sequential-from-1 fallback.
  anchored: boolean;
  // Each hunk's old and new side, markers stripped. Lets the turn-level
  // converter walk a file's sections BACKWARD to recover its pre-turn content
  // — the only way to get it when the baseline was captured mid-turn. Empty
  // for add/delete sections.
  hunks: Array<{ old: string[]; new: string[] }>;
}

export interface CodexBaselineAccess {
  // File content as of this patch.
  read: CodexBaselineResolver;
  // How a section reconciled against the caller's current view of the file: the
  // content immediately BEFORE it (null when the section created the file) and
  // immediately AFTER. A turn often applies SEVERAL patches to the SAME file —
  // create it, then append, then append again — each against the result of the
  // last, so anchoring every one against the start-of-turn file makes the 2nd
  // onward miss. Feeding the result back keeps the caller's view current.
  // Only called when the section was reconstructed exactly; a patch we could
  // not anchor reports nothing rather than a guessed file state.
  onApplied?: (relPath: string, after: string, before: string | null) => void;
}

// One classified line of a Codex hunk body, markers stripped. Shared by the
// counting, anchoring, and replay paths so a line can never be counted as
// context in one and as an addition in another (which would desync the emitted
// `,len` from the slice actually matched).
interface HunkLine { kind: 'add' | 'del' | 'ctx'; text: string }

function classifyHunk(h: string[]): HunkLine[] {
  return h.map((l) => {
    if (l.startsWith('+') && !l.startsWith('+++')) return { kind: 'add' as const, text: l.slice(1) };
    if (l.startsWith('-') && !l.startsWith('---')) return { kind: 'del' as const, text: l.slice(1) };
    // Git requires context to be space-prefixed; Codex context already is, but
    // bare/blank lines are not.
    return { kind: 'ctx' as const, text: l.startsWith(' ') ? l.slice(1) : l };
  });
}

const noCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);

// Split file content into lines, dropping the phantom empty element a trailing
// newline produces so indices are the file's real 1-based line numbers.
function fileLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const lines = content.split('\n').map(noCr);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

// The single 0-based index where `needle` occurs in `src` at or after `from`,
// or null when it is absent or occurs more than once. Uniqueness is the whole
// point: a non-unique match is a guess, and a guessed line number that looks
// authoritative is worse than an honest best-effort one.
function findUniqueRun(src: string[], needle: string[], from: number): number | null {
  if (!needle.length) return null;
  let found = -1;
  for (let s = from; s + needle.length <= src.length; s++) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (src[s + k] !== needle[k]) { hit = false; break; }
    }
    if (!hit) continue;
    if (found >= 0) return null; // ambiguous
    found = s;
  }
  return found < 0 ? null : found;
}

// Locate an ordered chain of runs, each after the previous one. All or nothing.
function matchChain(src: string[], needles: string[][]): number[] | null {
  const at: number[] = [];
  let from = 0;
  for (const n of needles) {
    const found = findUniqueRun(src, n, from);
    if (found == null) return null;
    at.push(found);
    from = found + n.length;
  }
  return at;
}

const oldSideOf = (h: HunkLine[]) => h.filter((l) => l.kind !== 'add').map((l) => noCr(l.text));
const newSideOf = (h: HunkLine[]) => h.filter((l) => l.kind !== 'del').map((l) => noCr(l.text));

// Locate `from` runs in `content` and swap each for the matching `to` run,
// reporting where each landed. Runs one edit — forward when from=old sides,
// backward (an un-apply) when from=new sides. Null if any run is missing or
// ambiguous.
function swapRuns(
  content: string,
  from: string[][],
  to: string[][],
): { result: string; at: number[] } | null {
  if (!content || !from.length) return null;
  const { lines: src, trailingNewline } = fileLines(content);
  if (!src.length) return null;
  if (from.some((r) => !r.length)) return null; // nothing to match on
  const at = matchChain(src, from);
  if (!at) return null;
  const built: string[] = [];
  let cursor = 0;
  at.forEach((idx, k) => {
    built.push(...src.slice(cursor, idx));
    built.push(...to[k]);
    cursor = idx + from[k].length;
  });
  built.push(...src.slice(cursor));
  return { result: built.join('\n') + (trailingNewline ? '\n' : ''), at };
}

// Recover the REAL 1-based old-file start line of every Update-File hunk, and
// reconstruct the file on both sides of the patch.
//
// Codex Update-File sections are CONTEXT-ANCHORED: the marker is a bare `@@`
// with no `-l,s +l,s` ranges, so the patch alone cannot say where a hunk lands.
// Numbering them sequentially from 1 (the previous behaviour) made the
// dashboard's per-prompt view render every Codex turn as if it started at line
// 1 while "by file" — which uses real git diffs — showed the true positions.
//
// Given the file, the positions ARE recoverable: a hunk's OLD side (context +
// removed lines) is by construction a verbatim contiguous slice of the
// pre-patch file, and its NEW side is one of the post-patch file. `view` may be
// either, because the watcher's baseline shadow is taken when it NOTICES the
// prompt and Codex is often already mid-edit by then (measured: a shadow taken
// 8.2s in already had the turn's first patch baked in). So try the post-patch
// reading FIRST — if the view already contains this patch's result, the patch
// is a no-op against it and the file BEFORE it is recovered by swapping each
// new side back for its old one. Otherwise read the view as pre-patch and
// replay forward.
//
// Returns null if ANY hunk is unmatched or ambiguous under both readings.
// All-or-nothing per section: mixing anchored and sequential positions inside
// one file's diff would emit non-monotonic hunk headers.
function reconcileUpdateHunks(
  hunks: HunkLine[][],
  view: string,
): { positions: number[]; before: string; after: string } | null {
  if (!view || !hunks.length) return null;
  const oldSides = hunks.map(oldSideOf);
  const newSides = hunks.map(newSideOf);
  if (oldSides.some((s) => !s.length)) return null; // zero-context insertion

  // 1. Already reflected in the view → rebuild the pre-patch file.
  const undo = swapRuns(view, newSides, oldSides);
  if (undo) {
    const positions: number[] = [];
    let delta = 0; // shift this patch's earlier hunks introduced
    undo.at.forEach((idx, k) => {
      positions.push(idx + 1 - delta);
      delta += newSides[k].length - oldSides[k].length;
    });
    return { positions, before: undo.result, after: view };
  }

  // 2. Not yet reflected → replay it forward.
  const redo = swapRuns(view, oldSides, newSides);
  if (!redo) return null;
  return { positions: redo.at.map((idx) => idx + 1), before: view, after: redo.result };
}

export function codexApplyPatchToDiff(
  patch: string,
  repoRoot?: string,
  resolveBaseline?: CodexBaselineResolver | CodexBaselineAccess,
): {
  diff: string; linesAdded: number; linesRemoved: number; filesChanged: string[];
  sections: CodexPatchSection[];
} {
  const out = {
    diff: '', linesAdded: 0, linesRemoved: 0,
    filesChanged: [] as string[],
    // Per-file blocks in emission order. `out.diff` is just these joined; the
    // turn-level converter regroups them when one file was patched repeatedly.
    sections: [] as CodexPatchSection[],
  };
  if (!patch || !patch.includes('*** Begin Patch')) return out;
  // A bare function stays supported — it's the read half of the same contract.
  const baselines: CodexBaselineAccess | undefined =
    typeof resolveBaseline === 'function' ? { read: resolveBaseline } : resolveBaseline;
  const noteApplied = (f: string, after: string, before: string | null) => {
    try { baselines?.onApplied?.(f, after, before); } catch { /* caller's cache — never fatal */ }
  };
  const rel = (p: string): string => {
    let f = p.trim().replace(/\\/g, '/');
    if (repoRoot) {
      const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      if (f.toLowerCase().startsWith(root.toLowerCase() + '/')) f = f.slice(root.length + 1);
    }
    return f;
  };
  const lines = patch.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('*** Begin Patch')) i++;
  i++; // past Begin Patch
  const collectBody = (): string[] => {
    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith('*** ')) { body.push(lines[i]); i++; }
    return body;
  };
  while (i < lines.length && !lines[i].startsWith('*** End Patch')) {
    const line = lines[i];
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const upd = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (add) {
      const f = rel(add[1]); out.filesChanged.push(f); i++;
      const added = collectBody().filter((l) => l.startsWith('+'));
      out.linesAdded += added.length;
      out.sections.push({
        file: f, kind: 'add', linesAdded: added.length, linesRemoved: 0, anchored: true, hunks: [],
        diff: `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${added.length} @@\n${added.join('\n')}`,
      });
      // An Add File section states the whole file, so a later patch in the same
      // turn ("create it with 11 rows" then "append 5 more") can anchor against
      // it without the file ever existing at the turn's baseline commit.
      if (added.length) noteApplied(f, added.map((l) => l.slice(1)).join('\n') + '\n', null);
    } else if (upd) {
      const f = rel(upd[1]); out.filesChanged.push(f); i++;
      const body = collectBody();
      // Codex Update-File sections use a BARE `@@` marker (no `-l,s +l,s`
      // ranges) — not a valid unified-diff hunk header. Emitting it verbatim
      // produces a diff no viewer can parse ("no diff captured"). Split the
      // body at each `@@`, compute real ±/context counts per hunk, and emit a
      // structurally valid `@@ -old,len +new,len @@` header.
      const hunks: string[][] = [];
      let cur: string[] | null = null;
      for (const l of body) {
        if (l.startsWith('@@')) { cur = []; hunks.push(cur); continue; }
        if (!cur) { cur = []; hunks.push(cur); }
        cur.push(l);
      }
      const classified = hunks.map(classifyHunk);
      // Absolute line numbers aren't in the patch, so recover them from the
      // file this patch was applied to, when the caller can supply it. `null`
      // (no resolver, unreadable file, unmatched or ambiguous context) keeps the
      // old best-effort sequential numbering — never a fabricated position.
      let anchored: { positions: number[]; before: string; after: string } | null = null;
      if (baselines && hunks.length) {
        let view: string | null = null;
        try { view = baselines.read(f); } catch { view = null; }
        if (view) anchored = reconcileUpdateHunks(classified, view);
      }
      const anchors = anchored?.positions ?? null;
      let sectionAdded = 0;
      let sectionRemoved = 0;
      let oldPos = 1;
      let newPos = 1;
      // Running new-side shift from earlier hunks in this file, so anchored
      // hunks report the post-patch line number on the `+` side.
      let delta = 0;
      const rendered: string[] = [];
      for (let hi = 0; hi < hunks.length; hi++) {
        const h = classified[hi];
        let add = 0; let del2 = 0; let ctx = 0;
        for (const l of h) {
          if (l.kind === 'add') add++;
          else if (l.kind === 'del') del2++;
          else ctx++;
        }
        sectionAdded += add;
        sectionRemoved += del2;
        const oldLen = ctx + del2;
        const newLen = ctx + add;
        // Re-emit with the marker git expects — context space-prefixed even
        // when Codex left a bare or blank line.
        const bodyLines = h.map((l) =>
          `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`,
        );
        const oldStart = anchors ? anchors[hi] : oldPos;
        const newStart = anchors ? anchors[hi] + delta : newPos;
        rendered.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
        rendered.push(...bodyLines);
        delta += add - del2;
        oldPos += oldLen;
        newPos += newLen;
      }
      out.linesAdded += sectionAdded;
      out.linesRemoved += sectionRemoved;
      out.sections.push({
        file: f, kind: 'update', linesAdded: sectionAdded, linesRemoved: sectionRemoved,
        anchored: !!anchored,
        hunks: classified.map((h) => ({ old: oldSideOf(h), new: newSideOf(h) })),
        diff: `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n${rendered.join('\n')}`,
      });
      // Only when every hunk matched — an unanchored patch leaves the caller's
      // view of the file untouched rather than replacing it with a guess.
      if (anchored) noteApplied(f, anchored.after, anchored.before);
    } else if (del) {
      const f = rel(del[1]); out.filesChanged.push(f); i++;
      const body = collectBody();
      const removed = body.filter((l) => l.startsWith('-')).length || body.length;
      out.linesRemoved += removed;
      out.sections.push({
        file: f, kind: 'delete', linesAdded: 0, linesRemoved: removed, anchored: true, hunks: [],
        diff: `diff --git a/${f} b/${f}\ndeleted file mode 100644\n--- a/${f}\n+++ /dev/null`,
      });
      // The file is gone; a later patch in this turn must not anchor against
      // the content it used to hold.
      noteApplied(f, '', null);
    } else {
      i++;
    }
  }
  out.diff = out.sections.map((s) => s.diff).join('\n');
  return out;
}

// Diff two full file contents as ONE unified-diff block.
//
// Needed because a turn that patches the same file several times cannot simply
// concatenate its per-patch blocks: each patch is expressed against the file as
// IT saw it, so the second onward reference lines the original file never had.
// Rendering the turn's start and end content instead gives one block that is
// genuinely valid against the baseline — which is what the dashboard needs to
// show all of a turn's changes to a file rather than only the first patch's.
//
// Deliberately simple: trim the common prefix and suffix and emit ONE hunk for
// the span between them, with up to `context` unchanged lines on each side. Not
// minimal for edits scattered through a file (git would emit several hunks),
// but always correct, and it matches git exactly for the append/replace shapes
// Codex actually produces. Returns null when nothing changed.
export function renderFileDiff(
  file: string,
  before: string | null,
  after: string,
  context = 3,
): { diff: string; linesAdded: number; linesRemoved: number } | null {
  const oldLines = before ? fileLines(before).lines : [];
  const newLines = after ? fileLines(after).lines : [];
  if (!oldLines.length && !newLines.length) return null;
  if (!oldLines.length) {
    return {
      diff: `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`
        + `@@ -0,0 +1,${newLines.length} @@\n${newLines.map((l) => `+${l}`).join('\n')}`,
      linesAdded: newLines.length,
      linesRemoved: 0,
    };
  }
  if (!newLines.length) {
    return {
      diff: `diff --git a/${file} b/${file}\ndeleted file mode 100644\n--- a/${file}\n+++ /dev/null`,
      linesAdded: 0,
      linesRemoved: oldLines.length,
    };
  }
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < oldLines.length - pre && suf < newLines.length - pre
    && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) suf++;
  const oldMid = oldLines.slice(pre, oldLines.length - suf);
  const newMid = newLines.slice(pre, newLines.length - suf);
  if (!oldMid.length && !newMid.length) return null; // identical
  const lead = Math.min(context, pre);
  const trail = Math.min(context, suf);
  const start = pre - lead; // 0-based
  const body = [
    ...oldLines.slice(start, pre).map((l) => ` ${l}`),
    ...oldMid.map((l) => `-${l}`),
    ...newMid.map((l) => `+${l}`),
    ...oldLines.slice(oldLines.length - suf, oldLines.length - suf + trail).map((l) => ` ${l}`),
  ];
  const oldLen = lead + oldMid.length + trail;
  const newLen = lead + newMid.length + trail;
  return {
    diff: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`
      + `@@ -${oldLen ? start + 1 : start},${oldLen} +${newLen ? start + 1 : start},${newLen} @@\n${body.join('\n')}`,
    linesAdded: newMid.length,
    linesRemoved: oldMid.length,
  };
}

// Convert ALL of one turn's apply_patch blocks together.
//
// Two things only work at turn level. First, the patches form a CHAIN — each is
// applied to the result of the last — so a shared, advancing view of every file
// is what lets patch 2 onward find its context at all. Second, when a file is
// patched more than once the per-patch blocks cannot be concatenated: they are
// each expressed against a different version of the file, and a viewer that
// merges them by path (as the dashboard does) renders only the first. Those
// files are re-rendered as a single diff from the turn's start to its end.
//
// `read` is optional and failure is never fatal: with no reader, an unreadable
// file, or context that can't be matched, this degrades to exactly what
// converting each patch on its own produces.
export function codexApplyPatchesToDiff(
  patches: string[],
  repoRoot?: string,
  read?: CodexBaselineResolver,
): { diff: string; linesAdded: number; linesRemoved: number; filesChanged: string[] } {
  // Per-file running content across the turn, plus how many of the file's
  // sections we managed to reconcile against it.
  const view = new Map<string, { tail: string; reconciled: number }>();
  const cache = new Map<string, string | null>();
  const access: CodexBaselineAccess | undefined = read
    ? {
      read: (p) => {
        if (view.has(p)) return view.get(p)!.tail;
        if (!cache.has(p)) {
          let c: string | null = null;
          try { c = read(p); } catch { c = null; }
          cache.set(p, c);
        }
        return cache.get(p)!;
      },
      onApplied: (p, after) => {
        const cur = view.get(p);
        if (cur) { cur.tail = after; cur.reconciled++; }
        else view.set(p, { tail: after, reconciled: 1 });
      },
    }
    : undefined;

  const all: CodexPatchSection[] = [];
  const out = { diff: '', linesAdded: 0, linesRemoved: 0, filesChanged: [] as string[] };
  const files = new Set<string>();
  for (const p of patches) {
    const r = codexApplyPatchToDiff(p, repoRoot, access);
    for (const s of r.sections) { all.push(s); files.add(s.file); }
    out.linesAdded += r.linesAdded;
    out.linesRemoved += r.linesRemoved;
  }

  // Collapse files this turn patched more than once — but only when EVERY one
  // of their sections reconciled, so the pair we render is the real story and
  // not a partial replay.
  const byFile = new Map<string, CodexPatchSection[]>();
  for (const s of all) {
    const list = byFile.get(s.file);
    if (list) list.push(s); else byFile.set(s.file, [s]);
  }
  const collapsed = new Map<string, { diff: string; linesAdded: number; linesRemoved: number }>();
  for (const [f, sections] of byFile) {
    if (sections.length < 2) continue;
    if (sections.some((s) => s.kind === 'delete')) continue; // deleted content is unrecoverable
    const v = view.get(f);
    if (!v || v.reconciled !== sections.length) continue;
    // Walk BACKWARD from the final content to recover the file as the turn
    // found it. Un-applying is the only way that works no matter where the
    // baseline was captured: the shadow can sit before the turn, between two of
    // its patches, or after all of them, and only the tail is known for certain.
    let head: string | null = v.tail;
    let walkable = true;
    for (let k = sections.length - 1; k >= 0; k--) {
      const s = sections[k];
      if (s.kind === 'add') { head = null; break; } // the turn created it
      const undone = swapRuns(head!, s.hunks.map((h) => h.new), s.hunks.map((h) => h.old));
      if (!undone) { walkable = false; break; }
      head = undone.result;
    }
    if (!walkable) continue; // could not walk it back — keep the per-patch blocks
    const merged = renderFileDiff(f, head, v.tail);
    if (merged) collapsed.set(f, merged);
  }

  const emitted = new Set<string>();
  const blocks: string[] = [];
  for (const s of all) {
    const merged = collapsed.get(s.file);
    if (!merged) { blocks.push(s.diff); continue; }
    if (emitted.has(s.file)) continue;
    emitted.add(s.file);
    blocks.push(merged.diff);
  }
  for (const [f, merged] of collapsed) {
    // The merged diff supersedes the per-patch counts for that file.
    let addSum = 0; let delSum = 0;
    for (const s of all) if (s.file === f) { addSum += s.linesAdded; delSum += s.linesRemoved; }
    out.linesAdded += merged.linesAdded - addSum;
    out.linesRemoved += merged.linesRemoved - delSum;
  }
  out.filesChanged = [...files];
  out.diff = blocks.join('\n');
  return out;
}

// Flatten Codex tool-call output into text. ≥0.145 returns an array of
// content blocks (`[{ type: 'input_text', text: '…' }]`); older builds use a
// plain string or `{ content }`.
function stringifyCodexToolOutput(out: any): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out
      .map((b) => (typeof b === 'string' ? b : (typeof b?.text === 'string' ? b.text : (typeof b?.content === 'string' ? b.content : ''))))
      .filter(Boolean)
      .join('');
  }
  if (typeof out === 'object') {
    if (typeof out.content === 'string') return out.content;
    if (typeof out.stdout === 'string') return out.stdout;
    if (Array.isArray(out.content)) {
      return out.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('');
    }
    try { return JSON.stringify(out); } catch { return ''; }
  }
  return String(out);
}

// Lean, live-heartbeat variant of parseCodexRollout used by the CLI heartbeat
// (pushInflightCodexState). It runs every ~30s on the in-flight rollout to keep
// the dashboard's transcript/tokens/prompts fresh WHILE the agent is working,
// and additionally recovers per-user-prompt timestamps for the diff baseline.
//
// It MUST stay schema-parity with parseCodexRollout above: they read the SAME
// rollout and the heartbeat's output OVERWRITES the stop-hook's transcript on
// the server (mcp PATCH is last-writer-wins on the transcript field). When this
// parser lagged behind on the Codex ≥0.145 `custom_tool_call` schema (#803 only
// updated parseCodexRollout, not this twin), every heartbeat tick shipped a
// tool-less transcript that clobbered the richer stop-hook one — the
// user-reported "tool output was there, then disappeared" bug (gpt-5.6-sol,
// Windows). Co-located here so the two can't drift apart unnoticed again;
// locked by codex-live-parser.test.ts.
export function parseCodexRolloutLive(rolloutFile: string): {
  userPrompts: string[];
  // Per-prompt timestamps (ms epoch) parsed from the rollout's user message
  // events. Used to compute the per-prompt diff baseline at heartbeat time
  // — the LAST committed sha whose commit time is at-or-before the prompt
  // start. Without this, baselines fall back to whichever HEAD existed when
  // the heartbeat happened to notice the prompt, which is usually AFTER
  // Codex has already made commits inside the prompt (then the diff against
  // that "baseline" loses the prompt's real work).
  promptTimestamps: number[];
  // Per-prompt apply_patch blocks (raw `*** Begin Patch … *** End Patch`), one
  // array per userPrompts entry, holding the patches Codex applied during that
  // turn. Lets the watcher reconstruct each turn's exact diff from the rollout
  // instead of a git working-tree snapshot that can't tell two fast turns apart.
  promptPatches: string[][];
  transcript: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  model?: string;
  toolCalls: number;
} | null {
  try {
    let content: string;
    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      const compressed = fs.readFileSync(rolloutFile);
      const decompressed = fzstd.decompress(new Uint8Array(compressed));
      content = Buffer.from(decompressed).toString('utf-8');
    } else {
      content = fs.readFileSync(rolloutFile, 'utf-8');
    }

    const lines = content.split('\n').filter(l => l.trim());
    const turns: Array<{ role: string; content: string }> = [];
    const promptTimestamps: number[] = [];
    // One entry per user prompt (pushed alongside promptTimestamps); apply_patch
    // tool calls are appended to the current (most recent) prompt's array.
    const promptPatches: string[][] = [];
    const pendingTools = new Map<string, number>();
    let maxInputTokens = 0, maxOutputTokens = 0, maxTotalTokens = 0, maxCachedInputTokens = 0;
    let model: string | undefined;
    let toolCalls = 0;
    const TRUNC = 2000;
    const truncate = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + `… [+${s.length - TRUNC} chars]` : s;

    const extractText = (c: any): string => {
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return '';
      return c.map((p: any) => p?.text || (typeof p === 'string' ? p : '') || (typeof p?.content === 'string' ? p.content : '')).filter(Boolean).join('');
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const tokenUsage = event?.total_token_usage || event?.data?.total_token_usage || event?.payload?.info?.total_token_usage || event?.payload?.total_token_usage;
        if (tokenUsage) {
          const i = tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0;
          const o = tokenUsage.output_tokens || tokenUsage.completion_tokens || 0;
          const cached = tokenUsage.cached_input_tokens || tokenUsage.prompt_tokens_details?.cached_tokens || 0;
          const t = tokenUsage.total_tokens || (i + o);
          if (t > maxTotalTokens) { maxInputTokens = i; maxOutputTokens = o; maxCachedInputTokens = cached; maxTotalTokens = t; }
        }
        if (!model && (event?.model || event?.data?.model || event?.payload?.model)) {
          model = event.model || event.data?.model || event.payload?.model;
        }
        const payload = event?.payload;
        const ptype = payload?.type || '';
        if (ptype === 'message') {
          const role = payload.role || 'assistant';
          const text = extractText(payload.content);
          if (text.trim()) {
            const isUser = role === 'user' || role === 'human';
            const isEcho = isUser && (text.includes('<!-- origin-managed -->') || /^#\s+AGENTS\.md instructions for /m.test(text));
            if (!isEcho) {
              const cleaned = isUser
                ? text
                    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                    .trim()
                : text;
              if (cleaned) {
                turns.push({ role, content: cleaned });
                // Capture per-user-prompt timestamp from any of Codex's
                // event-level time fields. Without this the prompt baseline
                // falls back to "whenever heartbeat noticed", which is
                // usually AFTER Codex made commits inside the prompt.
                if (isUser) {
                  const ts = (() => {
                    const candidates = [
                      event?.timestamp,
                      event?.created_at,
                      event?.payload?.timestamp,
                      event?.payload?.created_at,
                      payload?.timestamp,
                      payload?.created_at,
                    ];
                    for (const c of candidates) {
                      if (typeof c === 'number' && Number.isFinite(c)) return c > 1e12 ? c : c * 1000;
                      if (typeof c === 'string') {
                        const n = Date.parse(c);
                        if (Number.isFinite(n)) return n;
                      }
                    }
                    return 0;
                  })();
                  promptTimestamps.push(ts);
                  promptPatches.push([]); // start collecting this turn's patches
                }
              }
            }
          }
        } else if (ptype === 'reasoning') {
          const summary = Array.isArray(payload.summary) ? payload.summary : [];
          const t = summary.map((s: any) => s?.text || '').filter(Boolean).join('\n\n');
          if (t.trim()) turns.push({ role: 'assistant', content: `[Reasoning] ${t}` });
        } else if (ptype === 'function_call' || ptype === 'local_shell_call' || ptype === 'custom_tool_call') {
          // Codex ≥0.145 (gpt-5.6-sol/terra) records every tool call as a
          // `custom_tool_call` (name "exec"/"apply_patch") whose `input` is
          // either a JS wrapper (tools.exec_command / tools.apply_patch) or a
          // raw `*** Begin Patch`. describeCodexToolCall unwraps all shapes.
          toolCalls++;
          const rawArgs = payload.input ?? payload.arguments ?? payload.action ?? payload.command ?? '';
          const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          const { tool, display } = describeCodexToolCall(
            payload.name || (ptype === 'local_shell_call' ? 'shell' : 'tool'),
            argStr,
          );
          const callId = payload.call_id || payload.id || '';
          const idx = turns.length;
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(display)}` });
          if (callId) pendingTools.set(callId, idx);
          // Attribute the patch to the current turn for per-prompt diffs.
          if (tool === 'apply_patch' && typeof display === 'string' && display.includes('*** Begin Patch') && promptPatches.length > 0) {
            promptPatches[promptPatches.length - 1].push(display);
          }
        } else if (ptype === 'function_call_output' || ptype === 'local_shell_call_output' || ptype === 'custom_tool_call_output') {
          const callId = payload.call_id || payload.id || '';
          const out = stringifyCodexToolOutput(payload.output);
          if (out) {
            const idx = callId ? pendingTools.get(callId) : undefined;
            if (idx !== undefined) {
              turns[idx].content += `\n[Output] ${truncate(out)}`;
              pendingTools.delete(callId);
            } else {
              turns.push({ role: 'assistant', content: `[Output] ${truncate(out)}` });
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    if (turns.length === 0 && maxTotalTokens === 0) return null;
    const userPrompts: string[] = [];
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'human') {
        const c = t.content.trim();
        if (c) userPrompts.push(c);
      }
    }
    // EXCLUDE cache reads from tokensUsed/inputTokens to match the platform
    // contract (every other agent reports input+output only; cache is separate).
    // Codex's input_tokens INCLUDES cached, so subtract it. Mirrors
    // parseCodexRollout — keeps the heartbeat (live) and stop-hook token
    // definitions identical so a mid-session update can't disagree with the end.
    const liveNonCachedInput = Math.max(0, maxInputTokens - maxCachedInputTokens);
    return {
      userPrompts,
      promptTimestamps,
      promptPatches,
      transcript: JSON.stringify(turns),
      tokensUsed: liveNonCachedInput + maxOutputTokens,
      inputTokens: liveNonCachedInput,
      outputTokens: maxOutputTokens,
      cacheReadTokens: maxCachedInputTokens,
      model,
      toolCalls,
    };
  } catch { return null; }
}

export function parseCodexRollout(
  codexDir: string,
  rolloutPath: string,
  threadId: string,
  opts: { verbose?: boolean } = {},
): { tokensUsed: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; model?: string; turnCount: number; toolCalls: number; transcript?: string; userPrompts?: string[] } | null {
  try {
    // Try to resolve the rollout file
    let rolloutFile = '';

    if (rolloutPath && fs.existsSync(rolloutPath)) {
      rolloutFile = rolloutPath;
    } else if (rolloutPath) {
      // rollout_path might be relative to codexDir
      const abs = path.join(codexDir, rolloutPath);
      if (fs.existsSync(abs)) rolloutFile = abs;
    }

    // If no rollout_path, scan the sessions directory for most recent file
    // matching this thread ID
    if (!rolloutFile) {
      const sessionsDir = path.join(codexDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        rolloutFile = findLatestRollout(sessionsDir, threadId);
      }
    }

    if (!rolloutFile) return null;

    // Read + decompress. Previously relied on `zstd` CLI or `python3+zstandard`
    // which many users don't have installed — token capture silently degraded
    // to character-based estimation. fzstd is a pure-JS decoder (~20KB) so this
    // path now works on any machine with just Node.
    let content: string;
    if (rolloutFile.endsWith('.zst') || rolloutFile.endsWith('.zstd')) {
      try {
        const compressed = fs.readFileSync(rolloutFile);
        const decompressed = fzstd.decompress(new Uint8Array(compressed));
        content = Buffer.from(decompressed).toString('utf-8');
      } catch (err) {
        debugLog('codex', 'fzstd decompress failed', { error: String(err) });
        return null;
      }
    } else {
      content = fs.readFileSync(rolloutFile, 'utf-8');
    }

    // Parse JSONL events
    const lines = content.split('\n').filter(l => l.trim());
    let maxInputTokens = 0;
    let maxOutputTokens = 0;
    // OpenAI's `input_tokens` includes the cached portion as a subset,
    // so we track `cached_input_tokens` separately and subtract on
    // the way out — the cost path needs them split (cached is billed
    // at $0.50/M for gpt-5.5, regular is $5/M).
    let maxCachedInputTokens = 0;
    // Codex/gpt-5 reasoning tokens land in a separate field but are
    // billed at the output rate. Add to outputTokens on the way out
    // so neither the cost nor the tokensUsed total under-reports.
    let maxReasoningOutputTokens = 0;
    let maxTotalTokens = 0;
    let model: string | undefined;
    let turnCount = 0;
    let toolCalls = 0;

    // Build transcript from conversation events
    const turns: Array<{ role: string; content: string }> = [];

    // Truncation budget for tool args/output. Verbose mode keeps the full
    // payload so reviewers can see exactly what the agent ran; default mode
    // keeps each side ≤ 2 KB so a long session's transcript stays uploadable.
    const TOOL_TRUNC = opts.verbose ? Number.MAX_SAFE_INTEGER : 2000;
    const truncate = (s: string, max: number = TOOL_TRUNC): string =>
      s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s;

    // Pending tool calls keyed by call_id so we can attach their outputs
    // when the matching `function_call_output` arrives.
    const pendingTools = new Map<string, number>();  // call_id → turns[] index

    const extractMessageText = (content_: any): string => {
      if (typeof content_ === 'string') return content_;
      if (!Array.isArray(content_)) return '';
      return content_
        .map((c: any) => {
          if (!c) return '';
          if (typeof c === 'string') return c;
          // Codex content blocks: {type: "input_text"|"output_text", text: "..."}
          if (c.text) return c.text;
          if (c.content) return typeof c.content === 'string' ? c.content : '';
          return '';
        })
        .filter(Boolean)
        .join('');
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract token usage from TokenCountEvent or turn.completed events.
        // Codex emits multiple shapes across versions — check the union.
        const tokenUsage =
          event?.total_token_usage ||
          event?.data?.total_token_usage ||
          event?.payload?.info?.total_token_usage ||
          event?.payload?.total_token_usage ||
          event?.payload?.usage ||
          event?.usage ||
          event?.data?.usage;

        if (tokenUsage) {
          const input = tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0;
          const output = tokenUsage.output_tokens || tokenUsage.completion_tokens || 0;
          // Codex (responses-API) emits these on every TokenCountEvent.
          // OpenAI's older Chat Completions shape nests cache under
          // `prompt_tokens_details.cached_tokens`; cover both so we
          // don't silently drop cache info on legacy rollouts.
          const cached =
            tokenUsage.cached_input_tokens ||
            tokenUsage.prompt_tokens_details?.cached_tokens ||
            0;
          const reasoning =
            tokenUsage.reasoning_output_tokens ||
            tokenUsage.completion_tokens_details?.reasoning_tokens ||
            tokenUsage.reasoning_tokens ||
            0;
          const total = tokenUsage.total_tokens || (input + output);
          if (total > maxTotalTokens) {
            maxInputTokens = input;
            maxOutputTokens = output;
            maxCachedInputTokens = cached;
            maxReasoningOutputTokens = reasoning;
            maxTotalTokens = total;
          }
        }

        // Extract model from thread/turn/session events
        if (!model && (event?.model || event?.data?.model || event?.payload?.model)) {
          model = event.model || event.data?.model || event.payload?.model;
        }

        const eventType = event?.type || event?.event || '';
        const payload = event?.payload;
        const payloadType = payload?.type || '';

        // ── New-shape Codex rollouts: response_item events ────────────────
        // Each conversation item is wrapped as {type: "response_item", payload: {...}}.
        // The payload's `type` distinguishes message / reasoning / function_call /
        // function_call_output / local_shell_call.
        if (payloadType === 'message') {
          const role = payload.role || 'assistant';
          const text = extractMessageText(payload.content);
          if (text.trim()) {
            // Drop the AGENTS.md / origin-managed echo and Codex's
            // own <environment_context> session-init wrapper on
            // user-role turns. Codex replays both as the first user
            // events in the rollout; the dashboard renders the
            // whole transcript so without this they show up as
            // bogus turn 1 / 2 even though state.prompts filters them.
            const isUser = role === 'user' || role === 'human';
            const isEcho = isUser && (
              text.includes('<!-- origin-managed -->') ||
              /^#\s+AGENTS\.md instructions for /m.test(text)
            );
            if (!isEcho) {
              const cleaned = isUser
                ? text
                    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                    .trim()
                : text;
              if (cleaned) turns.push({ role, content: cleaned });
            }
          }
        } else if (payloadType === 'reasoning') {
          // Chain-of-thought summary — show as assistant reasoning so reviewers
          // can see the agent's plan, not just its actions.
          const summary = Array.isArray(payload.summary) ? payload.summary : [];
          const text = summary.map((s: any) => s?.text || '').filter(Boolean).join('\n\n');
          if (text.trim()) {
            turns.push({ role: 'assistant', content: `[Reasoning] ${text}` });
          }
        } else if (payloadType === 'function_call' || payloadType === 'local_shell_call' || payloadType === 'custom_tool_call') {
          toolCalls++;
          // Codex ≥0.145 records every tool call as a `custom_tool_call`
          // named "exec" whose `input` is a JS wrapper (tools.exec_command
          // / tools.apply_patch). The old branch only knew `function_call`,
          // so the new CLI reported 0 tools. Unwrap for a readable label.
          const rawArgs = payload.input ?? payload.arguments ?? payload.action ?? payload.command ?? '';
          const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          const { tool, display } = describeCodexToolCall(
            payload.name || (payloadType === 'local_shell_call' ? 'shell' : 'tool'),
            argStr,
          );
          const callId = payload.call_id || payload.id || '';
          const idx = turns.length;
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(display)}` });
          if (callId) pendingTools.set(callId, idx);
        } else if (payloadType === 'function_call_output' || payloadType === 'local_shell_call_output' || payloadType === 'custom_tool_call_output') {
          const callId = payload.call_id || payload.id || '';
          const out = stringifyCodexToolOutput(payload.output);
          if (out) {
            const idx = callId ? pendingTools.get(callId) : undefined;
            if (idx !== undefined) {
              turns[idx].content += `\n[Output] ${truncate(out)}`;
              pendingTools.delete(callId);
            } else {
              turns.push({ role: 'assistant', content: `[Output] ${truncate(out)}` });
            }
          }
        } else if (eventType === 'item.created' || eventType === 'message') {
          // ── Legacy/older-shape rollouts ─────────────────────────────────
          const item = event?.data || event?.item || event;
          const role = item?.role || item?.type;
          const content_ = item?.content || item?.text || item?.message;
          if (role && content_) {
            const text = extractMessageText(content_);
            if (text) {
              // Same AGENTS.md echo filter as the response_item path.
              const isUser = role === 'user' || role === 'human';
              const isEcho = isUser && (
                text.includes('<!-- origin-managed -->') ||
                /^#\s+AGENTS\.md instructions for /m.test(text)
              );
              if (!isEcho) {
                const cleaned = isUser
                  ? text
                      .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
                      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
                      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
                      .trim()
                  : text;
                if (cleaned) turns.push({ role, content: cleaned });
              }
            }
          }
        } else if (
          eventType === 'tool_call' || eventType === 'function_call' ||
          event?.data?.type === 'function_call' || event?.data?.type === 'shell'
        ) {
          toolCalls++;
          const tool = event?.data?.name || event?.data?.command || event?.name || 'tool';
          const args = event?.data?.arguments || event?.data?.args || '';
          const argStr = typeof args === 'string' ? args : JSON.stringify(args);
          turns.push({ role: 'assistant', content: `[Tool: ${tool}] ${truncate(argStr)}` });
        }

        // Track turns
        if (eventType === 'turn.completed' || eventType === 'turn.started') {
          turnCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Don't bail when token usage hasn't fired yet — the rollout often
    // contains a fully-formed transcript before the TokenCountEvent
    // lands (especially when stop hooks fire mid-stream). Returning null
    // here used to drop the entire conversation; now we keep whatever
    // we parsed and let the next heartbeat / stop event refresh tokens.
    if (maxTotalTokens === 0 && turns.length === 0) return null;

    // Extract every cleaned user prompt in the order they appear. Used by
    // the Stop hook / heartbeat to grow state.prompts for Codex sessions,
    // since Codex's UserPromptSubmit hook is unreliable (Codex auto-trust
    // edge cases) and the singleton SQLite `first_user_message` only
    // surfaces prompt 0 — so without this every prompt after the first was
    // missing a per-prompt diff mapping on the dashboard.
    const userPrompts: string[] = [];
    for (const t of turns) {
      if (t.role === 'user' || t.role === 'human') {
        const cleaned = t.content.trim();
        if (cleaned) userPrompts.push(cleaned);
      }
    }

    // Split cached out of input, fold reasoning into output. This is
    // the contract the rest of the pipeline expects:
    //   inputTokens     — NON-cached prompt tokens (billed at full
    //                     model input rate)
    //   cacheReadTokens — cached subset (billed at the cached rate,
    //                     e.g. $0.50/M for gpt-5.5)
    //   outputTokens    — visible output + reasoning, both billed at
    //                     the output rate
    //   tokensUsed      — non-cached input + output (incl. reasoning). EXCLUDES
    //                     cache reads, matching the platform contract every
    //                     other agent follows (Claude/Cursor/agy all report
    //                     input+output only; cache is tracked separately in
    //                     cacheReadTokens). Including cache here made Codex look
    //                     ~14× less token-efficient than an identical Claude
    //                     session in the benchmark scorecard — an artifact of
    //                     the definition, not real work.
    const nonCachedInputTokens = Math.max(0, maxInputTokens - maxCachedInputTokens);
    const billableOutputTokens = maxOutputTokens + maxReasoningOutputTokens;
    const grandTotalTokens = nonCachedInputTokens + billableOutputTokens;

    return {
      tokensUsed: grandTotalTokens,
      inputTokens: nonCachedInputTokens,
      outputTokens: billableOutputTokens,
      cacheReadTokens: maxCachedInputTokens,
      model,
      turnCount,
      toolCalls,
      transcript: turns.length > 0 ? JSON.stringify(turns) : undefined,
      userPrompts: userPrompts.length > 0 ? userPrompts : undefined,
    };
  } catch (err) {
    debugLog('codex', 'parseCodexRollout error', { error: String(err) });
    return null;
  }
}

/**
 * Scan ~/.codex/sessions/ for the most recent rollout file, optionally
 * matching a thread ID in the filename.
 */
/**
 * Read the `cwd` recorded in a Codex rollout's first `session_meta` line,
 * without fully parsing the (potentially huge) line. Handles plain `.jsonl`
 * (reads just the head) and `.jsonl.zst` (decompresses, reads the head).
 * Returns the OS-native path Codex stored, or null.
 */
export function readRolloutCwd(filePath: string): string | null {
  try {
    let head = '';
    if (filePath.endsWith('.zst') || filePath.endsWith('.zstd')) {
      const decompressed = fzstd.decompress(new Uint8Array(fs.readFileSync(filePath)));
      head = Buffer.from(decompressed.subarray(0, 16_384)).toString('utf-8');
    } else {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(16_384);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString('utf-8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
    }
    // `cwd` appears early in the session_meta payload (before base_instructions).
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    // Unescape the JSON string (turns "C:\\soft\\x" into "C:\soft\x").
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/**
 * Disk-based resolver for the Codex thread that matches `repoPath`, used when
 * the SQLite state DB can't be read. On native Windows, Codex holds
 * state_*.sqlite open in WAL mode and actively writes it, so sql.js's
 * whole-file read fails with "database disk image is malformed" and every
 * thread lookup returns nothing — leaving the session empty and swept. The
 * rollout `.jsonl` files are append-only and self-describing (each opens with
 * a session_meta line carrying `cwd` + the thread id in its filename), so we
 * resolve the current thread purely from disk. Matches cwd separator-
 * insensitively (Origin normalizes to '/', Codex writes native '\' on
 * Windows); returns the newest matching rollout.
 */
export function findCodexRolloutByCwd(
  codexDir: string,
  repoPath: string,
): { path: string; threadId: string } | null {
  const sessionsDir = path.join(codexDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  const norm = (p: string) => p.replace(/\\/g, '/');
  const wantedNorm = norm(repoPath);

  const candidates: { path: string; mtime: number }[] = [];
  try {
    const years = fs.readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d)).sort().slice(-1);
    for (const y of years) {
      const yDir = path.join(sessionsDir, y);
      const months = fs.readdirSync(yDir).filter(d => /^\d{2}$/.test(d)).sort().slice(-2);
      for (const mo of months) {
        const moDir = path.join(yDir, mo);
        const days = fs.readdirSync(moDir).filter(d => /^\d{2}$/.test(d)).sort().slice(-2);
        for (const d of days) {
          const dDir = path.join(moDir, d);
          for (const f of fs.readdirSync(dDir)) {
            if (!f.includes('rollout') || !(f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'))) continue;
            const fp = path.join(dDir, f);
            try { candidates.push({ path: fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* skip unreadable */ }
          }
        }
      }
    }
  } catch {
    return null;
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Newest first — the current session's rollout is almost always the first
  // file we read, so this usually touches one file.
  for (const c of candidates.slice(0, 40)) {
    const cwd = readRolloutCwd(c.path);
    if (!cwd || norm(cwd) !== wantedNorm) continue;
    const idMatch = path.basename(c.path).match(
      /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
    );
    if (!idMatch) continue;
    return { path: c.path, threadId: idMatch[1] };
  }
  return null;
}

export function findLatestRollout(sessionsDir: string, threadId: string): string {
  let best = '';
  let bestMtime = 0;

  // sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)
  try {
    const years = fs.readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d));
    for (const year of years.slice(-1)) {  // only check latest year
      const yearDir = path.join(sessionsDir, year);
      const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
      for (const month of months.slice(-2)) {  // last 2 months
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          const files = fs.readdirSync(dayDir).filter(f => f.includes('rollout') || f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'));
          for (const file of files) {
            const fp = path.join(dayDir, file);
            // Prefer files matching the thread ID
            if (threadId && file.includes(threadId)) return fp;
            const stat = fs.statSync(fp);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = fp;
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return best;
}

// ─── Hook Handlers ─────────────────────────────────────────────────────────

