/**
 * Which of these commits does some ref still hold? One answer for many
 * commits, in one `rev-list`.
 *
 * `git for-each-ref --contains <sha> refs/heads refs/remotes` answers it for
 * ONE commit, and its cost is paid per ref: on a repository with 1,734
 * branch and remote tips (plus 1,395 Origin shadow refs filtered afterwards)
 * it took ~0.55 s a call, and Stop's commit-patch pass asked it 28 times on a
 * 20-turn session — 15.6 s of a 46 s pass (TODO 1cd8f80e). The same question
 * for every commit at once is reachability: `git rev-list <commits> --not
 * <tips>` prints exactly the listed commits NO tip reaches, so a commit
 * missing from its output is held. Measured on 64 real commits: 28.6 s per
 * commit, 0.19 s batched, the same 57 held.
 *
 * Returns null when git could not answer — callers fall back to the
 * per-commit query, never to a guess. A commit git does not have is left out
 * of the map (the caller's own lookup decides what that means), so one
 * missing object cannot fail the batch.
 */
import { execFileSync } from 'child_process';

export interface RefsHoldingOptions {
  /** Ref namespaces whose tips count, e.g. ['refs/heads', 'refs/remotes']. */
  namespaces: string[];
  /** A ref that does not count even inside those namespaces. */
  excludeRef?: (refname: string) => boolean;
}

const HEX = /^[0-9a-fA-F]{7,64}$/;

export function commitsHeldByRefs(
  repoPath: string,
  shas: readonly string[],
  opts: RefsHoldingOptions,
): Map<string, boolean> | null {
  const git = (args: string[], input?: string): string => execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf-8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}),
  });
  const wanted = [...new Set(shas.filter((s) => typeof s === 'string' && HEX.test(s)))];
  const out = new Map<string, boolean>();
  if (wanted.length === 0) return out;
  try {
    // Existing commits only, resolved to their full ids.
    const checked = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], wanted.map((s) => `${s}^{commit}`).join('\n') + '\n');
    const full = new Map<string, string>();
    checked.split('\n').forEach((line, i) => {
      const [id, type] = line.trim().split(' ');
      if (type === 'commit' && id && i < wanted.length) full.set(wanted[i], id.toLowerCase());
    });
    if (full.size === 0) return out;
    const tips = new Set<string>();
    for (const line of git(['for-each-ref', '--format=%(objectname) %(refname)', ...opts.namespaces]).split('\n')) {
      const at = line.indexOf(' ');
      if (at <= 0) continue;
      const ref = line.slice(at + 1).trim();
      if (opts.excludeRef?.(ref)) continue;
      tips.add(line.slice(0, at));
    }
    let unheld = new Set<string>();
    if (tips.size > 0) {
      const listed = git(['rev-list', '--stdin'], [...new Set(full.values()), '--not', ...tips].join('\n') + '\n');
      unheld = new Set(listed.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
    }
    for (const [asked, id] of full) out.set(asked, tips.size > 0 && !unheld.has(id));
    return out;
  } catch {
    return null;
  }
}
