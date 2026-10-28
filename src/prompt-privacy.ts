/**
 * Which prompt-bearing data may leave the machine through Git (OR-48/A8).
 *
 * Git refs are read by anyone with read access to the repository, with no
 * Origin permission check, so the default is metadata only, and every
 * decision here fails closed.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';

type RepoPromptSetting = { kind: 'set'; value: boolean } | { kind: 'unset'; seals: boolean } | { kind: 'invalid' };

// The repo's own say, read directly rather than through loadRepoConfig: that
// returns null for a missing file AND for an unreadable or corrupt one, and a
// broken .origin.json must not fall through to a machine-wide opt-in.
function repoPromptSetting(repoPath: string): RepoPromptSetting {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoPath, '.origin.json'), 'utf-8');
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { kind: 'unset', seals: false } : { kind: 'invalid' };
  }
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { return { kind: 'invalid' }; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { kind: 'invalid' };
  if (!Object.prototype.hasOwnProperty.call(cfg, 'notesIncludePrompts')) {
    return { kind: 'unset', seals: (cfg as Record<string, unknown>).notesEncryptPrompts === true };
  }
  const value = (cfg as Record<string, unknown>).notesIncludePrompts;
  return typeof value === 'boolean' ? { kind: 'set', value } : { kind: 'invalid' };
}

// Content gate for every prompt-bearing Git publication (OR-48/A8): the
// prompt text, summary and markers in refs/notes/origin, the automatic push
// of the memory notes, and of the origin-sessions branch to the repository's
// `origin`. Anyone with read access to the repository reads these refs, with
// no Origin permission check, so the default is metadata only: the note keeps
// attribution, originUrl and provable prompt hashes, and the prompts stay in
// the permissioned Origin record.
//
//   - .origin.json says `notesIncludePrompts: true|false` → that, whatever
//     the machine says;
//   - .origin.json asks for sealed prompts (`notesEncryptPrompts: true`)
//     without the key → metadata only (the prompts ride sealed, note-seal.ts):
//     a repo that asked for encryption is never overridden by one person's
//     machine-wide opt-in;
//   - .origin.json is missing, or a valid object without the key → the
//     machine config (~/.origin/config.json), and only a literal `true` there;
//   - .origin.json is unreadable, not a JSON object, or has the key with any
//     other type → metadata only, without consulting the machine.
//
// Notes written earlier are not rewritten; `origin scrub-notes --push` cleans
// them.
export function shouldIncludePromptText(repoPath: string): boolean {
  return promptTextDecision(repoPath).include;
}

/**
 * Where the decision came from, for a user who has to change it: `repo` its
 * .origin.json key, `repo-invalid` a broken .origin.json, `repo-sealed` its
 * notesEncryptPrompts, `machine` an explicit key in ~/.origin/config.json,
 * `default` nobody set anything (metadata only).
 */
export type PromptTextSource = 'repo' | 'repo-invalid' | 'repo-sealed' | 'machine' | 'default';

export function promptTextDecision(repoPath: string): { include: boolean; source: PromptTextSource } {
  const repo = repoPromptSetting(repoPath);
  if (repo.kind === 'set') return { include: repo.value, source: 'repo' };
  if (repo.kind === 'invalid') return { include: false, source: 'repo-invalid' };
  if (repo.seals) return { include: false, source: 'repo-sealed' };
  try {
    const cfg = loadConfig();
    const value = cfg?.notesIncludePrompts;
    if (value === undefined) return { include: false, source: 'default' };
    return { include: value === true, source: 'machine' };
  } catch {
    return { include: false, source: 'default' };
  }
}

/**
 * Where the memory-push decision came from, for a user who has to change it:
 * `repo` / `machine` an explicit key (notesPushMemory, or the older
 * notesIncludePrompts: false that used to hold memory back), `repo-invalid` a
 * broken .origin.json, `default` nobody set anything.
 */
export type MemoryPushSource = 'repo' | 'repo-invalid' | 'machine' | 'default';

/**
 * Whether the memory notes (refs/notes/origin-memory and its brief) are
 * pushed. ON by default, separately from prompt text: with prompt text off,
 * memory is written without it (buildMemoryEntry, scrubPromptTextFromMemory),
 * so what travels is the agents' summaries, decisions, TODOs and file notes.
 *
 *   - .origin.json `notesPushMemory: true|false` → that;
 *   - .origin.json `notesIncludePrompts` without notesPushMemory → that: it
 *     was the memory switch before memory had its own, so `false` stays an
 *     opt-out after an upgrade and `true` still pushes;
 *   - .origin.json unreadable, not a JSON object, or either key not a boolean
 *     → off, without consulting the machine (fail closed, as for prompts);
 *   - otherwise the machine config, by the same two rules; otherwise on.
 */
