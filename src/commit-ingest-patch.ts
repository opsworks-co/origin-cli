// The patch a commit ingest carries — post-commit's own commit and every
// commit the history backfill ships. One rule for both, kept out of
// diff-budget.ts because that file is shared byte-for-byte with the API.
import { fitDiffToBudget } from './diff-budget.js';

/** The byte ceiling for a commit's stored patch (the server keeps the same). */
export const COMMIT_INGEST_PATCH_LIMIT = 500_000;

/**
 * Whole hunks up to the limit, plus `diffTruncated` when anything was left
 * out so the server can mark the row clipped (`Commit.patchClipLimit`) and
 * readers stop counting its text as the commit's lines. Absent entirely for
 * an empty diff.
 *
 * Both producers used to byte-slice at the same limit with no flag. The
 * backfill also sent no counts, and the server counted the slice: prod
 * 92408f51 (2026-09-25) stored +678 for a +729 commit that way.
 */
export function ingestPatchForCommit(diff: string | null | undefined): { diff?: string; diffTruncated?: true } {
  if (!diff) return {};
  const fitted = fitDiffToBudget(diff, COMMIT_INGEST_PATCH_LIMIT);
  if (!fitted.diff) return { diffTruncated: true };
  return fitted.truncated ? { diff: fitted.diff, diffTruncated: true } : { diff: fitted.diff };
}
