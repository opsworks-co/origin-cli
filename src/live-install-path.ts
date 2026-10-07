// A path this CLI derives from its own location, mapped back through the npm
// name so it follows `origin upgrade`.
//
// Under the atomic install (atomic-global-install.ts) `<root>/@origin/cli` is a
// symlink to `<root>/@origin/.cli-<version>-<tag>`, and Node resolves every
// module to its real path — so `import.meta.url` names ONE version's copy. A
// daemon that re-reads "the installed version" from there never sees the next
// upgrade and never restarts onto it; a heartbeat or watcher spawned from there
// is pinned to that copy; an entry path written into a hook config names a
// directory that the upgrade after next deletes.
//
// Only a path inside a versioned copy is rewritten, and only while
// `@origin/cli` exists to read it through. Everything else — a dev checkout,
// the pre-symlink layout, Windows — comes back unchanged.
import fs from 'fs';

const VERSIONED = /^(.*[\\/]@origin[\\/])\.cli-\d[^\\/]*(?=$|[\\/])(.*)$/;

export function throughLiveInstall(p: string): string {
  const m = VERSIONED.exec(p);
  if (!m) return p;
  const live = `${m[1]}cli`;
  try { fs.lstatSync(live); } catch { return p; }
  return live + m[2];
}

