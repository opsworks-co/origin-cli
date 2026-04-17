// Heuristic scan of a public GitHub repository for AI-authored commits.
// Fetches the last N commits via the GitHub REST API and scores each one
// against a small set of AI-authorship signals. This is NOT forensic — it's
// a lead-magnet quality estimate. The CLI's local backfill is more accurate.

interface GitHubCommit {
  sha: string;
  commit: {
    author: { name: string; email: string; date: string } | null;
    message: string;
  };
  stats?: { additions: number; deletions: number; total: number };
}

interface ScanResult {
  commitCount: number;
  aiCommitCount: number;
  aiPercentage: number;
  topModel: string | null;
  estimatedCost: number;
  totalLines: number;
  topAuthors: Array<{ name: string; aiCount: number; humanCount: number }>;
  modelBreakdown: Record<string, number>;
  signalsFound: string[];
}

// ── GitHub repo URL parsing ────────────────────────────────────────────
// Accepts: https://github.com/owner/repo, github.com/owner/repo, owner/repo
// Returns { owner, repo } or null if invalid.
export function parseGitHubUrl(input: string): { owner: string; repo: string } | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Strip protocol + domain
  const withoutProto = trimmed.replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '');
  const parts = withoutProto.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  // Strip trailing .git or query/fragment/path
  repo = repo.replace(/\.git$/i, '').replace(/[?#].*$/, '');
  // Validate characters — GitHub allows alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

// ── Commit scoring ─────────────────────────────────────────────────────
// Each commit contributes to a set of signals. A commit is classified AI if
// ANY definitive signal matches, or if heuristic score >= threshold.

interface CommitSignals {
  definitiveAi: boolean;
  heuristicScore: number;
  models: string[];     // detected model names (claude, gpt, gemini, copilot, ...)
  reasons: string[];    // human-readable signal names
}

function scoreCommit(c: GitHubCommit): CommitSignals {
  const msg = c.commit.message || '';
  const lower = msg.toLowerCase();
  const models: string[] = [];
  const reasons: string[] = [];
  let definitive = false;
  let heuristic = 0;

  // ── Definitive signals ──
  // Origin-Session trailer = our own CLI tagged this commit.
  if (/^Origin-Session:/m.test(msg)) {
    definitive = true;
    reasons.push('Origin-Session trailer');
    // Parse the agent if present: "Origin-Session: id | Claude Code | 3 prompts"
    const originMatch = msg.match(/^Origin-Session:\s*[^|]*\|\s*([^|]+)/m);
    if (originMatch) {
      const agent = originMatch[1].trim().toLowerCase();
      if (agent.includes('claude')) models.push('claude');
      else if (agent.includes('cursor')) models.push('cursor');
      else if (agent.includes('gemini')) models.push('gemini');
      else if (agent.includes('codex')) models.push('codex');
      else if (agent.includes('copilot')) models.push('copilot');
    }
  }

  // Co-Authored-By: <AI> trailers — strong signal.
  const coAuthoredMatches = msg.match(/Co-Authored-By:\s*[^\n<]+<[^>]+>/gi);
  if (coAuthoredMatches) {
    for (const m of coAuthoredMatches) {
      const ml = m.toLowerCase();
      if (ml.includes('claude') || ml.includes('anthropic')) { definitive = true; models.push('claude'); reasons.push('Co-Authored-By: Claude'); }
      else if (ml.includes('openai') || ml.includes('chatgpt') || ml.includes('codex')) { definitive = true; models.push('gpt'); reasons.push('Co-Authored-By: OpenAI'); }
      else if (ml.includes('gemini') || ml.includes('google ai')) { definitive = true; models.push('gemini'); reasons.push('Co-Authored-By: Gemini'); }
      else if (ml.includes('cursor')) { definitive = true; models.push('cursor'); reasons.push('Co-Authored-By: Cursor'); }
      else if (ml.includes('copilot') || ml.includes('github.copilot')) { definitive = true; models.push('copilot'); reasons.push('Co-Authored-By: Copilot'); }
      else if (ml.includes('aider')) { definitive = true; models.push('aider'); reasons.push('Co-Authored-By: Aider'); }
    }
  }

  // Generated-by-* trailers (rarer but unambiguous).
  if (/^Generated(-|\s)by:\s*claude/im.test(msg)) { definitive = true; models.push('claude'); reasons.push('Generated-by: Claude'); }

  // ── Heuristic signals ──
  // Body mentions the tool explicitly.
  if (/\b(claude code|claude-code|anthropic)\b/i.test(msg)) { heuristic += 2; if (!models.includes('claude')) models.push('claude'); reasons.push('mentions Claude'); }
  if (/\b(cursor ide|cursor ai|\bcursor\.so)\b/i.test(msg)) { heuristic += 2; if (!models.includes('cursor')) models.push('cursor'); reasons.push('mentions Cursor'); }
  if (/\b(gemini cli|gemini-cli)\b/i.test(msg)) { heuristic += 2; if (!models.includes('gemini')) models.push('gemini'); reasons.push('mentions Gemini'); }
  if (/\b(github copilot|gh-copilot)\b/i.test(msg)) { heuristic += 2; if (!models.includes('copilot')) models.push('copilot'); reasons.push('mentions Copilot'); }
  if (/\baider\b/i.test(lower) && lower.includes('commit')) { heuristic += 1; reasons.push('aider commit style'); }

  // Emoji-conventional-commit that also has a large body — AI commit pattern.
  if (/^(feat|fix|chore|refactor|docs|test|style|perf)(\([^)]+\))?!?:/m.test(msg) && msg.length > 400) {
    heuristic += 1;
    reasons.push('structured commit w/ long body');
  }

  // "Generated with..." or "via Origin" anywhere.
  if (/generated with\b.*(claude|ai|cursor|gemini|copilot)/i.test(msg)) { heuristic += 2; reasons.push('"generated with" mention'); }

  return { definitiveAi: definitive, heuristicScore: heuristic, models, reasons };
}

// ── Cost estimation ─────────────────────────────────────────────────────
// Very rough: $0.02/100 changed lines for AI-authored commits. This matches
// the ballpark of observed Origin sessions (~$0.02-0.04 per prompt, average
// 50-150 lines per prompt). Deliberately conservative so the number feels
// defensible rather than click-baity.
function estimateCost(aiLines: number): number {
  return Math.round((aiLines / 100) * 0.02 * 100) / 100;
}

// ── GitHub fetching ─────────────────────────────────────────────────────
// Uses GITHUB_TOKEN if present (higher rate limit). Falls back to anonymous
// — rate-limited to 60 req/h per IP, but we fetch at most 2 pages (100 commits)
// per scan so we stay well under that.
async function ghFetch(path: string): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'origin-codebase-scan/1.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(`https://api.github.com${path}`, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Main scan function ──────────────────────────────────────────────────
export async function scanRepository(
  owner: string,
  repo: string,
  commitLimit = 100,
): Promise<ScanResult> {
  // 1. Verify repo exists and is public
  await ghFetch(`/repos/${owner}/${repo}`);

  // 2. List commits — paginate up to commitLimit
  const perPage = Math.min(100, commitLimit);
  const pages = Math.ceil(commitLimit / perPage);
  const allCommits: GitHubCommit[] = [];
  for (let p = 1; p <= pages; p++) {
    const batch = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${p}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allCommits.push(...batch);
    if (batch.length < perPage) break;
  }

  if (allCommits.length === 0) {
    return {
      commitCount: 0, aiCommitCount: 0, aiPercentage: 0, topModel: null,
      estimatedCost: 0, totalLines: 0, topAuthors: [], modelBreakdown: {}, signalsFound: [],
    };
  }

  // 3. Score each commit. We DO NOT fetch per-commit diff stats by default
  //    (that's N round-trips and burns GitHub quota). The list endpoint gives
  //    us the commit message which is where all the definitive signals live.
  let aiCount = 0;
  const modelBreakdown: Record<string, number> = {};
  const allSignals = new Set<string>();
  const authorStats = new Map<string, { aiCount: number; humanCount: number }>();

  for (const c of allCommits) {
    const signals = scoreCommit(c);
    const isAi = signals.definitiveAi || signals.heuristicScore >= 2;
    if (isAi) aiCount++;

    // Track models
    for (const m of signals.models) {
      modelBreakdown[m] = (modelBreakdown[m] || 0) + 1;
    }
    for (const r of signals.reasons) allSignals.add(r);

    // Track authors
    const authorName = c.commit.author?.name || 'unknown';
    const cur = authorStats.get(authorName) || { aiCount: 0, humanCount: 0 };
    if (isAi) cur.aiCount++;
    else cur.humanCount++;
    authorStats.set(authorName, cur);
  }

  // 4. For a sample of AI commits, fetch stats to estimate line count.
  //    We cap the sample to keep GitHub API usage bounded.
  const aiCommitsForStats = allCommits
    .filter((c) => {
      const s = scoreCommit(c);
      return s.definitiveAi || s.heuristicScore >= 2;
    })
    .slice(0, 20); // sample first 20 AI commits

  let sampledLines = 0;
  let sampledCount = 0;
  for (const c of aiCommitsForStats) {
    try {
      const detail = await ghFetch(`/repos/${owner}/${repo}/commits/${c.sha}`);
      const total = detail?.stats?.total || 0;
      sampledLines += total;
      sampledCount++;
    } catch { /* skip, GitHub rate limit etc. */ }
  }

  // Extrapolate total AI lines from the sample.
  const avgLinesPerAiCommit = sampledCount > 0 ? sampledLines / sampledCount : 80;
  const totalAiLines = Math.round(avgLinesPerAiCommit * aiCount);

  // 5. Determine top model
  let topModel: string | null = null;
  let topModelCount = 0;
  for (const [m, n] of Object.entries(modelBreakdown)) {
    if (n > topModelCount) { topModel = m; topModelCount = n; }
  }

  // 6. Top authors (top 5 by AI commits)
  const topAuthors = Array.from(authorStats.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.aiCount - a.aiCount)
    .slice(0, 5);

  return {
    commitCount: allCommits.length,
    aiCommitCount: aiCount,
    aiPercentage: Math.round((aiCount / allCommits.length) * 100),
    topModel,
    estimatedCost: estimateCost(totalAiLines),
    totalLines: totalAiLines,
    topAuthors,
    modelBreakdown,
    signalsFound: Array.from(allSignals),
  };
}
