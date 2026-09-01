// Shell writes — the capture-side half of the empty-`edits` problem.
//
// An agent that writes files through the SHELL (`cat > f <<'EOF'`, `sed -i`,
// a `python3 - <<'PY'` script that calls `open(p,'w')`, `cp`, an `scp`/`tar`
// restore off a server) fires no Edit/Write tool call, so the transcript and
// the live PostToolUse ledger both come up empty and `capturePromptEdits`
// records `{"edits":[]}` for the turn. On the wire that is byte-identical to
// a genuinely chat-only turn, and the server has to treat empty edits as
// authoritative or a pure question would inherit the worktree's pre-existing
// dirt (#528). Every read surface then needs its own "is this really
// chat-only?" test, and each one that lacked it hid real work: the session
// tab (5212035e), the commit detail, and By-Prompt blame (#1097, session
// c5c94af7 — three turns that committed 1929 / 1081 / 2 lines rendered as
// "made no source changes").
//
// This module closes it at the source. The unit is the TURN WINDOW: git's
// own diff between the baseline captured when the turn started and the tree
// as it stands when the turn ends. That window is exactly this turn's work —
// which is what makes it usable where `supplementUncoveredCommittedFiles`
// (the existing shell backfill) is not: that one derives edits from a COMMIT,
// and a commit routinely carries several turns' work, so its edits ship as
// `source: 'commit'` and every server surface filters them out of authorship.
//
// Two things keep the window honest:
//   • It is computed at the END OF THE TURN IT DESCRIBES, so a later turn's
//     work cannot leak backwards into it, and pre-session dirt sits in the
//     baseline rather than the diff.
//   • It is only consulted for a turn that actually ran a write-shaped shell
//     command (see `commandWritesFiles`). A turn that only ran `ls` / `grep`
//     / `git status` claims nothing.
//
// Residual risk, stated plainly: if a HUMAN (or a concurrent agent) edits a
// file during a turn that also ran a write-shaped shell command, that edit
// lands in the window and is claimed by the turn. That is the same exposure
// the git-captured `pc.diff` has always had — this module does not widen it,
// but it does not close it either.

import type { PromptEdit, PromptEditOp } from './prompt-capture/types.js';

/** Stamped on every edit this module produces, so a bad claim is traceable. */
export const SHELL_WINDOW_SOURCE = 'shell-window';

// Shell/terminal tool names across the agents that fire PostToolUse. Codex
// is absent on purpose: it routes its shell work through apply_patch, which
// `extractEditsFromToolCall` already parses into exact edits.
const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'run_shell_command',
  'run_terminal_command',
  'run_terminal_cmd',
  'runcommands',
  'execute_command',
  'terminal',
  'run_in_terminal',
]);

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(String(toolName || '').toLowerCase());
}

/** Pull the command text out of a shell tool's input, whatever it calls it. */
export function shellCommandText(input: any): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'script', 'commandLine', 'command_line', 'input']) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) return v;
    // Codex-style `command: ["bash", "-lc", "…"]`.
    if (Array.isArray(v)) {
      const joined = v.filter((p) => typeof p === 'string').join(' ');
      if (joined) return joined;
    }
  }
  return '';
}

