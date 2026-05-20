// Codex per-prompt diff backfill.
//
// Codex doesn't fire user-prompt-submit reliably, so the live capture path
// only gets per-prompt diffs for the prompts where the hook happened to
// fire. Stop hooks then upload a sparse mapping and the dashboard's AI
// Blame view shows wrong attribution — typically lumping a turn's work
// onto whichever prompt was active when the commit *landed*, which races
// against the user typing the next prompt.
//
// Turn-scoped attribution: walk the Codex rollout chronologically; user
// `message` events advance an in-memory turn counter; `function_call_output`
// events for shell commits contain the commit SHA right after `[branch sha]`
// in the output. We map (commitSha → promptIndex) directly from the rollout
// — no timestamp comparison, no race conditions, the commit is attributed
// to the turn whose tool call produced it.
//
// `mapCommitsToPromptsFromRollout` returns the SHA→promptIndex map.
// `buildPerPromptDiffs` then runs `git diff parent..head` for each prompt's
// commit range to produce the per-prompt diff.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { gitOrNull, git as gitExec } from './utils/exec.js';
import * as fzstd from 'fzstd';

const HEX = /^[0-9a-f]{4,64}$/i;

export interface CodexPrompt {
  text: string;
  timestamp: number; // ms epoch, 0 if unknown
}

export interface CodexCommit {
  sha: string;
  parentSha: string | null;
  timestamp: number; // ms epoch
}

export interface CodexPromptMapping {
  promptIndex: number;
  promptText: string;
  filesChanged: string[];
  diff: string;
  uncommittedDiff: string;
  commitSha: string | null;
  // Marks this mapping as the authoritative source for the prompt — derived
  // from the rollout's per-turn [branch sha] markers, not racy live captures.
  // The server overwrites diff/uncommittedDiff/filesChanged with the values
  // in this object instead of preserving prior data, so wrong per-turn data
  // that landed during user-prompt-submit races gets cleared.
  authoritative?: boolean;
}

/**
 * Group commits by the prompt window they belong to. A commit C belongs to
 * prompt P when P is the LATEST prompt whose timestamp ≤ C.timestamp. If
 * timestamps are missing (== 0), commits fall through to the last prompt so
 * we don't drop them on the floor.
 */
export function groupCommitsByPrompt(
  prompts: CodexPrompt[],
  commits: CodexCommit[],
): Map<number, CodexCommit[]> {
  const grouped = new Map<number, CodexCommit[]>();
  if (prompts.length === 0) return grouped;

  for (const commit of commits) {
    let pickIdx = -1;
    for (let i = 0; i < prompts.length; i++) {
      const ts = prompts[i].timestamp;
      if (ts > 0 && commit.timestamp > 0 && ts <= commit.timestamp) {
        pickIdx = i;
      } else if (ts === 0 || commit.timestamp === 0) {
        // Unknown timestamp on either side — fall through to "latest" so we
        // at least attribute to the most recent prompt instead of dropping.
        pickIdx = i;
      }
    }
    if (pickIdx < 0) pickIdx = prompts.length - 1;
    if (!grouped.has(pickIdx)) grouped.set(pickIdx, []);
    grouped.get(pickIdx)!.push(commit);
  }
  return grouped;
}

/**
 * List commits in `headBefore..headAfter` along with their commit times.
 * Returns commits in reverse-chronological order (newest first), matching
 * `git log`. Returns [] if either ref is invalid or the range yields nothing.
 */
export function getSessionCommitsWithTimes(
  repoPath: string,
  headBefore: string,
  headAfter: string,
): CodexCommit[] {
  if (!HEX.test(headBefore) || !HEX.test(headAfter)) return [];
  const opts = { cwd: repoPath, timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 };
  let log: string;
  try {
    log = gitExec(
      ['log', `--format=%H|%P|%ct`, `${headBefore}..${headAfter}`],
      opts,
    ).trim();
  } catch {
    return [];
  }
  if (!log) return [];
  const out: CodexCommit[] = [];
  for (const line of log.split('\n')) {
    const [sha, parents, ctStr] = line.split('|');
    if (!sha || !HEX.test(sha)) continue;
    const firstParent = (parents || '').split(' ').filter(Boolean)[0] || null;
    const ct = Number(ctStr);
    if (!Number.isFinite(ct)) continue;
    out.push({
      sha,
      parentSha: firstParent && HEX.test(firstParent) ? firstParent : null,
      timestamp: ct * 1000, // %ct is unix seconds — promote to ms to match rollout timestamps
    });
  }
  return out;
}

