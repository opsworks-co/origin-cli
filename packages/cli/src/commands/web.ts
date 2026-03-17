import http from 'http';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { getGitRoot, getBranch } from '../session-state.js';
import { getAllPrompts } from '../local-db.js';
import { loadAgentConfig } from '../config.js';

/**
 * origin web — Launch a local web dashboard for your repo's AI attribution data.
 * No server, no login. Reads git notes + sessions branch + local DB.
 */

interface CommitInfo {
  sha: string;
  date: string;
  message: string;
  author: string;
  isAi: boolean;
  model?: string;
  sessionId?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

interface SessionInfo {
  id: string;
  model: string;
  date: string;
  cost?: number;
  tokens?: number;
  promptCount?: number;
}

function gatherData(repoRoot: string) {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  const branch = getBranch(repoRoot) || 'unknown';

  // Commits with notes
  const commits: CommitInfo[] = [];
  let totalAiLines = 0;
  let totalHumanLines = 0;
  let totalAiCommits = 0;
  let totalHumanCommits = 0;
  const toolCounts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};

  try {
    const log = execSync('git log --format="%H|%aI|%s|%an" -100 2>/dev/null', execOpts).trim();
    if (log) {
      for (const line of log.split('\n').filter(Boolean)) {
        const [sha, date, ...rest] = line.split('|');
        const msgParts = rest.slice(0, -1);
        const author = rest[rest.length - 1];
        const message = msgParts.join('|');
        let isAi = false;
        let model: string | undefined;
        let sessionId: string | undefined;
        let linesAdded = 0;
        let linesRemoved = 0;

        try {
          const note = execSync(`git notes --ref=origin show ${sha} 2>/dev/null`, execOpts).trim();
          const parsed = JSON.parse(note);
          const data = parsed.origin || parsed;
          isAi = true;
          model = data.model;
          sessionId = data.sessionId;
          linesAdded = data.linesAdded || 0;
          linesRemoved = data.linesRemoved || 0;
        } catch { /* no note */ }

        // Get line stats if not from note
        if (!linesAdded && !linesRemoved) {
          try {
            const stat = execSync(`git diff-tree --root --numstat ${sha} 2>/dev/null`, execOpts).trim();
            for (const s of stat.split('\n').slice(1)) {
              const [a, r] = s.split('\t');
              if (a !== '-') linesAdded += parseInt(a) || 0;
              if (r !== '-') linesRemoved += parseInt(r) || 0;
            }
          } catch { /* ignore */ }
        }

        if (isAi) {
          totalAiCommits++;
          totalAiLines += linesAdded;
          const tool = detectTool(model || '');
          toolCounts[tool] = (toolCounts[tool] || 0) + 1;
          modelCounts[model || 'unknown'] = (modelCounts[model || 'unknown'] || 0) + 1;
        } else {
          totalHumanCommits++;
          totalHumanLines += linesAdded;
        }

        commits.push({ sha, date, message, author, isAi, model, sessionId, linesAdded, linesRemoved });
      }
    }
  } catch { /* ignore */ }

  // Sessions
  const sessions: SessionInfo[] = [];
  try {
    const tree = execSync('git ls-tree --name-only origin-sessions:sessions/ 2>/dev/null', execOpts).trim();
    if (tree) {
      for (const sid of tree.split('\n').filter(Boolean).slice(-30)) {
        let model = 'unknown';
        let date = '';
        let cost: number | undefined;
        let tokens: number | undefined;
        let promptCount: number | undefined;
        try {
          const meta = execSync(`git show origin-sessions:sessions/${sid}/metadata.json 2>/dev/null`, execOpts).trim();
          if (meta) {
            const m = JSON.parse(meta);
            model = m.model || 'unknown';
            date = m.startedAt || m.timestamp || '';
            cost = m.costUsd;
            tokens = m.tokensUsed;
            promptCount = m.promptCount;
          }
        } catch { /* ignore */ }
        sessions.push({ id: sid, model, date, cost, tokens, promptCount });
      }
    }
  } catch { /* ignore */ }

