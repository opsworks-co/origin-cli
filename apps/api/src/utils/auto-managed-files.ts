// ── Origin auto-managed file filter ──────────────────────────────────────
// Origin maintains per-agent context files in the repo root (AGENTS.md,
// GEMINI.md, .windsurfrules). CLAUDE.md is special — projects may hand-edit
// it, but a file whose content sits entirely between `<!-- origin-managed -->`
// markers is Origin's. These files are noise in every diff-rendering surface
// (per-prompt diff, sessionDiff, AI Blame, commit detail) and the user has
// flagged this repeatedly. CLI strips at capture time; this module is the
// read-time strip used by API endpoints so legacy sessions captured before
// the CLI strip landed are cleaned the same way.

export const ORIGIN_AUTO_MANAGED_FILES = new Set<string>([
  'AGENTS.md',
  'GEMINI.md',
  '.windsurfrules',
]);

// CLAUDE.md is auto-managed only when its diff is entirely inside
// `<!-- origin-managed -->` markers. Mirrors the CLI heuristic at
// packages/cli/src/ignore-patterns.ts:isDiffEntirelyOriginManaged.
export function isDiffEntirelyOriginManaged(fileSection: string): boolean {
  let inBlock = false;
  let sawNonMarkerChange = false;
  for (const rawLine of fileSection.split('\n')) {
    if (rawLine.startsWith('+++') || rawLine.startsWith('---')) continue;
    if (!rawLine.startsWith('+') && !rawLine.startsWith('-')) {
      // Hunk header or context line — track marker pairs.
      if (rawLine.includes('<!-- origin-managed -->')) inBlock = !inBlock;
      continue;
    }
    const content = rawLine.slice(1);
    if (content.includes('<!-- origin-managed -->')) {
      // The marker itself is being added or removed — toggle and continue.
      inBlock = !inBlock;
      continue;
    }
    if (!inBlock) {
      sawNonMarkerChange = true;
      break;
    }
  }
  return !sawNonMarkerChange;
}

// Strip auto-managed file sections from a unified diff. Returns the input
// unchanged if no sections matched.
export function stripAutoManagedSections(diffText: string): string {
  if (!diffText) return diffText;
  const parts = diffText.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  for (const part of parts) {
    const header = part.split('\n', 1)[0] || '';
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = m ? m[2] : '';
    const basename = filePath.split('/').pop() || '';
    if (ORIGIN_AUTO_MANAGED_FILES.has(filePath) || ORIGIN_AUTO_MANAGED_FILES.has(basename)) continue;
    if (basename === 'CLAUDE.md' && isDiffEntirelyOriginManaged(part)) continue;
    kept.push(part);
  }
  return kept.join('').trim();
}

// True when a filename should be hidden from any "files changed" list.
// Caller decides whether to also check the diff content for CLAUDE.md —
// the path-only check returns true to hide it everywhere; pass `requireMarkers`
// to allow hand-edited CLAUDE.md through.
export function isAutoManagedPath(filename: string): boolean {
  const basename = (filename || '').split('/').pop() || '';
  if (ORIGIN_AUTO_MANAGED_FILES.has(filename) || ORIGIN_AUTO_MANAGED_FILES.has(basename)) return true;
  // CLAUDE.md is auto-managed by default; surfaces that have to inspect
  // diff content (to spot hand edits) should call isDiffEntirelyOriginManaged
  // instead of this helper.
  return basename === 'CLAUDE.md';
}
