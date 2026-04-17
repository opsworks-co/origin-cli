/**
 * Helpers for filtering out "noise" commits that shouldn't appear in the
 * main Commits UI.
 *
 * The canonical case: Origin itself writes session metadata into git notes
 * via `git notes add`, and `git notes add` creates a *real* commit on the
 * notes ref (e.g. refs/notes/origin) with a message like:
 *
 *   Notes added by 'git notes add'
 *
 * When that notes ref gets mirrored to the server via webhook push or the
 * CLI's auto-sync, those metadata commits can land in the Commit table and
 * render as if they were normal code changes. The UI then shows 6 identical
 * rows for a single underlying commit — one per `git notes add` invocation.
 *
 * We filter these at BOTH ends:
 *
 *   1. Write side (webhook / snapshot ingest): drop before insert so the
 *      table doesn't accumulate garbage over time.
 *   2. Read side (commits list endpoint): drop in the mapper so existing
 *      rows in the DB are hidden without requiring a backfill migration.
 *
 * The regex is deliberately loose — git itself has localized this string
 * in the past, and some tools wrap it differently — but it always starts
 * with "Notes added by" followed by a git-notes reference.
 */

const NOTES_METADATA_RE = /^\s*Notes added by ['"]?git notes/i;

/**
 * Returns true if this commit message looks like a `git notes add`
 * metadata commit that should be hidden from the Commits UI.
 */
export function isGitNotesMetadataCommit(message: string | null | undefined): boolean {
  if (!message) return false;
  return NOTES_METADATA_RE.test(message);
}
