// ─── Per-prompt capture completeness ────────────────────────────────────────
//
// Root-cause fix for a recurring class of bugs. On a "commit-and-go" turn (the
// agent CREATES files and COMMITS them in the same turn) a file can fall out of
// EVERY live per-prompt diff capture — by the time the stop hook runs, the work
// is committed and the working tree is clean, and the heartbeat's committed-side
// capture races the commit. The file then survives ONLY in the commit.
//
// Because each downstream consumer re-derives "what did this prompt do?" from a
// different source, an incomplete per-prompt diff shows up as a different bug on
// each surface: an empty turn diff, a wrong AI% line count, and — worst — a
// 100%-AI file rendered as "human" in By-File blame (which matches lines against
// pc.diff). Fixing them one at a time is whack-a-mole.
//
// The invariant enforced here: EVERY file a session commit changed must appear
// in exactly one prompt's diff. Files in a commit but in no prompt diff (orphans)
// are attached to the committing prompt, reconstructed from the commit. Once
// pc.diff is complete, every consumer is correct at the source.

const HEXSHA = /^[0-9a-f]{7,40}$/i;

export interface CompletenessChange {
  diff: string;
  filesChanged: string[];
  commitSha?: string | null;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CompletenessCommit {
  sha: string;
  filesChanged: string[];
}

/** Repo-relative file paths appearing as `diff --git a/<path> b/...` headers. */
function filesInDiff(diff: string): Set<string> {
  const s = new Set<string>();
  for (const m of (diff || '').matchAll(/^diff --git a\/(.*?) b\//gm)) {
    if (m[1]) s.add(m[1]);
  }
  return s;
}

function countLines(diff: string): { added: number; removed: number } {
  const dl = (diff || '').split('\n');
  return {
    added: dl.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: dl.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  };
}

/**
 * Enforce per-prompt capture completeness against the session's own commits.
 *
 * For each commit, any file it changed that is present in NO prompt's diff is
 * attached to the committing prompt (the change whose commitSha matches; else
 * the last change). The file's unified-diff section is fetched via
 * `showFile(sha, file)` — in production a `git show <sha> -- <file>` — so this
 * stays pure and unit-testable (inject a stub in tests).
 *
 * Mutates `changes` in place: appends the section to the owner's diff, adds the
 * file to its filesChanged, and recomputes line counts for every changed owner.
 * `rel` normalizes a commit's file path to the repo-relative form used in diff
 * headers (defaults to identity). Returns true if anything was attached.
 */
export function attachOrphanCommitFiles(
  changes: CompletenessChange[],
  commitDetails: CompletenessCommit[],
  showFile: (sha: string, file: string) => string,
  rel: (f: string) => string = (f) => f,
): boolean {
  if (changes.length === 0 || !Array.isArray(commitDetails) || commitDetails.length === 0) {
    return false;
  }
  // Files already carried by some prompt's diff — earliest coverage wins, and
  // a file modified across prompts legitimately appears in several diffs; we
  // only ever ADD files that appear in none.
  const covered = new Set<string>();
  for (const ch of changes) {
    for (const f of filesInDiff(ch.diff)) covered.add(rel(f));
  }

  let mutated = false;
  for (const commit of commitDetails) {
    if (!commit || !commit.sha || !HEXSHA.test(commit.sha)) continue;
    const owner =
      changes.find((ch) => ch.commitSha === commit.sha) || changes[changes.length - 1];
    if (!owner) continue;
    for (const f of commit.filesChanged || []) {
      const relF = rel(f);
      if (covered.has(relF)) continue; // already attributed to some prompt
      let section = '';
      try {
        section = (showFile(commit.sha, f) || '').trim();
      } catch {
        section = '';
      }
      if (!section) continue;
      owner.diff = owner.diff ? owner.diff + '\n' + section : section;
      if (!owner.filesChanged.includes(relF)) owner.filesChanged.push(relF);
      covered.add(relF);
      mutated = true;
    }
  }

  if (mutated) {
    for (const ch of changes) {
      const c = countLines(ch.diff);
      ch.linesAdded = c.added;
      ch.linesRemoved = c.removed;
    }
  }
  return mutated;
}