/**
 * Build a per-prompt diff from a contiguous range of commits. Uses the FIRST
 * commit's parent as the base ref and the LAST commit's sha as the head ref,
 * so the resulting diff reflects everything the agent landed for that prompt
 * even when it made multiple commits.
 */
export function buildDiffForCommitRange(
  repoPath: string,
  commits: CodexCommit[],
): { diff: string; filesChanged: string[]; baseRef: string | null; headRef: string | null } {
  if (commits.length === 0) {
    return { diff: '', filesChanged: [], baseRef: null, headRef: null };
  }
  // commits is reverse-chronological (newest first). The OLDEST commit is at
  // the end of the array; its parent is the base. The NEWEST commit is at
  // index 0 — that's our diff head.
  const oldest = commits[commits.length - 1];
  const newest = commits[0];
  const baseRef = oldest.parentSha;
  const headRef = newest.sha;
  if (!baseRef) {
    // Root commit (no parent). Fall back to diffing against the empty tree.
    // git's empty-tree hash is stable: 4b825dc642cb6eb9a060e54bf8d69288fbee4904.
    return diffAgainst(repoPath, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', headRef);
  }
  return diffAgainst(repoPath, baseRef, headRef);
}

function diffAgainst(
  repoPath: string,
  base: string,
  head: string,
): { diff: string; filesChanged: string[]; baseRef: string; headRef: string } {
  const opts = { cwd: repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
  let diff = '';
  let names = '';
  try {
    diff = gitExec(['diff', `${base}..${head}`], opts);
  } catch { /* ignore */ }
  try {
    names = gitExec(['diff', '--name-only', `${base}..${head}`], opts);
  } catch { /* ignore */ }
  return {
    diff: (diff || '').slice(0, 200_000),
    filesChanged: (names || '').split('\n').map((s) => s.trim()).filter(Boolean),
    baseRef: base,
    headRef: head,
  };
}

// Read a Codex rollout file (handles .zst compression) and return its
// raw JSONL text. Returns null on missing file or unrecoverable decode error.
function readRolloutText(rolloutFile: string): string | null {
  try {
    if (!fs.existsSync(rolloutFile)) return null;
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

// Pull SHAs out of a shell command's output. `git commit` prints
// `[branch SHORTSHA] message`; we capture short SHAs that look like git
// hashes (7-40 hex chars). The caller normalises to full SHAs via git log.
function extractShasFromOutput(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // Pattern from `git commit`: [branch abc1234] message  OR  [(root-commit) abc1234] message
  for (const m of text.matchAll(/^\[(?:\([^)]+\)\s+)?[^\s\]]+\s+([0-9a-f]{7,40})\]/gm)) {
    out.push(m[1]);
  }
  // Also catch standalone short SHAs in output lines like "create mode 100644 abc1234".
  // Conservative: only the [branch sha] form is reliable, so we stop here.
  return out;
}

// Walk a Codex rollout and produce a map of commit SHA → promptIndex.
// Strategy:
//   1. Iterate events in chronological order.
//   2. Each user-role `message` event (not echo/wrapper text) advances the
//      current promptIndex counter.
//   3. Each `function_call_output` / `local_shell_call_output` is scanned
//      for git commit SHAs. Any SHA found is attributed to the CURRENT
//      promptIndex (the turn whose tool call produced the output).
//
// This sidesteps the timestamp race that plagues the old approach: the
// commit's SHA is locked to the turn that executed the shell call,
// regardless of when the user typed the next prompt.
//
// Exported for unit testing.
export function mapCommitsToPromptsFromRollout(
  rolloutText: string,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!rolloutText) return result;

  let currentPromptIdx = -1;

  for (const line of rolloutText.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }

    const payload = event?.payload;
    const payloadType = payload?.type || '';
    const eventType = event?.type || event?.event || '';

    // ── New-shape Codex rollouts: response_item events ────────────────
    if (payloadType === 'message') {
      const role = payload.role || '';
      if (role === 'user' || role === 'human') {
        // Filter out Codex's auto-injected wrappers. AGENTS.md echo + the
        // <INSTRUCTIONS>/<environment_context> session-init blob always
        // appear as the first user-role events; they don't represent the
        // human typing anything, so they must NOT advance the turn counter.
        const text = extractMessageText(payload.content);
        if (isRealUserText(text)) currentPromptIdx++;
      }
    } else if (payloadType === 'function_call_output' || payloadType === 'local_shell_call_output') {
      if (currentPromptIdx < 0) continue; // outputs before any user turn — skip
      const output = stringifyOutput(payload?.output);
      for (const sha of extractShasFromOutput(output)) {
        // Earliest-prompt-wins to be deterministic if the same commit
        // somehow appears in two outputs.
        if (!result.has(sha)) result.set(sha, currentPromptIdx);
      }
    } else if (eventType === 'item.created' || eventType === 'message') {
      // ── Legacy/older-shape rollouts ─────────────────────────────────
      const item = event?.data || event?.item || event;
      const role = item?.role || item?.type || '';
      const content = item?.content || item?.text || item?.message;
      if ((role === 'user' || role === 'human') && content) {
        const text = extractMessageText(content);
        if (isRealUserText(text)) currentPromptIdx++;
      }
    } else if (
      eventType === 'function_call_output' ||
      eventType === 'tool_call_output' ||
      eventType === 'shell_output'
    ) {
      if (currentPromptIdx < 0) continue;
      const data = event?.data || event;
      const output = stringifyOutput(data?.output ?? data?.stdout ?? data?.content);
      for (const sha of extractShasFromOutput(output)) {
        if (!result.has(sha)) result.set(sha, currentPromptIdx);
      }
    }
  }
  return result;
}