  // Prompts from local DB
  const prompts = getAllPrompts();

  return {
    branch,
    repoRoot,
    commits,
    sessions,
    prompts,
    stats: {
      totalCommits: commits.length,
      aiCommits: totalAiCommits,
      humanCommits: totalHumanCommits,
      aiLines: totalAiLines,
      humanLines: totalHumanLines,
      toolCounts,
      modelCounts,
    },
  };
}

function detectTool(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'claude-code';
  if (m.includes('gemini') || m.includes('gemma')) return 'gemini-cli';
  if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('o4-')) return 'cursor';
  if (m.includes('codex')) return 'codex';
  if (m.includes('aider')) return 'aider';
  return model || 'unknown';
}

function buildHTML(data: ReturnType<typeof gatherData>): string {
  const { commits, sessions, stats, branch, repoRoot, prompts } = data;
  const repoName = repoRoot.split('/').pop() || 'repo';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Origin — ${repoName}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 20px; font-weight: 600; color: #f0f6fc; }
  .header .repo { color: #58a6ff; font-size: 14px; }
  .header .branch { background: #1f6feb33; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  .nav { background: #161b22; border-bottom: 1px solid #30363d; padding: 0 24px; display: flex; gap: 0; }
  .nav button { background: none; border: none; color: #8b949e; padding: 12px 16px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; transition: all 0.2s; }
  .nav button:hover { color: #c9d1d9; }
  .nav button.active { color: #f0f6fc; border-bottom-color: #f78166; }
  .content { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .tab { display: none; }
  .tab.active { display: block; }

  /* Stats cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .stat-card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: #f0f6fc; margin-top: 4px; }
  .stat-card .sub { color: #8b949e; font-size: 13px; margin-top: 4px; }

  /* Bar chart */
  .bar-chart { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .bar-chart h3 { color: #f0f6fc; margin-bottom: 16px; font-size: 14px; }
  .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .bar-label { width: 120px; font-size: 13px; color: #8b949e; text-align: right; flex-shrink: 0; }
  .bar-track { flex: 1; height: 24px; background: #21262d; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s; display: flex; align-items: center; padding-left: 8px; font-size: 11px; color: #fff; min-width: fit-content; }
  .bar-fill.ai { background: linear-gradient(90deg, #f78166, #da3633); }
  .bar-fill.human { background: linear-gradient(90deg, #3fb950, #238636); }

  /* Commit list */
  .commit-list { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  .commit-item { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid #21262d; gap: 12px; }
  .commit-item:last-child { border-bottom: none; }
  .commit-item:hover { background: #1c2128; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .badge.ai { background: #f7816633; color: #f78166; }
  .badge.human { background: #3fb95033; color: #3fb950; }
  .commit-msg { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit-sha { font-family: monospace; font-size: 12px; color: #58a6ff; }
  .commit-date { font-size: 12px; color: #8b949e; white-space: nowrap; }
  .commit-model { font-size: 12px; color: #d2a8ff; white-space: nowrap; }
  .commit-author { font-size: 12px; color: #8b949e; white-space: nowrap; }
  .commit-lines { font-size: 11px; white-space: nowrap; }
  .commit-lines .add { color: #3fb950; }
  .commit-lines .del { color: #f85149; }

  /* Session list */
  .session-item { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid #21262d; gap: 12px; }
  .session-item:last-child { border-bottom: none; }
  .session-item:hover { background: #1c2128; }
  .session-id { font-family: monospace; font-size: 13px; color: #58a6ff; width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .session-model { color: #d2a8ff; font-size: 13px; width: 160px; }
  .session-meta { font-size: 12px; color: #8b949e; }

  /* Prompt list */
  .prompt-item { padding: 12px 16px; border-bottom: 1px solid #21262d; }
  .prompt-item:last-child { border-bottom: none; }
  .prompt-item:hover { background: #1c2128; }
  .prompt-text { font-size: 14px; color: #c9d1d9; margin-bottom: 4px; }
  .prompt-meta { font-size: 12px; color: #8b949e; display: flex; gap: 16px; }
  .prompt-files { font-size: 12px; color: #3fb950; margin-top: 4px; }

  .empty { text-align: center; padding: 40px; color: #8b949e; }
  .footer { text-align: center; padding: 24px; color: #484f58; font-size: 12px; }
</style>
</head>
<body>

<div class="header">
  <h1>Origin</h1>
  <span class="repo">${repoName}</span>
  <span class="branch">${branch}</span>
</div>

<div class="nav">
  <button class="active" onclick="showTab('overview')">Overview</button>
  <button onclick="showTab('commits')">Commits</button>
  <button onclick="showTab('sessions')">Sessions</button>
  <button onclick="showTab('prompts')">Prompts</button>
</div>

<div class="content">
  <!-- Overview -->
  <div id="tab-overview" class="tab active">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Commits</div>
        <div class="value">${stats.totalCommits}</div>
        <div class="sub">${stats.aiCommits} AI · ${stats.humanCommits} Human</div>
      </div>
      <div class="stat-card">
        <div class="label">AI Ratio</div>
        <div class="value">${stats.totalCommits ? Math.round((stats.aiCommits / stats.totalCommits) * 100) : 0}%</div>
        <div class="sub">of commits are AI-authored</div>
      </div>
      <div class="stat-card">
        <div class="label">Lines Added</div>
        <div class="value">${(stats.aiLines + stats.humanLines).toLocaleString()}</div>
        <div class="sub">${stats.aiLines.toLocaleString()} AI · ${stats.humanLines.toLocaleString()} Human</div>
      </div>
      <div class="stat-card">
        <div class="label">Sessions</div>
        <div class="value">${sessions.length}</div>
        <div class="sub">tracked AI sessions</div>
      </div>
    </div>

    <div class="bar-chart">
      <h3>By Tool</h3>
      ${Object.entries(stats.toolCounts).sort((a, b) => b[1] - a[1]).map(([tool, count]) => {
        const pct = stats.aiCommits ? Math.round((count / stats.aiCommits) * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-label">${tool}</span>
          <div class="bar-track"><div class="bar-fill ai" style="width: ${Math.max(pct, 5)}%">${count} commits (${pct}%)</div></div>
        </div>`;
      }).join('\n') || '<div class="empty">No AI commits detected yet</div>'}
    </div>

    <div class="bar-chart">
      <h3>By Model</h3>
      ${Object.entries(stats.modelCounts).sort((a, b) => b[1] - a[1]).map(([model, count]) => {
        const pct = stats.aiCommits ? Math.round((count / stats.aiCommits) * 100) : 0;
        return `<div class="bar-row">
          <span class="bar-label">${model}</span>
          <div class="bar-track"><div class="bar-fill ai" style="width: ${Math.max(pct, 5)}%">${count} commits (${pct}%)</div></div>
        </div>`;
      }).join('\n') || '<div class="empty">No AI commits detected yet</div>'}
    </div>

    <div class="bar-chart">
      <h3>Commits — AI vs Human</h3>
      <div class="bar-row">
        <span class="bar-label">AI</span>
        <div class="bar-track"><div class="bar-fill ai" style="width: ${stats.totalCommits ? Math.max(Math.round((stats.aiCommits / stats.totalCommits) * 100), 2) : 0}%">${stats.aiCommits}</div></div>
      </div>
      <div class="bar-row">
        <span class="bar-label">Human</span>
        <div class="bar-track"><div class="bar-fill human" style="width: ${stats.totalCommits ? Math.max(Math.round((stats.humanCommits / stats.totalCommits) * 100), 2) : 0}%">${stats.humanCommits}</div></div>
      </div>
    </div>
  </div>

  <!-- Commits -->
  <div id="tab-commits" class="tab">
    <div class="commit-list">
      ${commits.length === 0 ? '<div class="empty">No commits found</div>' : commits.map(c => `
        <div class="commit-item">
          <span class="badge ${c.isAi ? 'ai' : 'human'}">${c.isAi ? 'AI' : 'HU'}</span>
          <span class="commit-msg">${escapeHtml(c.message)}</span>
          <span class="commit-model">${c.isAi ? (c.model || '') : ''}</span>
          <span class="commit-author">${c.isAi ? '' : c.author}</span>
          <span class="commit-lines"><span class="add">+${c.linesAdded || 0}</span> <span class="del">-${c.linesRemoved || 0}</span></span>
          <span class="commit-sha">${c.sha.slice(0, 7)}</span>
          <span class="commit-date">${new Date(c.date).toLocaleDateString()}</span>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Sessions -->
  <div id="tab-sessions" class="tab">
    <div class="commit-list">
      ${sessions.length === 0 ? '<div class="empty">No sessions tracked yet.<br>Sessions appear after AI agents make commits.</div>' : sessions.reverse().map(s => `
        <div class="session-item">
          <span class="session-id">${s.id.slice(0, 16)}</span>
          <span class="session-model">${s.model}</span>
          <span class="session-meta">${s.date ? new Date(s.date).toLocaleString() : ''}</span>
          <span class="session-meta">${s.tokens ? s.tokens.toLocaleString() + ' tokens' : ''}</span>
          <span class="session-meta">${s.cost ? '$' + s.cost.toFixed(4) : ''}</span>
          <span class="session-meta">${s.promptCount ? s.promptCount + ' prompts' : ''}</span>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Prompts -->
  <div id="tab-prompts" class="tab">
    <div class="commit-list">
      ${prompts.length === 0 ? '<div class="empty">No prompts in local database.<br>Run <code>origin db import</code> to import from origin-sessions branch.</div>' : prompts.slice(-50).reverse().map(p => `
        <div class="prompt-item">
          <div class="prompt-text">${escapeHtml(p.promptText.slice(0, 200))}${p.promptText.length > 200 ? '...' : ''}</div>
          <div class="prompt-meta">
            <span>${p.model}</span>
            <span>${p.sessionId.slice(0, 12)}</span>
            <span>${p.timestamp ? new Date(p.timestamp).toLocaleString() : ''}</span>
          </div>
          ${p.filesChanged.length > 0 ? `<div class="prompt-files">${p.filesChanged.slice(0, 5).join(', ')}${p.filesChanged.length > 5 ? ` +${p.filesChanged.length - 5} more` : ''}</div>` : ''}
        </div>
      `).join('')}
    </div>
  </div>
</div>

<div class="footer">Origin CLI — local AI code attribution dashboard</div>

<script>
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function webCommand(opts: { port?: string }) {
  const cwd = process.cwd();
  const repoRoot = getGitRoot(cwd);
  if (!repoRoot) {
    console.log(chalk.red('Not inside a git repository.'));
    process.exit(1);
  }

  const port = parseInt(opts.port || '3141', 10);

  console.log(chalk.bold('\n  Origin Web Dashboard\n'));
  console.log(chalk.gray('  Gathering data from git notes, sessions, and local DB...'));

  const data = gatherData(repoRoot);
  const html = buildHTML(data);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.green(`\n  ✓ Dashboard running at ${chalk.bold(url)}\n`));
    console.log(chalk.gray(`  ${data.stats.totalCommits} commits · ${data.stats.aiCommits} AI · ${data.sessions.length} sessions · ${data.prompts.length} prompts`));
    console.log(chalk.gray('\n  Press Ctrl+C to stop.\n'));

    // Open browser
    try {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCmd} ${url}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  });
}
