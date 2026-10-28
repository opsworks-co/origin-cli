/**
 * The session header's diff for a file the session's own commits touched more
 * than once — or committed and then went on editing — as ONE net section.
 *
 * The header is rendered commit by commit (sessionScopedCommittedDiff, on
 * purpose: see sessionAuthoredSnapshot), so such a file arrives as two or more
 * `diff --git` sections. combineApplyableTurnDiff can only coalesce them by
 * keeping the LAST one when it has no working-tree diff to take the net from,
 * and the header then counted only the last commit's lines for that file.
 * Session f6c7b6ef (2026-10-26): reflog-pickup.ts was created in one commit
 * (+673) and edited in the next (+4/-2); the header read +263/-2 against
 * turns carrying +1239, and the release gate blocked on it
 * (header_exceeds_turns).
 *
 * Git can give the net exactly — `git diff <before the first commit> <last>
 * -- <file>` (or `… -- <file>` against the working tree when the file is also
 * dirty) — but only when the span holds nothing but the session's own work on
 * that file. That is checked, never assumed: the commits that touched the file
 * nearest the session's newest one must be exactly the session's commits, and
 * every one an ancestor of the newest, and for the dirty case nothing foreign
 * may have touched it between there and HEAD. When git cannot prove it, every
 * section is kept as it is: an over-long diff is the honest answer, a dropped
 * commit is not.
 */
import { execFileSync } from 'child_process';
import { combineApplyableTurnDiff, splitDiffFileSections } from './applyable-turn-diff.js';

const READ = { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'ignore'] as ['pipe', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
const FULL = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** Files netted per render; the rest keep their sections. */
const MAX_NETTED = 100;

function git(cwd: string, args: string[], input?: string): string | null {
  try {
    return execFileSync('git', args, { ...READ, cwd, ...(input !== undefined ? { input } : {}) }).toString();
  } catch {
    return null;
  }
}

function isAncestor(cwd: string, a: string, b: string): boolean {
  return a === b || git(cwd, ['merge-base', '--is-ancestor', a, b]) !== null;
}

/** Each of `shas` (full, non-merge) → the paths it changed, from one git process. */
function pathsByCommit(cwd: string, shas: string[]): Map<string, Set<string>> | null {
  const out = git(cwd, ['diff-tree', '--stdin', '-r', '--root', '--name-only', '--no-renames', '-z'], `${shas.join('\n')}\n`);
  if (out === null) return null;
  const map = new Map<string, Set<string>>();
  let current: Set<string> | null = null;
  for (const tok of out.split('\0')) {
    const t = tok.replace(/^\n+/, '');
    if (!t) continue;
    if (FULL.test(t)) { current = new Set(); map.set(t, current); continue; }
    current?.add(t);
  }
  return map;
}

/**
 * The commit the net for `file` is measured from — the parent of the oldest of
 * `ours` that touched it, or the empty tree for a root — and the newest of
 * them; null when the span holds anything but `ours`.
 */
function provenSpan(cwd: string, file: string, touching: string[], ours: Set<string>): { base: string; newest: string } | null {
  const listed = git(cwd, ['rev-list', '--topo-order', `--max-count=${touching.length}`, ...touching, '--', file]);
  const span = (listed || '').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (span.length !== touching.length || !span.every((s) => ours.has(s))) return null;
  const newest = span[0];
  if (!span.every((s) => isAncestor(cwd, s, newest))) return null;
  const oldest = span[span.length - 1];
  const parent = (git(cwd, ['rev-parse', '--verify', '--quiet', `${oldest}^1`]) || '').trim().toLowerCase();
  if (FULL.test(parent)) return { base: parent, newest };
  const empty = (git(cwd, ['hash-object', '-t', 'tree', '--stdin'], '') || '').trim().toLowerCase();
  return FULL.test(empty) ? { base: empty, newest } : null;
}

/**
 * The session's diff — `committed` (its own commits, one section per commit
 * per file) joined with `uncommitted` (vs HEAD) — with a file that appears more
 * than once rendered as its proven net, or kept in full where it cannot be.
 * Files that appear once are exactly what combineApplyableTurnDiff makes of
 * them.
 */
export function sessionNetDiff(repoPath: string, ownShas: ReadonlyArray<string>, committed: string, uncommitted: string): string {
  const cSections = splitDiffFileSections(committed);
  const uSections = splitDiffFileSections(uncommitted);
  const cCount = new Map<string, number>();
  for (const s of cSections) if (s.file) cCount.set(s.file, (cCount.get(s.file) || 0) + 1);
  const dirty = new Set(uSections.map((s) => s.file).filter(Boolean));
  const repeated = [...cCount.keys()].filter((f) => (cCount.get(f) || 0) > 1 || dirty.has(f));
  if (repeated.length === 0) return combineApplyableTurnDiff({ committedDiff: committed, uncommittedDiff: uncommitted });

  const net = new Map<string, string>();
  const resolved = (git(repoPath, ['rev-list', '--ignore-missing', '--no-walk=unsorted', '--no-merges', ...ownShas]) || '')
    .split('\n').map((s) => s.trim().toLowerCase()).filter((s) => FULL.test(s));
  const ours = new Set(resolved);
  const paths = resolved.length > 0 ? pathsByCommit(repoPath, resolved) : null;
  const head = (git(repoPath, ['rev-parse', 'HEAD']) || '').trim().toLowerCase();
  for (const file of repeated.slice(0, MAX_NETTED)) {
    if (!paths) break;
    const touching = resolved.filter((sha) => paths.get(sha)?.has(file));
    // Every committed section of the file must be one of these plain commits.
    // A merge's resolution is a section too, and a net over the plain commits
    // alone would drop it — those files keep every section.
    if (touching.length === 0 || touching.length !== (cCount.get(file) || 0)) continue;
    const span = provenSpan(repoPath, file, touching, ours);
    if (!span) continue;
    let text: string | null;
    if (dirty.has(file)) {
      // Measured to the working tree: nothing foreign may have changed the file after our newest commit.
      if (!FULL.test(head) || !isAncestor(repoPath, span.newest, head)) continue;
      const after = (git(repoPath, ['rev-list', head, `^${span.newest}`, '--', file]) || '').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (after.some((s) => !ours.has(s))) continue;
      text = git(repoPath, ['diff', '--no-color', span.base, '--', file]);
    } else {
      text = git(repoPath, ['diff', '--no-color', span.base, span.newest, '--', file]);
    }
    if (text !== null) net.set(file, text.trim());
  }

  // Files seen once are the combiner's, exactly as before.
  const once = (sections: typeof cSections) => sections.filter((s) => !s.file || !repeated.includes(s.file)).map((s) => s.text).join('');
  const out: string[] = [combineApplyableTurnDiff({ committedDiff: once(cSections), uncommittedDiff: once(uSections) })];
  const done = new Set<string>();
  for (const s of [...cSections, ...uSections]) {
    if (!s.file || !repeated.includes(s.file)) continue;
    if (net.has(s.file)) {
      if (!done.has(s.file) && net.get(s.file)) out.push(net.get(s.file)!);
      done.add(s.file);
      continue;
    }
    // Not provable: every section stays, so no commit's lines are lost.
    out.push(s.text);
  }
  return out.map((t) => t.replace(/\s+$/, '')).filter(Boolean).join('\n').trim();
}
