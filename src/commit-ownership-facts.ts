// What git says about a commit's ownership: its committer, its date and its
// message. A leaf module — no hook-side imports — so the transcript watcher,
// which commands/hooks.ts itself imports, can read the same facts the hooks'
// `commitBelongsToSession` weighs without an import cycle.
import { execFileSync } from 'child_process';

const GIT_READ_OPTS = {
  windowsHide: true, encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], timeout: 5000,
};

/**
 * The repo's configured committer email, lowercased — the identity a local
 * `git commit` in this checkout stamps. Empty when nothing is configured.
 */
export function localCommitterEmail(repoPath: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'user.email'], { ...GIT_READ_OPTS, cwd: repoPath })
      .toString().trim().toLowerCase();
  } catch { return ''; }
}

/** The three facts `commitBelongsToSession` weighs for one commit. */
export interface CommitOwnershipFacts {
  /** Committer email, trimmed and lowercased. */
  committerEmail: string;
  /** Committer date in ms (NaN when unparseable). */
  committedAtMs: number;
  /** Raw commit message. */
  body: string;
}

/**
 * Ownership facts for many commits in ONE git process, keyed by lowercased
 * full sha. A commit git could not name is simply absent, and a failed read
 * returns an empty map — callers fall back to `readCommitOwnershipFacts`.
 *
 * A turn that merged a busy main holds hundreds of commits in its window, and
 * reading each with its own `git show` (twice, once for the committer rule and
 * once inside `commitBelongsToSession`) cost ~4.6s for 300 commits inside
 * hooks that run on a timeout.
 */
export function readCommitOwnershipFactsBatch(repoPath: string, shas: string[]): Map<string, CommitOwnershipFacts> {
  const out = new Map<string, CommitOwnershipFacts>();
  const wanted = [...new Set(shas.filter((s) => /^[a-fA-F0-9]{7,40}$/.test(s)))];
  if (wanted.length === 0) return out;
  try {
    // --stdin: a window can hold thousands of shas, more than an argv should.
    const raw = execFileSync('git', ['log', '--no-walk=unsorted', '--stdin', '--format=%H%x00%ce%x00%ct%x00%B%x1e'], {
      ...GIT_READ_OPTS, cwd: repoPath, input: wanted.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024,
    }).toString();
    for (const record of raw.split('\x1e')) {
      const [shaField = '', email = '', ct = '', ...rest] = record.replace(/^\n/, '').split('\0');
      const full = shaField.trim().toLowerCase();
      if (!/^[a-f0-9]{40,64}$/.test(full)) continue;
      out.set(full, {
        committerEmail: email.trim().toLowerCase(),
        committedAtMs: Number(ct.trim()) * 1000,
        body: rest.join('\0'),
      });
    }
  } catch { return new Map(); }
  return out;
}

/**
 * The commits in a watcher's session-start..HEAD walk that are NOT this
 * session's, by the rules `commitBelongsToSession` applies on the hook path:
 *
 *   - a commit the session already owns (recorded, paired to a turn, or proven
 *     by its transcript) is kept, whatever its message says;
 *   - a trailer naming this session keeps it; a trailer naming anyone else
 *     drops it — the watcher has no sibling state files to tell a stale amend
 *     trailer from a live owner, and the ownership list above is what rescues
 *     an amended commit of our own;
 *   - a commit committed before the session started is somebody else's;
 *   - an untrailered commit is ours only when the local identity committed it —
 *     a pull brings commits GitHub (or their author) committed.
 *
 * A commit git could not describe is kept, as on the hook path: guessing work
 * away is worse than keeping an unreadable commit.
 */
export function foreignWalkCommits(
  shas: string[],
  facts: Map<string, CommitOwnershipFacts>,
  ctx: { sessionIds: Array<string | null | undefined>; owned: string[]; startedAt?: string | null; localEmail: string },
): Set<string> {
  const same = (a: string, b: string) => {
    const x = a.toLowerCase(); const y = b.toLowerCase();
    return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
  };
  const ids = ctx.sessionIds.filter((s): s is string => !!s).map((s) => s.toLowerCase());
  const startedMs = ctx.startedAt ? Math.floor(Date.parse(ctx.startedAt) / 1000) * 1000 : NaN;
  const out = new Set<string>();
  for (const sha of shas) {
    if (!sha || ctx.owned.some((o) => same(o, sha))) continue;
    const f = facts.get(sha.toLowerCase()) || [...facts].find(([full]) => same(full, sha))?.[1];
    if (!f) continue;
    const owner = f.body.match(/^Origin-Session:\s*([^\s|]+)/mi)?.[1]?.toLowerCase();
    if (owner && ids.some((id) => id.startsWith(owner) || owner.startsWith(id))) continue;
    if (owner) { out.add(sha); continue; }
    if (Number.isFinite(startedMs) && Number.isFinite(f.committedAtMs) && f.committedAtMs < startedMs) { out.add(sha); continue; }
    if (ctx.localEmail && f.committerEmail && f.committerEmail !== ctx.localEmail) out.add(sha);
  }
  return out;
}
