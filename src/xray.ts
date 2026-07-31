// ── Repo-wide AI code survival (the X-Ray's locked metric) ───────────────────
// The web X-Ray answers "how much of your recent code did AI write?" from commit
// messages alone (GitHub API, no clone). It deliberately CANNOT answer the more
// interesting question — "how much of that AI code is still alive?" — because
// survival needs `git blame` against the working tree, which the API server has
// no clone for. The CLI does. So this runs locally and unlocks the tile.
//
// Method (first-author-wins, same as benchmark survival):
//   1. Find AI-authored commits in the last N days from their messages, using
//      the SAME definitive signals as the web scan so the two agree.
//   2. Sum the lines those commits ADDED (numstat) → the denominator.
//   3. `git blame` HEAD over the files they touched; a line still attributed to
//      one of those shas is still alive → the numerator.
//
// Honest caveats, encoded rather than hidden:
//   • Squash-merge/rebase rewrites shas, so blame would report 0 for work that
//     is actually alive. computeSessionSurvival detects that (no sha reachable
//     from HEAD) and returns resolvable:false — we surface survivalPct = null
//     ("unknown"), never a misleading 0.
//   • The denominator counts every added line, including a line an AI commit
//     later rewrote; blame counts each surviving line once. So the ratio is a
//     conservative FLOOR. We clamp to 100 rather than pretend to sub-line
//     precision.
import { runDetailed } from './utils/exec.js';
import { computeSessionSurvival } from './benchmark-survival.js';

export interface RepoAiSurvival {
  windowDays: number;
  totalCommits: number;
  aiCommits: number;
  aiLinesAdded: number;
  aiLinesSurviving: number;
  /** 0-100, or null when history was rewritten (squash/rebase) → UNKNOWN. */
  survivalPct: number | null;
  resolvable: boolean;
  byAgent: Record<string, number>;
}

function git(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  const r = runDetailed('git', args, { cwd: repoPath, timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '' };
}

/**
 * Definitive AI-authorship signals only — the same ones services/public-scan.ts
 * treats as definitive. Heuristics ("structured commit w/ long body") are fine
 * for a lead-magnet estimate but would poison a survival RATIO, so they're out.
 * Returns the agent slug, or null when the commit isn't AI-authored.
 */
export function detectAgent(message: string): string | null {
  if (!message) return null;
  const originTrailer = message.match(/^Origin-Session:\s*[^|]*\|\s*([^|\n]+)/m);
  if (originTrailer) {
    const a = originTrailer[1].trim().toLowerCase();
    for (const k of ['claude', 'cursor', 'gemini', 'codex', 'copilot', 'devin', 'aider']) {
      if (a.includes(k)) return k;
    }
    return 'ai';
  }
  const co = message.match(/Co-Authored-By:\s*[^\n<]*<[^>]*>/gi);
  if (co) {
    for (const line of co) {
      const l = line.toLowerCase();
      if (l.includes('claude') || l.includes('anthropic')) return 'claude';
      if (l.includes('openai') || l.includes('chatgpt') || l.includes('codex')) return 'codex';
      if (l.includes('gemini') || l.includes('google ai')) return 'gemini';
      if (l.includes('cursor')) return 'cursor';
      if (l.includes('copilot')) return 'copilot';
      if (l.includes('aider')) return 'aider';
      if (l.includes('devin')) return 'devin';
    }
  }
  if (/^Generated(-|\s)by:\s*claude/im.test(message)) return 'claude';
  return null;
}

const REC_SEP = '\x1e';   // git emits this via %x1e
const FIELD_SEP = '\x1f'; // git emits this via %x1f

/** AI-authored commits in the window, with the files+additions they contributed. */
export function collectAiCommits(
  repoPath: string,
  windowDays: number,
): { shas: string[]; totalCommits: number; byAgent: Record<string, number>; linesAdded: number; files: string[] } {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  // %B is the raw body (multi-line). Delimited with the ASCII unit/record
  // separators, which git emits itself via %x1f/%x1e — so the ARGUMENT stays
  // plain text (spawn rejects NUL bytes in argv) while the OUTPUT is split on
  // bytes no commit message realistically contains.
  const { ok, stdout } = git(repoPath, ['log', `--since=${since}`, `--pretty=format:%H%x1f%B%x1e`]);
  if (!ok || !stdout.trim()) {
    return { shas: [], totalCommits: 0, byAgent: {}, linesAdded: 0, files: [] };
  }

  const shas: string[] = [];
  const byAgent: Record<string, number> = {};
  let totalCommits = 0;
  for (const rec of stdout.split(REC_SEP)) {
    const trimmed = rec.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const [sha, message = ''] = trimmed.split(FIELD_SEP);
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
    totalCommits++;
    const agent = detectAgent(message);
    if (agent) {
      shas.push(sha);
      byAgent[agent] = (byAgent[agent] || 0) + 1;
    }
  }

  // Additions + touched files for the AI commits. `git show --numstat` per sha
  // keeps memory bounded and skips merges (-m omitted) so a merge commit can't
  // double-count an already-counted change.
  let linesAdded = 0;
  const files = new Set<string>();
  for (const sha of shas) {
    const r = git(repoPath, ['show', '--numstat', '--format=', '--no-renames', sha]);
    if (!r.ok) continue;
    for (const line of r.stdout.split('\n')) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line.trim());
      if (!m) continue; // '-' additions = binary file
      linesAdded += Number(m[1]);
      files.add(m[3]);
    }
  }
  return { shas, totalCommits, byAgent, linesAdded, files: [...files] };
}

/** Repo-wide "how much of the AI code I shipped is still alive?" */
export function computeRepoAiSurvival(repoPath: string, windowDays = 90): RepoAiSurvival {
  const { shas, totalCommits, byAgent, linesAdded, files } = collectAiCommits(repoPath, windowDays);
  const base: RepoAiSurvival = {
    windowDays,
    totalCommits,
    aiCommits: shas.length,
    aiLinesAdded: linesAdded,
    aiLinesSurviving: 0,
    survivalPct: null,
    resolvable: false,
    byAgent,
  };
  if (shas.length === 0 || linesAdded === 0 || files.length === 0) return base;

  const { linesSurviving, resolvable } = computeSessionSurvival(repoPath, shas, files);
  if (!resolvable) return base; // squashed/rebased away → UNKNOWN, never a fake 0
  return {
    ...base,
    aiLinesSurviving: linesSurviving,
    resolvable: true,
    survivalPct: Math.min(100, Math.round((linesSurviving / linesAdded) * 100)),
  };
}