// Commands that mutate the working tree. Deliberately generous on the
// interpreters (`python3 - <<'PY'` is how an agent hand-patches a file when
// the Edit tool would be awkward) — a false positive costs one `git diff`
// per turn and nothing else, because the window itself decides what, if
// anything, is claimed.
// Commands that mutate the working tree. Deliberately generous on the
// interpreters (`python3 - <<'PY'` is how an agent hand-patches a file when
// the Edit tool would be awkward) — a false positive costs one `git diff`
// per turn and nothing else, because the window itself decides what, if
// anything, is claimed.
//
// `/m` + a leading-whitespace anchor is load-bearing: an agent's Bash call is
// routinely a multi-line script (`cd <repo>\npython3 - <<'PY'`), so a rule
// anchored only at `^` or after `;&|(` misses every command past the first
// line — which is exactly where the write usually is.
const WRITE_COMMANDS = [
  /(^\s*|[;&|(]\s*)(sed|perl)\s+(-[a-zA-Z]*\s+)*-i/m,          // in-place edit
  /(^\s*|[;&|(]\s*)(cp|mv|rm|mkdir|touch|ln|install|patch|dd|truncate|rsync|scp|unzip|gunzip)\b/m,
  /(^\s*|[;&|(]\s*)tar\b[^|;&\n]*\s-[a-zA-Z]*x/m,               // tar extract
  /(^\s*|[;&|(]\s*)(tee|sponge)\b/m,
  // curl/wget only when the output actually lands in a file — an agent
  // probing a URL with `-o /dev/null` writes nothing.
  /(^\s*|[;&|(]\s*)(curl|wget)\b[^|;&\n]*\s(-o\s+(?!\/dev\/null)|-O\b|--output[=\s]+(?!\/dev\/null))/m,
  /(^\s*|[;&|(]\s*)git\s+(checkout|switch|restore|apply|reset|stash|clone|pull|merge|revert|cherry-pick|rm|mv|am)\b/m,
  /(^\s*|[;&|(]\s*)(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|link)\b/m,
  /(^\s*|[;&|(]\s*)(pip|pip3)\s+install\b/m,
  /(^\s*|[;&|(]\s*)(make|cargo|go|gradle|mvn|dotnet|npx|tsc|webpack|vite|next|prisma)\b/m,
  // Any interpreter invocation — a script's whole purpose may be to write.
  /(^\s*|[;&|(]\s*)(python3?|node|ruby|perl|php|deno|bun|osascript|pwsh|powershell)\b/m,
];

// A redirect that lands in a FILE. Excludes fd duplication (`2>&1`),
// /dev/null, and process substitution — none of those touch the repo.
const FILE_REDIRECT = />>?\s*(?!&)(?!\/dev\/null)(?!\/dev\/stderr)(?!\/dev\/stdout)[^\s;&|)<>]/;

/**
 * Whether a shell command could have written to the working tree.
 *
 * This is a COST GATE, not the correctness gate — the turn window decides
 * what is actually claimed. It exists so a read-only turn never even looks
 * at the window, which is what keeps a `ls`-and-`grep` turn from claiming an
 * edit the user made in their editor while the agent was talking.
 */
export function commandWritesFiles(command: string): boolean {
  const cmd = String(command || '');
  if (!cmd.trim()) return false;
  // Probe the SHELL, not the data: a heredoc body is prose, JSX or python
  // source, and matching command names or `>` inside it is reading the file
  // being written as if it were the thing doing the writing. The write-shaped
  // command (`python3 - <<'PY'`, `cat > f <<'EOF'`) is always on the line that
  // opens the heredoc, which survives stripping.
  const shell = stripHeredocBodies(cmd);
  if (WRITE_COMMANDS.some((re) => re.test(shell))) return true;
  return FILE_REDIRECT.test(shell);
}

export function stripHeredocBodies(cmd: string): string {
  const lines = cmd.split('\n');
  const out: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (m) terminator = m[1];
  }
  return out.join('\n');
}

export interface ShellWindowDeps {
  /** Files that changed between `baselineSha` and the current tree. */
  listChangedFiles: (baselineSha: string) => string[];
  /** File content at the turn's baseline, or null when it didn't exist. */
  readAtRev: (baselineSha: string, file: string) => string | null;
  /** File content as it stands now, or null when it no longer exists. */
  readWorking: (file: string) => string | null;
}

export interface ShellWindowOptions {
  baselineSha: string;
  /** Files already carried by this turn's tool-call edits — never re-claimed. */
  coveredFiles?: Iterable<string>;
  /** Paths to skip (Origin's own managed files, user ignore patterns). */
  isIgnored?: (file: string) => boolean;
  /**
   * Files a CONCURRENT session owns. The window is a bare
   * `baseline..working-tree` diff, so in a shared checkout it contains
   * whatever other agents were writing while this turn ran — and unlike the
   * tool-call path there is no per-edit record to tell them apart.
   *
   * Measured: session b629d2cb's shell-heavy turns kept being credited with
   * 97ad4482's `commit-attribution.test.ts` and `routes/sessions.ts` through
   * three successive fixes to the exclusion SET, because this path never
   * consulted it. Pass `uncommittedExcludeUnion(state)` here.
   */
  foreignFiles?: Iterable<string>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ShellWindowResult {
  edits: PromptEdit[];
  /** Files the window held but we did not claim, with the reason. */
  skipped: Array<{ file: string; reason: 'covered' | 'ignored' | 'foreign' | 'too-large' | 'budget' | 'unchanged' | 'binary' }>;
}

/**
 * Trim a whole-file before/after pair down to the region that actually differs,
 * keeping a few unchanged lines either side as context.
 *
 * The identical leading and trailing lines carry no change, so dropping them
 * loses nothing an LCS would have reported — the hunks are the same, they just
 * no longer cost the size of the file to store. `startLine` is the 1-based line
 * the kept region begins at, which is the edit's real anchor.
 *
 * Returns null when there is nothing to trim (identical content, or a pair with
 * no common edges), leaving the caller on its existing size behaviour.
 */
export function trimToChangedRegion(
  oldContent: string,
  newContent: string,
  contextLines = 3,
): { oldContent: string; newContent: string; startLine: number } | null {
  if (oldContent === newContent) return null;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuffix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const keepFrom = Math.max(0, prefix - contextLines);
  const dropTail = Math.max(0, suffix - contextLines);
  // Nothing common to shed — trimming would return the input unchanged.
  if (keepFrom === 0 && dropTail === 0) return null;

  return {
    oldContent: oldLines.slice(keepFrom, oldLines.length - dropTail).join('\n'),
    newContent: newLines.slice(keepFrom, newLines.length - dropTail).join('\n'),
    startLine: keepFrom + 1,
  };
}

// A single file's content pair. A file whose CHANGE still exceeds this after
// trimToChangedRegion has shed the unchanged edges is skipped, not clamped.
const DEFAULT_MAX_FILE_BYTES = 96 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;

// Content that isn't worth diffing line-by-line. `git show` hands back the
// raw bytes for an image or a font, and an LCS over those produces a
// meaningless wall of `+`/`-`.
function looksBinary(content: string): boolean {
  return content.includes('\0');
}

/**
 * Turn one prompt's git window into authoritative PromptEdits.
 *
 * `source: 'uncommitted'` is deliberate. The content genuinely comes from
 * working-tree state, and it is a value every server surface ALREADY accepts
 * as authorship (`!e.source || e.source === 'tool_call' || e.source ===
 * 'uncommitted'`), so these edits count the day a CLI ships them — no
 * server-side allow-list to update, and no silent drop if one site is
 * missed. A new source value would have been the honest label and the
 * dangerous one. `backfillSource` carries the real provenance for anyone
 * auditing a claim.
 */
export function shellWindowEdits(deps: ShellWindowDeps, opts: ShellWindowOptions): ShellWindowResult {
  const result: ShellWindowResult = { edits: [], skipped: [] };
  if (!opts.baselineSha) return result;

  // Both exclusion sets mix repo-relative and ABSOLUTE paths, depending on
  // whether an entry came from a tool call or a git capture, so a window file
  // (always repo-relative) has to match `/abs/checkout/src/app.ts` against
  // `src/app.ts`. That reconciliation used to be done by ALSO indexing every
  // entry's basename — which silently excludes any OTHER file sharing the name.
  //
  // agy session 65953fe2: the turn's tool calls created `frontend/index.html`,
  // and the same turn deleted the repo-root `index.html` from the shell. The
  // basename `index.html` was in `covered`, so the deletion was dropped as
  // "already accounted for" and its 51 removed lines were recorded nowhere —
  // 7 of the turn's 8 deletions landed, the 8th vanished.
  //
  // Suffix matching keeps the absolute↔relative tolerance that was actually
  // needed and nothing more: an entry covers `file` when it IS `file`, or when
  // it is an ABSOLUTE path ending in `/<file>` (i.e. the same file seen through
  // a checkout root). A sibling repo-relative path never matches.
  const excludes = (entries: Iterable<string> | undefined): ((file: string) => boolean) => {
    const exact = new Set<string>();
    const absolute: string[] = [];
    for (const raw of entries || []) {
      if (!raw) continue;
      const f = raw.replace(/\\/g, '/');
      exact.add(f);
      // Absolute in either POSIX (`/x`) or Windows (`C:/x`) form.
      if (f.startsWith('/') || /^[A-Za-z]:\//.test(f)) absolute.push(f);
    }
    return (file: string): boolean => {
      const f = file.replace(/\\/g, '/');
      if (exact.has(f)) return true;
      return absolute.some((a) => a.endsWith(`/${f}`));
    };
  };
  const isCovered = excludes(opts.coveredFiles);
  const isForeign = excludes(opts.foreignFiles);

  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  let files: string[];
  try {
    files = deps.listChangedFiles(opts.baselineSha) || [];
  } catch {
    return result;
  }

  let spent = 0;
  for (const file of files.slice(0, maxFiles)) {
    if (!file) continue;
    if (isCovered(file)) {
      result.skipped.push({ file, reason: 'covered' });
      continue;
    }
    if (opts.isIgnored?.(file)) {
      result.skipped.push({ file, reason: 'ignored' });
      continue;
    }
    // Another session's file. Checked AFTER `covered` on purpose: a file this
    // turn provably edited via a tool call stays ours even if a sibling also
    // touched it, which keeps a contested file from vanishing from the turn
    // that really wrote it.
    if (isForeign(file)) {
      result.skipped.push({ file, reason: 'foreign' });
      continue;
    }
    let oldContent: string | null;
    let newContent: string | null;
    try {
      oldContent = deps.readAtRev(opts.baselineSha, file);
      newContent = deps.readWorking(file);
    } catch {
      continue;
    }
    if (oldContent === null && newContent === null) continue;
    if (oldContent !== null && newContent !== null && oldContent === newContent) {
      // git reported it changed but the content matches — a mode-only change.
      result.skipped.push({ file, reason: 'unchanged' });
      continue;
    }
    if ((oldContent && looksBinary(oldContent)) || (newContent && looksBinary(newContent))) {
      result.skipped.push({ file, reason: 'binary' });
      continue;
    }
    const op: PromptEditOp = oldContent === null ? 'create' : newContent === null ? 'delete' : 'edit';
    // The cap is on CONTENT, and this path stores whole files — so a big file
    // was dropped for its SIZE rather than for the size of its change, and
    // dropped means gone: the next turn's baseline is anchored at the current
    // tree, so nothing downstream can recover it.
    //
    // Session 3dbff831 turn 7 edited SessionDetail.tsx (112KB) and
    // RepoDetail.tsx (120KB) through shell scripts. Both blew the 96KB
    // old+new ceiling, both were skipped, and their +8/-13 landed on NO turn
    // while sitting in the commit — the turn read +131/-20 against a commit of
    // +139/-33, and the gap was exactly those two files. api.ts (85KB) is over
    // the ceiling too and survived only because a tool call had already
    // claimed it.
    //
    // A file's CHANGE is almost always small even when the file is not, so
    // trim the pair to the changed region before giving up. That keeps the
    // (oldContent, newContent) contract every consumer already reads — an LCS
    // over the trimmed pair yields the same hunks as one over the whole file —
    // and pays the real anchor as a bonus. Only a genuinely huge change still
    // trips the cap.
    let oldC = oldContent ?? '';
    let newC = newContent ?? '';
    let anchor: number | undefined;
    let bytes = oldC.length + newC.length;
    if (bytes > maxFileBytes && op === 'edit') {
      const trimmed = trimToChangedRegion(oldC, newC);
      if (trimmed && trimmed.oldContent.length + trimmed.newContent.length <= maxFileBytes) {
        oldC = trimmed.oldContent;
        newC = trimmed.newContent;
        anchor = trimmed.startLine;
        bytes = oldC.length + newC.length;
      }
    }
    if (bytes > maxFileBytes) {
      result.skipped.push({ file, reason: 'too-large' });
      continue;
    }
    if (spent + bytes > maxTotalBytes) {
      result.skipped.push({ file, reason: 'budget' });
      continue;
    }
    spent += bytes;

    result.edits.push({
      file,
      op,
      oldContent: oldC,
      newContent: newC,
      // Only set when the pair was trimmed — the region no longer starts at
      // line 1, and without this the hunk would claim it does.
      ...(anchor !== undefined && { oldStart: anchor, newStart: anchor }),
      source: 'uncommitted',
      // INFERENCE, not proof: this file was dirty inside the turn's window,
      // which in a shared checkout also describes a sibling agent's work and
      // the user's own hand edits. The per-command probe
      // (shell-command-probe.ts) is the proof path; anything reaching here is
      // what the probe could not see, and every surface should be able to tell
      // the two apart rather than rendering them identically.
      evidence: 'turn_window',
      backfillSource: SHELL_WINDOW_SOURCE,
    });
  }
  if (files.length > maxFiles) {
    for (const file of files.slice(maxFiles)) result.skipped.push({ file, reason: 'budget' });
  }
  return result;
}
