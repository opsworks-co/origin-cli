// A benchmark clone: a checkout `origin benchmark replay` makes under
// ~/.origin/bakeoff-repos/ for one replay arm (context-replay.ts, replayRoot).
//
// Its history is a copy of the replayed repo's, and it has no remote, so
// nothing tied it to the repo the server already knows: every arm's history
// sync uploaded ~490 of the replayed repo's commits, patches and all, into a
// repo of its own (prod: ~68k duplicate Commit rows in three days). A clone's
// commits are never sent; the server refuses them too (apps/api
// utils/benchmark-clone.ts).
//
// Narrower than memory.ts's isBakeoffRepo on purpose: that one also matches
// agent bake-off worktrees of the REAL repo (`<repo>-bakeoff-<id>-<agent>`),
// whose commits belong to it.

export function isBenchmarkClonePath(p: string | null | undefined): boolean {
  if (!p) return false;
  return String(p).replace(/\\/g, '/').includes('/.origin/bakeoff-repos/');
}