export function memoryPushDecision(repoPath: string): { push: boolean; source: MemoryPushSource; key?: 'notesPushMemory' | 'notesIncludePrompts' } {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(path.join(repoPath, '.origin.json'), 'utf-8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return { push: false, source: 'repo-invalid' };
  }
  if (raw !== null) {
    let cfg: unknown;
    try { cfg = JSON.parse(raw); } catch { return { push: false, source: 'repo-invalid' }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { push: false, source: 'repo-invalid' };
    const c = cfg as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(c, k);
    if (has('notesPushMemory')) {
      return typeof c.notesPushMemory === 'boolean' ? { push: c.notesPushMemory, source: 'repo', key: 'notesPushMemory' } : { push: false, source: 'repo-invalid' };
    }
    // The repo's prompt key decides for it either way, as it always did: true
    // was the old way to push memory, false the old way to keep it local.
    if (has('notesIncludePrompts')) {
      if (typeof c.notesIncludePrompts !== 'boolean') return { push: false, source: 'repo-invalid' };
      return { push: c.notesIncludePrompts, source: 'repo', key: 'notesIncludePrompts' };
    }
  }
  try {
    const m = loadConfig() as { notesPushMemory?: unknown; notesIncludePrompts?: unknown } | null;
    if (m && typeof m.notesPushMemory === 'boolean') return { push: m.notesPushMemory, source: 'machine', key: 'notesPushMemory' };
    if (m && m.notesIncludePrompts === false) return { push: false, source: 'machine', key: 'notesIncludePrompts' };
  } catch { /* an unreadable machine config is no opt-out */ }
  return { push: true, source: 'default' };
}

export function shouldPushMemory(repoPath: string): boolean {
  return memoryPushDecision(repoPath).push;
}

/** Where an automatic push of the origin-sessions branch may go. */
export type SessionBranchPushTarget =
  | { kind: 'origin' }
  | { kind: 'snapshot'; remote: string };

/**
 * What asks to push the branch: a publish moment (a commit, session end) or
 * the user's own `git push` (the pre-push hook).
 */
export type SessionBranchPushTrigger = 'publish-moment' | 'pre-push';

// A snapshotRepo value may be a remote name, path or URL the user typed:
// restricted characters, and never something git would read as an option.
// On Windows a path is spelled with backslashes (`C:\repos\snapshot.git`).
function validSnapshotRepo(value: unknown): value is string {
  const chars = process.platform === 'win32' ? /^[a-zA-Z0-9_./\\:@+%~=-]+$/ : /^[a-zA-Z0-9_./:@+%~=-]+$/;
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-')
    && chars.test(value);
}

/**
 * The one decision for pushing the origin-sessions branch (per-prompt
 * payloads and diffs), shared by every path that pushes it so they cannot
 * disagree on permission, strategy or destination. null = push nowhere.
 *
 *   - `pushStrategy: 'false'` → never, from any trigger.
 *   - `pushStrategy: 'prompt'` → not at a publish moment; the user's own push
 *     (pre-push) is the moment.
 *   - `snapshotRepo` set → that destination only, and nothing to `origin`:
 *     choosing a separate snapshot store is not consent to publish the branch
 *     in the repository. An invalid value pushes nowhere.
 *   - otherwise `origin`, with the prompt opt-in or `pushStrategy: 'always'`.
 */
export function sessionBranchPushTarget(
  repoPath: string,
  config: { snapshotRepo?: string; pushStrategy?: string } | null | undefined,
  trigger: SessionBranchPushTrigger,
): SessionBranchPushTarget | null {
  const strategy = config?.pushStrategy || 'auto';
  if (strategy === 'false') return null;
  if (strategy === 'prompt' && trigger !== 'pre-push') return null;
  if (config?.snapshotRepo !== undefined && config.snapshotRepo !== '') {
    return validSnapshotRepo(config.snapshotRepo) ? { kind: 'snapshot', remote: config.snapshotRepo } : null;
  }
  return shouldIncludePromptText(repoPath) || strategy === 'always' ? { kind: 'origin' } : null;
}
