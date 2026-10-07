/**
 * Recover a commit attestation a missed post-commit hook never wrote — see
 * recoverCommittedTurnProofs. (The module once also moved a git-only turn's
 * stamp onto the turn that wrote the files, #1482; since 2026-10-02 the
 * committing turn keeps it.)
 */

function filesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((f): f is string => typeof f === 'string');
  return [];
}

export interface StampMapping {
  promptIndex: number;
  filesChanged?: string[] | null;
  diff?: string | null;
  uncommittedDiff?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  commitSha?: string | null;
}

export interface RecoveredCommitProof {
  promptIndex: number;
  sha: string;
}

type CommitDetail = {
  sha?: string | null;
  filesChanged?: string[] | null;
  patch?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
};

function sameFileSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const left = new Set(a);
  const right = new Set(b);
  return left.size === a.length && right.size === b.length
    && [...left].every((file) => right.has(file));
}

/**
 * Recover a missed post-commit attestation from a completed turn whose file
 * boundary exactly matches the commit's own boundary.
 *
 * A regular Stop payload must never be allowed to move an existing SHA: its
 * current-HEAD observation can be stale. This recovery is different. The
 * mapping already names the commit, and git independently proves that the
 * turn's complete file set is that commit's complete file set. That gives the
 * server the same one-turn ownership fact as a delayed post-commit hook.
 *
 * A prior divergent-baseline capture can leave a clean committed mapping with
 * the right SHA plus files from an abandoned branch. If the real commit's file
 * set is a strict subset and the mapping has no retained bytes of its own,
 * replace that contaminated shell with git's commit patch before making the
 * proof. We deliberately do not trim mappings with uncommitted or stored diff
 * content: their superset may be genuine work from the same turn.
 */
export function recoverCommittedTurnProofs(
  mappings: StampMapping[],
  commitDetails: CommitDetail[],
): RecoveredCommitProof[] {
  const detailsBySha = new Map<string, CommitDetail>();
  for (const detail of commitDetails || []) {
    if (detail?.sha) detailsBySha.set(detail.sha.toLowerCase(), detail);
  }

  const proofs: RecoveredCommitProof[] = [];
  for (const mapping of mappings || []) {
    const sha = mapping.commitSha?.trim();
    if (!sha || (mapping.uncommittedDiff || '').trim()) continue;
    const detail = detailsBySha.get(sha.toLowerCase());
    const commitFiles = filesOf(detail?.filesChanged);
    const mappingFiles = filesOf(mapping.filesChanged);
    if (commitFiles.length === 0 || mappingFiles.length === 0) continue;

    if (!sameFileSet(mappingFiles, commitFiles)) {
      const hasOnlyLeakedFiles = !(mapping.diff || '').trim()
        && commitFiles.every((file) => mappingFiles.includes(file));
      const patch = (detail?.patch || '').trim();
      if (!hasOnlyLeakedFiles || !patch) continue;
      mapping.filesChanged = [...commitFiles];
      mapping.diff = patch;
      mapping.linesAdded = detail?.linesAdded ?? mapping.linesAdded;
      mapping.linesRemoved = detail?.linesRemoved ?? mapping.linesRemoved;
    }

    // The repair above made the mapping equal to the commit's known boundary.
    if (sameFileSet(filesOf(mapping.filesChanged), commitFiles)) {
      proofs.push({ promptIndex: mapping.promptIndex, sha });
    }
  }
  return proofs;
}

