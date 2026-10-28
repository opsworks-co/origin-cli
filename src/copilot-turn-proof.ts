// ---------------------------------------------------------------------------
// Origin CLI — does Copilot's events log prove the running turn made a commit?
// ---------------------------------------------------------------------------
// Copilot fires no tool-level hook, so post-commit never has the captures it
// opens a running turn by for other agents (the edit hook's mapping, the live
// ledger, pre-tool-use's record of the committing shell call): every Copilot
// commit was recorded "(no active turn)" and nothing could attest it (OR-45
// G2). Copilot's own events.jsonl holds the same observations, and this reads
// them — the stand-in for the missing hooks, not a new heuristic:
//
//   1. a content-bearing edit/create/apply_patch of the CURRENT prompt whose
//      tool.execution_complete said `success: true` (the G1 verdict the
//      extractor uses), on a repo-relative path that is exactly one of the
//      commit's changed paths; or
//   2. a `bash` call of the current prompt that is still open (no completion
//      yet) and whose command is itself a `git commit` OF THIS CHECKOUT: the
//      caller resolves every `git -C` chain the command names to the commit's
//      working-tree top, and a command whose target the text cannot settle
//      (`cd`, GIT_DIR, `--work-tree`, a `$VAR` path, an earlier `cd` in the
//      same persistent shell) proves nothing.
//
// The current prompt is the segment after the log's last user.message, and
// only when that message IS the running prompt — the whole text, compared
// exactly after Copilot's envelopes are stripped and whitespace collapsed.
// Never promptKey: it keeps 200 characters, so two long prompts sharing a
// prefix would read as one and hand the next prompt's edit to this turn. A
// stored prompt that was clipped matches nothing. Everything else is no proof:
// a torn or unreadable log, no or a different last prompt, a failed /
// cancelled / unknown outcome, another file, a same-named file elsewhere, an
// earlier prompt's work, a finished or failed bash call. Time, basenames,
// path-only or back-filled records and commit mentions are never read.
// ---------------------------------------------------------------------------

import { copilotCallVerdicts, copilotStartEdits, copilotVerdictOf } from './prompt-capture/index.js';
import { stripCopilotEnvelopes } from './transcript.js';

export type CopilotTurnProof =
  | { proven: true; signal: 'successful_edit' | 'open_commit_call' }
  | { proven: false; reason: 'torn_log' | 'no_prompt' | 'other_prompt' | 'no_signal' };

const EDIT_TOOLS = new Set(['edit', 'create', 'apply_patch']);

/** A prompt as text, for an exact comparison: envelopes off, whitespace collapsed, nothing cut. */
function fullPromptText(text: string): string {
  return stripCopilotEnvelopes(String(text || '')).replace(/\s+/g, ' ').trim();
}

// A shell command that moves its working directory, or points git elsewhere
// without one, names a target its text alone cannot settle.
const CWD_CHANGE = /(?:^|[\s;&|(){}`'"])(?:cd|pushd|popd|chdir)(?=$|[\s;&|(){}`'"])/;
const GIT_REDIRECT = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b|--git-dir\b|--work-tree\b/;
// post-commit's COMMITTING_COMMAND, with its options captured.
const GIT_COMMIT = /\bgit\b((?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+commit\b/g;

/** Does this shell command change the shell's own directory? */
export function shellChangesDirectory(command: string): boolean {
  return CWD_CHANGE.test(String(command || ''));
}

/**
 * The `-C` chain (in order, as git applies them) of every `git … commit` in a
 * shell command — `[]` for one run where the shell stands — or null when the
 * text cannot settle a target: no commit at all, a cwd change, a git-dir or
 * work-tree redirect, or a `-C` argument that is quoted oddly, expands
 * (`$`, backticks, `~`, globs) or escapes.
 */
export function gitCommitDirChains(command: string): string[][] | null {
  const text = String(command || '');
  if (shellChangesDirectory(text) || GIT_REDIRECT.test(text)) return null;
  const chains: string[][] = [];
  for (const m of text.matchAll(GIT_COMMIT)) {
    const chain: string[] = [];
    for (const c of (m[1] || '').matchAll(/\s-C\s+(\S+)/g)) {
      let dir = c[1];
      const q = dir[0];
      if ((q === '"' || q === "'") && dir.length >= 2 && dir.endsWith(q)) dir = dir.slice(1, -1);
      if (!dir || /[\s$`~*?[\]{}\\'"]/.test(dir)) return null;
      chain.push(dir);
    }
    chains.push(chain);
  }
  return chains.length > 0 ? chains : null;
}

export function copilotRunningTurnProof(
  raw: string,
  opts: {
    /** The commit's repo root; Copilot logs absolute paths. */
    repoPath: string;
    /** The running prompt as Origin stored it. */
    runningPrompt: string;
    /** The commit's changed paths, repo-relative. */
    commitFiles: readonly string[];
    /**
     * Does `command` commit the checkout post-commit fired in? Handed every
     * bash command the log ran before it, in any prompt: the shell persists,
     * so an earlier `cd` leaves its directory unknown.
     */
    commitsThisCheckout: (command: string, earlierCommands: readonly string[]) => boolean;
  },
): CopilotTurnProof {
  const events: any[] = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { return { proven: false, reason: 'torn_log' }; }
  }

  let last = -1;
  for (let i = 0; i < events.length; i++) if (events[i]?.type === 'user.message') last = i;
  if (last < 0) return { proven: false, reason: 'no_prompt' };
  const logged = fullPromptText(typeof events[last]?.data?.content === 'string' ? events[last].data.content : '');
  const running = fullPromptText(opts.runningPrompt || '');
  if (!logged || !running || logged !== running) return { proven: false, reason: 'other_prompt' };

  const verdicts = copilotCallVerdicts(events);
  const commitFiles = new Set(opts.commitFiles.map((f) => f.replace(/\\/g, '/')));
  const bashCommand = (e: any): string | null => {
    if (e?.type !== 'tool.execution_start' || e?.data?.toolName !== 'bash') return null;
    return typeof e?.data?.arguments?.command === 'string' ? e.data.arguments.command : '';
  };
  for (let i = last + 1; i < events.length; i++) {
    const e = events[i];
    if (e?.type !== 'tool.execution_start') continue;
    const data = e?.data || {};
    const toolName = String(data.toolName || '');
    if (EDIT_TOOLS.has(toolName)) {
      if (copilotVerdictOf(verdicts, data.toolCallId) !== 'succeeded') continue;
      const { edits, contentBearing } = copilotStartEdits(toolName, data.arguments, opts.repoPath);
      if (!contentBearing) continue;
      if (edits.some((ed) => commitFiles.has(ed.file.replace(/\\/g, '/')))) return { proven: true, signal: 'successful_edit' };
      continue;
    }
    if (toolName === 'bash') {
      const id = data.toolCallId;
      if (typeof id !== 'string' || !id || verdicts.completed.has(id)) continue;
      const command = data.arguments && typeof data.arguments.command === 'string' ? data.arguments.command : '';
      if (!command) continue;
      const earlier = events.slice(0, i).map(bashCommand).filter((c): c is string => c !== null);
      if (opts.commitsThisCheckout(command, earlier)) return { proven: true, signal: 'open_commit_call' };
    }
  }
  return { proven: false, reason: 'no_signal' };
}