function extractMessageText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => {
      if (!c) return '';
      if (typeof c === 'string') return c;
      if (c.text) return c.text;
      if (typeof c.content === 'string') return c.content;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function stringifyOutput(out: any): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object') {
    if (typeof out.content === 'string') return out.content;
    if (typeof out.stdout === 'string') return out.stdout;
    try { return JSON.stringify(out); } catch { return ''; }
  }
  return String(out);
}

function isRealUserText(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (text.includes('<!-- origin-managed -->')) return false;
  if (/^#\s+AGENTS\.md instructions for /m.test(text)) return false;
  // Strip the envelope tags. If the remainder is empty, it was a wrapper-only blob.
  const stripped = text
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .trim();
  return stripped.length > 0;
}

/**
 * Resolve the short SHAs harvested from rollout outputs against the
 * session's actual git log so we end up with FULL 40-char SHAs that match
 * the commits we produce diffs from. Skips SHAs that don't appear in the
 * session's commit range — they may be from sub-modules, scratch repos,
 * or output of a `git log` command rather than a real commit.
 */
function resolveShortToFullShas(
  short2turn: Map<string, number>,
  fullShas: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [short, turn] of short2turn) {
    const full = fullShas.find((f) => f.startsWith(short.toLowerCase()));
    if (full) out.set(full, turn);
  }
  return out;
}

/**
 * Full pipeline. Returns one mapping per prompt that produced at least one
 * commit, ordered by promptIndex. Prompts that produced no commits are
 * omitted — the caller (stop hook) decides whether to also surface them as
 * chat-only entries.
 *
 * `rolloutFile` optional: when provided, commit→prompt attribution comes
 * from the rollout's `function_call_output` events (turn-scoped, no race
 * with the next prompt). When omitted, falls back to timestamp-based
 * `groupCommitsByPrompt` (legacy behaviour).
 */
