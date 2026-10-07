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
  const repo = repoPromptSetting(repoPath);
  if (repo.kind === 'set') return repo.value;
  if (repo.kind === 'invalid') return false;
  if (repo.seals) return false;
  try {
    return loadConfig()?.notesIncludePrompts === true;
  } catch {
    return false;
  }
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
function validSnapshotRepo(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-')
    && /^[a-zA-Z0-9_./:@+%~=-]+$/.test(value);
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
