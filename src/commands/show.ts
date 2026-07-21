import chalk from 'chalk';
import { listSessionIds, readSessionFile } from '../session-store.js';
import { execFileSync, execSync } from 'child_process';
import { getGitRoot, loadSessionState, listActiveSessions } from '../session-state.js';
import { loadConfig, isConnectedMode } from '../config.js';
import { api } from '../api.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function readOriginNote(repoPath: string, sha: string): Record<string, any> | null {
  try {
    const note = execFileSync('git', ['notes', '--ref=origin', 'show', sha], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return JSON.parse(note)?.origin || null;
  } catch {
    return null;
  }
}

function agentLabel(note: Record<string, any>): string {
  if (note.agent) {
    const map: Record<string, string> = {
      'claude': 'Claude Code', 'claude-code': 'Claude Code',
      'cursor': 'Cursor', 'gemini': 'Gemini CLI', 'codex': 'Codex',
      'devin': 'Devin', 'aider': 'Aider', 'copilot': 'Copilot',
      'amp': 'Amp', 'junie': 'Junie', 'opencode': 'Opencode',
      'rovo': 'Rovo', 'droid': 'Droid',
    };
    return map[note.agent] || note.agent;
  }
  const m = (note.model || '').toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus')) return 'Claude Code';
  if (m.includes('gpt')) return 'Cursor';
  if (m.includes('gemini')) return 'Gemini CLI';
  return 'AI';
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ─── Load full session data (local git branch or API) ────────────────────

interface FullSession {
  sessionId: string;
  model: string;
  agent: string;
  duration: string;
  cost: string;
  tokensUsed: number;
  promptCount: number;
  linesAdded: number;
  linesRemoved: number;
  originUrl?: string;
  prompts: Array<{ index: number; text: string; filesChanged?: string[]; linesAdded?: number; linesRemoved?: number }>;
}

function loadLocalSession(sessionId: string, repoPath: string): FullSession | null {
  const execOpts = { encoding: 'utf-8' as const, cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
  // Try to find session dir on origin-sessions branch
  let dir = sessionId;
  if (!readSessionFile(repoPath, sessionId, 'metadata.json')) {
    // Short ID prefix match
    const found = listSessionIds(repoPath).find((d) => d.startsWith(sessionId));
    if (!found) return null;
    dir = found;
  }

  try {
    const metaJson = (readSessionFile(repoPath, dir, 'metadata.json') ?? '').trim();
    const meta = JSON.parse(metaJson);

    // Prompts come from prompts.md — the only prompt file the CLI has ever
    // written. This used to read a prompts.json that nothing produces, so the
    // list was always empty.
    const prompts = parsePromptsMarkdown(readSessionFile(repoPath, dir, 'prompts.md'));

    // metadata.json is NESTED (cost.usd, tokens.total, lines.added) — see
    // buildMetadataJson in local-entrypoint.ts. These were read as though it
    // were flat (meta.costUsd, meta.tokensUsed, meta.linesAdded), which always
    // yielded 0. Not currently visible — showCommand renders these numbers from
    // the git note and only takes `prompts` from here — but the struct is public
    // enough that returning zeros for data we hold is a trap for the next caller.
    return {
      sessionId: meta.sessionId || dir,
      model: meta.model || 'unknown',
      agent: meta.agent || '',
      duration: formatDuration(meta.durationMs || 0),
      cost: formatCost(meta.cost?.usd ?? 0),
      tokensUsed: meta.tokens?.total ?? 0,
      promptCount: prompts.length,
      linesAdded: meta.lines?.added ?? 0,
      linesRemoved: meta.lines?.removed ?? 0,
      prompts,
    };
  } catch {
    return null;
  }
}

/**
 * Pull the prompts out of a prompts.md written by buildPromptsMd.
 *
 * Shape it parses (one block per prompt):
 *   ## Prompt 1
 *
 *   <text>
 *
 *   **Files changed:**
 *   - `a.ts`
 */
function parsePromptsMarkdown(md: string | null): FullSession['prompts'] {
  if (!md) return [];
  const prompts: FullSession['prompts'] = [];
  // Keep the heading so we can recover the real (1-based) index rather than
  // assuming the blocks are contiguous.
  const blocks = md.split(/^## Prompt /m).slice(1);
  for (const block of blocks) {
    const idxMatch = block.match(/^(\d+)/);
    const body = block.replace(/^\d+\s*/, '');
    const [beforeFiles, filesPart] = body.split('**Files changed:**');
    const text = beforeFiles.replace(/\n---\n?/g, '').trim();
    const filesChanged = filesPart
      ? filesPart.split('\n')
          .map((l) => l.match(/^-\s+`(.+)`$/)?.[1])
          .filter((f): f is string => !!f)
      : undefined;
    prompts.push({
      index: idxMatch ? parseInt(idxMatch[1], 10) : prompts.length + 1,
      text,
      filesChanged,
    });
  }
  return prompts;
}

async function loadApiSession(sessionId: string): Promise<FullSession | null> {
  try {
    const session = await api.getSession(sessionId) as any;
    if (!session) return null;
    // promptIndex is 1-based (it matches "## Prompt N" in prompts.md), so the
    // positional fallback has to be 1-based too — `?? i` mixed the two and the
    // renderer then added 1 on top, numbering prompts 2,3,4…
    const prompts = (session.promptChanges || []).map((pc: any, i: number) => ({
      index: pc.promptIndex ?? i + 1,
      text: pc.promptText || '',
      filesChanged: pc.filesChanged || [],
      linesAdded: pc.linesAdded,
      linesRemoved: pc.linesRemoved,
    }));
    return {
      sessionId: session.id,
      model: session.model || 'unknown',
      agent: session.agentSlug || session.agent || '',
      duration: formatDuration(session.durationMs || 0),
      cost: formatCost(session.costUsd || 0),
      tokensUsed: session.tokensUsed || 0,
      promptCount: prompts.length || session.promptCount || 0,
      linesAdded: session.linesAdded || 0,
      linesRemoved: session.linesRemoved || 0,
      originUrl: session.originUrl,
      prompts,
    };
  } catch {
    return null;
  }
}

// ─── Command ──────────────────────────────────────────────────────────────

export async function showCommand(commitSha: string, options: { json?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repoPath = getGitRoot(cwd);
  if (!repoPath) {
    console.log(chalk.red('Not a git repository'));
    process.exit(1);
  }

  const execOpts = { cwd: repoPath, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

  // Resolve short SHA
  let fullSha: string;
  try {
    fullSha = execFileSync('git', ['rev-parse', commitSha], execOpts).trim();
  } catch {
    console.log(chalk.red(`Commit not found: ${commitSha}`));
    process.exit(1);
  }

  // Get commit info
  let commitMessage: string, commitAuthor: string, commitDate: string;
  try {
    commitMessage = execFileSync('git', ['log', '-1', '--format=%s', fullSha], execOpts).trim();
    commitAuthor = execFileSync('git', ['log', '-1', '--format=%an', fullSha], execOpts).trim();
    commitDate = execFileSync('git', ['log', '-1', '--format=%aI', fullSha], execOpts).trim();
  } catch {
    console.log(chalk.red('Failed to read commit info'));
    process.exit(1);
  }

  // Read git note
  const note = readOriginNote(repoPath, fullSha);

  if (!note) {
    console.log('');
    console.log(`  ${chalk.yellow(fullSha.slice(0, 7))} ${chalk.white(commitMessage)}`);
    console.log(`  ${chalk.gray(`by ${commitAuthor} on ${new Date(commitDate).toLocaleDateString()}`)}`);
    console.log('');
    console.log(chalk.gray('  No Origin session linked to this commit.'));
    console.log(chalk.gray('  This commit was made outside of an AI coding session.'));
    console.log('');
    return;
  }

  // Get files changed in this commit
  let filesChanged: string[] = [];
  try {
    const raw = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', fullSha], execOpts).trim();
    filesChanged = raw ? raw.split('\n').filter(Boolean) : [];
  } catch { /* ignore */ }

  // Get line counts from diff
  let linesAdded = note.linesAdded || 0;
  let linesRemoved = note.linesRemoved || 0;
  if (!linesAdded && !linesRemoved) {
    try {
      const stat = execFileSync('git', ['diff', '--shortstat', `${fullSha}~1..${fullSha}`], execOpts).trim();
      const addMatch = stat.match(/(\d+) insertion/);
      const delMatch = stat.match(/(\d+) deletion/);
      if (addMatch) linesAdded = parseInt(addMatch[1]);
      if (delMatch) linesRemoved = parseInt(delMatch[1]);
    } catch { /* first commit */ }
  }

  const agent = agentLabel(note);
  const sessionId = note.sessionId;

  if (options.json) {
    console.log(JSON.stringify({
      commit: fullSha,
      message: commitMessage,
      author: commitAuthor,
      date: commitDate,
      session: {
        id: sessionId,
        agent,
        model: note.model,
        cost: note.costUsd,
        duration: note.durationMs,
        promptCount: note.promptCount,
        tokensUsed: note.tokensUsed,
        linesAdded,
        linesRemoved,
      },
      filesChanged,
    }, null, 2));
    return;
  }

  // Pretty print
  console.log('');
  console.log(`  ${chalk.yellow(fullSha.slice(0, 7))} ${chalk.white(commitMessage)}`);
  console.log(`  ${chalk.gray(`by ${commitAuthor} on ${new Date(commitDate).toLocaleDateString()}`)}`);
  console.log('');
  console.log(chalk.bold.white('  Session'));
  console.log(`  ${chalk.gray('ID:')}       ${chalk.cyan(sessionId)}`);
  console.log(`  ${chalk.gray('Agent:')}    ${chalk.cyan(agent)} ${chalk.gray('/')} ${chalk.gray(note.model || 'unknown')}`);
  console.log(`  ${chalk.gray('Duration:')} ${chalk.white(formatDuration(note.durationMs || 0))}`);
  console.log(`  ${chalk.gray('Cost:')}     ${chalk.green(formatCost(note.costUsd || 0))}`);
  console.log(`  ${chalk.gray('Tokens:')}   ${chalk.white((note.tokensUsed || 0).toLocaleString())}`);
  console.log(`  ${chalk.gray('Prompts:')}  ${chalk.white(String(note.promptCount || 0))}`);
  console.log(`  ${chalk.gray('Lines:')}    ${chalk.green(`+${linesAdded}`)} ${chalk.red(`-${linesRemoved}`)}`);

  if (note.aiPercentage != null) {
    console.log(`  ${chalk.gray('AI %:')}     ${chalk.blue(`${Math.round(note.aiPercentage)}%`)}`);
  }

  // Prompt summary
  if (note.promptSummary) {
    console.log('');
    console.log(chalk.bold.white('  Prompts'));
    const summaryLines = note.promptSummary.split('\n').filter(Boolean);
    for (const line of summaryLines) {
      console.log(`  ${chalk.gray('→')} ${chalk.white(line.trim())}`);
    }
  }

  // Files
  if (filesChanged.length > 0) {
    console.log('');
    console.log(chalk.bold.white('  Files'));
    for (const f of filesChanged.slice(0, 15)) {
      // Get per-file stats
      try {
        const stat = execFileSync('git', ['diff', '--numstat', `${fullSha}~1..${fullSha}`, '--', f], execOpts).trim();
        const parts = stat.split('\t');
        if (parts.length >= 2) {
          const add = parts[0] === '-' ? '?' : parts[0];
          const del = parts[1] === '-' ? '?' : parts[1];
          console.log(`  ${chalk.gray('·')} ${chalk.white(f)} ${chalk.green(`+${add}`)} ${chalk.red(`-${del}`)}`);
        } else {
          console.log(`  ${chalk.gray('·')} ${chalk.white(f)}`);
        }
      } catch {
        console.log(`  ${chalk.gray('·')} ${chalk.white(f)}`);
      }
    }
    if (filesChanged.length > 15) {
      console.log(chalk.gray(`  ... and ${filesChanged.length - 15} more files`));
    }
  }

  // Try loading full session data for detailed prompt list
  let fullSession: FullSession | null = null;

  // Try local first
  fullSession = loadLocalSession(sessionId, repoPath);

  // Try API if connected
  if (!fullSession && isConnectedMode()) {
    fullSession = await loadApiSession(sessionId);
  }

  if (fullSession && fullSession.prompts.length > 0) {
    console.log('');
    console.log(chalk.bold.white('  Prompt Details'));
    for (const p of fullSession.prompts) {
      const text = p.text.length > 100 ? p.text.slice(0, 100) + '...' : p.text;
      const fileCount = p.filesChanged?.length || 0;
      const stats = [];
      if (fileCount > 0) stats.push(`${fileCount} files`);
      if (p.linesAdded) stats.push(chalk.green(`+${p.linesAdded}`));
      if (p.linesRemoved) stats.push(chalk.red(`-${p.linesRemoved}`));
      const statStr = stats.length > 0 ? ` ${chalk.gray('(')}${stats.join(chalk.gray(', '))}${chalk.gray(')')}` : '';
      // p.index is already 1-based from both loaders — don't re-add one.
      console.log(`  ${chalk.gray(`${p.index}.`)} ${chalk.white(`"${text}"`)}${statStr}`);
    }
  }

  // Link to dashboard
  const config = loadConfig();
  const apiUrl = config?.apiUrl || 'https://getorigin.io';
  if (isConnectedMode()) {
    console.log('');
    console.log(chalk.gray(`  View in dashboard: ${apiUrl.replace('/api', '').replace('api.', '')}/sessions/${sessionId}`));
  }

  console.log('');
}

// Internals exercised by session-file-shape-readers.test.ts, which pins these
// readers against a file set produced by the real writer. Not a public API.
export const __testing = { loadLocalSession, parsePromptsMarkdown };