export function backfillCodexPromptMappings(opts: {
  repoPath: string;
  headShaAtStart: string;
  headShaAtEnd: string;
  prompts: CodexPrompt[];
  rolloutFile?: string;
}): CodexPromptMapping[] {
  if (opts.prompts.length === 0) return [];
  const commits = getSessionCommitsWithTimes(opts.repoPath, opts.headShaAtStart, opts.headShaAtEnd);
  if (commits.length === 0) return [];

  // ── Build the commit → prompt map ────────────────────────────────────
  // Prefer rollout-derived attribution. Falls back to timestamps only when
  // the rollout doesn't surface a SHA for a given commit (rare — `git
  // commit` always echoes `[branch sha]`).
  let grouped: Map<number, CodexCommit[]>;
  if (opts.rolloutFile) {
    const rolloutText = readRolloutText(opts.rolloutFile);
    if (rolloutText) {
      const short2turn = mapCommitsToPromptsFromRollout(rolloutText);
      const fullShas = commits.map((c) => c.sha);
      const full2turn = resolveShortToFullShas(short2turn, fullShas);
      grouped = new Map();
      const unresolved: CodexCommit[] = [];
      for (const c of commits) {
        const idx = full2turn.get(c.sha);
        if (idx == null) {
          unresolved.push(c);
          continue;
        }
        if (!grouped.has(idx)) grouped.set(idx, []);
        grouped.get(idx)!.push(c);
      }
      // Backfill unresolved commits via timestamps as a last resort.
      if (unresolved.length > 0) {
        const fallback = groupCommitsByPrompt(opts.prompts, unresolved);
        for (const [idx, cs] of fallback) {
          if (!grouped.has(idx)) grouped.set(idx, []);
          grouped.get(idx)!.push(...cs);
        }
      }
    } else {
      grouped = groupCommitsByPrompt(opts.prompts, commits);
    }
  } else {
    grouped = groupCommitsByPrompt(opts.prompts, commits);
  }

  const out: CodexPromptMapping[] = [];
  for (let idx = 0; idx < opts.prompts.length; idx++) {
    const promptCommits = grouped.get(idx);
    if (!promptCommits || promptCommits.length === 0) continue;
    // Sort newest-first to match buildDiffForCommitRange's expectations.
    promptCommits.sort((a, b) => b.timestamp - a.timestamp);
    const { diff, filesChanged, headRef } = buildDiffForCommitRange(opts.repoPath, promptCommits);
    if (!diff && filesChanged.length === 0) continue;
    out.push({
      promptIndex: idx,
      promptText: opts.prompts[idx].text.slice(0, 1000),
      filesChanged,
      diff,
      uncommittedDiff: '',
      commitSha: headRef,
      authoritative: true,
    });
  }

  // Fold any current working-tree diff (vs HEAD) into the LAST prompt that
  // produced commits. Without this, Codex edits the agent made but never
  // committed in this session are dropped from the per-prompt view entirely —
  // e.g. README updates that the agent left dirty get attributed to no
  // prompt at all. Attributing them to the last commit-producing prompt is a
  // best-effort approximation (we don't have per-prompt working-tree snapshots
  // for Codex), but it beats losing the data.
  if (out.length > 0) {
    const uncommittedOpts = { cwd: opts.repoPath, timeoutMs: 15_000, maxBuffer: 10 * 1024 * 1024 };
    let uncommittedDiff = '';
    let uncommittedNames: string[] = [];
    try {
      uncommittedDiff = gitExec(['diff', '--unified=2000', 'HEAD'], uncommittedOpts) || '';
    } catch { /* working tree clean or HEAD missing — leave empty */ }
    try {
      const names = gitExec(['diff', '--name-only', 'HEAD'], uncommittedOpts) || '';
      uncommittedNames = names.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* ignore */ }
    if (uncommittedDiff || uncommittedNames.length > 0) {
      const last = out[out.length - 1];
      last.uncommittedDiff = uncommittedDiff.slice(0, 200_000);
      // Union with committed files so the per-prompt files list reflects
      // EVERYTHING this prompt touched, committed or not.
      const merged = new Set(last.filesChanged);
      for (const f of uncommittedNames) merged.add(f);
      last.filesChanged = Array.from(merged);
    }
  }
  return out;
}
